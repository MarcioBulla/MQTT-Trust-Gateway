<script setup>
import SensitiveValue from './SensitiveValue.vue';
import { computed, nextTick, onUnmounted, reactive, ref, watch } from 'vue';
import { revealScopes, isRevealed } from '../sensitive';
import { copy } from '../api';

const source = ref('admin'), connected = ref(false), logView = ref(null), error = ref('');
const following = reactive({ admin: true, broker: true }), scrolling = reactive({ admin: true, broker: true });
const follow = computed({ get: () => following[source.value], set: (value) => { following[source.value] = value; } });
const autoScroll = computed({ get: () => scrolling[source.value], set: (value) => { scrolling[source.value] = value; } });
const logs = reactive({ admin: '', broker: '' });
const available = reactive({ admin: false, broker: false });
const text = computed(() => logs[source.value]);
let stream;
function close() { stream?.close(); stream = null; connected.value = false; }
function connect() {
  close(); error.value = '';
  if (!follow.value || !isRevealed('audit')) { logs.admin = ''; logs.broker = ''; return; }
  const current = source.value;
  stream = new EventSource(`/api/logs/events?source=${current}`);
  stream.onopen = () => { connected.value = true; error.value = ''; };
  stream.onerror = () => { connected.value = false; error.value = 'Connection interrupted. Reconnecting…'; };
  stream.addEventListener('logs', (event) => {
    if (!isRevealed('audit')) return;
    const snapshot = JSON.parse(event.data);
    logs[current] = snapshot.text; available[current] = snapshot.available;
  });
  stream.addEventListener('log-error', () => {
    error.value = 'The log source is unavailable. Resume follow to retry.';
    follow.value = false; close();
  });
}
async function scrollToEnd() {
  await nextTick();
  if (autoScroll.value && logView.value) logView.value.scrollTop = logView.value.scrollHeight;
}
watch([source, follow, () => revealScopes.audit], connect, { immediate: true });
watch([text, autoScroll], scrollToEnd);
onUnmounted(close);
</script>

<template>
  <v-card class="pa-4">
    <v-tabs v-model="source" density="compact" class="mb-4" aria-label="Service log sources"><v-tab value="admin">Admin</v-tab><v-tab value="broker">MQTT broker</v-tab></v-tabs>
    <div class="d-flex flex-wrap align-center justify-space-between ga-3 mb-3">
      <div class="d-flex align-center ga-2"><v-chip size="small" :color="!follow ? 'default' : connected ? 'success' : 'warning'">{{ !follow ? 'Paused' : connected ? 'Following' : 'Connecting' }}</v-chip><span class="text-caption text-medium-emphasis">Latest 500 lines · updates every second</span></div>
      <div class="d-flex flex-wrap align-center ga-2"><v-switch v-model="autoScroll" label="Auto-scroll" density="compact" hide-details color="primary" /><v-btn size="small" variant="tonal" :prepend-icon="follow ? 'mdi-pause' : 'mdi-play'" @click="follow = !follow">{{ follow ? 'Pause' : 'Follow' }}</v-btn><v-btn icon="mdi-content-copy" size="small" variant="text" :disabled="!text" aria-label="Copy visible logs" @click="copy(text)" /></div>
    </div>
    <v-alert v-if="error" type="warning" variant="tonal" density="compact" class="mb-3">{{ error }}</v-alert>
    <pre ref="logView" class="runtime-log" tabindex="0" :aria-label="`${source === 'admin' ? 'Admin' : 'MQTT broker'} live logs`"><SensitiveValue scope="audit"><span>{{ text || (available[source] ? 'No log entries yet.' : 'Waiting for service logs…') }}</span></SensitiveValue></pre>
  </v-card>
</template>

<style scoped>
.runtime-log { height: 420px; max-height: 65vh; overflow: auto; padding: 16px; border-radius: 8px; background: #101419; color: #d1e1dc; font: 12px/1.65 monospace; white-space: pre-wrap; overflow-wrap: anywhere; tab-size: 2; }
</style>
