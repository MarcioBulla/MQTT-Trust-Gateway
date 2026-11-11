<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import { api, action, state } from '../api';
import { ensureSensitive, revealScopes, isRevealed } from '../sensitive';
import HelpButton from './HelpButton.vue';

const props = defineProps({ deviceId: { type: String, required: true } });
const mode = ref('all'), publish = ref(''), subscribe = ref(''), loaded = ref(false);
let request = 0;
function clear() { request++; loaded.value = false; mode.value = 'all'; publish.value = ''; subscribe.value = ''; }
watch(() => revealScopes.devices, (grant) => { if (!grant) clear(); }, { flush: 'sync' });
onBeforeUnmount(clear);
async function load() {
  await ensureSensitive('devices');
  const grant = revealScopes.devices, id = ++request;
  const result = await api(`/devices/${encodeURIComponent(props.deviceId)}/rules`);
  if (id !== request || !isRevealed('devices') || revealScopes.devices !== grant) return;
  mode.value = result.rules.mode;
  publish.value = result.rules.publish.join('\n');
  subscribe.value = result.rules.subscribe.join('\n');
  loaded.value = true;
}
onMounted(() => action(load));
function lines(value) { return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean); }
function save() {
  action(async () => {
    await api(`/devices/${encodeURIComponent(props.deviceId)}/rules`, 'PUT', {
      mode: mode.value, publish: lines(publish.value), subscribe: lines(subscribe.value),
    });
    await load();
  }, 'Rules saved. Apply pending broker changes to enforce them.');
}
</script>

<template>
  <v-card class="pa-6">
    <div class="d-flex align-center ga-2 mb-2"><h2 class="text-h6">Topic rules</h2><HelpButton topic-id="device-topic-rules" /></div>
    <p class="text-body-2 text-medium-emphasis mb-4">Control where this identity can publish and which topics it can receive. Changes take effect after applying broker changes.</p>
    <template v-if="loaded">
      <v-radio-group v-model="mode" label="Access policy">
        <v-radio label="All topics (#)" value="all" />
        <v-radio label="Only configured topic filters" value="custom" />
      </v-radio-group>
      <v-alert v-if="mode === 'all'" type="warning" variant="tonal" class="mb-4">This identity can publish and receive messages on all ordinary topics, including other devices’ topics.</v-alert>
      <template v-else>
        <p class="text-body-2 mb-4">Enter one MQTT topic filter per line. An empty list denies that direction. Use + for one level and # as the final level.</p>
        <v-textarea v-model="publish" label="Publish topic filters" hint="Example: devices/sensor-01/command/+" persistent-hint rows="3" class="mb-3" />
        <v-textarea v-model="subscribe" label="Subscribe topic filters" hint="Example: devices/sensor-01/state" persistent-hint rows="3" class="mb-4" />
      </template>
      <v-btn color="primary" :loading="!!state.busy" @click="save">Save rules</v-btn>
    </template>
    <v-btn v-else variant="tonal" :loading="!!state.busy" @click="action(load)">Unlock rules</v-btn>
  </v-card>
</template>
