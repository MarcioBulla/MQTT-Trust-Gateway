# step-ca Server

This directory contains only the compose file used to run the MQTT Trust Gateway device certificate authority on the broker VPS.

Use the broker setup wizard from the project root:

```bash
sudo ./setup-wizard.sh
```

The wizard initializes and configures the CA under `${BASE_DIR}/step-ca`, exports the MQTT client CA to `${BASE_DIR}/pki/step-ca/ca.crt`, and starts the `step-ca` container.
