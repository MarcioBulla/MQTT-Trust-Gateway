import ssl
import threading
import time
import uuid

import paho.mqtt.client as mqtt
import pytest


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
