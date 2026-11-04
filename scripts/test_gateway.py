"""Offline lifecycle checks; no host services or real Podman commands are changed."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import json
import sqlite3
import tarfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("gateway", Path(__file__).with_name("gateway.py"))
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class BrokerCertificateCommandTests(unittest.TestCase):
    def exercise(self, preflight, failure=False):
        with tempfile.TemporaryDirectory(prefix="gateway-cli-") as temporary:
            data = Path(temporary)
            config = data / "gateway.env"
            config.write_text(f"DATA_DIR={data}\nMQTT_BROKER_EXTRA_SANS=mqtt.example.com\n")
            calls = []

            def run(*args, **kwargs):
                calls.append(args)
                if failure and args[-1] == "broker-certificate":
                    raise subprocess.CalledProcessError(1, args)
                return subprocess.CompletedProcess(args, 0, stdout="true\n")

            with (
                patch.object(sys, "argv", ["gateway", "broker-certificate", "--env", str(config)]),
                patch.object(gateway.os, "getuid", return_value=1000),
                patch.object(gateway.os, "getgid", return_value=1000),
                patch.object(gateway.shutil, "which", return_value="/usr/bin/podman"),
                patch.object(gateway, "run", side_effect=run),
                patch.object(gateway.subprocess, "run", return_value=subprocess.CompletedProcess([], preflight)),
            ):
                if preflight not in (0, 10):
                    with self.assertRaises(SystemExit):
                        gateway.main()
                elif failure:
                    with self.assertRaises(subprocess.CalledProcessError):
                        gateway.main()
                else:
                    gateway.main()
            return calls

    def test_current_certificate_does_not_stop_or_restart_services(self):
        calls = self.exercise(0)
        self.assertFalse(any("stop" in call or "start" in call or "restart" in call for call in calls))

    def test_validation_failure_does_not_stop_services(self):
        calls = self.exercise(1)
        self.assertFalse(any("stop" in call for call in calls))

    def test_update_reads_env_and_only_stops_admin(self):
        calls = self.exercise(10)
        stops = [call for call in calls if "stop" in call]
        self.assertEqual(stops, [("systemctl", "--user", "stop", "mqtt-admin.service")])
        command = next(call for call in calls if call[-1] == "broker-certificate")
        self.assertIn("--env-file", command)
        self.assertIn("--network=none", command)
        self.assertEqual(calls[-1], ("systemctl", "--user", "start", "mqtt-admin.service"))

    def test_signing_failure_still_starts_admin(self):
        calls = self.exercise(10, failure=True)
        self.assertEqual(calls[-1], ("systemctl", "--user", "start", "mqtt-admin.service"))


class ReleaseBuildMetadataTests(unittest.TestCase):
    def test_dirty_checkout_is_not_mislabeled_with_a_commit_hash(self):
        with patch.object(gateway.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout=" M README.md\n")):
            self.assertEqual(gateway.source_commit(), "uncommitted")


class BackupArchiveTests(unittest.TestCase):
    def fixture(self, temporary):
        root = Path(temporary)
        data = root / "runtime"
        admin = data / "admin"
        broker = data / "broker"
        units = root / "units"
        admin.mkdir(parents=True)
        broker.mkdir()
        units.mkdir()
        database = sqlite3.connect(admin / "gateway.sqlite")
        database.executescript("CREATE TABLE state(id INTEGER PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE audit(id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL); INSERT INTO state VALUES(1, '{\"devices\":[],\"certificates\":[]}'); PRAGMA user_version=1;")
        database.close()
        (admin / "ca.key").write_text("test-private-key-placeholder")
        env_file = root / "gateway.env"
        env_file.write_text("DATA_DIR=/test/runtime\n")
        (units / "mqtt-admin.container").write_text("[Container]\n")
        return root, data, units, env_file

    def test_backup_is_private_and_contains_validated_sqlite_quadlets_and_image_ids(self):
        with tempfile.TemporaryDirectory(prefix="gateway-backup-test-") as temporary:
            root, data, units, env_file = self.fixture(temporary)
            archive_path = root / "backup.tar.gz"
            image_ids = {"admin": "sha256:" + "a" * 64, "broker": "sha256:" + "b" * 64}
            gateway.create_backup_archive(data, env_file, archive_path, units, image_ids)
            self.assertEqual(archive_path.stat().st_mode & 0o777, 0o600)
            with tarfile.open(archive_path, "r:gz") as archive:
                names = archive.getnames()
                self.assertIn("runtime/admin/gateway.sqlite", names)
                self.assertIn("quadlets/mqtt-admin.container", names)
                metadata = json.load(archive.extractfile("release-images.json"))
                self.assertEqual(metadata["images"], image_ids)

    def test_corrupt_sqlite_prevents_backup_and_removes_partial_archive(self):
        with tempfile.TemporaryDirectory(prefix="gateway-backup-test-") as temporary:
            root, data, units, env_file = self.fixture(temporary)
            (data / "admin/gateway.sqlite").write_bytes(b"not sqlite")
            archive_path = root / "backup.tar.gz"
            with self.assertRaises(sqlite3.DatabaseError):
                gateway.create_backup_archive(data, env_file, archive_path, units, {})
            self.assertFalse(archive_path.exists())


if __name__ == "__main__":
    unittest.main()
