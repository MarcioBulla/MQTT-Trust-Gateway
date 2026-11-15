<script setup>
import { ref, watch } from 'vue';
import { api, action, copy, markBrokerMutation } from '../api';
import HelpButton from './HelpButton.vue';
const props = defineProps({ deviceId: { type: String, required: true } });
const config = ref(null), status = ref('unknown');
async function load() {
  const response = await api(`/devices/${encodeURIComponent(props.deviceId)}/health`);
  if (response) { config.value = response.config; status.value = response.status; }
}
watch(() => props.deviceId, () => action(load), { immediate: true });
function save() {
  action(async () => {
    const result = await api(`/devices/${encodeURIComponent(props.deviceId)}/health`, 'PUT', config.value);
    config.value = result.config; status.value = result.status; markBrokerMutation();
  }, 'Health Check saved. Apply pending broker changes before monitoring.');
}
</script>
<template>
  <v-card v-if="config" class="pa-6">
    <div class="d-flex align-center justify-space-between"><div class="d-flex align-center ga-2"><h2 class="text-h6">Health Check</h2><HelpButton topic-id="device-health-check" /></div><v-btn variant="text" prepend-icon="mdi-refresh" @click="action(load)">Refresh</v-btn></div>
    <p class="text-body-2 text-medium-emphasis my-3">Passively monitor MQTT connection status. A retained status alone does not prove that a device is connected.</p>
    <v-switch v-model="config.enabled" label="Enable Health Check" color="primary" hide-details />
    <v-text-field v-model="config.topic" label="Health Topic" append-inner-icon="mdi-content-copy" @click:append-inner="copy(config.topic)" />
    <v-alert type="info" variant="tonal" class="mb-4">The selected topic is reserved for this device. Its publish Rules must allow the topic. Apply broker changes after saving.</v-alert>
    <p>Monitoring Strategy: <strong>MQTT LWT + Retain + QoS 1</strong></p>
    <p>Current Status: <strong>{{ status }}</strong></p>
    <p>Expected Keep Alive: <strong>60 seconds</strong> (configured by firmware)</p>
    <p class="mt-3">Configure the MQTT Will as <code>offline</code>, QoS 1 and retain. After connecting, publish <code>online</code> with QoS 1 and retain. Publish <code>offline</code> before a clean disconnect.</p>
    <p class="text-body-2 text-medium-emphasis">Use one MQTT session per device identity. Simultaneous sessions sharing an identity can report conflicting status. After a broker or Gateway restart, status remains Unknown until a new live publication is received.</p>
    <v-btn variant="text" prepend-icon="mdi-content-copy" @click="copy(`Topic: ${config.topic}\nOnline: online\nOffline / Will: offline\nQoS: 1\nRetain: true\nKeep Alive: 60 seconds`)">Copy MQTT parameters</v-btn>
    <v-expansion-panels class="mt-4"><v-expansion-panel title="Advanced Settings"><v-expansion-panel-text>
      <v-text-field v-model.number="config.offlineGrace" type="number" min="0" max="3600" label="Offline Grace Period (seconds)" />
      <v-text-field v-model.number="config.recoveryStability" type="number" min="0" max="3600" label="Recovery Stability Period (seconds)" />
      <p class="text-body-2">Unknown periods are excluded from uptime and old retained messages do not establish the current state.</p>
    </v-expansion-panel-text></v-expansion-panel></v-expansion-panels>
    <div class="d-flex justify-end mt-4"><v-btn color="primary" @click="save">Save Health Check</v-btn></div>
  </v-card>
</template>
