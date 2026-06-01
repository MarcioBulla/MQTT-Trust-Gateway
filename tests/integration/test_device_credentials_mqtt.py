from cryptography import x509

from helpers.device_credentials import create_signed_device_credentials, renew_device_certificate, revoke_device_certificate
from helpers.mqtt_roundtrip import assert_roundtrip


def test_device_lifecycle_create_sign_pub_sub_renew_revoke(tmp_path, gateway_config, provisioner_password):
    credentials = create_signed_device_credentials(tmp_path, gateway_config, provisioner_password)
    original = x509.load_pem_x509_certificate(credentials["cert_file"].read_bytes())

    assert_roundtrip(
        gateway_config,
        credentials,
        "tcp",
        gateway_config.mqtt_tls_port,
    )
    assert_roundtrip(
        gateway_config,
        credentials,
        "websockets",
        gateway_config.mqtt_ws_tls_port,
    )

    renewed_cert_file = renew_device_certificate(credentials, gateway_config)
    renewed = x509.load_pem_x509_certificate(renewed_cert_file.read_bytes())

    assert renewed.subject == original.subject
    assert renewed.serial_number != original.serial_number

    revoked_serial = revoke_device_certificate(renewed_cert_file, credentials, gateway_config)
    assert revoked_serial == str(renewed.serial_number)
