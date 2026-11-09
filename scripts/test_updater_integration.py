"""Opt-in real rootless integration, with exclusively synthetic temporary data.

RUN_GATEWAY_UPDATE_INTEGRATION=1 python3 -m unittest scripts.test_updater_integration
Only uniquely named temporary user units, containers, network and images are used.
"""
import base64
import hashlib
import json
import multiprocessing
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import uuid
from scripts.updater.host import Host,command,atomic_bytes
from scripts.updater import releases
from scripts.updater.controller import Controller

ROOT=Path(__file__).resolve().parents[1]


class FixtureHost(Host):
    """Air-gapped signed artifacts, preloaded as real Podman images for tests."""
    def __init__(self,config,artifacts):
        super().__init__(config)
        self.artifacts=artifacts
    def resolve(self,version):
        artifact=self.artifacts[version]
        raw=Path(artifact['manifest']).read_bytes()
        signature=Path(artifact['signature']).read_bytes()
        result=releases.verify(raw,signature,base64.b64decode(self.config['publicKey']),version)
        installed=self.installed()
        if releases.version_key(version)<=releases.version_key(installed['version']): raise ValueError('Release must advance')
        releases.compatible(result,installed['version'],self.schema(),'5.0.0')
        return result
    def image_reference(self,release,component):
        return self.artifacts[release['version']]['images'][component]
    def download(self,release):
        # Images are preloaded for offline testing; production always pulls the
        # official immutable references. Actual digests are still verified.
        for name in ('admin','broker'):
            self._run('podman','image','inspect',self.image_reference(release,name))
    def health(self,release):
        super().health(release)
        expected=(self.bridge/'maintenance.json').exists()
        script="""
          import net from 'node:net';
          const blocked=BLOCKED;
          for(const port of [8883,8443]) await new Promise((resolve,reject)=>{
            const socket=net.connect({host:'mqtt-broker',port});
            const timeout=setTimeout(()=>{socket.destroy();reject(new Error('Gate probe timed out'))},2000);
            socket.once('connect',()=>{clearTimeout(timeout);socket.destroy();blocked?reject(new Error('Maintenance listener was externally reachable')):resolve()});
            socket.once('error',error=>{clearTimeout(timeout);blocked&&error.code==='ECONNREFUSED'?resolve():reject(error)});
          });
          console.log('gate-ok');
        """.replace('BLOCKED','true' if expected else 'false')
        if self._run('podman','exec',self.names['admin'],'node','--input-type=module','-e',script)!='gate-ok':
            raise RuntimeError('Network maintenance gate failed')
    def activate(self,release):
        super().activate(release)
        if self.artifacts[release['version']].get('crash') and not (self.state/'crash-injected').exists():
            (self.state/'crash-injected').write_text('once')
            os._exit(86)  # Abrupt host process termination: no finally/cleanup.


def serve_fixture(config, artifacts):
    from scripts.updater.service import Server
    with Server(config, backend=FixtureHost(config, artifacts)) as server:
        server.serve_forever(poll_interval=0.1)


def socket_request(path, method, route, body=None):
    import http.client
    connection = http.client.HTTPConnection('localhost', timeout=10)
    connection.sock = socket.socket(socket.AF_UNIX)
    connection.sock.settimeout(10)
    try:
        connection.sock.connect(str(path))
        connection.request(method, route, json.dumps(body) if body is not None else None, {'Content-Type':'application/json'})
        response = connection.getresponse()
        return response.status, json.loads(response.read())
    finally:
        connection.close()


def interrupted_install(config,artifacts,version):
    Controller(config['state'],FixtureHost(config,artifacts)).install(version)


@unittest.skipUnless(os.environ.get('RUN_GATEWAY_UPDATE_INTEGRATION')=='1','requires explicit isolated rootless integration opt-in')
class RealUpdateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.getuid()==0: raise unittest.SkipTest('requires rootless user')
        command('systemctl','--user','show-environment')
        cls.temporary=tempfile.TemporaryDirectory(prefix='gateway-update-integration-')
        cls.root=Path(cls.temporary.name)
        cls.data=cls.root/'runtime'
        cls.state=cls.root/'updater'
        cls.prefix='mqtt-update-it-'+uuid.uuid4().hex[:8]
        cls.names={'admin':cls.prefix+'-admin','broker':cls.prefix+'-broker','network':cls.prefix+'-network'}
        cls.units=Path.home()/'.config/containers/systemd'
        cls.created_units=[]
        cls.created_images=[]
        cls.config={}
        cls.artifacts={}
        try:
            for name in ('admin','broker','mosquitto'):(cls.data/name).mkdir(mode=0o700,parents=True)
            cls.state.mkdir(mode=0o700)
            (cls.state/'bridge').mkdir(mode=0o700)
            cls.key=cls.root/'release-private.pem'
            command('openssl','genpkey','-algorithm','ED25519','-out',cls.key)
            cls.key.chmod(0o600)
            public=command('openssl','pkey','-in',cls.key,'-pubout','-outform','PEM')
            # Binary DER is deliberately handled without decoding/logging.
            der=subprocess.check_output(['openssl','pkey','-in',str(cls.key),'-pubout','-outform','DER'])
            cls.environment=cls.root/'gateway.env'
            cls.environment.write_text('DATA_DIR='+str(cls.data)+'\nADMIN_APP_PORT=8080\nPUBLIC_URL=http://localhost:8080\nMQTT_HOST=mqtt-broker\nCA_COMMON_NAME=Integration Test CA\nGATEWAY_UPDATE_PUBLIC_KEY_B64='+base64.b64encode(der).decode()+'\n')
            cls.environment.chmod(0o600)
            cls.config={'data':str(cls.data),'state':str(cls.state),'environment':str(cls.environment),'units':str(cls.units),'publicKey':base64.b64encode(der).decode(),'names':cls.names}
            cls.base_admin='localhost/mqtt-update-test-admin:base'
            cls.base_broker='localhost/mqtt-update-test-broker:base'
            cls.source_admin,cls.source_broker=cls.base_admin,cls.base_broker
            cls.source_version=command('podman','run','--rm','--network=none','--entrypoint','node',cls.source_admin,'-p','JSON.parse(require("fs").readFileSync("package.json")).version')
            cls.target_version=cls.source_version if cls.source_version!='1.0.2' else '1.1.0'
            if cls.source_version!='1.0.2':
                baseline=cls.root/'baseline';baseline.mkdir()
                (baseline/'Containerfile').write_text('FROM '+cls.source_admin+'\nUSER root\nRUN node -e "const f=require(\'fs\');const p=JSON.parse(f.readFileSync(\'package.json\'));p.version=\'1.0.2\';f.writeFileSync(\'package.json\',JSON.stringify(p))"\nUSER node\nLABEL org.opencontainers.image.version=1.0.2\n')
                cls.base_admin='localhost/'+cls.prefix+'-baseline-admin:base'
                command('podman','build','-t',cls.base_admin,baseline,timeout=300)
                cls.created_images.append(cls.base_admin)
                (baseline/'Containerfile').write_text('FROM '+cls.source_broker+'\nLABEL org.opencontainers.image.version=1.0.2\n')
                cls.base_broker='localhost/'+cls.prefix+'-baseline-broker:base'
                command('podman','build','-t',cls.base_broker,baseline,timeout=300)
                cls.created_images.append(cls.base_broker)

            cls._prepare()
            cls._units(cls.base_admin,cls.base_broker)
            command('systemctl','--user','daemon-reload')
            command('systemctl','--user','start',cls.names['broker']+'.service',cls.names['admin']+'.service')
            cls.host=FixtureHost(cls.config,cls.artifacts)
            try:
                cls.host.health({'version':'1.0.2','schemaVersion':1})
            except Exception:
                # This integration fixture contains only generated identities
                # and synthetic data. Surface broker startup diagnostics so
                # CI runner differences are actionable without dumping the
                # gateway environment or credential files.
                for name in ('broker','admin'):
                    unit=cls.names[name]+'.service'
                    state=subprocess.run(['systemctl','--user','show',unit,
                        '--property=LoadState,ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,FragmentPath,ExecStart',
                        '--no-pager'],capture_output=True,text=True)
                    if state.stdout.strip(): print('Synthetic '+name+' unit state: '+state.stdout.strip().replace('\n',' | '))
                    journal=subprocess.run(['journalctl','--user','--unit',unit,'--no-pager','--output=cat','--lines=30'],capture_output=True,text=True)
                    journal_lines=(journal.stdout+'\n'+journal.stderr).splitlines()
                    relevant=[line for line in journal_lines if any(token in line.lower() for token in ('error','failed','denied','cannot','unable','not found'))]
                    if relevant: print('Synthetic '+name+' unit diagnostics: '+' | '.join(relevant[-12:]))
                    result=subprocess.run(['podman','logs','--tail','40',cls.names[name]],capture_output=True,text=True)
                    lines=(result.stdout+'\n'+result.stderr).splitlines()
                    relevant=[line for line in lines if any(token in line.lower() for token in ('error','failed','denied','cannot','unable'))]
                    if relevant: print('Synthetic '+name+' startup diagnostics: '+' | '.join(relevant[-12:]))
                raise
            cls.mqtt_fixture('retain-write','retained-state')
            from scripts.updater.journal import atomic_json
            atomic_json(cls.state/'installed.json',cls.host.installed())
        except BaseException:
            cls.tearDownClass()
            raise

    @classmethod
    def _prepare(cls):
        seed="""
          import { prepareGateway } from './src/services/certificate-service.js';
          import { loadDb,saveDb } from './src/db.js';
          import argon2 from 'argon2';
          await prepareGateway();
          const db=loadDb();
          db.users.push({id:'integration-admin',username:'integration-admin',passwordHash:await argon2.hash('synthetic-integration-password'),credentials:[]});
          db.devices.push({id:'synthetic-device',name:'Synthetic device',enabled:false,trusted:false,status:'active'});
          saveDb(db);
        """
        command('podman','run','--rm','--network=none','--userns=keep-id','--user',f'{os.getuid()}:{os.getgid()}',
                '--env-file',cls.environment,'-v',f'{cls.data}/admin:/data:rw,Z','-v',f'{cls.data}/broker:/broker:rw,z',
                cls.base_admin,'node','--input-type=module','-e',seed)

    @classmethod
    def _units(cls,admin,broker):
        files={cls.names['network']+'.network':'[Network]\nNetworkName='+cls.names['network']+'\n',}
        for name,image in (('admin',admin),('broker',broker)):
            text='# Managed by MQTT Trust Gateway\n[Unit]\nDescription=Isolated updater integration '+name+'\n'
            if name=='admin':text+='After='+cls.names['broker']+'.service\nWants='+cls.names['broker']+'.service\n'
            text+='[Container]\nImage='+image+'\nContainerName='+cls.names[name]+'\nNetwork='+cls.names['network']+'.network\nNetworkAlias='+('mqtt-broker' if name=='broker' else 'mqtt-admin')+'\nUserNS=keep-id\nUser='+str(os.getuid())+':'+str(os.getgid())+'\nDropCapability=all\nNoNewPrivileges=true\nReadOnly=true\nTmpfs=/tmp:rw,noexec,nosuid,size=32m\nEnvironmentFile='+str(cls.environment)+'\n'
            if name=='admin': text+='Volume='+str(cls.data)+'/admin:/data:rw,Z\nVolume='+str(cls.data)+'/broker:/broker:rw,z\nVolume='+str(cls.state)+'/bridge:/updater:ro,z\nEnvironment=GATEWAY_UPDATER_DIR=/updater\n'
            else: text+='Environment=GATEWAY_UPDATER_DIR=/updater\nVolume='+str(cls.state)+'/bridge:/updater:ro,z\nPodmanArgs=--image-volume=ignore\nVolume='+str(cls.data)+'/broker:/broker:rw,z\nVolume='+str(cls.data)+'/mosquitto:/mosquitto/data:rw,Z\n'
            text+='[Service]\nTimeoutStartSec=120\n'
            files[cls.names[name]+'.container']=text
        for name,text in files.items():
            file=cls.units/name
            if file.exists():raise RuntimeError('Refusing to overwrite an existing integration unit')
            atomic_bytes(file,text.encode())
            cls.created_units.append(file)

    @classmethod
    def artifact(cls,version,health_failure=False,migration_failure=False,crash=False):
        directory=cls.root/('build-'+version)
        directory.mkdir()
        admin='localhost/'+cls.prefix+'-admin:'+version
        broker='localhost/'+cls.prefix+'-broker:'+version
        containerfile='FROM '+cls.base_admin+'\nUSER root\nRUN node -e "const f=require(\'fs\');const p=JSON.parse(f.readFileSync(\'package.json\'));p.version=\''+version+'\';f.writeFileSync(\'package.json\',JSON.stringify(p))"\n'
        if health_failure:containerfile+="RUN echo 'process.exit(9);' > src/update-health.js\n"
        if migration_failure:containerfile+="RUN echo 'throw new Error(\"injected migration failure\");' > src/update-migrate.js\n"
        containerfile+='USER node\nLABEL org.opencontainers.image.version='+version+'\n'
        (directory/'Containerfile').write_text(containerfile)
        command('podman','build','-t',admin,'-f',directory/'Containerfile',directory,timeout=300)
        (directory/'Brokerfile').write_text('FROM '+cls.base_broker+'\nLABEL org.opencontainers.image.version='+version+'\n')
        command('podman','build','-t',broker,'-f',directory/'Brokerfile',directory,timeout=300)
        cls.created_images.extend([admin,broker])
        if version==cls.source_version and not health_failure and not migration_failure:
            admin,broker=cls.source_admin,cls.source_broker
        images={}
        for name,image in (('admin',admin),('broker',broker)):
            digest=command('podman','image','inspect','--format','{{.Digest}}',image)
            images[name]={'reference':'ghcr.io/marciobulla/mqtt-trust-'+name+'@'+digest}
        manifest={'version':version,'channel':'beta' if releases.VERSION.fullmatch(version).group(4) else 'stable','schema_version':1,'images':images,
                  'compatibility':{'min_gateway_version':'1.0.2','min_podman_version':'5.0.0'},
                  'migrations':{'from':0,'to':1,'requires_snapshot':True},
                  'health_checks':dict.fromkeys(('admin','database','broker_tls','mqtt_mtls'),True)}
        raw=directory/'update-manifest.json'
        raw.write_text(json.dumps(manifest,separators=(',',':')))
        signature=subprocess.check_output(['openssl','pkeyutl','-sign','-inkey',str(cls.key),'-rawin','-in',str(raw)])
        (directory/'update-manifest.sig').write_bytes(base64.b64encode(signature))
        cls.artifacts[version]={'manifest':str(raw),'signature':str(directory/'update-manifest.sig'),'images':{'admin':admin,'broker':broker},'crash':crash}
        return manifest

    @classmethod
    def mqtt_fixture(cls,action,payload):
        script = """
          import mqtt from 'mqtt'; import fs from 'node:fs';
          const action=ACTION, expected=PAYLOAD;
          const retained='gateway:update:health/retained-fixture';
          const offline='gateway:update:health/offline-fixture';
          const options={ca:fs.readFileSync('/data/ca/ca.crt'),cert:fs.readFileSync('/data/update-health-client.crt'),key:fs.readFileSync('/data/update-health-client.key'),rejectUnauthorized:true,reconnectPeriod:0,protocolVersion:5,clean:true};
          const timeout=setTimeout(()=>process.exit(2),5000);
          const finish=(client,value)=>client.end(false,()=>{clearTimeout(timeout);console.log(JSON.stringify(value));});
          const client=mqtt.connect('mqtts://mqtt-broker:8883',{...options,...(action==='queue-prepare'||action==='queue-read'?{clientId:'isolated-update-persistent',clean:false,properties:{sessionExpiryInterval:3600}}:{})});
          client.on('error',()=>process.exit(3));
          let resumed=false;
          client.on('message',(topic,body,packet)=>{
            if(action==='retain-read'&&topic===retained&&body.toString()===expected&&packet.retain)finish(client,{ok:true});
            if(action==='queue-read'&&topic===offline&&body.toString()===expected&&resumed)finish(client,{ok:true,sessionPresent:true});
          });
          client.on('connect',packet=>{
            resumed=packet.sessionPresent;
            if(action==='retain-write'||action==='queue-write')client.publish(action==='retain-write'?retained:offline,expected,{qos:1,retain:action==='retain-write'},error=>error?process.exit(4):finish(client,{ok:true}));
            else if(action==='queue-prepare')client.subscribe(offline,{qos:1},error=>error?process.exit(5):finish(client,{ok:true}));
            else if(action==='retain-read')client.subscribe(retained,{qos:1},error=>{if(error)process.exit(6)});
          });
        """.replace('ACTION',json.dumps(action)).replace('PAYLOAD',json.dumps(payload))
        result=json.loads(command('podman','exec',cls.names['admin'],'node','--input-type=module','-e',script,timeout=15))
        if result.get('ok') is not True:raise RuntimeError('Synthetic MQTT fixture failed')
        return result

    @classmethod
    def tearDownClass(cls):
        if getattr(cls,'names',None):
            subprocess.run(['systemctl','--user','stop',cls.names['admin']+'.service',cls.names['broker']+'.service'],capture_output=True)
        if getattr(cls,'updater_service',None):
            subprocess.run(['systemctl','--user','disable','--now',cls.updater_service.name],capture_output=True)
            cls.updater_service.unlink(missing_ok=True)
        for file in getattr(cls,'created_units',[]):file.unlink(missing_ok=True)
        subprocess.run(['systemctl','--user','daemon-reload'],capture_output=True)
        if getattr(cls,'names',None):
            subprocess.run(['podman','network','rm',cls.names['network']],capture_output=True)
        for image in getattr(cls,'created_images',[]):subprocess.run(['podman','image','rm',image],capture_output=True)
        if getattr(cls,'temporary',None):cls.temporary.cleanup()

    def test_real_updates_and_recovery(self):
        target=self.target_version
        major,minor,_=releases.version_key(target)[:3]
        failed_health=f'{major}.{minor+1}.0'
        failed_migration=f'{major}.{minor+2}.0'
        interrupted=f'{major}.{minor+3}.0'
        ca_before=hashlib.sha256((self.data/'admin/ca/ca.key').read_bytes()).hexdigest()
        controller=Controller(self.state,self.host)
        candidate=self.artifact(target)
        self.host.resolve(target)
        self.host.verify_images(candidate)
        self.host.preflight(candidate)
        self.mqtt_fixture('queue-prepare','')
        self.mqtt_fixture('queue-write','queued-before-'+target)
        daemon=multiprocessing.get_context('spawn').Process(target=serve_fixture,args=(self.config,self.artifacts))
        daemon.start()
        try:
            endpoint=self.state/'bridge/control.sock'
            deadline=time.monotonic()+120
            while not endpoint.exists() and time.monotonic()<deadline: time.sleep(0.1)
            self.assertTrue(endpoint.exists())
            self.assertEqual(socket_request(endpoint,'POST','/install',{'version':target,'command':'not-allowed'})[0],400)
            self.assertEqual(socket_request(endpoint,'POST','/install',{'version':target})[0],202)
            self.assertEqual(socket_request(endpoint,'POST','/install',{'version':target})[0],409)
            while time.monotonic()<deadline:
                _, status=socket_request(endpoint,'GET','/status')
                successful=status['operation']
                if successful and successful['state'] in {'COMPLETED','FAILED','ROLLED_BACK','RECOVERY_REQUIRED'}: break
                time.sleep(0.25)
            self.assertEqual(successful['state'],'COMPLETED', 'Controller stage: '+str(successful.get('errorCode'))+' / '+str(successful.get('failedStage')))
            self.assertTrue(daemon.is_alive(), 'Host updater survives Admin replacement')
            bridge_check="import http from 'node:http';http.get({socketPath:'/updater/control.sock',path:'/status'},r=>{if(r.statusCode!==200)process.exit(1);r.resume()}).on('error',()=>process.exit(2));"
            command('podman','exec',self.names['admin'],'node','--input-type=module','-e',bridge_check)
        finally:
            daemon.terminate(); daemon.join(timeout=10)

        manual=controller.rollback(successful['id'],'ROLLBACK 1.0.2')
        self.assertEqual(manual['state'],'COMPLETED')
        self.assertEqual(self.host.installed()['version'],'1.0.2')
        self.mqtt_fixture('retain-read','retained-state')
        successful=controller.install(target)
        self.assertEqual(successful['state'],'COMPLETED', 'Controller stage: '+str(successful.get('errorCode'))+' / '+str(successful.get('failedStage')))
        self.host.health({'version':target,'schemaVersion':1})
        self.mqtt_fixture('retain-read','retained-state')
        self.assertTrue(self.mqtt_fixture('queue-read','queued-before-'+target)['sessionPresent'])
        import sqlite3
        with sqlite3.connect(self.data/'admin/gateway.sqlite') as database:
            database.execute('BEGIN IMMEDIATE')
            state=json.loads(database.execute('SELECT value FROM state WHERE id=1').fetchone()[0])
            state['devices'].append({'id':'created-after-commit','name':'Synthetic new identity','status':'active','enabled':False,'trusted':False})
            database.execute('UPDATE state SET value=? WHERE id=1',(json.dumps(state),))
        with self.assertRaises(ValueError):controller.rollback(successful['id'],'ROLLBACK 1.0.2')

        for version,options in [(failed_health,{'health_failure':True}),(failed_migration,{'migration_failure':True})]:
            self.artifact(version,**options)
            self.mqtt_fixture('queue-prepare','')
            self.mqtt_fixture('queue-write','queued-before-'+version)
            result=controller.install(version)
            self.assertEqual(result['state'],'ROLLED_BACK')
            self.assertEqual(self.host.installed()['version'],target)
            self.assertTrue(any(device['id']=='created-after-commit' for device in self.host._state()['devices']))
            self.mqtt_fixture('retain-read','retained-state')
            self.assertTrue(self.mqtt_fixture('queue-read','queued-before-'+version)['sessionPresent'])
            self.assertEqual(hashlib.sha256((self.data/'admin/ca/ca.key').read_bytes()).hexdigest(),ca_before)
        self.artifact(interrupted,crash=True)
        process=multiprocessing.get_context('spawn').Process(target=interrupted_install,args=(self.config,self.artifacts,interrupted))
        process.start(); process.join(timeout=120)
        if process.is_alive(): process.terminate(); process.join(); self.fail('Isolated controller did not reach interruption boundary')
        self.assertEqual(process.exitcode,86)
        recovered=Controller(self.state,FixtureHost(self.config,self.artifacts)).recover()
        self.assertEqual(recovered['state'],'ROLLED_BACK')
        self.assertEqual(hashlib.sha256((self.data/'admin/ca/ca.key').read_bytes()).hexdigest(),ca_before)
        self.host.health({'version':target,'schemaVersion':1})

        # Bootstrap and run the actual independently installed systemd updater.
        self.__class__.updater_service=Path.home()/'.config/systemd/user'/(self.prefix+'-updater.service')
        command('python3',ROOT/'scripts/updater/cli.py','enable','--env',self.environment,'--unit-dir',self.units,'--state-dir',self.state,'--config',self.root/'updater.json','--instance-prefix',self.prefix,timeout=180)
        self.assertEqual(command('systemctl','--user','is-active',self.updater_service.name),'active')
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            try:
                code,status=socket_request(self.state/'bridge/control.sock','GET','/status')
                if code==200:break
            except (OSError,ValueError):pass
            time.sleep(0.2)
        self.assertTrue(status['available'])
        self.assertEqual(status['installed']['version'],target)
        self.host.health({'version':target,'schemaVersion':1})
