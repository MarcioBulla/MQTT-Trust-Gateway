"""Failure-injection checks for the update state machine, no real services."""
import tempfile
import unittest
from scripts.updater.controller import Controller


class PowerLoss(BaseException):
    pass


class Backend:
    def __init__(self, failure=None, power=None):
        self.failure, self.power, self.calls = failure, power, []
        self.live_version = '1.0.2'
        self.marker = False
    def installed(self): return {'version':'1.0.2'}
    def __getattr__(self, method):
        def call(*args):
            self.calls.append(method)
            if method == self.power:
                self.power = None
                raise PowerLoss()
            if method == self.failure:
                self.failure = None
                raise RuntimeError('synthetic failure: sensitive details must never enter operation history')
            if method == 'resolve': return {'version':args[0]}
            if method == 'snapshot': return {'id':'synthetic-snapshot','sha256':'a'*64}
            if method == 'activate': self.live_version = args[0]['version']
            if method == 'restore': self.live_version = args[0]['previous']['version']
            if method == 'maintenance': self.marker = args[0]
        return call


class ControllerTests(unittest.TestCase):
    def test_update_commits_only_after_functional_health(self):
        with tempfile.TemporaryDirectory() as root:
            backend = Backend()
            result = Controller(root,backend).install('1.1.0')
            self.assertEqual(result['state'],'COMPLETED')
            self.assertLess(backend.calls.index('health'),backend.calls.index('commit'))
            self.assertFalse(backend.marker)

    def test_pre_commit_failures_restore_previous_version(self):
        for failure in ('migrate','activate','start','health'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as root:
                backend=Backend(failure=failure)
                result=Controller(root,backend).install('1.1.0')
                self.assertEqual(result['state'],'ROLLED_BACK')
                self.assertEqual(backend.live_version,'1.0.2')
                self.assertNotIn('sensitive',str(result))

    def test_download_verification_and_snapshot_failures_do_not_mutate_runtime(self):
        for failure in ('resolve','download','verify_images','preflight','snapshot'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as root:
                backend=Backend(failure=failure)
                result=Controller(root,backend).install('1.1.0')
                self.assertIn(result['state'],('FAILED','ROLLED_BACK'))
                self.assertNotIn('activate',backend.calls)
                self.assertNotIn('restore',backend.calls)
                self.assertEqual(backend.live_version,'1.0.2')

    def test_reboot_at_each_boundary_recovers_deterministically(self):
        for boundary in ('download','verify_images','preflight','maintenance','stop','snapshot','migrate','activate','start','health','commit'):
            with self.subTest(boundary=boundary), tempfile.TemporaryDirectory() as root:
                backend=Backend(power=boundary)
                with self.assertRaises(PowerLoss):
                    Controller(root,backend).install('1.1.0')
                result=Controller(root,backend).recover()
                self.assertIn(result['state'],('FAILED','ROLLED_BACK','COMPLETED'))
                if boundary == 'commit':
                    self.assertEqual(result['state'],'COMPLETED')
                    self.assertNotIn('restore',backend.calls)
                self.assertFalse(backend.marker)

    def test_failed_rollback_enters_manual_recovery_without_retry_loop(self):
        with tempfile.TemporaryDirectory() as root:
            backend=Backend(failure='health')
            def broken_restore(*_): raise RuntimeError('cannot restore')
            backend.restore=broken_restore
            controller=Controller(root,backend)
            result=controller.install('1.1.0')
            self.assertEqual(result['state'],'RECOVERY_REQUIRED')
            calls=len(backend.calls)
            controller.recover()
            self.assertEqual(len(backend.calls),calls)
            self.assertTrue(backend.marker)


class MutableBackend(Backend):
    def __init__(self):
        super().__init__()
        self.record={'version':'1.0.2','schemaVersion':1,'images':{'admin':'sha256:'+'a'*64,'broker':'sha256:'+'b'*64}}
        self.fingerprint='unchanged'
    def installed(self):return dict(self.record)
    def persistent_fingerprint(self):return self.fingerprint
    def commit(self,operation):
        self.calls.append('commit')
        self.record={'version':operation['version'],'schemaVersion':1,'operationId':operation['id'],'persistentFingerprint':self.fingerprint,'images':dict(self.record['images'])}
    def snapshot(self,operation):
        self.calls.append('snapshot')
        return {'id':operation['id'],'sha256':'a'*64}
    def restore(self,operation):
        self.calls.append('restore')
        self.record=dict(operation['previous'])
        self.live_version=self.record['version']


class ManualRollbackTests(unittest.TestCase):
    def test_manual_rollback_requires_confirmation_and_fresh_snapshot(self):
        with tempfile.TemporaryDirectory() as root:
            backend=MutableBackend()
            controller=Controller(root,backend)
            initial=controller.install('1.1.0')
            self.assertEqual(initial['state'],'COMPLETED')
            with self.assertRaises(ValueError):controller.rollback(initial['id'],'incorrect')
            rolled=controller.rollback(initial['id'],'ROLLBACK 1.0.2')
            self.assertEqual(rolled['state'],'COMPLETED')
            self.assertEqual(backend.record['version'],'1.0.2')
            self.assertEqual(backend.calls.count('snapshot'),2)
            with self.assertRaises(ValueError):controller.rollback(initial['id'],'ROLLBACK 1.0.2')

    def test_new_persistent_writes_prevent_restoration_of_an_old_snapshot(self):
        with tempfile.TemporaryDirectory() as root:
            backend=MutableBackend()
            controller=Controller(root,backend)
            initial=controller.install('1.1.0')
            backend.fingerprint='new certificate or revocation'
            calls=len(backend.calls)
            with self.assertRaises(ValueError):controller.rollback(initial['id'],'ROLLBACK 1.0.2')
            self.assertEqual(len(backend.calls),calls)
            self.assertEqual(backend.record['version'],'1.1.0')


class ExplicitRecoveryTests(unittest.TestCase):
    def test_explicit_retry_is_confirmed_bounded_and_does_not_restore_after_commit(self):
        for committed in (False, True):
            with self.subTest(committed=committed), tempfile.TemporaryDirectory() as root:
                backend = Backend()
                controller = Controller(root, backend)
                operation = controller.journal.begin('1.1.0', {'version':'1.0.2'})
                operation.update(committed=committed, release={'version':'1.1.0'}, snapshot={'id':'test'})
                controller.journal.transition(operation, 'RECOVERY_REQUIRED')
                with self.assertRaises(ValueError): controller.retry_recovery(operation['id'], 'wrong')
                result = controller.retry_recovery(operation['id'], 'RECOVER ' + operation['id'])
                self.assertEqual(result['state'], 'COMPLETED' if committed else 'ROLLED_BACK')
                self.assertEqual('restore' in backend.calls, not committed)
                with self.assertRaises(ValueError): controller.retry_recovery(operation['id'], 'RECOVER ' + operation['id'])
