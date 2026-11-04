"""Recovery-storage tests use only temporary files and a disposable GPG keyring."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest
import uuid
from unittest.mock import patch
from scripts.updater.host import Host
from scripts.updater.journal import Journal, atomic_json


class StorageTests(unittest.TestCase):
    def host(self, root):
        host=Host.__new__(Host)
        host.state=root/'state';host.state.mkdir()
        host.snapshot_root=host.state/'snapshots';host.snapshot_root.mkdir()
        host._state=lambda:{'settings':{'updateSnapshotRetention':2}}
        host.installed=lambda:{'operationId':None}
        return host

    def snapshot(self, host, sequence, state='COMPLETED'):
        identifier=str(uuid.uuid4())
        point=host.snapshot_root/identifier;point.mkdir()
        (point/'state.tar.gz').write_bytes(b'synthetic-private-recovery-point')
        (point/'snapshot.json').write_text('{}')
        os.utime(point,(sequence,sequence))
        operation={'id':identifier,'state':state,'snapshot':{'id':identifier,'sha256':'test'}}
        atomic_json(host.state/'history'/(identifier+'.json'),operation)
        return operation,point

    def test_retention_protects_installed_pending_unknown_and_symlinked_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);host=self.host(root)
            old,oldpoint=self.snapshot(host,1)
            pending,pendingpoint=self.snapshot(host,2,'RECOVERY_REQUIRED')
            removed,removedpoint=self.snapshot(host,3)
            for n in (4,5):self.snapshot(host,n)
            host.installed=lambda:{'operationId':old['id']}
            unknown=host.snapshot_root/str(uuid.uuid4());unknown.mkdir()
            outside=root/'outside';outside.mkdir()
            link=host.snapshot_root/str(uuid.uuid4());link.symlink_to(outside,target_is_directory=True)
            host.prune_snapshots()
            self.assertTrue(oldpoint.exists());self.assertTrue(pendingpoint.exists())
            self.assertFalse(removedpoint.exists());self.assertTrue(unknown.exists())
            self.assertTrue(link.is_symlink());self.assertTrue(outside.exists())
            # Pending current recovery stops all pruning, including old completed snapshots.
            Journal(host.state).write(pending)
            extra,extrapoint=self.snapshot(host,0)
            host.prune_snapshots();self.assertTrue(extrapoint.exists())

    @unittest.skipUnless(shutil.which('gpg'),'optional GPG encrypted export requires GnuPG')
    def test_encrypted_export_decrypts_only_with_private_key_and_never_overwrites(self):
        with tempfile.TemporaryDirectory() as temporary:
            root=Path(temporary);host=self.host(root)
            operation,point=self.snapshot(host,1)
            verified=[]
            host.verify_snapshot=lambda op:verified.append(op['id'])
            home=root/'gnupg';home.mkdir(mode=0o700)
            with patch.dict(os.environ,{'GNUPGHOME':str(home)}):
                subprocess.run(['gpg','--batch','--pinentry-mode','loopback','--passphrase','','--quick-generate-key','Snapshot test <snapshot@example.invalid>','ed25519','cert','1d'],check=True,capture_output=True)
                listing=subprocess.check_output(['gpg','--batch','--with-colons','--list-keys'],stderr=subprocess.DEVNULL).decode()
                primary=next(line.split(':')[9] for line in listing.splitlines() if line.startswith('fpr:'))
                subprocess.run(['gpg','--batch','--pinentry-mode','loopback','--passphrase','','--quick-add-key',primary,'cv25519','encrypt','1d'],check=True,capture_output=True)
                destination=root/'backup.gpg'
                host.export_snapshot(operation['id'],destination,primary)
                self.assertEqual(verified,[operation['id']])
                self.assertEqual(destination.stat().st_mode&0o777,0o600)
                self.assertNotIn(b'synthetic-private',destination.read_bytes())
                decrypted=subprocess.check_output(['gpg','--batch','--decrypt',str(destination)],stderr=subprocess.DEVNULL)
                import io
                with tarfile.open(fileobj=io.BytesIO(decrypted),mode='r:gz') as archive:
                    self.assertEqual(archive.extractfile('snapshot/state.tar.gz').read(),(point/'state.tar.gz').read_bytes())
                    self.assertIn('snapshot/snapshot.json',archive.getnames())
                with self.assertRaises(ValueError):host.export_snapshot(operation['id'],destination,primary)
                with self.assertRaises(ValueError):host.export_snapshot('../not-uuid',root/'unsafe.gpg',primary)
                self.assertEqual(list(root.glob('.encrypted-snapshot-*')),[])
            subprocess.run(['gpgconf','--homedir',str(home),'--kill','gpg-agent'],capture_output=True)
