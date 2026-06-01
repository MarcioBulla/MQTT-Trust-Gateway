import pytest

from helpers.device_credentials import create_signed_device_credentials
from helpers.mqtt_roundtrip import assert_roundtrip


@pytest.fixture()
def signed_device_credentials(tmp_path, gateway_config, provisioner_password):
    return create_signed_device_credentials(tmp_path, gateway_config, provisioner_password)


def test_device_certificate_publish_and_receive_over_mqtts(gateway_config, signed_device_credentials):
    assert_roundtrip(
        gateway_config,
        signed_device_credentials,
        "tcp",
        gateway_config.mqtt_tls_port,
    )


def test_device_certificate_publish_and_receive_over_wss(gateway_config, signed_device_credentials):
    assert_roundtrip(
        gateway_config,
        signed_device_credentials,
        "websockets",
        gateway_config.mqtt_ws_tls_port,
    )
