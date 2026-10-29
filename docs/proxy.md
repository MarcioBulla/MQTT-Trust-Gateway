# Optional external proxy

The gateway installs no proxy, tunnel, public CA client or ACME automation.
It runs at http://localhost:8080 by default, with TLS MQTT on 8883 and WSS on
8443. For LAN administration without a domain, provide a certificate trusted
by your clients using ADMIN_TLS_CERT and ADMIN_TLS_KEY (paths inside /data),
change PUBLIC_URL to https://your-LAN-host:8080, and set ADMIN_BIND appropriately.
This serves HTTPS directly from Node. A private CA trusted by your devices is
sufficient; public DNS and Let's Encrypt are not required.

Remote HTTP administration is rejected. To administer a remote installation
locally, use an SSH local port forward and keep PUBLIC_URL=http://localhost:8080.
Passkeys require HTTPS with an appropriate RP hostname or localhost. Changing
RP hostname requires registering new passkeys; existing password/TOTP access
can be used to do so. Do not bypass secure-context checks.

For a proxy on the shared network use `http://mqtt-admin:8080`. Set PUBLIC_URL
to the final HTTPS origin, ALLOWED_ORIGINS to any additional exact browser
origins (comma-separated; no wildcards), and TRUSTED_PROXIES to the proxy's actual
source IP or narrow CIDR. Do not trust all peers on a shared network. Preserve
Host; set X-Forwarded-Proto=https. Requests from untrusted peers cannot assert
HTTPS through forwarding headers. Allow credentials only on the same origin.
The console uses HTTP REST and server-sent events; disable proxy buffering for
`/api/mqtt/events`, and allow long-lived responses.

## Existing Nginx example (documentation only)

```nginx
server {
    listen 443 ssl;
    server_name gateway.example.com;
    ssl_certificate /your/existing/fullchain.pem;
    ssl_certificate_key /your/existing/key.pem;
    location / {
        proxy_pass http://mqtt-admin:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto https;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

Nginx must already exist, own its TLS configuration, and resolve the backend
(e.g. by joining mqtt-gateway). For broker WSS with client certificates, use
TCP TLS passthrough to 8443 unless your design explicitly preserves and verifies
client identity. An ordinary TLS-terminating HTTP proxy discards the device's
TLS certificate and cannot authenticate as that device to the broker.

Raw MQTT TLS on 8883 requires a TCP forwarding/stream capability, separately
from an HTTP virtual host. For example an existing Nginx stream configuration
can forward TCP bytes to mqtt-broker:8883 without terminating TLS. It requires
Nginx's stream module. Do not send raw MQTT to an HTTP proxy_pass endpoint.

## Existing proxy or tunnel

Configure an HTTPS origin for the admin upstream reachable from your existing
proxy or connector, such as `mqtt-admin:8080` when it joins `mqtt-gateway`. Set
`PUBLIC_URL` to the final HTTPS origin and trust only the proxy's actual source
addresses. Preserve the public Host and HTTPS forwarding information, and allow
server-sent events. If the proxy adds its own authentication, configure it to
coexist with the Gateway's sessions.

Only use raw TCP forwarding for MQTT TLS endpoints. An HTTP resource alone does
not forward raw MQTT or preserve mTLS certificates. Verify that the selected
proxy or tunnel supports raw TCP passthrough before exposing `mqtt-broker:8883`
or the configured WSS listener.

For full public hostname validation on raw TCP routes, configure
`MQTT_BROKER_EXTRA_SANS=mqtt.example.com` in `gateway.env` and run
`./gateway broker-certificate` with the updated image installed. This changes
only the Mosquitto server certificate and preserves the CA and device trust.
See [controlled SAN updates](../README.md#public-mqtt-hostnames-and-broker-sans).
An HTTPS certificate used by the admin web proxy does not cover the raw TCP
broker endpoint: the device must trust `server-ca.crt` and verify the broker's DNS SAN.

## Protocol map

| Endpoint | Protocol | External integration |
|---|---|---|
| 8080 | HTTP or native HTTPS admin, REST, SSE | Optional HTTP reverse proxy |
| 8883 | MQTT over TLS, mandatory client certificates | TCP passthrough |
| 8443 | MQTT over secure WebSocket, mandatory client certificates | TCP passthrough to preserve mTLS |

For TLS/CRL and listener options see the [Mosquitto reference](https://mosquitto.org/man/mosquitto-conf-5.html).

## KeePassXC on localhost

KeePassXC has an additional desktop setting for passkeys on HTTP localhost,
separate from enabling passkeys in KeePassXC-Browser. Its default is disabled.
The same provider may therefore work on HTTPS sites while rejecting a local
HTTP origin. For local testing, review **Settings → Browser Integration →
Advanced → Allow using localhost with passkeys** in KeePassXC. Alternatively use
native HTTPS with a certificate trusted by your browser. The gateway does not
change this setting or relax RP/origin/user-verification checks. See
[KeePassXC's origin validation](https://github.com/keepassxreboot/keepassxc/blob/develop/src/browser/PasskeyUtils.cpp)
and [settings UI](https://github.com/keepassxreboot/keepassxc/blob/develop/src/browser/BrowserSettingsWidget.ui).

The login form exposes stable username, password and TOTP input names and
standard autocomplete values (`username`, `current-password`, `one-time-code`).
Store the actual gateway URL in the password-manager entry. If using its TOTP
autofill, configure the gateway's TOTP seed in that same entry.
