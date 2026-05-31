import getpass
import os
import shutil
from dataclasses import dataclass

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


@pytest.fixture(scope="session")
def gateway_config():
    domain = os.getenv("MQTT_DOMAIN", "").strip()
    fingerprint = os.getenv("STEP_CA_FINGERPRINT", "").strip()

    missing = []
    if not domain:
        missing.append("MQTT_DOMAIN")
    if not fingerprint:
        missing.append("STEP_CA_FINGERPRINT")
    if missing:
        pytest.skip("Missing integration environment variables: " + ", ".join(missing))

    return GatewayConfig(
        domain=domain,
        step_ca_url=os.getenv("STEP_CA_URL", f"https://{domain}:9000").strip(),
        step_ca_fingerprint=fingerprint,
        step_ca_provisioner=os.getenv("STEP_CA_PROVISIONER", "mqtt-devices").strip(),
        device_cert_ttl=os.getenv("STEP_CA_DEVICE_CERT_TTL", "24h").strip(),
        topic_prefix=os.getenv("MQTT_TOPIC_PREFIX", "devices").strip(),
        mqtt_tls_port=int(os.getenv("MQTT_TLS_PORT", "8883")),
        mqtt_ws_tls_port=int(os.getenv("MQTT_WS_TLS_PORT", "8443")),
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
