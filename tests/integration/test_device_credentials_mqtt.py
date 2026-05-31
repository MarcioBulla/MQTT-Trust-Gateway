import os
import ssl
import subprocess
import threading
import time
import uuid

import paho.mqtt.client as mqtt
import pytest
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


@pytest.fixture()
def signed_device_credentials(tmp_path, gateway_config, provisioner_password):
    device_id = f"it-{uuid.uuid4().hex[:12]}"
    key_file, csr_file = write_device_csr(tmp_path, device_id)
    cert_file = tmp_path / f"{device_id}.crt"
    password_file = tmp_path / "provisioner-password"
    steppath = tmp_path / "step"

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
        "cert_file": cert_file,
    }


def make_client(gateway_config, credentials, transport):
    client = mqtt.Client(
        callback_api_version=mqtt.CallbackAPIVersion.VERSION2,
        client_id=f"{credentials['device_id']}-{transport}-{uuid.uuid4().hex[:8]}",
        protocol=mqtt.MQTTv311,
        transport=transport,
    )
    client.tls_set(
        certfile=str(credentials["cert_file"]),
        keyfile=str(credentials["key_file"]),
        tls_version=ssl.PROTOCOL_TLS_CLIENT,
    )
    client.tls_insecure_set(False)
    if transport == "websockets":
        client.ws_set_options(path="/mqtt")
    return client


def wait_for_connect(client, host, port):
    connected = threading.Event()
    errors = []

    def on_connect(_client, _userdata, _flags, reason_code, _properties):
        if reason_code == 0 or str(reason_code) == "Success":
            connected.set()
        else:
            errors.append(f"connect failed with reason code {reason_code}")

    client.on_connect = on_connect
    client.connect(host, port, keepalive=20)
    client.loop_start()

    if not connected.wait(10):
        client.loop_stop()
        client.disconnect()
        if errors:
            pytest.fail(errors[-1])
        pytest.fail(f"MQTT client did not connect to {host}:{port}")


def assert_roundtrip(gateway_config, credentials, transport, port):
    topic = f"{gateway_config.topic_prefix}/{credentials['device_id']}/integration/{uuid.uuid4().hex}"
    payload = f"hello-{transport}-{time.time_ns()}"
    received = threading.Event()
    subscribed = threading.Event()
    received_payloads = []

    subscriber = make_client(gateway_config, credentials, transport)
    publisher = make_client(gateway_config, credentials, transport)

    def on_message(_client, _userdata, message):
        if message.topic == topic:
            received_payloads.append(message.payload.decode())
            received.set()

    def on_subscribe(_client, _userdata, _mid, _reason_codes, _properties):
        subscribed.set()

    subscriber.on_message = on_message
    subscriber.on_subscribe = on_subscribe
    wait_for_connect(subscriber, gateway_config.domain, port)
    subscriber.subscribe(topic, qos=1)
    assert subscribed.wait(10), f"Subscriber did not subscribe to {topic}"

    wait_for_connect(publisher, gateway_config.domain, port)
    result = publisher.publish(topic, payload, qos=1, retain=False)
    result.wait_for_publish(timeout=10)

    try:
        assert received.wait(10), f"Did not receive MQTT message over {transport}"
        assert payload in received_payloads
    finally:
        publisher.loop_stop()
        publisher.disconnect()
        subscriber.loop_stop()
        subscriber.disconnect()


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
