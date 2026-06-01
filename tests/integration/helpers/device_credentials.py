import os
import subprocess
import uuid

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID


def write_device_csr(workdir, device_id):
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    key_file = workdir / f"{device_id}.key"
    csr_file = workdir / f"{device_id}.csr"

    csr = (
        x509.CertificateSigningRequestBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, device_id)]))
        .add_extension(
            x509.SubjectAlternativeName([
                x509.DNSName(device_id),
                x509.UniformResourceIdentifier(f"urn:mqtt-trust-gateway:device:{device_id}"),
            ]),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )

    key_file.write_bytes(
        key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        )
    )
    key_file.chmod(0o600)
    csr_file.write_bytes(csr.public_bytes(serialization.Encoding.PEM))
    return key_file, csr_file


def run_step(args, steppath):
    env = os.environ.copy()
    env["STEPPATH"] = str(steppath)
    subprocess.run(args, env=env, check=True, text=True)


def create_signed_device_credentials(workdir, gateway_config, provisioner_password):
    device_id = f"it-{uuid.uuid4().hex[:12]}"
    key_file, csr_file = write_device_csr(workdir, device_id)
    cert_file = workdir / f"{device_id}.crt"
    password_file = workdir / "provisioner-password"
    steppath = workdir / "step"

    steppath.mkdir()
    password_file.write_text(f"{provisioner_password}\n")
    password_file.chmod(0o600)

    run_step(
        [
            "step",
            "ca",
            "bootstrap",
            "--ca-url",
            gateway_config.step_ca_url,
            "--fingerprint",
            gateway_config.step_ca_fingerprint,
            "--force",
        ],
        steppath,
    )
    run_step(
        [
            "step",
            "ca",
            "sign",
            str(csr_file),
            str(cert_file),
            "--provisioner",
            gateway_config.step_ca_provisioner,
            "--provisioner-password-file",
            str(password_file),
            "--not-after",
            gateway_config.device_cert_ttl,
            "--force",
        ],
        steppath,
    )

    return {
        "device_id": device_id,
        "key_file": key_file,
        "csr_file": csr_file,
        "cert_file": cert_file,
        "password_file": password_file,
        "steppath": steppath,
    }


def renew_device_certificate(credentials, gateway_config):
    renewed_cert_file = credentials["cert_file"].with_name(f"{credentials['device_id']}.renewed.crt")
    run_step(
        [
            "step",
            "ca",
            "sign",
            str(credentials["csr_file"]),
            str(renewed_cert_file),
            "--ca-url",
            gateway_config.step_ca_url,
            "--root",
            str(credentials["steppath"] / "certs" / "root_ca.crt"),
            "--provisioner",
            gateway_config.step_ca_provisioner,
            "--provisioner-password-file",
            str(credentials["password_file"]),
            "--not-after",
            gateway_config.device_cert_ttl,
            "--force",
        ],
        credentials["steppath"],
    )
    return renewed_cert_file


def revoke_device_certificate(cert_file, credentials, gateway_config):
    certificate = x509.load_pem_x509_certificate(cert_file.read_bytes())
    serial = str(certificate.serial_number)
    token = subprocess.run(
        [
            "step",
            "ca",
            "token",
            serial,
            "--revoke",
            "--ca-url",
            gateway_config.step_ca_url,
            "--root",
            str(credentials["steppath"] / "certs" / "root_ca.crt"),
            "--provisioner",
            gateway_config.step_ca_provisioner,
            "--provisioner-password-file",
            str(credentials["password_file"]),
        ],
        env={**os.environ, "STEPPATH": str(credentials["steppath"])},
        check=True,
        text=True,
        capture_output=True,
    ).stdout.strip()
    run_step(
        [
            "step",
            "ca",
            "revoke",
            serial,
            "--ca-url",
            gateway_config.step_ca_url,
            "--root",
            str(credentials["steppath"] / "certs" / "root_ca.crt"),
            "--token",
            token,
            "--reason",
            "keyCompromise",
        ],
        credentials["steppath"],
    )
    return serial
