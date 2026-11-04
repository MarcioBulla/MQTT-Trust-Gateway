"""Durable update orchestration independent of the administrative container."""
from .journal import Journal

PRE_MUTATION = {'CHECKING', 'DOWNLOADING', 'VERIFYING', 'PREPARING'}


class Controller:
    def __init__(self, directory, backend):
        self.journal = Journal(directory)
        self.backend = backend

    def install(self, version):
        with self.journal.lock():
            operation = self.journal.begin(version, self.backend.installed())
            try:
                release = self.backend.resolve(version)
                operation['release'] = release
                self.journal.transition(operation, 'DOWNLOADING')
                self.backend.download(release)
                self.journal.transition(operation, 'VERIFYING')
                self.backend.verify_images(release)
                self.journal.transition(operation, 'PREPARING')
                self.backend.preflight(release)
                # Maintenance is durable before stopping writers. Recovery must
                # restart the prior services if power fails before a snapshot.
                self.journal.transition(operation, 'STOPPING', maintenance=True)
                self.backend.maintenance(True)
                self.backend.prepare_stop()
                self.backend.stop()
                self.journal.transition(operation, 'BACKING_UP')
                snapshot = self.backend.snapshot(operation)
                self.journal.transition(operation, 'MIGRATING', snapshot=snapshot)
                self.backend.migrate(release, operation)
                self.journal.transition(operation, 'INSTALLING')
                self.backend.activate(release)
                self.journal.transition(operation, 'STARTING')
                self.backend.start()
                self.journal.transition(operation, 'HEALTH_CHECKING')
                self.backend.health(release)
                # Once commit starts, recovery always moves forward. No old
                # snapshot may replace a successfully committed installation.
                self.journal.transition(operation, 'COMMITTING', committed=True)
                self.backend.commit(operation)
                self.backend.maintenance(False)
                self.journal.transition(operation, 'COMPLETED')
            except Exception:
                self._recover(operation)
            return self.journal.read()

    def recover(self):
        with self.journal.lock():
            operation = self.journal.read()
            if not operation:
                return None
            if operation['state'] == 'COMPLETED':
                self.backend.maintenance(False)
            elif operation['state'] not in {'ROLLED_BACK', 'FAILED', 'RECOVERY_REQUIRED'}:
                self._recover(operation)
            return self.journal.read()

    def retry_recovery(self, operation_id, confirmation):
        """One explicit host-owner retry; committed operations only move forward."""
        with self.journal.lock():
            operation = self.journal.read()
            if not operation or operation['state'] != 'RECOVERY_REQUIRED' or operation['id'] != operation_id:
                raise ValueError('No matching recovery-required operation')
            if confirmation != 'RECOVER ' + operation_id:
                raise ValueError('Explicit recovery confirmation is required')
            operation['state'] = 'COMMITTING' if operation.get('committed') else 'ROLLING_BACK'
            self.journal.transition(operation, operation['state'], manualRecovery=True)
            self._recover(operation)
            return self.journal.read()

    def rollback(self, source_id, confirmation):
        import json
        import re
        if not isinstance(source_id,str) or not re.fullmatch(r'[a-f0-9-]{36}',source_id):
            raise ValueError('Invalid operation identifier')
        with self.journal.lock():
            source=json.loads((self.journal.directory/'history'/(source_id+'.json')).read_text())
            installed=self.backend.installed()
            if source['state']!='COMPLETED' or installed.get('operationId')!=source_id or not source.get('snapshot'):
                raise ValueError('No safe rollback recovery point exists')
            if confirmation!='ROLLBACK '+source['previous']['version']:
                raise ValueError('Explicit rollback confirmation is required')
            if installed.get('persistentFingerprint')!=self.backend.persistent_fingerprint():
                raise ValueError('Persistent data changed after commit; automatic snapshot restoration is unsafe')
            operation=self.journal.begin(source['previous']['version'],installed,kind='rollback')
            operation['release']={'version':source['previous']['version'],'schema_version':source['previous']['schemaVersion']}
            try:
                self.backend.verify_snapshot(source)
                self.journal.transition(operation,'STOPPING',maintenance=True)
                self.backend.maintenance(True)
                self.backend.prepare_stop()
                self.backend.stop()
                if installed['persistentFingerprint']!=self.backend.persistent_fingerprint():
                    raise ValueError('Persistent data changed while preparing rollback')
                self.journal.transition(operation,'BACKING_UP')
                safety=self.backend.snapshot(operation)
                self.journal.transition(operation,'INSTALLING',snapshot=safety)
                target={**source,'id':operation['id']+'-target'}
                self.backend.restore(target)
                self.journal.transition(operation,'STARTING')
                self.backend.start()
                self.journal.transition(operation,'HEALTH_CHECKING')
                self.backend.health(operation['release'])
                self.journal.transition(operation,'COMMITTING',committed=True)
                self.backend.commit(operation)
                self.backend.maintenance(False)
                self.journal.transition(operation,'COMPLETED')
            except Exception:
                self._recover(operation)
            return self.journal.read()

    def _recover(self, operation):
        if operation['state'] not in {'ROLLING_BACK','COMMITTING'}:
            operation.setdefault('failedStage',operation['state'])
        if operation.get('committed'):
            try:
                self.backend.maintenance(True)
                self.backend.start()
                self.backend.health(operation['release'])
                self.backend.commit(operation)
                self.backend.maintenance(False)
                self.journal.transition(operation, 'COMPLETED')
            except Exception:
                self.journal.transition(operation, 'RECOVERY_REQUIRED', errorCode='COMMIT_RECOVERY_FAILED')
            return
        if operation['state'] in PRE_MUTATION:
            self.journal.transition(operation, 'FAILED', errorCode=operation['state']+'_FAILED')
            return
        try:
            self.journal.transition(operation, 'ROLLING_BACK', errorCode=operation.get('failedStage','UPDATE')+'_FAILED')
            self.backend.maintenance(True)
            if operation.get('snapshot'):
                self.backend.stop()
                self.backend.restore(operation)
            self.backend.start()
            self.backend.health(operation['previous'])
            self.backend.maintenance(False)
            self.journal.transition(operation, 'ROLLED_BACK')
        except Exception:
            self.journal.transition(operation, 'RECOVERY_REQUIRED', errorCode='ROLLBACK_FAILED')
