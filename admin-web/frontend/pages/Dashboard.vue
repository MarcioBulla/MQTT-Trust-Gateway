<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue';
import { api, action, copy } from '../api';
const status = ref(null);
let timer;
const load = () =>
  action(async () => {
    status.value = await api('/status');
  });
onMounted(() => {
  load();
  timer = setInterval(load, 15000);
});
onUnmounted(() => clearInterval(timer));
const host = computed(() => status.value?.domain || status.value?.localAddress || 'localhost');
const steps = computed(() => [
  [
    '1. Register a device',
    'Open Devices and create an identifier such as sensor-01. The identifier becomes the certificate CN and MQTT ACL identity.',
  ],
  [
    '2. Generate a key and CSR on the device',
    'openssl req -new -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout sensor-01.key -out sensor-01.csr -subj /CN=sensor-01',
  ],
  [
    '3. Issue a certificate',
    'Select Issue in Devices, paste the CSR, choose a validity and download the resulting public certificate. Keep the private key on the device.',
  ],
  [
    '4. Download the CA',
    'Use Download CA below and configure it as the trust anchor on your device.',
  ],
  [
    '5. Connect using mTLS',
    `mosquitto_pub -h ${host.value} -p ${status.value?.mqttTlsPort || 8883} --cafile gateway-ca.crt --cert sensor-01.crt --key sensor-01.key -t devices/sensor-01/hello -m hello -q 1`,
  ],
  [
    '6. Renew',
    'Open Licenses, select Renew and submit a new CSR if the device key has changed. Renewal issues a new serial. Revoke the old serial when no longer needed.',
  ],
  [
    '7. Revoke',
    'Revoke a certificate in Licenses or disable the device in Devices. Use Apply changes in the banner and check broker acknowledgement. Shift-click a final action to apply immediately.',
  ],
  [
    '8. Connect using WebSocket',
    `Use wss://${host.value}:${status.value?.mqttWsPort || 8443}/mqtt with a native MQTT client that supplies the device certificate and key. Browser JavaScript cannot select TLS client certificates; install a certificate in the browser/OS if supported. The console uses the authenticated backend bridge.`,
  ],
  [
    '9. Add an external proxy',
    'See docs/proxy.md. Set PUBLIC_URL and exact TRUSTED_PROXIES addresses, forward HTTP/WebSocket and preserve the public origin. Raw MQTT TLS needs a separate TCP forwarding capability. No proxy is installed by this gateway.',
  ],
]);
</script>
<template>
  <div class="d-flex align-center justify-space-between mb-6">
    <div>
      <div class="text-overline text-primary">GATEWAY OVERVIEW</div>
      <h1 class="text-h4 font-weight-bold">Your trust boundary</h1>
      <p class="text-medium-emphasis mt-2">
        Live service state, identities, and certificate health.
      </p>
    </div>
    <v-btn icon="mdi-refresh" aria-label="Refresh status" @click="load" />
  </div>
  <template v-if="status">
    <v-row
      ><v-col
        v-for="[label, value] in [
          ['Registered devices', status.registeredDevices],
          ['Valid certificates', status.validCertificates],
          ['Expiring within 30 days', status.expiringCertificates],
          ['Expired certificates', status.expiredCertificates],
        ]"
        :key="label"
        cols="12"
        sm="6"
        lg="3"
        ><v-card class="pa-5"
          ><div class="text-medium-emphasis">{{ label }}</div>
          <div class="metric mt-2">{{ value }}</div></v-card
        ></v-col
      ></v-row
    >
    <v-row class="mt-2"
      ><v-col cols="12" md="6"
        ><v-card class="pa-6 h-100"
          ><h2 class="text-h6 mb-4">Service health</h2>
          <v-chip :color="status.mqtt.connected ? 'success' : 'error'" class="mb-4"
            >Broker {{ status.mqtt.connected ? 'connected' : 'unavailable' }}</v-chip
          ><v-chip class="mb-4 ml-2" :color="status.ca ? 'success' : 'error'"
            >Local CA {{ status.ca ? 'ready' : 'unavailable' }}</v-chip
          >
          <p v-if="status.mqtt.lastError" class="text-error mb-3">{{ status.mqtt.lastError }}</p>
          <p class="text-body-2 mb-3">
            Connected devices: unavailable. Certificate validity does not indicate an active
            connection.
          </p>
          <p class="text-body-2">
            Broker authorization revision: {{ status.enforcement.applied ? 'Applied' : 'Pending' }}
          </p>
          <p class="text-caption text-medium-emphasis mono mt-2">
            {{ status.enforcement.revision }}
          </p>
          <v-divider class="my-4" />
          <div>CA expires: {{ status.ca?.validTo }}</div>
          <div>Broker certificate expires: {{ status.serverCertificate?.validTo }}</div>
          <v-btn class="mt-4" href="/api/certificates/ca" prepend-icon="mdi-download"
            >Download CA</v-btn
          ></v-card
        ></v-col
      >
      <v-col cols="12" md="6"
        ><v-card class="pa-6 h-100"
          ><h2 class="text-h6 mb-4">Connection details</h2>
          <v-table class="connection-table"
            ><tbody>
              <tr
                v-for="[label, value] in [
                  ['Hostname', status.hostname],
                  ['Domain', status.domain || 'Not configured'],
                  ['Public IP', status.publicIP || 'Not configured'],
                  ['Local address', status.localAddress],
                  ['Admin URL', status.publicUrl],
                  ['Admin port', status.adminPort],
                  ['MQTT TLS', status.mqttTlsPort],
                  ['MQTT WebSocket TLS', status.mqttWsPort],
                ]"
                :key="label"
              >
                <td>{{ label }}</td>
                <td class="mono">{{ value }}</td>
                <td>
                  <v-btn
                    size="small"
                    icon="mdi-content-copy"
                    :aria-label="`Copy ${label}`"
                    variant="text"
                    @click="copy(String(value))"
                  />
                </td>
              </tr></tbody></v-table></v-card></v-col
    ></v-row>
    <h2 class="text-h5 font-weight-bold mt-8 mb-4">From first device to first message</h2>
    <v-expansion-panels variant="accordion"
      ><v-expansion-panel v-for="[title, text] in steps" :key="title" :title="title"
        ><v-expansion-panel-text>
          <pre>{{ text }}</pre>
          <v-btn size="small" class="mt-3" prepend-icon="mdi-content-copy" @click="copy(text)"
            >Copy</v-btn
          ></v-expansion-panel-text
        ></v-expansion-panel
      ></v-expansion-panels
    >
  </template>
</template>
