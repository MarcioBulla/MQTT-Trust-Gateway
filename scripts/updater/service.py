"""Same-UID Unix socket interface; no arbitrary command/path/image interface."""
import json
import os
from pathlib import Path
import socket
import socketserver
import struct
import threading
from http.server import BaseHTTPRequestHandler
from .controller import Controller
from .host import Host


def public_operation(operation):
    if not operation: return None
    return {key:operation.get(key) for key in ('id','state','version','kind','startedAt','updatedAt','committed','errorCode','failedStage','events')} | {
        'previousVersion':operation.get('previous',{}).get('version'),
        'snapshotAvailable':bool(operation.get('snapshot')),
    }


class Server(socketserver.ThreadingMixIn,socketserver.UnixStreamServer):
    daemon_threads=True
    allow_reuse_address=False
    request_queue_size=16
    request_slots=threading.BoundedSemaphore(8)

    def process_request(self, request, client_address):
        request.settimeout(10)
        if not self.request_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try: super().process_request(request, client_address)
        except BaseException:
            self.request_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try: super().process_request_thread(request, client_address)
        finally: self.request_slots.release()

    def __init__(self,config,backend=None):
        self.host=backend or Host(config)
        self.controller=Controller(self.host.state,self.host)
        self.gate=threading.Lock()
        self.last_request_error=None
        self.podman_version=json.loads(self.host._run('podman','version','--format','json'))['Client']['Version']
        # Recovery completes (or enters RECOVERY_REQUIRED) before accepting any
        # new operation. An Admin container restart cannot terminate this host.
        self.controller.recover()
        self.path=self.host.bridge/'control.sock'
        if self.path.exists():
            with socket.socket(socket.AF_UNIX) as probe:
                try: probe.connect(str(self.path))
                except ConnectionRefusedError: self.path.unlink()
                else: raise RuntimeError('Another updater is listening')
        super().__init__(str(self.path),Handler)
        self.path.chmod(0o600)

    def verify_request(self,request,_address):
        _pid,uid,_gid=struct.unpack('3i',request.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
        return uid==os.getuid()

    def history(self, offset=0):
        files=sorted((self.host.state/'history').glob('*.json'), key=lambda p:p.stat().st_mtime, reverse=True)
        items=[public_operation(json.loads(file.read_text())) for file in files[offset:offset+50]]
        return {'items':items, 'nextOffset':offset+50 if len(files)>offset+50 else None}

    def status(self):
        installed=self.host.installed()
        operation=self.controller.journal.read()
        history=[]
        for file in sorted((self.host.state/'history').glob('*.json'),key=lambda p:p.stat().st_mtime,reverse=True)[:50]:
            history.append(public_operation(json.loads(file.read_text())))
        can_rollback=False
        if operation and operation.get('state')=='COMPLETED' and operation.get('snapshot') and installed.get('operationId')==operation['id']:
            point=self.host.snapshot_root/operation['snapshot']['id']
            try: can_rollback=(point/'state.tar.gz').is_file() and (point/'snapshot.json').is_file() and installed.get('persistentFingerprint')==self.host.persistent_fingerprint()
            except Exception: can_rollback=False
        return {'available':True,'podmanVersion':self.podman_version,'installed':{'version':installed['version'],'schemaVersion':installed['schemaVersion']},
                'operation':public_operation(operation),'history':history,'canRollback':can_rollback,
                'maintenance':(self.host.bridge/'maintenance.json').exists(),'lastRequestError':self.last_request_error}


class Handler(BaseHTTPRequestHandler):
    def log_message(self,*_): pass
    def reply(self,status,value):
        payload=json.dumps(value,separators=(',',':')).encode()
        self.send_response(status)
        self.send_header('Content-Type','application/json')
        self.send_header('Cache-Control','no-store')
        self.send_header('Content-Length',str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path.startswith('/history?offset='):
            import re
            if not re.fullmatch(r'/history\?offset=[0-9]{1,7}', self.path): return self.reply(400, {'error':'Invalid history offset'})
            return self.reply(200, self.server.history(int(self.path.split('=')[1])))
        if self.path!='/status': return self.reply(404,{'error':'Unknown updater operation'})
        try: self.reply(200,self.server.status())
        except Exception: self.reply(503,{'error':'Updater status requires recovery'})

    def do_POST(self):
        if self.path not in ('/install','/rollback'):
            return self.reply(404,{'error':'Unknown updater operation'})
        try:
            length=int(self.headers.get('Content-Length','0'))
            if not 0<length<=2048: raise ValueError()
            body=json.loads(self.rfile.read(length))
            if not isinstance(body,dict): raise ValueError()
            if self.path=='/install':
                if set(body)!={'version'}: raise ValueError()
                from .releases import version_key
                version_key(body['version'])
                action=lambda:self.server.controller.install(body['version'])
            else:
                if set(body)!={'operationId','confirmation'}: raise ValueError()
                import re
                if not isinstance(body['operationId'],str) or not re.fullmatch(r'[a-f0-9-]{36}',body['operationId']): raise ValueError()
                if not isinstance(body['confirmation'],str) or len(body['confirmation'])>100: raise ValueError()
                status=self.server.status()
                if not status['canRollback'] or status['operation']['id']!=body['operationId']:
                    return self.reply(409,{'error':'Rollback is unsafe because recovery state is unavailable or persistent data changed'})
                source=json.loads((self.server.host.state/'history'/(body['operationId']+'.json')).read_text())
                if body['confirmation']!='ROLLBACK '+source['previous']['version']: raise ValueError()
                action=lambda:self.server.controller.rollback(body['operationId'],body['confirmation'])
        except (ValueError,KeyError,TypeError):
            return self.reply(400,{'error':'Invalid updater request'})
        if not self.server.gate.acquire(blocking=False):
            return self.reply(409,{'error':'Another update or recovery is running'})
        existing=self.server.controller.journal.read()
        if existing and existing['state'] not in ('COMPLETED','ROLLED_BACK','FAILED'):
            self.server.gate.release()
            return self.reply(409,{'error':'Interrupted update requires recovery before another operation'})
        def run():
            try: action()
            except Exception:
                from .journal import timestamp
                self.server.last_request_error={'code':'REQUEST_REJECTED','at':timestamp()}
            finally:
                try: self.server.host.prune_snapshots()
                except Exception: pass  # Retain backups if cleanup cannot be verified.
                self.server.gate.release()
        self.server.last_request_error=None
        threading.Thread(target=run,name='gateway-update',daemon=False).start()
        self.reply(202,{'accepted':True})
