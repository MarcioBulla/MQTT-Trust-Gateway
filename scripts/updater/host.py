"""Fixed rootless Podman/systemd adapter. All paths come from host configuration."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import subprocess

from scripts.gateway import read_env
from . import releases, snapshots
from .journal import atomic_json
from .mqtt_state import fingerprint as mqtt_fingerprint


def command(*args, input=None, timeout=180):
    result = subprocess.run(list(map(str,args)), input=input, capture_output=True, timeout=timeout)
    if result.returncode:
        # Never store subprocess output: it may contain configuration or keys.
        message='Updater subprocess failed: '+str(args[0])
        stage=re.search(rb'UPDATE_FUNCTIONAL_HEALTH_FAILED:([A-Z_]{1,40})',result.stderr)
        if stage and stage[1].decode() in {'ADMIN_API','DATABASE','BROKER_TLS','BROKER_CRL','BROKER_REVISION','MQTT_CONNECT','MQTT_DELIVERY','WSS_DELIVERY','ACL_SUBSCRIBE','ACL_PUBLISH','INVALID_CREDENTIAL'}:
            message+=' (health stage '+stage[1].decode()+')'
        raise RuntimeError(message)
    return result.stdout.decode().strip()


def atomic_bytes(path, payload, mode=0o600):
    import tempfile
    path=Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary=tempfile.mkstemp(prefix='.activate-',dir=path.parent)
    try:
        with os.fdopen(fd,'wb') as output:
            output.write(payload); output.flush(); os.fchmod(output.fileno(),mode); os.fsync(output.fileno())
        os.replace(temporary,path)
        parent=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
        try: os.fsync(parent)
        finally: os.close(parent)
    finally: Path(temporary).unlink(missing_ok=True)


class Host:
    def __init__(self, config):
        self.config=config
        self.data=Path(config['data']).resolve()
        self.environment=Path(config['environment']).resolve()
        self.units=Path(config['units']).resolve()
        self.state=Path(config['state']).resolve()
        self.bridge=self.state/'bridge'
        self.bridge.mkdir(mode=0o700,parents=True,exist_ok=True)
        self.names=config.get('names',{'admin':'mqtt-admin','broker':'mqtt-broker','network':'mqtt-gateway'})
        if set(self.names)!={'admin','broker','network'} or any(not re.fullmatch(r'[a-zA-Z0-9_-]{1,80}',n) for n in self.names.values()):
            raise ValueError('Invalid managed service names')
        if self.state==self.data or self.data in self.state.parents:
            raise ValueError('Updater state must be outside runtime')
        self.snapshot_root=self.state/'snapshots'
        self.unit_files={name:self.units/(self.names[name]+'.container') for name in ('admin','broker')}
        self.environment_values=read_env(self.environment)
        if os.getuid()==0:
            raise ValueError('Updater must run as a rootless user')

    def _run(self,*args,**kwargs): return command(*args,**kwargs)

    def installed(self):
        record=self.state/'installed.json'
        if record.exists(): return json.loads(record.read_text())
        version=self._run('podman','exec',self.names['admin'],'node','-p','JSON.parse(require("fs").readFileSync("package.json")).version')
        releases.version_key(version)
        return {'version':version,'schemaVersion':self.schema(),'images':self.image_ids()}

    def schema(self):
        connection=sqlite3.connect(f'file:{(self.data/"admin/gateway.sqlite").as_posix()}?mode=ro',uri=True)
        try: return connection.execute('PRAGMA user_version').fetchone()[0]
        finally: connection.close()

    def image_ids(self):
        result={}
        for name,file in self.unit_files.items():
            references=re.findall(r'^Image=(.+)$',file.read_text(),re.M)
            if len(references)!=1: raise ValueError('Managed Quadlet must specify exactly one image')
            try: image=self._run('podman','inspect','--type','container','--format','{{.Image}}',self.names[name])
            except RuntimeError: image=self._run('podman','image','inspect','--format','{{.Id}}',references[0])
            if re.fullmatch(r'[a-f0-9]{64}',image): image='sha256:'+image
            if not re.fullmatch(r'sha256:[a-f0-9]{64}',image): raise ValueError('Installed image cannot be identified')
            result[name]=image
        return result

    def resolve(self,version):
        raw,signature=releases.discover(version)
        key=base64.b64decode(self.config['publicKey'],validate=True)
        manifest=releases.verify(raw,signature,key,version)
        installed=self.installed()
        if releases.version_key(version)<=releases.version_key(installed['version']):
            raise ValueError('Installation must advance the release; use guarded rollback for older versions')
        podman=json.loads(self._run('podman','version','--format','json'))['Client']['Version']
        releases.compatible(manifest,installed['version'],self.schema(),podman)
        return manifest

    def image_reference(self,release,component):
        return release['images'][component]['reference']

    def download(self,release):
        for component in ('admin','broker'):
            self._run('podman','pull',self.image_reference(release,component),timeout=900)

    def verify_images(self,release):
        for component in ('admin','broker'):
            reference=release['images'][component]['reference']
            document=json.loads(self._run('podman','image','inspect',self.image_reference(release,component)))[0]
            expected=reference.split('@',1)[1]
            if document.get('Digest')!=expected and reference not in document.get('RepoDigests',[]):
                raise ValueError('Downloaded image digest does not match signed manifest')
            labels=document.get('Labels', document.get('Config',{}).get('Labels',{}))
            if labels.get('org.opencontainers.image.version')!=release['version']:
                raise ValueError('Image release version does not match its manifest')
            if component=='broker' and document.get('Labels', document.get('Config',{}).get('Labels',{})).get('io.mqtt-gateway.update-gate')!='1':
                raise ValueError('Broker image does not support maintenance isolation')

    def preflight(self,release):
        self._run('systemctl','--user','show-environment')
        if self._run('podman','info','--format','{{.Host.Security.Rootless}}')!='true':
            raise ValueError('Only rootless Podman is supported')
        if (self.data/'broker/pending-revision').exists():
            raise ValueError('Apply or resolve pending broker changes before updating')
        if (self.data/'broker/revision').read_bytes()!=(self.data/'broker/applied-revision').read_bytes():
            raise ValueError('Broker configuration is not applied')
        for name,file in self.unit_files.items():
            text=file.read_text()
            if '# Managed by MQTT Trust Gateway' not in text:
                raise ValueError('Refusing to change unmanaged Quadlets')
        required=sum(p.stat().st_size for p in self.data.rglob('*') if p.is_file())*3+16*1024*1024
        if shutil.disk_usage(self.state).free<required:
            raise OSError('Insufficient snapshot space')
        capability=self._run('podman','inspect','--type','container','--format','{{index .Config.Labels \"io.mqtt-gateway.update-gate\"}}',self.names['broker'])
        if capability!='1': raise ValueError('Bootstrap a broker with maintenance isolation before enabling signed updates')
        if self.installed()['images']!=self.image_ids():
            raise ValueError('Running images differ from the installed release record')

    def maintenance(self,enabled):
        marker=self.bridge/'maintenance.json'
        if enabled: atomic_json(marker,{'maintenance':True})
        else:
            marker.unlink(missing_ok=True)
            self.wait_gate('open')

    def wait_gate(self,expected):
        import time
        for attempt in range(100):
            gate=self.data/'broker/update-gate'
            if gate.exists() and gate.read_text()==expected: return
            time.sleep(0.1)
        raise ValueError('Broker maintenance isolation did not acknowledge the requested policy')

    def prepare_stop(self):
        result=json.loads(self._run('podman','exec',self.names['admin'],'node','src/update-health.js','ready',timeout=30))
        if result.get('ok') is not True: raise ValueError('One-time provisioning delivery is still pending')
        self.wait_gate('maintenance')

    def stop(self):
        for name in ('admin','broker'):
            self._run('systemctl','--user','stop',self.names[name]+'.service')
        self.assert_quiescent()

    def assert_quiescent(self):
        for name in ('admin','broker'):
            active=self._run('systemctl','--user','show','--property=ActiveState','--value',self.names[name]+'.service')
            if active not in ('inactive','failed'):
                raise ValueError('Gateway writers are not stopped')

    def _canonical_units(self,destination):
        destination.mkdir(mode=0o700)
        for name in ('admin','broker'):
            shutil.copy2(self.unit_files[name],destination/f'mqtt-{name}.container')
        shutil.copy2(self.units/(self.names['network']+'.network'),destination/'mqtt-gateway.network')

    def verify_snapshot(self,operation):
        return snapshots.verify(self.snapshot_root/operation['snapshot']['id'],operation['snapshot']['sha256'])

    def snapshot(self,operation):
        import tempfile
        destination=self.snapshot_root/operation['id']
        # Managed names can differ in isolated integration installations. Snapshot
        # members keep stable canonical names; restore maps them back explicitly.
        with tempfile.TemporaryDirectory(prefix='.quadlets-',dir=self.state) as temporary:
            canonical=Path(temporary)/'units'
            self._canonical_units(canonical)
            meta=snapshots.create(destination,self.data,self.environment,canonical,operation['previous']['images'],self.assert_quiescent,operation['previous']['version'])
        return {'id':operation['id'],'sha256':meta['sha256'],'caHashes':{name:meta['inventory']['runtime/'+name]['sha256'] for name in ('admin/ca/ca.key','admin/ca/ca.crt')}}

    def migrate(self,release,operation):
        self.assert_quiescent()
        workspace=self.state/'migrations'/operation['id']
        workspace.mkdir(mode=0o700,parents=True,exist_ok=True)
        source=sqlite3.connect(f'file:{(self.data/"admin/gateway.sqlite").as_posix()}?mode=ro',uri=True)
        target=sqlite3.connect(workspace/'gateway.sqlite')
        try:
            source.backup(target)
            target.execute('PRAGMA journal_mode=DELETE')
        finally: target.close(); source.close()
        (workspace/'gateway.sqlite').chmod(0o600)
        # Only a database copy is writable by migration code. CA state, device
        # credentials, environment and the live database are not mounted.
        self._run('podman','run','--rm','--network=none','--userns=keep-id','--user',f'{os.getuid()}:{os.getgid()}',
                  '--cap-drop=all','--security-opt=no-new-privileges','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=32m',
                  '--env','ADMIN_DATA_DIR=/data','-v',f'{workspace}:/data:rw,Z',
                  self.image_reference(release,'admin'),'node','src/update-migrate.js',str(release['schema_version']))
        if snapshots.validate_database(workspace/'gateway.sqlite')!=release['schema_version']:
            raise ValueError('Migration did not reach the required schema')
        canonical=workspace/'canonical.sqlite'
        source=sqlite3.connect(workspace/'gateway.sqlite')
        target=sqlite3.connect(canonical)
        try:
            source.backup(target)
            target.execute('PRAGMA journal_mode=DELETE')
        finally: target.close(); source.close()
        for suffix in ('-wal','-shm'):
            (self.data/('admin/gateway.sqlite'+suffix)).unlink(missing_ok=True)
        atomic_bytes(self.data/'admin/gateway.sqlite',canonical.read_bytes())

    def activate(self,release):
        self.assert_quiescent()
        for name in ('admin','broker'):
            file=self.unit_files[name]
            text,count=re.subn(r'^Image=.+$',lambda _: 'Image='+self.image_reference(release,name),file.read_text(),flags=re.M)
            if count!=1: raise ValueError('Invalid managed image entry')
            atomic_bytes(file,text.encode(),0o600)
        self._run('systemctl','--user','daemon-reload')

    def start(self):
        for name in ('broker','admin'):
            self._run('systemctl','--user','start',self.names[name]+'.service')

    def health(self,release):
        import time
        schema=release.get('schema_version',release.get('schemaVersion',1))
        for attempt in range(5):
            try:
                for name in ('admin','broker'):
                    if self._run('systemctl','--user','is-active',self.names[name]+'.service')!='active':
                        raise RuntimeError('Service is not active')
                operation_file=self.state/'operation.json'
                if operation_file.exists():
                    operation=json.loads(operation_file.read_text())
                    for name,expected in operation.get('snapshot',{}).get('caHashes',{}).items():
                        if snapshots.digest(self.data/name)!=expected:
                            raise ValueError('CA identity changed during update')
                image=self.image_ids()['admin']
                arguments=['podman','run','--rm','--network','container:'+self.names['broker'],
                    '--userns=keep-id','--user',f'{os.getuid()}:{os.getgid()}',
                    '--cap-drop=all','--security-opt=no-new-privileges','--read-only',
                    '--tmpfs','/tmp:rw,noexec,nosuid,size=32m',
                    '--env-file',self.environment,'--env','ADMIN_DATA_DIR=/data',
                    '--env','MQTT_HOST=localhost','--env','UPDATE_HEALTH_API_HOST=mqtt-admin',
                    '-v',f'{self.data}/admin:/data:ro','-v',f'{self.data}/broker:/broker:ro']
                # Reuse Admin's SELinux category for read-only access rather
                # than disabling labels or relabelling a running data volume.
                label=self._run('podman','inspect','--format','{{.ProcessLabel}}',self.names['admin'])
                if label:
                    parts=label.split(':',3)
                    if len(parts)!=4 or not re.fullmatch(r's[0-9]+(?::c[0-9]+(?:,c[0-9]+)*)?',parts[3]):
                        raise ValueError('Unsupported SELinux process label')
                    arguments+=['--security-opt','label=level:'+parts[3]]
                arguments += [image,'node','src/update-health.js',str(schema),release['version']]
                result=json.loads(self._run(*arguments,timeout=60))
                if not all(result.get(name) is True for name in ('ok','admin','database','brokerTls','mqttMtls','wss','delivery','acl','invalidCredentialsRejected')):
                    raise ValueError('Functional health check failed')
                return
            except (RuntimeError,ValueError,subprocess.TimeoutExpired) as error:
                if attempt==4: raise RuntimeError('Gateway functional health check failed: '+str(error)) from None
                time.sleep(1)

    def restore(self,operation):
        import tempfile
        self.assert_quiescent()
        snapshot=self.snapshot_root/operation['snapshot']['id']
        work=self.state/'recovery'/operation['id']
        # Canonical unit output remains private until each complete managed unit
        # is atomically installed under this installation's actual unit names.
        canonical=work/'canonical-units'
        try: previous_security = self._state()
        except (sqlite3.DatabaseError,ValueError,TypeError): previous_security = {}
        snapshots.restore(snapshot,self.data,self.environment,canonical,work/'restore',self.assert_quiescent,operation['snapshot']['sha256'])
        # Never resurrect sessions/challenges that were invalidated after the
        # recovery point. Preserve replay counters for unchanged credentials.
        database=sqlite3.connect(self.data/'admin/gateway.sqlite')
        try:
            restored=json.loads(database.execute('SELECT value FROM state WHERE id=1').fetchone()[0])
            restored['sessions']={}; restored['challenges']={}
            for user in restored.get('users',[]):
                current=next((item for item in previous_security.get('users',[]) if item.get('id')==user.get('id')),None)
                if not current: continue
                for credential in user.get('credentials',[]):
                    other=next((item for item in current.get('credentials',[]) if item.get('id')==credential.get('id') and item.get('publicKey')==credential.get('publicKey')),None)
                    if other: credential['counter']=max(credential.get('counter',0),other.get('counter',0))
                old_totp,new_totp=user.get('totp'),current.get('totp')
                if old_totp and new_totp and {k:v for k,v in old_totp.items() if k!='lastStep'}=={k:v for k,v in new_totp.items() if k!='lastStep'}:
                    old_totp['lastStep']=max(old_totp.get('lastStep',-1),new_totp.get('lastStep',-1))
            database.execute('UPDATE state SET value=? WHERE id=1',(json.dumps(restored,separators=(',',':')),))
            observations=work/'restore/previous-runtime/admin/gateway.sqlite'
            if observations.is_file():
                source=None
                database.execute('SAVEPOINT observations')
                try:
                    source=sqlite3.connect(f'file:{observations.as_posix()}?mode=ro',uri=True)
                    for row in source.execute('SELECT id,at,actor,action,detail FROM audit ORDER BY id'):
                        old=database.execute('SELECT at,actor,action,detail FROM audit WHERE id=?',(row[0],)).fetchone()
                        if old is None: database.execute('INSERT INTO audit VALUES(?,?,?,?,?)',row)
                        elif tuple(row[1:])!=old and not database.execute('SELECT id FROM audit WHERE at=? AND actor=? AND action=? AND detail=?',row[1:]).fetchone():
                            database.execute('INSERT INTO audit(at,actor,action,detail) VALUES(?,?,?,?)',row[1:])
                    if source.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='traffic_history'").fetchone():
                        database.execute('CREATE TABLE IF NOT EXISTS traffic_history(timestamp INTEGER PRIMARY KEY, received INTEGER NOT NULL, sent INTEGER NOT NULL, dropped INTEGER NOT NULL, publicationFailures INTEGER NOT NULL)')
                        for row in source.execute('SELECT timestamp,received,sent,dropped,publicationFailures FROM traffic_history'):
                            database.execute('INSERT INTO traffic_history VALUES(?,?,?,?,?) ON CONFLICT(timestamp) DO UPDATE SET received=MAX(received,excluded.received),sent=MAX(sent,excluded.sent),dropped=MAX(dropped,excluded.dropped),publicationFailures=MAX(publicationFailures,excluded.publicationFailures)',row)
                except sqlite3.DatabaseError:
                    # A broken candidate database must not prevent restoration
                    # of the verified recovery point. Its files remain retained.
                    database.execute('ROLLBACK TO observations')
                finally:
                    if source: source.close()
                    database.execute('RELEASE observations')
            database.commit()
        finally: database.close()
        for name in ('admin','broker'):
            text=(canonical/f'mqtt-{name}.container').read_text()
            image=operation['previous']['images'][name]
            text=re.sub(r'^Image=.+$',lambda _:'Image='+image,text,flags=re.M)
            atomic_bytes(self.unit_files[name],text.encode())
        atomic_bytes(self.units/(self.names['network']+'.network'),(canonical/'mqtt-gateway.network').read_bytes())
        self._run('systemctl','--user','daemon-reload')
        atomic_json(self.state/'installed.json',operation['previous'])

    def _state(self):
        connection=sqlite3.connect(f'file:{(self.data/"admin/gateway.sqlite").as_posix()}?mode=ro',uri=True)
        try: return json.loads(connection.execute('SELECT value FROM state WHERE id=1').fetchone()[0])
        finally: connection.close()

    def persistent_fingerprint(self):
        hasher=hashlib.sha256()
        state=self._state()
        state.pop('sessions',None); state.pop('challenges',None)
        for user in state.get('users',[]):
            for credential in user.get('credentials',[]): credential.pop('counter',None)
            if user.get('totp'): user['totp'].pop('lastStep',None)
        hasher.update(json.dumps(state,sort_keys=True,separators=(',',':')).encode())
        hasher.update(str(self.schema()).encode())
        for folder in ('admin','broker','mosquitto'):
            for file in sorted((self.data/folder).rglob('*')):
                if file.is_file() and 'logs' not in file.relative_to(self.data).parts and file.name not in {'update-gate','update-gate.tmp','gateway.sqlite','gateway.sqlite-wal','gateway.sqlite-shm'}:
                    hasher.update(file.relative_to(self.data).as_posix().encode())
                    if folder=='mosquitto' and file.name=='mosquitto.db':hasher.update(mqtt_fingerprint(file).encode())
                    else:hasher.update(bytes.fromhex(snapshots.digest(file)))
        for file in (self.environment,*self.unit_files.values(),self.units/(self.names['network']+'.network')):
            hasher.update(bytes.fromhex(snapshots.digest(file)))
        return hasher.hexdigest()

    def commit(self,operation):
        record=self.state/'installed.json'
        if record.exists() and json.loads(record.read_text()).get('operationId')==operation['id']:
            return
        release=operation['release']
        atomic_json(record,{'version':release['version'],'schemaVersion':release['schema_version'],
                    'images':self.image_ids(),'operationId':operation['id'],
                    'persistentFingerprint':self.persistent_fingerprint()})

    def prune_snapshots(self):
        """Prune only completed operations, preserving current recovery points."""
        from .journal import Journal
        with Journal(self.state).lock():
            current=Journal(self.state).read()
            if current and current['state'] not in {'COMPLETED','ROLLED_BACK','FAILED'}:
                return
            keep=self._state().get('settings',{}).get('updateSnapshotRetention',5)
            if type(keep) is not int or not 2<=keep<=100: keep=5
            protected={self.installed().get('operationId')}
            if current:
                protected.add(current['id'])
                protected.add(current.get('snapshot',{}).get('id'))
            candidates=[]
            for point in self.snapshot_root.glob('*'):
                if point.is_symlink() or not point.is_dir() or not re.fullmatch(r'[a-f0-9-]{36}',point.name): continue
                history=self.state/'history'/(point.name+'.json')
                if not history.is_file(): continue
                operation=json.loads(history.read_text())
                if operation.get('state') not in {'COMPLETED','ROLLED_BACK','FAILED'}: continue
                candidates.append(point)
            candidates.sort(key=lambda point:point.stat().st_mtime,reverse=True)
            retained={point.name for point in candidates[:keep]}|protected
            for point in candidates:
                if point.name not in retained: shutil.rmtree(point)

    def export_snapshot(self, operation_id, destination, recipient):
        """Encrypt a verified recovery point to an explicitly selected GPG key."""
        import tarfile
        import tempfile
        from .journal import Journal
        if not re.fullmatch(r'[a-f0-9-]{36}',operation_id) or not re.fullmatch(r'[A-Fa-f0-9]{40}|[A-Fa-f0-9]{64}',recipient):
            raise ValueError('An operation UUID and full encryption-key fingerprint are required')
        destination=Path(destination).expanduser().absolute()
        if destination.exists(): raise ValueError('Encrypted backup destination already exists')
        destination.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
        with Journal(self.state).lock():
            operation=json.loads((self.state/'history'/(operation_id+'.json')).read_text())
            self.verify_snapshot(operation)
            snapshot=self.snapshot_root/operation['snapshot']['id']
            fd, temporary=tempfile.mkstemp(prefix='.encrypted-snapshot-',dir=destination.parent)
            try:
                with os.fdopen(fd,'wb') as output:
                    process=subprocess.Popen(['gpg','--batch','--yes','--trust-model','always','--encrypt','--recipient',recipient],stdin=subprocess.PIPE,stdout=output,stderr=subprocess.DEVNULL)
                    try:
                        with tarfile.open(fileobj=process.stdin,mode='w|gz') as archive:
                            archive.add(snapshot,arcname='snapshot',recursive=True)
                        process.stdin.close()
                        process.wait(timeout=120)
                        if process.returncode: raise ValueError('Encrypted snapshot export failed')
                    finally:
                        if process.poll() is None: process.kill(); process.wait()
                        if process.stderr: process.stderr.close()
                    output.flush();os.fsync(output.fileno())
                os.link(temporary,destination)
                snapshots.sync_directory(destination.parent)
            finally: Path(temporary).unlink(missing_ok=True)
