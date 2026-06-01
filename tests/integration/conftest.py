import getpass
import os
import shutil
from dataclasses import dataclass
from pathlib import Path

import pytest


@dataclass(frozen=True)
class GatewayConfig:
    domain: str
    step_ca_url: str
    step_ca_fingerprint: str
    step_ca_provisioner: str
    device_cert_ttl: str
    topic_prefix: str
    mqtt_tls_port: int
    mqtt_ws_tls_port: int


def pytest_addoption(parser):
    parser.addoption(
        "--provisioner-password",
        action="store",
        default=None,
        help="step-ca provisioner password used to sign the integration-test CSR.",
    )


def load_env_file():
    env_file = next((path for path in (Path("gateway.env"), Path("broker.env")) if path.exists()), None)
    if env_file is None:
        return {}

    values = {}
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'\"")
        if key:
            values[key] = value
    return values


def config_value(name, broker_env, default=""):
    return os.getenv(name, broker_env.get(name, default)).strip()


@pytest.fixture(scope="session")
def gateway_config():
    env_file_values = load_env_file()
    domain = config_value("MQTT_DOMAIN", env_file_values)
    fingerprint = config_value("STEP_CA_FINGERPRINT", env_file_values)

    missing = []
    if not domain:
        missing.append("MQTT_DOMAIN")
    if not fingerprint:
        missing.append("STEP_CA_FINGERPRINT")
    if missing:
        pytest.skip("Missing integration environment variables: " + ", ".join(missing))

    return GatewayConfig(
        domain=domain,
        step_ca_url=config_value("STEP_CA_URL", env_file_values, f"https://{domain}:9000"),
        step_ca_fingerprint=fingerprint,
        step_ca_provisioner=config_value("STEP_CA_PROVISIONER", env_file_values, "mqtt-devices"),
        device_cert_ttl=config_value("STEP_CA_DEVICE_CERT_TTL", env_file_values, "24h"),
        topic_prefix=config_value("MQTT_TOPIC_PREFIX", env_file_values, "devices"),
        mqtt_tls_port=int(config_value("MQTT_TLS_PORT", env_file_values, "8883")),
        mqtt_ws_tls_port=int(config_value("MQTT_WS_TLS_PORT", env_file_values, "8443")),
    )


@pytest.fixture(scope="session")
def provisioner_password(pytestconfig):
    password = pytestconfig.getoption("--provisioner-password") or os.getenv("STEP_CA_PROVISIONER_PASSWORD")
    if password:
        return password

    if not os.isatty(0):
        pytest.skip("Provide --provisioner-password or STEP_CA_PROVISIONER_PASSWORD to sign the CSR")

    return getpass.getpass("step-ca provisioner password: ")


@pytest.fixture(scope="session", autouse=True)
def require_step_cli():
    if not shutil.which("step"):
        pytest.skip("step CLI is required for integration tests")
