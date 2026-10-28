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

## Existing external proxy installation (documentation only)

Configure an HTTP resource for the admin upstream reachable from your existing
connector, e.g. mqtt-admin:8080 if the connector participates in mqtt-gateway.
Set the gateway's PUBLIC_URL to that resource's HTTPS origin and trust only the
actual connector/proxy source addresses. Preserve the public Host and HTTPS
forwarding information, and permit SSE. If that external proxy resource imposes its
own authentication, configure it to coexist with the gateway's sessions.

Whether TCP or UDP resources and TLS passthrough are available depends on your
external proxy deployment/version. Only expose mqtt-broker:8883 or :8443 through a
resource that actually supports raw TCP passthrough. An HTTP resource alone
does not provide raw MQTT forwarding or preserve mTLS certificates. Follow the
official documentation for your installed version: https://docs.external proxy.net/ .

## Protocol map

| Endpoint | Protocol | External integration |
|---|---|---|
| 8080 | HTTP or native HTTPS admin, REST, SSE | Optional HTTP reverse proxy |
| 8883 | MQTT over TLS, mandatory client certificates | TCP passthrough |
| 8443 | MQTT over secure WebSocket, mandatory client certificates | TCP passthrough to preserve mTLS |

For TLS/CRL and listener options see the [Mosquitto reference](https://mosquitto.org/man/mosquitto-conf-5.html).
