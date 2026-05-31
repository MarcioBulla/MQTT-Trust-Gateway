# MQTT Trust Gateway

MQTT Trust Gateway is a secure MQTT broker stack for VPS deployments.

It provides:

- Mosquitto with public TLS using Let's Encrypt
- device authentication with mutual TLS
- a Smallstep `step-ca` certificate authority for device certificates
- an Admin Web interface protected by passkeys/WebAuthn
- Nginx for the public HTTPS admin endpoint
- a setup wizard for DNS, firewall, certificates, and container startup

## Layout

```text
https://<MQTT_DOMAIN>          -> Admin Web with passkey login
mqtts://<MQTT_DOMAIN>:8883     -> MQTT TLS with device mTLS
wss://<MQTT_DOMAIN>:8443       -> MQTT over secure WebSocket with device mTLS
https://<STEP_CA_DOMAIN>:9000  -> step-ca API
```

## Requirements

On the VPS:

- Ubuntu 24.04 LTS or similar Linux server
- Docker Compose or Podman Compose
- DNS records for `<MQTT_DOMAIN>` and `<STEP_CA_DOMAIN>` pointing to the VPS public IP
- inbound ports `80/tcp`, `443/tcp`, `8883/tcp`, `8443/tcp`, and `9000/tcp`

VPS dependencies:

- `docker` with `docker compose`, or `podman` with `podman compose`
- `step`, the Smallstep CLI used to initialize and manage `step-ca`
- `openssl`, used for certificate and secret generation
- `python3`, used by the setup wizard to update `step-ca` configuration
- `curl` or `dig`, used by the setup wizard for public IP and DNS checks
- `ss` or `lsof`, used by the setup wizard for local port checks
- `ufw`, `firewalld`, or `iptables`, used to inspect or adjust local firewall rules
- `netfilter-persistent`, optional, used to persist `iptables` rules across reboots on Ubuntu/Debian

On Ubuntu/Debian, install the base OS tools with:

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg openssl python3 dnsutils iproute2 lsof ufw iptables
```

Install `step-cli` and `step-ca` using the official Smallstep guide:

[Smallstep step-ca installation guide](https://smallstep.com/docs/step-ca/installation/)

Install either Docker Compose or Podman Compose before running the wizard.

Port usage:

- `80/tcp`: Let's Encrypt HTTP challenge
- `443/tcp`: Admin Web HTTPS
- `8883/tcp`: MQTT TLS
- `8443/tcp`: MQTT over secure WebSocket
- `9000/tcp`: step-ca API, preferably restricted to trusted networks

## Setup

Run the wizard from the project root:

```bash
chmod +x setup-wizard.sh
sudo ./setup-wizard.sh
```

The wizard:

- writes `broker.env`
- checks container engine, DNS, firewall, and ports
- initializes `step-ca`
- exports the MQTT client CA
- saves the root CA fingerprint
- generates an Admin Web first-registration setup token
- starts `step-ca`, Certbot, Mosquitto, Admin Web, and Nginx

> [!NOTE]
> When the wizard asks for `Domain`, leave it empty to use the detected public VPS IP directly instead of a DNS name. In IP-only mode, DNS checks are skipped and Certbot is configured for Let's Encrypt IP address certificates with the `shortlived` profile.

After startup, open:

```text
https://<MQTT_DOMAIN>
```

Use the setup token printed by the wizard to register the first passkey.

## Device Credentials

Create device credentials from an operator/provisioning machine, not on the VPS when possible.

First time on the operator machine:

```bash
export MQTT_DOMAIN="<mqtt-domain>"
export STEP_CA_URL="https://<step-ca-domain>:<step-ca-port>"
export STEP_CA_PROVISIONER="<step-ca-provisioner>"
export STEP_CA_FINGERPRINT="<root-ca-fingerprint-from-broker-env>"
export STEP_CA_DEVICE_CERT_TTL="<device-certificate-ttl>"
export MQTT_TOPIC_PREFIX="<mqtt-topic-prefix>"

step ca bootstrap \
  --ca-url "${STEP_CA_URL}" \
  --fingerprint "${STEP_CA_FINGERPRINT}"
```

Create one device credential:

```bash
export DEVICE_ID="<device-id>"
DEVICE_DIR=./devices/${DEVICE_ID}
mkdir -p "${DEVICE_DIR}"

openssl genrsa -out "${DEVICE_DIR}/${DEVICE_ID}.key" 2048
chmod 600 "${DEVICE_DIR}/${DEVICE_ID}.key"

openssl req \
  -new \
  -key "${DEVICE_DIR}/${DEVICE_ID}.key" \
  -out "${DEVICE_DIR}/${DEVICE_ID}.csr" \
  -subj "/CN=${DEVICE_ID}" \
  -addext "subjectAltName=DNS:${DEVICE_ID},URI:urn:mqtt-trust-gateway:device:${DEVICE_ID}"

step ca sign \
  "${DEVICE_DIR}/${DEVICE_ID}.csr" \
  "${DEVICE_DIR}/${DEVICE_ID}.crt" \
  --provisioner "${STEP_CA_PROVISIONER}" \
  --not-after "${STEP_CA_DEVICE_CERT_TTL}"
```

The private key stays on the operator machine or device. The CA receives only the CSR.

You can also paste the CSR into the Admin Web and sign it there.

## Security Notes

- Do not commit `runtime/`, private keys, passwords, issued device keys, or production `broker.env` secrets.
- Restrict `9000/tcp` where practical.
- Prefer generating device private keys on a trusted provisioning workstation or directly on the device.
- Protect the step-ca provisioner password.
- Use passkeys for Admin Web access and remove stale admin data before handing the VPS to another operator.

## Goals

- [x] Mosquitto MQTT broker with public TLS
- [x] Let's Encrypt certificate automation with Certbot
- [x] Device authentication with mTLS
- [x] Smallstep `step-ca` integration for device certificate signing
- [x] CSR-first device credential flow
- [x] Setup wizard for DNS, ports, firewall, step-ca, and container startup
- [x] Admin Web entrypoint on `https://<MQTT_DOMAIN>`
- [x] Passkey/WebAuthn login for Admin Web
- [x] Admin Web CSR signing without storing device private keys
- [ ] Admin Web device inventory with certificate serial, fingerprint, expiration, and revocation status
- [ ] Certificate revocation from Admin Web using `step ca revoke`
- [ ] Broker health checks for Mosquitto, step-ca, Nginx, Certbot, and certificate expiration
- [ ] Optional IP allowlist or VPN-only mode for Admin Web and step-ca API
- [ ] Backup and restore documentation for `runtime/step-ca`, Admin Web data, and Mosquitto data
- [ ] Automatic log rotation guidance for Podman/Docker and host logs
- [ ] Non-interactive setup mode for CI or repeatable VPS provisioning
- [ ] Integration tests for the wizard, generated Mosquitto config, and Admin Web CSR signing flow
- [ ] Docker Compose validation examples for both Docker and Podman
- [ ] Safer provisioner flow using short-lived tokens instead of asking for the provisioner password in Admin Web
