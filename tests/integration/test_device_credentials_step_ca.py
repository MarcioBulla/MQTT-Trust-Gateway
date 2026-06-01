import uuid

from cryptography import x509

from helpers.device_credentials import (
    create_signed_device_credentials,
    renew_device_certificate,
    revoke_device_certificate,
    write_device_csr,
)


def test_generates_device_private_key_and_csr(tmp_path):
    device_id = f"it-{uuid.uuid4().hex[:12]}"
    key_file, csr_file = write_device_csr(tmp_path, device_id)

    assert key_file.exists()
    assert key_file.stat().st_mode & 0o777 == 0o600
    assert csr_file.exists()

    csr = x509.load_pem_x509_csr(csr_file.read_bytes())
    assert csr.is_signature_valid
    assert csr.subject.rfc4514_string() == f"CN={device_id}"

    san = csr.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    assert device_id in san.get_values_for_type(x509.DNSName)
    assert f"urn:mqtt-trust-gateway:device:{device_id}" in san.get_values_for_type(x509.UniformResourceIdentifier)


def test_signs_device_csr_with_step_ca(tmp_path, gateway_config, provisioner_password):
    credentials = create_signed_device_credentials(tmp_path, gateway_config, provisioner_password)

    assert credentials["key_file"].exists()
    assert credentials["cert_file"].exists()

    certificate = x509.load_pem_x509_certificate(credentials["cert_file"].read_bytes())
    assert certificate.subject.rfc4514_string() == f"CN={credentials['device_id']}"


def test_renews_and_revokes_device_certificate(tmp_path, gateway_config, provisioner_password):
    credentials = create_signed_device_credentials(tmp_path, gateway_config, provisioner_password)
    original = x509.load_pem_x509_certificate(credentials["cert_file"].read_bytes())

    renewed_cert_file = renew_device_certificate(credentials, gateway_config)
    renewed = x509.load_pem_x509_certificate(renewed_cert_file.read_bytes())

    assert renewed.subject == original.subject
    assert renewed.serial_number != original.serial_number

    revoked_serial = revoke_device_certificate(renewed_cert_file, credentials, gateway_config)
    assert revoked_serial == str(renewed.serial_number)
