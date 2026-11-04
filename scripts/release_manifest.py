#!/usr/bin/env python3
"""Create an Ed25519-signed release manifest; never print a private key."""
import argparse
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
from scripts.updater.releases import verify,version_key


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version',required=True)
    parser.add_argument('--admin',required=True)
    parser.add_argument('--broker',required=True)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--ephemeral-test-key',action='store_true')
    args=parser.parse_args()
    version_key(args.version)
    args.output.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='gateway-signing-') as directory:
        root=Path(directory)
        key=root/'private.pem'
        if args.ephemeral_test_key:
            subprocess.run(['openssl','genpkey','-algorithm','ED25519','-out',str(key)],check=True,capture_output=True)
        else:
            value=os.environ.get('GATEWAY_RELEASE_PRIVATE_KEY','')
            if not value: raise ValueError('Release signing secret is not configured')
            key.write_text(value)
        key.chmod(0o600)
        public=subprocess.check_output(['openssl','pkey','-in',str(key),'-pubout','-outform','DER'],stderr=subprocess.PIPE)
        if not args.ephemeral_test_key and base64.b64decode(os.environ.get('GATEWAY_RELEASE_PUBLIC_KEY_B64',''),validate=True)!=public:
            raise ValueError('Signing key does not match the separately configured trust key')
        manifest={'format_version':1,'version':args.version,'channel':'beta' if '-' in args.version.split('+')[0] else 'stable',
            'schema_version':1,'images':{'admin':{'reference':args.admin},'broker':{'reference':args.broker}},
            'compatibility':{'min_gateway_version':'1.0.2','min_podman_version':'5.0.0'},
            'migrations':{'from':0,'to':1,'requires_snapshot':True},
            'health_checks':dict.fromkeys(('admin','database','broker_tls','mqtt_mtls'),True)}
        payload=json.dumps(manifest,sort_keys=True,separators=(',',':')).encode()+b'\n'
        raw=root/'manifest.json';raw.write_bytes(payload)
        signature=subprocess.check_output(['openssl','pkeyutl','-sign','-inkey',str(key),'-rawin','-in',str(raw)],stderr=subprocess.PIPE)
        encoded=base64.b64encode(signature)+b'\n'
        verify(payload,encoded,public,args.version)
        (args.output/'update-manifest.json').write_bytes(payload)
        (args.output/'update-manifest.sig').write_bytes(encoded)
        (args.output/'update-public-key.der').write_bytes(public)
        if args.ephemeral_test_key:(args.output/'TEST-ONLY-NOT-INSTALLABLE').write_text('Ephemeral test trust key. Never publish as an official installable release.\n')
    print('Release manifest generated and signature verified.')


if __name__=='__main__':
    try:main()
    except Exception:
        raise SystemExit('Release manifest generation failed; no signing secret was logged.')
