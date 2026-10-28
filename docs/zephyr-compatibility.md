# Zephyr RTOS compatibility

Status checked: 2026-10-28. The Zephyr release table lists **4.4.0 as the latest
stable release** (released 2026-04-14). The 4.5 documentation currently identifies
itself as a release candidate; this guide targets the stable 4.4.0 API. The local
Zephyr workspace available for this review identifies itself as `4.4.99`
(`v4.4.0-16104-g64437be51c3`), a development snapshot after the stable tag. The
MQTT/TLS and secure WebSocket example translation unit compiled for
`esp32c3_devkitc` against that checkout. A full image build did not complete:
the checkout's Mbed TLS/TF-PSA configuration failed in upstream crypto sources.
No firmware image or hardware handshake was verified. Stable API statements
were separately checked against the official 4.4.0 headers.

## Provisioning methods

The Gateway supports four certificate workflows:

1. **Sign a device CSR.** The device creates and retains its private key, sends a
   signed PEM CSR, and receives a client certificate. This is the preferred
   method when the board can create its key locally.
2. **Gateway CSR for external signing.** The Gateway creates an ephemeral key,
   delivers it once, and retains the CSR/public key metadata. The private key is
   not stored in SQLite or on persistent storage. This is useful for a
   separately operated CA, but key delivery still requires a secure admin
   session and protected handling by the operator.
3. **Gateway-generated client certificate.** The Gateway generates a key,
   issues the certificate under its local CA, and returns the key only in the
   one-time download response. This is the simplest path for devices whose
   firmware does not implement CSR creation. Install the downloaded key in a
   hardware-backed or otherwise protected store where available.
4. **Import an existing client certificate.** The issuer chain must be
   provided or already known. The certificate is registered even when the
   issuer is not trusted, but Mosquitto refuses it until an administrator
   explicitly approves that CA.

Only PEM is returned by default. Zephyr TLS credential support is based on the
selected TLS backend: DER is supported by default in the Mbed TLS socket API,
while PEM parsing must be enabled in the application configuration. Convert
PEM to DER during firmware packaging only if the board configuration needs it.

## MQTT over TLS with mTLS

The device needs two trust directions: its own client certificate and private
key for authenticating to the Gateway, and the Gateway server CA certificate
for authenticating the broker. For this Gateway the local CA signs both, so the
downloaded CA file fills both roles. Keep the hostname equal to a DNS name or IP
address present in the broker certificate SAN. Do not disable peer verification.

Example configuration (network interface, DNS, addressing, buffers and event
loop are application-specific):

```conf
CONFIG_NETWORKING=y
CONFIG_NET_SOCKETS=y
CONFIG_NET_SOCKETS_SOCKOPT_TLS=y
CONFIG_MQTT_LIB=y
CONFIG_MQTT_LIB_TLS=y
CONFIG_MBEDTLS=y
CONFIG_MBEDTLS_SSL_PROTO_TLS1_2=y
CONFIG_MBEDTLS_KEY_EXCHANGE_ECDHE_ECDSA_ENABLED=y
CONFIG_MBEDTLS_X509_CRT_PARSE_C=y
CONFIG_MBEDTLS_PEM_PARSE_C=y
CONFIG_MBEDTLS_HAVE_TIME_DATE=y
CONFIG_PSA_WANT_ALG_ECDH=y
CONFIG_PSA_WANT_ALG_ECDSA=y
# RSA-2048 devices may also need the matching RSA key exchange and PSA options.
# For DER credentials, PEM parsing can be omitted.
```

Register the PEM credentials once after networking is ready. The strings below
stand for the contents of `client-ca.crt`, `device.crt`, and `device.key` from
the Gateway download. The security tags are application-local identifiers.

```c
#include <zephyr/net/mqtt.h>
#include <zephyr/net/tls_credentials.h>
#include <zephyr/net/socket.h>
#include <string.h>

#define CA_TAG       10
#define CLIENT_TAG   11
#define MQTT_HOST    "gateway.example.lan"
#define MQTT_PORT    8883

static const unsigned char server_ca[] = "-----BEGIN CERTIFICATE-----\n...\n";
static const unsigned char device_cert[] = "-----BEGIN CERTIFICATE-----\n...\n";
static const unsigned char device_key[] = "-----BEGIN PRIVATE KEY-----\n...\n";
static const sec_tag_t tags[] = { CA_TAG, CLIENT_TAG };
static struct mqtt_client client;
static struct sockaddr_in broker;
static unsigned char rx_buf[1024], tx_buf[1024];

static void mqtt_event(struct mqtt_client *client, const struct mqtt_evt *event)
{
    ARG_UNUSED(client);
    if (event->type == MQTT_EVT_CONNACK && event->result == 0) {
        /* TLS peer verification completed before MQTT CONNACK. */
    }
}

static int register_credentials(void)
{
    int ret;

    ret = tls_credential_add(CA_TAG, TLS_CREDENTIAL_CA_CERTIFICATE,
                             server_ca, sizeof(server_ca) - 1);
    if (ret != 0) return ret;
    ret = tls_credential_add(CLIENT_TAG, TLS_CREDENTIAL_PUBLIC_CERTIFICATE,
                             device_cert, sizeof(device_cert) - 1);
    if (ret != 0) return ret;
    return tls_credential_add(CLIENT_TAG, TLS_CREDENTIAL_PRIVATE_KEY,
                              device_key, sizeof(device_key) - 1);
}

static int configure_secure_mqtt(void)
{
    struct zsock_addrinfo hints = {0};
    struct zsock_addrinfo *addresses = NULL;
    int ret = register_credentials();
    if (ret != 0) return ret;

    hints.ai_family = AF_INET;
    hints.ai_socktype = SOCK_STREAM;
    ret = zsock_getaddrinfo(MQTT_HOST, "8883", &hints, &addresses);
    if (ret != 0) return ret;
    memcpy(&broker, addresses->ai_addr, sizeof(broker));
    zsock_freeaddrinfo(addresses);

    mqtt_client_init(&client);
    client.broker = &broker;
    client.evt_cb = mqtt_event;
    client.client_id.utf8 = (uint8_t *)"zephyr-sensor-01";
    client.client_id.size = sizeof("zephyr-sensor-01") - 1;
    client.protocol_version = MQTT_VERSION_3_1_1;
    client.transport.type = MQTT_TRANSPORT_SECURE;
    client.transport.tls.config.peer_verify = TLS_PEER_VERIFY_REQUIRED;
    client.transport.tls.config.sec_tag_list = tags;
    client.transport.tls.config.sec_tag_count = sizeof(tags) / sizeof(tags[0]);
    client.transport.tls.config.hostname = MQTT_HOST;
    client.rx_buf = rx_buf;
    client.rx_buf_size = sizeof(rx_buf);
    client.tx_buf = tx_buf;
    client.tx_buf_size = sizeof(tx_buf);

    return mqtt_connect(&client);
}
```

The example assumes IPv4 and a configured DNS resolver. After connecting, poll
`client.transport.tls.sock` and call `mqtt_input()` and `mqtt_live()` as
described by the MQTT client API. Handle connection events and errors in the
callback; never treat a successful TCP connection as proof that the TLS peer
was verified.

The Zephyr 4.4.0 TLS credentials header does **not** define
`TLS_CREDENTIAL_PRIVATE_KEY_PSA`. Current 4.5 release-candidate API docs add
that credential type; its payload is a `psa_key_id_t` for a key already
resident in PSA, replacing `TLS_CREDENTIAL_PRIVATE_KEY`. Do not use this
credential type in a 4.4 application. On releases that provide it, check the
Mbed TLS/PSA configuration, TLS socket backend, and SoC support. The Gateway
does not require exporting a PSA-backed key.

## MQTT over secure WebSocket (WSS)

Zephyr 4.4's MQTT API includes `MQTT_TRANSPORT_SECURE_WEBSOCKET`, gated by
`CONFIG_MQTT_LIB_WEBSOCKET`, `CONFIG_WEBSOCKET_CLIENT`, and
`CONFIG_MQTT_LIB_TLS`. Use the secure websocket transport, set the WebSocket
request host and path (`/mqtt`), configure the TLS peer verification, hostname,
and credential tags just as for direct MQTT/TLS, and connect to the Gateway's
WSS port (default 8443). The Gateway's WSS listener requires a client
certificate just like its direct MQTT/TLS listener.

Add these options to `prj.conf` for WSS:

```conf
CONFIG_MQTT_LIB_WEBSOCKET=y
CONFIG_WEBSOCKET_CLIENT=y
```

WSS wraps MQTT in HTTP WebSocket framing. It is not raw MQTT/TCP and an HTTP
proxy must support WebSocket upgrade. A proxy terminating TLS also terminates
the device's mTLS identity; it must re-authenticate to the broker using a
defined, trusted design. The Gateway does not trust arbitrary identity headers.
Browser JavaScript cannot generally select a client certificate/private key
for its native WebSocket connection; this limitation does not apply to native
Zephyr TLS sockets.

For 4.4, the transport selection and TLS settings are separate fields in the
MQTT context:

```c
client.transport.type = MQTT_TRANSPORT_SECURE_WEBSOCKET;
client.transport.websocket.config.host = MQTT_HOST;
client.transport.websocket.config.url = "/mqtt";
client.transport.websocket.config.tmp_buf = ws_handshake_buffer;
client.transport.websocket.config.tmp_buf_len = sizeof(ws_handshake_buffer);
client.transport.tls.config.peer_verify = TLS_PEER_VERIFY_REQUIRED;
client.transport.tls.config.sec_tag_list = tags;
client.transport.tls.config.sec_tag_count = sizeof(tags) / sizeof(tags[0]);
client.transport.tls.config.hostname = MQTT_HOST;
```

Resolve `MQTT_HOST`, set the broker port to 8443, assign the broker address,
and provide normal MQTT RX/TX buffers and callbacks as in the TCP example.
This snippet is API guidance; it has not been compiled in a Zephyr workspace.

## CSR creation on the device

CSR creation is optional. Zephyr applications can use Mbed TLS X.509 CSR
functions and PSA Crypto to generate a P-256 key and sign a CSR locally. The
official TF-M PSA Crypto sample demonstrates a persistent `secp256r1` key and
PEM CSR generation. This usually requires application-specific Kconfig, memory
and storage settings, and a platform that supports the chosen PSA key policy.
The Gateway-generated certificate method remains available if an application
does not implement CSR generation.

## Algorithms and platform constraints

- Prefer ECDSA P-256 with SHA-256 for small certificates and constrained
  devices. RSA-2048 is available for compatibility, with higher RAM, flash, and
  handshake cost.
- The Gateway's CSR and import validation accepts RSA keys of at least 2048
  bits and EC curves prime256v1, secp384r1, or secp521r1. Device key support is
  constrained by each board's Mbed TLS/PSA configuration and hardware.
- Client certificates use X.509 v3, `CA:FALSE`, digital-signature Key Usage,
  and `clientAuth` Extended Key Usage. The Gateway controls the MQTT identity
  using the certificate CN and ignores CSR-requested extensions.
- A device must have a usable wall clock for certificate validity checks. A
  secure time source is required if the clock resets or starts at an invalid
  date.
- PEM is convenient for provisioning; DER can reduce stored size but must be
  converted and registered in the exact format enabled by the TLS backend.
- Flash encryption, secure boot, hardware-backed key slots, secure elements,
  and PSA persistent storage are board/application responsibilities. A downloaded
  exportable private key is a bearer credential and should be protected from
  firmware images, logs, source control, and debug dumps.

## ESP32-C3 and ESP32-C6 verification

The MQTT/TLS and MQTT/WSS example code compiled as a translation unit for
ESP32-C3 against the available 4.4.99 development snapshot. The full image build
failed inside that checkout's Mbed TLS/TF-PSA sources before link. ESP32-C6 has
not been compiled, and no on-board handshake was performed. Treat this as
experimental source-level verification only. Compile a product application
with its selected stable Zephyr release, SDK, board target, Wi-Fi configuration,
TLS backend and key-storage settings, then test against the Gateway's 8883 or
8443 listener.

## Official references

- [Supported Zephyr releases](https://docs.zephyrproject.org/latest/releases/index.html)
- [Zephyr 4.4.0 MQTT documentation](https://docs.zephyrproject.org/4.4.0/services/connectivity/networking/api/mqtt.html)
- [Zephyr WebSocket client](https://docs.zephyrproject.org/latest/services/connectivity/networking/api/websocket.html)
- [TLS credentials API](https://docs.zephyrproject.org/latest/doxygen/html/group__tls__credentials.html)
- [Zephyr 4.4 MQTT transport declarations](https://github.com/zephyrproject-rtos/zephyr/blob/v4.4.0/include/zephyr/net/mqtt.h)
- [Zephyr 4.4 TLS credential declarations](https://github.com/zephyrproject-rtos/zephyr/blob/v4.4.0/include/zephyr/net/tls_credentials.h)
- [Zephyr TF-M PSA Crypto sample](https://github.com/zephyrproject-rtos/zephyr/blob/main/samples/tfm_integration/psa_crypto/src/psa_crypto.c)
