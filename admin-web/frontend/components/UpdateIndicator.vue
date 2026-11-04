<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { state } from '../api';
const router = useRouter();
const status = ref(null), notifications = ref(true);
let timer;
const operation = computed(() => status.value?.controller?.operation);
const working = computed(() => operation.value && !['COMPLETED', 'ROLLED_BACK', 'FAILED', 'RECOVERY_REQUIRED'].includes(operation.value.state));
const failed = computed(() => operation.value && ['FAILED', 'RECOVERY_REQUIRED', 'ROLLED_BACK'].includes(operation.value.state));
const visible = computed(() => state.user && ((notifications.value && status.value?.latest?.installable) || working.value || failed.value));
const label = computed(() => working.value ? 'Gateway update in progress' : failed.value ? 'Gateway update needs review' : 'Gateway update available');
async function refresh() {
  if (!state.user) { status.value = null; return; }
  try {
    const configResponse = await fetch('/api/system-updates/config', { credentials: 'same-origin', cache: 'no-store' });
    if (!configResponse.ok) return;
    const config = await configResponse.json();
    notifications.value = config.notifications !== false;
    const response = await fetch('/api/system-updates/status?channel=' + encodeURIComponent(config.channel) + '&cached=1', { credentials: 'same-origin', cache: 'no-store' });
    if (response.ok) status.value = await response.json();
  } catch { /* Release availability never interrupts administration. */ }
}
function view() {
  router.push({ path: '/settings', query: { tab: 'updates', version: working.value || failed.value ? operation.value.version : status.value.latest.version } });
}
watch(() => [state.user, state.updatesRevision], refresh);
onMounted(() => { refresh(); timer = setInterval(refresh, 30_000); });
onUnmounted(() => clearInterval(timer));
</script>
<template>
  <v-menu v-if="visible" location="bottom end">
    <template #activator="{ props }">
      <v-btn v-bind="props" :icon="failed ? 'mdi-alert-circle-outline' : working ? 'mdi-progress-download' : 'mdi-download-circle-outline'" :color="failed ? 'warning' : 'primary'" :aria-label="label">
        <v-badge dot :color="failed ? 'warning' : working ? 'primary' : 'success'"><v-icon :icon="failed ? 'mdi-alert-circle-outline' : working ? 'mdi-progress-download' : 'mdi-download-circle-outline'" /></v-badge>
        <v-tooltip activator="parent" location="bottom">{{ label }}</v-tooltip>
      </v-btn>
    </template>
    <v-card class="pa-4" min-width="280" max-width="420">
      <div class="text-subtitle-1 font-weight-bold">{{ label }}</div>
      <div class="text-body-2 text-medium-emphasis mt-1">Installed: {{ status.installed.version }}</div>
      <div v-if="working || failed" class="text-body-2 mt-2">{{ operation.version }} · {{ operation.state.replaceAll('_', ' ') }}</div>
      <template v-else><div class="text-body-2 mt-2">{{ status.latest.version }} · {{ status.latest.channel }}</div><p class="text-body-2 text-medium-emphasis mt-2 update-summary">{{ status.latest.changelog?.slice(0, 400) || 'Open the release details to review this update.' }}</p></template>
      <v-btn class="mt-3" color="primary" block @click="view">View update</v-btn>
    </v-card>
  </v-menu>
</template>
<style scoped>.update-summary { white-space: pre-wrap; overflow-wrap: anywhere; }</style>
