"""Release artifacts must be signed by the separately pinned production identity."""
import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from scripts.updater.releases import verify


class ManifestPublishingTests(unittest.TestCase):
    def test_production_key_binding_test_marker_and_tamper_rejection(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            key=root/'private'
            subprocess.run(['openssl','genpkey','-algorithm','ED25519','-out',str(key)],check=True,capture_output=True)
            public=subprocess.check_output(['openssl','pkey','-in',str(key),'-pubout','-outform','DER'])
            args=['python3','-m','scripts.release_manifest','--version','1.1.0','--admin','ghcr.io/marciobulla/mqtt-trust-admin@sha256:'+'a'*64,'--broker','ghcr.io/marciobulla/mqtt-trust-broker@sha256:'+'b'*64,'--output',str(root/'official')]
            env={**os.environ,'GATEWAY_RELEASE_PRIVATE_KEY':key.read_text(),'GATEWAY_RELEASE_PUBLIC_KEY_B64':base64.b64encode(public).decode()}
            success=subprocess.run(args,env=env,capture_output=True)
            self.assertEqual(success.returncode,0,success.stderr.decode())
            manifest=(root/'official/update-manifest.json').read_bytes()
            signature=(root/'official/update-manifest.sig').read_bytes()
            self.assertEqual(verify(manifest,signature,public,'1.1.0')['version'],'1.1.0')
            self.assertFalse((root/'official/TEST-ONLY-NOT-INSTALLABLE').exists())
            with self.assertRaises(ValueError):verify(manifest+b' ',signature,public,'1.1.0')
            failure=subprocess.run(args,env={**env,'GATEWAY_RELEASE_PUBLIC_KEY_B64':base64.b64encode(b'wrong').decode()},capture_output=True)
            self.assertNotEqual(failure.returncode,0)
            self.assertNotIn(key.read_bytes(),failure.stdout+failure.stderr)
            testargs=args[:-1]+[str(root/'test'),'--ephemeral-test-key']
            self.assertEqual(subprocess.run(testargs,capture_output=True).returncode,0)
            self.assertTrue((root/'test/TEST-ONLY-NOT-INSTALLABLE').is_file())
