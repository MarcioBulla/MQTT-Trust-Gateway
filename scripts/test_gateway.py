"""Offline lifecycle checks; no host services or real Podman commands are changed."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
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


if __name__ == "__main__":
    unittest.main()
