#!/usr/bin/env python3
"""Small rootless lifecycle tool. Environment files are parsed, never executed."""

import argparse
import fcntl
import ipaddress
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent


def run(*args, **kwargs):
    return subprocess.run([str(a) for a in args], check=True, **kwargs)


def read_env(file):
    values = {}
    for line in file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise ValueError("Invalid environment assignment")
        key, value = line.split("=", 1)
        if not re.fullmatch(r"[A-Z][A-Z0-9_]*", key):
            raise ValueError(f"Invalid environment key: {key}")
        values[key] = value.strip().strip('"').strip("'")
    return values


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "command",
        choices=[
            "install",
            "update",
            "broker-certificate",
            "status",
            "logs",
            "restart",
            "stop",
            "uninstall",
            "backup",
            "restore",
        ],
    )
    parser.add_argument("--env", type=Path, default=ROOT / "gateway.env")
    parser.add_argument(
        "--file",
        type=Path,
        help="Backup archive to create or restore (services stopped during operation)",
    )
    parser.add_argument(
        "--unit-dir", type=Path, default=Path.home() / ".config/containers/systemd"
    )
    args = parser.parse_args()
    if os.getuid() == 0:
        sys.exit("Run as your regular user. Rootful operation is unsupported.")
    if not shutil.which("podman"):
        sys.exit("Podman is required.")
    run("systemctl", "--user", "show-environment", stdout=subprocess.DEVNULL)
    rootless = run(
        "podman",
        "info",
        "--format",
        "{{.Host.Security.Rootless}}",
        capture_output=True,
        text=True,
    ).stdout.strip()
    if rootless != "true":
        sys.exit("Only a local rootless Podman engine is supported.")
    if not args.env.exists():
        if args.command != "install":
            sys.exit("Configuration is missing. Run install first.")
        shutil.copyfile(ROOT / "gateway.env.example", args.env)
        args.env.chmod(0o600)
    args.env = args.env.resolve()
    env = read_env(args.env)
    if "BASE_DIR" in env or any(k.startswith("STEP_CA_") for k in env):
        sys.exit(
            "Legacy configuration detected. Back up and follow docs/migration.md; trust is never replaced automatically."
        )
    data = Path(env.get("DATA_DIR") or ROOT / "runtime").expanduser().resolve()
    if re.search(r"\s|[%@\n\r]", str(data) + str(args.env)):
        sys.exit("Data and environment paths must not contain whitespace, %, or @.")
    for key in ["ADMIN_APP_PORT", "MQTT_TLS_PORT", "MQTT_WS_PORT"]:
        port = int(
            env.get(
                key,
                "8080"
                if key == "ADMIN_APP_PORT"
                else "8883"
                if key == "MQTT_TLS_PORT"
                else "8443",
            )
        )
        if not 1024 <= port <= 65535:
            sys.exit(f"{key} must be an unprivileged port (1024–65535).")
    ports = [
        env.get(k, d)
        for k, d in [
            ("ADMIN_APP_PORT", "8080"),
            ("MQTT_TLS_PORT", "8883"),
            ("MQTT_WS_PORT", "8443"),
        ]
    ]
    if len(set(ports)) != 3:
        sys.exit("Host ports must be distinct.")
    for key, default in [("ADMIN_BIND", "127.0.0.1"), ("MQTT_BIND", "0.0.0.0")]:
        ipaddress.ip_address(env.get(key, default))
    units = ["mqtt-broker.service", "mqtt-admin.service"]
    if args.command in ["install", "update", "uninstall"]:
        for name in [
            "mqtt-admin.container",
            "mqtt-broker.container",
            "mqtt-gateway.network",
        ]:
            target = args.unit_dir / name
            if (
                target.exists()
                and "# Managed by MQTT Trust Gateway" not in target.read_text()
            ):
                sys.exit(f"Refusing to manage an unrelated unit: {target}")
    if args.command in ["install", "update"]:
        for name in ["admin", "broker", "mosquitto"]:
            (data / name).mkdir(parents=True, exist_ok=True, mode=0o700)
        run(
            "podman",
            "build",
            "-t",
            "localhost/mqtt-trust-admin:latest",
            "-f",
            ROOT / "admin-web/Containerfile",
            ROOT / "admin-web",
        )
        run(
            "podman",
            "build",
            "-t",
            "localhost/mqtt-trust-broker:latest",
            "-f",
            ROOT / "Containerfile.broker",
            ROOT,
        )
        # No simultaneous CA writer: stop admin before offline initialization.
        subprocess.run(
            ["systemctl", "--user", "stop", *units],
            check=False,
            stderr=subprocess.DEVNULL,
        )
        run(
            "podman",
            "run",
            "--rm",
            "--userns=keep-id",
            "--user",
            f"{os.getuid()}:{os.getgid()}",
            "--cap-drop=all",
            "--security-opt=no-new-privileges",
            "--env-file",
            args.env,
            "-v",
            f"{data}/admin:/data:Z",
            "-v",
            f"{data}/broker:/broker:z",
            "localhost/mqtt-trust-admin:latest",
            "node",
            "src/cli.js",
            "prepare",
        )
        args.unit_dir.mkdir(parents=True, exist_ok=True)
        replacements = {
            "UID": str(os.getuid()),
            "GID": str(os.getgid()),
            "ENV": str(args.env),
            "DATA": str(data),
            "ADMIN_BIND": env.get("ADMIN_BIND", "127.0.0.1"),
            "MQTT_BIND": env.get("MQTT_BIND", "0.0.0.0"),
            "ADMIN_PORT": env.get("ADMIN_APP_PORT", "8080"),
            "TLS_PORT": env.get("MQTT_TLS_PORT", "8883"),
            "WS_PORT": env.get("MQTT_WS_PORT", "8443"),
        }
        for source in (ROOT / "quadlet").iterdir():
            text = source.read_text()
            for key, value in replacements.items():
                text = text.replace(f"@{key}@", value)
            target = args.unit_dir / source.name
            if (
                target.exists()
                and target.read_text() != text
                and "# Managed by MQTT Trust Gateway" not in target.read_text()
            ):
                sys.exit(f"Refusing to overwrite an unrelated unit: {target}")
            target.write_text("# Managed by MQTT Trust Gateway\n" + text)
        run("systemctl", "--user", "daemon-reload")
        run("systemctl", "--user", "start", *units)
        import time

        for attempt in range(15):
            health = subprocess.run(
                ["podman", "exec", "mqtt-admin", "node", "src/healthcheck.js"],
                capture_output=True,
            )
            if health.returncode == 0:
                break
            time.sleep(1)
        else:
            sys.exit(
                "Admin failed readiness check. Run gateway logs; data was preserved."
            )
        print(
            f"Admin: {env.get('PUBLIC_URL', 'http://localhost:8080')}\nMQTT TLS: {ports[1]} | WebSocket TLS: {ports[2]}"
        )
        if (data / "admin/bootstrap-token").exists():
            print(
                f"Bootstrap: read {data}/admin/bootstrap-token locally, then create your administrator in the browser."
            )
        else:
            print(
                "Administrator already initialized; sign in with your existing credentials."
            )
        print(
            "Optional reboot persistence: loginctl enable-linger YOUR_USER (host policy may require administrator approval)."
        )
    elif args.command == "broker-certificate":
        with (data / ".broker-certificate.lock").open("a") as lock:
            os.chmod(lock.name, 0o600)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            # Read the latest env in a one-shot container. A running container retains
            # its old environment; exec alone would silently ignore edited SANs.
            command = [
                "podman", "run", "--rm", "--userns=keep-id", "--user",
                f"{os.getuid()}:{os.getgid()}", "--cap-drop=all",
                "--security-opt=no-new-privileges", "--security-opt=label=disable",
                "--network=none", "--read-only",
                "--tmpfs=/tmp:rw,noexec,nosuid,size=32m", "--env-file", str(args.env),
                # Do not relabel mounts used by live containers on SELinux hosts.
                "-v", f"{data}/admin:/data", "-v", f"{data}/broker:/broker",
                "localhost/mqtt-trust-admin:latest", "node", "src/cli.js",
            ]
            check = subprocess.run([*command, "broker-certificate-check"])
            if check.returncode == 0:
                return
            if check.returncode != 10:
                sys.exit("Broker certificate validation failed; no services were stopped.")
            run("systemctl", "--user", "is-active", "--quiet", *units)
            # Prevent concurrent signing/maintenance; the broker stays up until the
            # complete certificate is published and its revision is submitted.
            run("systemctl", "--user", "stop", "mqtt-admin.service")
            try:
                run(*command, "broker-certificate")
            finally:
                run("systemctl", "--user", "start", "mqtt-admin.service")
            print("CA and device credentials preserved. The broker applies the new certificate once.")
    elif args.command in ["status", "logs", "restart", "stop"]:
        if args.command == "logs":
            run(
                "journalctl",
                "--user",
                "-u",
                units[0],
                "-u",
                units[1],
                "-n",
                "100",
                "--no-pager",
            )
        else:
            run("systemctl", "--user", args.command, *units)
    elif args.command == "uninstall":
        run("systemctl", "--user", "stop", *units)
        for name in [
            "mqtt-admin.container",
            "mqtt-broker.container",
            "mqtt-gateway.network",
        ]:
            target = args.unit_dir / name
            if (
                target.exists()
                and "# Managed by MQTT Trust Gateway" in target.read_text()
            ):
                target.unlink()
        run("systemctl", "--user", "daemon-reload")
        print(f"Data preserved at {data}. Images and shared network preserved.")
    elif args.command in ["backup", "restore"]:
        import tarfile

        if not args.file:
            sys.exit("--file is required")
        run("systemctl", "--user", "stop", *reversed(units))
        if args.command == "backup":
            if args.file.exists():
                sys.exit("Refusing to overwrite an existing backup")
            fd = os.open(args.file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
            with (
                os.fdopen(fd, "wb") as stream,
                tarfile.open(fileobj=stream, mode="w:gz") as archive,
            ):
                archive.add(data, arcname="runtime")
                archive.add(args.env, arcname="gateway.env")
            print("Backup contains private keys. Store it encrypted and offline.")
        else:
            if data.exists() and any(data.iterdir()):
                sys.exit(
                    "Restore requires an empty DATA_DIR. Existing data was preserved. Services remain stopped."
                )
            data.parent.mkdir(parents=True, exist_ok=True)
            with tarfile.open(args.file, "r:gz") as archive:
                # Extraction filter rejects links, traversal and special files.
                for member in archive.getmembers():
                    if (
                        not member.name.startswith("runtime/")
                        and member.name != "runtime"
                        and member.name != "gateway.env"
                    ):
                        sys.exit("Unexpected archive entry")
                    if not (member.isfile() or member.isdir()):
                        sys.exit("Links and special files are forbidden in backups")
                import tempfile

                with tempfile.TemporaryDirectory(dir=data.parent) as tmp:
                    archive.extractall(tmp, filter="data")
                    if data.exists():
                        data.rmdir()
                    shutil.move(str(Path(tmp) / "runtime"), str(data))
                    saved = args.env.with_suffix(".restored.env")
                    shutil.copyfile(Path(tmp) / "gateway.env", saved)
                    saved.chmod(0o600)
            print(
                f"Restored data. Review {saved} and run install. Services remain stopped."
            )
        if args.command == "backup":
            run("systemctl", "--user", "start", *units)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, subprocess.CalledProcessError, OSError) as error:
        sys.exit(str(error))
