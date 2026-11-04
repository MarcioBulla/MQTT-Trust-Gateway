"""Snapshot checks use synthetic state in temporary directories only."""
import json
import sqlite3
import stat
import tempfile
import unittest
from pathlib import Path
from scripts.updater.snapshots import create, restore, verify, ESSENTIAL, UNITS, digest


class SnapshotTests(unittest.TestCase):
    def fixture(self, directory):
        root = Path(directory)
        data, units = root/'runtime', root/'units'
        units.mkdir()
        for name in ESSENTIAL:
            file = data/name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(('synthetic state: '+name).encode())
            file.chmod(0o600)
        (data/'admin/gateway.sqlite').unlink()
        connection = sqlite3.connect(data/'admin/gateway.sqlite')
        connection.executescript('PRAGMA journal_mode=WAL; CREATE TABLE state(id INTEGER PRIMARY KEY, value TEXT); PRAGMA user_version=1;')
        connection.execute('INSERT INTO state VALUES(1,?)', (json.dumps({'devices':[{'id':'synthetic-device'}], 'certificates':[], 'settings':{}}),))
        connection.commit()
        (data/'mosquitto').mkdir()
        (data/'mosquitto/mosquitto.db').write_bytes(b'synthetic retained MQTT state')
        for name in UNITS:
            (units/name).write_text('[Container]\nImage=sha256:'+'a'*64+'\n')
        environment = root/'gateway.env'
        environment.write_text('DATA_DIR='+str(data)+'\nCUSTOM_OPTION=preserved\n')
        environment.chmod(0o600)
        images = {'admin':'sha256:'+'a'*64, 'broker':'sha256:'+'b'*64}
        return root, data, units, environment, images, connection

    def test_snapshot_uses_sqlite_backup_and_restores_entire_state_and_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            root,data,units,environment,images,connection = self.fixture(directory)
            original_key = (data/'admin/ca/ca.key').read_bytes()
            calls=[]
            snapshot=root/'snapshots/first'
            meta=create(snapshot,data,environment,units,images,lambda:calls.append('stopped'),'1.0.2')
            connection.close()
            self.assertGreaterEqual(len(calls),2)
            self.assertEqual(stat.S_IMODE((snapshot/'state.tar.gz').stat().st_mode),0o600)
            self.assertFalse(any(name.endswith(('-wal','-shm')) for name in meta['inventory']))
            (data/'admin/ca/ca.key').write_bytes(b'changed by synthetic update')
            (data/'mosquitto/mosquitto.db').write_bytes(b'changed state')
            environment.write_text('changed')
            restore(snapshot,data,environment,units,root/'recovery',lambda:None,meta['sha256'])
            self.assertEqual((data/'admin/ca/ca.key').read_bytes(),original_key)
            self.assertEqual(stat.S_IMODE((data/'admin/ca/ca.key').stat().st_mode),0o600)
            self.assertEqual((data/'mosquitto/mosquitto.db').read_bytes(),b'synthetic retained MQTT state')
            self.assertIn('CUSTOM_OPTION=preserved',environment.read_text())
            self.assertEqual((root/'recovery/previous-runtime/admin/ca/ca.key').read_bytes(),b'changed by synthetic update')
            with sqlite3.connect(data/'admin/gateway.sqlite') as database:
                self.assertEqual(json.loads(database.execute('SELECT value FROM state').fetchone()[0])['devices'][0]['id'],'synthetic-device')

    def test_interrupted_restore_resumes_after_each_persistent_write(self):
        for boundary in ('runtime-displaced','runtime-installed','configuration-installed'):
            with self.subTest(boundary=boundary), tempfile.TemporaryDirectory() as directory:
                root,data,units,environment,images,connection=self.fixture(directory)
                connection.close()
                snapshot=root/'snapshots/first'
                meta=create(snapshot,data,environment,units,images,lambda:None,'1.0.2')
                def crash(stage):
                    if stage==boundary:
                        raise InterruptedError('simulated interruption')
                with self.assertRaises(InterruptedError):
                    restore(snapshot,data,environment,units,root/'recovery',lambda:None,meta['sha256'],crash)
                restore(snapshot,data,environment,units,root/'recovery',lambda:None,meta['sha256'])
                self.assertTrue(json.loads((root/'recovery/restore.json').read_text())['completed'])
                self.assertEqual(digest(data/'admin/ca/ca.key'),meta['inventory']['runtime/admin/ca/ca.key']['sha256'])

    def test_tampered_archive_missing_state_and_live_services_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root,data,units,environment,images,connection=self.fixture(directory)
            connection.close()
            def running():
                raise RuntimeError('services still running')
            with self.assertRaises(RuntimeError):
                create(root/'blocked',data,environment,units,images,running,'1.0.2')
            snapshot=root/'snapshots/first'
            meta=create(snapshot,data,environment,units,images,lambda:None,'1.0.2')
            original=(data/'admin/ca/ca.key').read_bytes()
            with (snapshot/'state.tar.gz').open('ab') as stream: stream.write(b'corrupt')
            with self.assertRaises(ValueError):
                restore(snapshot,data,environment,units,root/'recovery',lambda:None,meta['sha256'])
            self.assertEqual((data/'admin/ca/ca.key').read_bytes(),original)
            (data/'admin/ca/ca.key').unlink()
            with self.assertRaises(ValueError):
                create(root/'incomplete',data,environment,units,images,lambda:None,'1.0.2')

    def test_snapshot_rejects_links_and_retains_displaced_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root,data,units,environment,images,connection=self.fixture(directory)
            connection.close()
            (data/'admin/link').symlink_to(environment)
            with self.assertRaises(ValueError):
                create(root/'unsafe',data,environment,units,images,lambda:None,'1.0.2')
