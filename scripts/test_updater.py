import json
import stat
import tempfile
import unittest
from pathlib import Path
from scripts.updater.journal import Journal, OperationBusy


class JournalTests(unittest.TestCase):
    def test_restart_keeps_operation_and_rejects_concurrent_or_unrecovered_work(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = Journal(directory)
            with journal.lock():
                with self.assertRaises(OperationBusy):
                    with Journal(directory).lock():
                        pass
                operation = journal.begin("1.1.0", "1.0.2")
                journal.transition(operation, "INSTALLING", snapshot="private-snapshot")
            reopened = Journal(directory)
            self.assertEqual(reopened.read()["state"], "INSTALLING")
            with reopened.lock():
                with self.assertRaises(OperationBusy):
                    reopened.begin("1.2.0", "1.0.2")
            self.assertEqual(stat.S_IMODE(journal.path.stat().st_mode), 0o600)
            history = Path(directory) / "history" / (operation["id"] + ".json")
            self.assertEqual(json.loads(history.read_text())["id"], operation["id"])

    def test_committed_update_never_automatically_restores_old_data(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = Journal(directory)
            operation = journal.begin("1.1.0", "1.0.2")
            journal.transition(operation, "COMMITTING", committed=True)
            with self.assertRaises(ValueError):
                journal.transition(operation, "ROLLING_BACK")
            journal.transition(operation, "COMPLETED")
            with self.assertRaises(ValueError):
                journal.transition(operation, "INSTALLING")

    def test_recovery_required_blocks_new_operations(self):
        with tempfile.TemporaryDirectory() as directory:
            journal = Journal(directory)
            operation = journal.begin("1.1.0", "1.0.2")
            journal.transition(operation, "RECOVERY_REQUIRED")
            with self.assertRaises(OperationBusy):
                journal.begin("1.1.0", "1.0.2")


class ReleaseTests(unittest.TestCase):
    def test_signed_manifest_binds_official_digests_and_version(self):
        import base64
        import subprocess
        from scripts.updater.releases import verify, compatible, version_key
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def openssl(*args):
                return subprocess.run(['openssl', *map(str, args)], check=True, capture_output=True).stdout
            openssl('genpkey', '-algorithm', 'ED25519', '-out', root/'private')
            public = openssl('pkey', '-in', root/'private', '-pubout', '-outform', 'DER')
            manifest = {'version': '1.1.0', 'channel': 'stable', 'schema_version': 1,
                        'images': {name: {'reference': 'ghcr.io/marciobulla/mqtt-trust-'+name+'@sha256:'+'a'*64} for name in ('admin','broker')},
                        'compatibility': {'min_gateway_version': '1.0.2', 'min_podman_version': '5.0.0'},
                        'health_checks': dict.fromkeys(('admin','database','broker_tls','mqtt_mtls'), True)}
            payload = json.dumps(manifest).encode()
            (root/'payload').write_bytes(payload)
            signature = base64.b64encode(openssl('pkeyutl','-sign','-inkey',root/'private','-rawin','-in',root/'payload'))
            self.assertEqual(verify(payload,signature,public,'1.1.0')['version'],'1.1.0')
            compatible(manifest,'1.0.2',1,'5.3.0')
            for modified, version in ((payload+b' ', '1.1.0'), (payload, '1.2.0')):
                with self.assertRaises(ValueError):
                    verify(modified,signature,public,version)
            with self.assertRaises(ValueError):
                compatible(manifest,'1.0.2',2,'5.3.0')
            with self.assertRaises(ValueError):
                compatible(manifest,'1.0.2',1,'4.9.0')
            self.assertLess(version_key('1.1.0-beta.2'),version_key('1.1.0-beta.10'))
            self.assertLess(version_key('1.1.0-beta.10'),version_key('1.1.0'))
