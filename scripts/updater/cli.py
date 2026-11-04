#!/usr/bin/env python3
"""Host-side updater commands; never requires a root Podman socket."""
import argparse
import base64
import json
import os
from pathlib import Path
import socket
import sys

if __package__ in (None,''):
    sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
    __package__='scripts.updater'
from .controller import Controller
from .host import Host, atomic_bytes
from .journal import atomic_json
from .service import Server
from scripts.gateway import ROOT,read_env


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command',choices=('enable','serve','status','recover','install','rollback','export-snapshot'))
    parser.add_argument('--config',type=Path,default=Path.home()/'.config/mqtt-trust-gateway/updater.json')
    parser.add_argument('--env',type=Path,default=ROOT/'gateway.env')
    parser.add_argument('--unit-dir',type=Path,default=Path.home()/'.config/containers/systemd')
    parser.add_argument('--state-dir',type=Path,default=Path.home()/'.local/share/mqtt-trust-gateway/updater')
    parser.add_argument('--instance-prefix', help='Optional isolated installation prefix')
    parser.add_argument('--version')
    parser.add_argument('--operation-id')
    parser.add_argument('--confirm')
    parser.add_argument('--file',type=Path)
    parser.add_argument('--recipient')
    args=parser.parse_args()
    if os.getuid()==0: raise ValueError('Run updater as the Gateway rootless user')
    if args.command=='enable':
        environment=args.env.resolve()
        values=read_env(environment)
        key=values.get('GATEWAY_UPDATE_PUBLIC_KEY_B64','')
        public=base64.b64decode(key,validate=True)
        if len(public)!=44 or public[:12]!=bytes.fromhex('302a300506032b6570032100'):
            raise ValueError('Configure the trusted Ed25519 release public key before enabling updates')
        config={'data':str(Path(values.get('DATA_DIR') or ROOT/'runtime').expanduser().resolve()),
                'environment':str(environment),'units':str(args.unit_dir.resolve()),'state':str(args.state_dir.resolve()),'publicKey':key}
        import re
        if args.instance_prefix:
            if not re.fullmatch(r'[a-zA-Z0-9_-]{1,48}',args.instance_prefix): raise ValueError('Invalid instance prefix')
            config['names']={name:args.instance_prefix+'-'+name for name in ('admin','broker','network')}
        for value in (str(args.config.resolve()),*(value for value in config.values() if isinstance(value,str))):
            if any(c in value for c in ('\n','\r','%','\"','\\')): raise ValueError('Unsupported updater configuration path')
        host=Host(config)
        installed=host.installed()
        host.preflight({})
        host.health(installed)
        from .journal import Journal
        service_name=(args.instance_prefix+'-updater' if args.instance_prefix else 'mqtt-gateway-updater')+'.service'
        service=Path.home()/'.config/systemd/user'/service_name
        originals={file:file.read_bytes() for file in host.unit_files.values()}
        stopping=False
        with Journal(host.state).lock():
            pending=Journal(host.state).read()
            if pending and pending['state'] not in {'COMPLETED','ROLLED_BACK','FAILED'}:
                raise ValueError('Recover the pending operation before enabling updater configuration')
            try:
                # Freeze the already-running API before mounting the persistent
                # bridge. This prevents losing an in-memory one-time key during
                # initial setup, which necessarily replaces the Admin container.
                host._run('podman','exec',host.names['admin'],'node','-e',
                    'require("node:fs").writeFileSync("/tmp/gateway-updater-enabling","",{mode:0o600})')
                host._run('podman','exec',host.names['admin'],'node','src/update-health.js','ready')
                host.maintenance(True)
                stopping=True
                host.stop()
                bridge=f'Volume={host.bridge}:/updater:ro,z\nEnvironment=GATEWAY_UPDATER_DIR=/updater\n'
                for file in host.unit_files.values():
                    text=file.read_text()
                    if 'GATEWAY_UPDATER_DIR=' not in text:
                        text=text.replace('[Container]\n','[Container]\n'+bridge,1)
                        atomic_bytes(file,text.encode())
                host._run('systemctl','--user','daemon-reload')
                host.start()
                host.health(installed)
                atomic_json(host.state/'installed.json',installed)
                atomic_json(args.config,config)
                executable=str(Path(__file__).resolve())
                unit='[Unit]\nDescription=MQTT Gateway rootless update controller\n[Service]\nType=simple\nUMask=0077\nExecStart=/usr/bin/python3 "'+executable+'" serve --config "'+str(args.config.resolve())+'"\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=180\n[Install]\nWantedBy=default.target\n'
                atomic_bytes(service,unit.encode())
                host.maintenance(False)
                host.health(installed)
            except Exception:
                # No images or application data were changed by enablement.
                # Restore its previous unit configuration before releasing it.
                try:
                    if stopping:
                        host.stop()
                        for file,payload in originals.items(): atomic_bytes(file,payload)
                    (host.bridge/'maintenance.json').unlink(missing_ok=True)
                    if stopping:
                        host._run('systemctl','--user','daemon-reload')
                        host.start()
                finally:
                    try: host._run('podman','exec',host.names['admin'],'node','-e','require("node:fs").rmSync("/tmp/gateway-updater-enabling",{force:true})')
                    except Exception: pass
                raise
        host._run('systemctl','--user','daemon-reload')
        host._run('systemctl','--user','enable',service_name)
        host._run('systemctl','--user','restart',service_name)
        print('Rootless updater enabled. Existing CA, devices and broker remain in place.')
        return
    config=json.loads(args.config.read_text())
    host=Host(config)
    controller=Controller(host.state,host)
    if args.command=='serve':
        with Server(config) as server: server.serve_forever(poll_interval=0.5)
    elif args.command=='export-snapshot':
        if not args.operation_id or not args.file or not args.recipient: raise ValueError('--operation-id, --file and --recipient are required')
        host.export_snapshot(args.operation_id,args.file,args.recipient)
        print('Verified snapshot exported with GPG encryption.')
    elif args.command=='recover':
        if args.operation_id:
            print(json.dumps(controller.retry_recovery(args.operation_id,args.confirm)))
        else:
            print(json.dumps(controller.recover()))
    elif args.command=='install':
        if not args.version: raise ValueError('--version is required')
        print(json.dumps(controller.install(args.version)))
    elif args.command=='rollback':
        if not args.operation_id or not args.confirm: raise ValueError('--operation-id and --confirm are required')
        print(json.dumps(controller.rollback(args.operation_id,args.confirm)))
    else:
        from .service import public_operation
        print(json.dumps({'installed':host.installed(),'operation':public_operation(controller.journal.read())}))


if __name__=='__main__':
    try: main()
    except Exception:
        print('Updater command failed. Inspect private operation state and the user service status.',file=sys.stderr)
        sys.exit(1)
