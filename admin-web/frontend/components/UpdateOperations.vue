<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { startAuthentication } from '@simplewebauthn/browser';
import { api, copy, state } from '../api';
import DataList from './DataList.vue';
import DateTime from './DateTime.vue';
const props = defineProps({ release: { type: Object, default: null } });
const emit = defineEmits(['changed']);
const controller = ref(null), disconnected = ref(false), dialog = ref(false), busy = ref(false), error = ref('');
const history = ref([]), nextOffset = ref(null), selectedHistory = ref(null), awaitingOperation = ref(false);
const operationKind = ref('install'), confirmation = ref(''), method = ref('passkey'), password = ref(''), totp = ref('');
let timer, lastRefresh = 0, previousState = '', requestedAfter = 0;
const terminal = ['COMPLETED', 'ROLLED_BACK', 'FAILED', 'RECOVERY_REQUIRED'];
const operation = computed(() => controller.value?.operation);
const running = computed(() => operation.value && !terminal.includes(operation.value.state));
const methods = computed(() => [
  ...(state.user?.passkeys?.length ? [{ title: 'Passkey', value: 'passkey' }] : []),
  ...(state.user?.hasPassword && (state.user?.totpEnabled || !state.user?.passkeys?.length) ? [{ title: state.user.totpEnabled ? 'Password + authenticator code' : 'Password', value: 'password' }] : []),
]);
const requiredText = computed(() => operationKind.value === 'install' ? `INSTALL ${props.release?.version || ''}` : `ROLLBACK ${operation.value?.previousVersion || ''}`);
const headers = [{ title: 'Version', key: 'version' }, { title: 'Result', key: 'state' }, { title: 'Started', key: 'startedAt' }, { title: 'Duration', key: 'duration' }, { title: 'Recovery point', key: 'snapshotAvailable' }, { title: '', key: 'details', sortable: false }];
function stateColor(value) { return value === 'COMPLETED' ? 'success' : value === 'ROLLED_BACK' ? 'warning' : ['FAILED', 'RECOVERY_REQUIRED'].includes(value) ? 'error' : 'primary'; }
function duration(row) { return `${Math.max(0, Math.round((Date.parse(row.updatedAt) - Date.parse(row.startedAt)) / 1000))} s`; }
function close() { dialog.value = false; password.value = ''; totp.value = ''; confirmation.value = ''; error.value = ''; }
function review(kind) {
  close(); operationKind.value = kind; method.value = methods.value[0]?.value || ''; dialog.value = true;
}
async function refresh() {
  if (!state.user) return;
  lastRefresh = Date.now();
  try {
    const response = await fetch('/api/system-updates/progress', { credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401) { state.user = null; return; }
    if (!response.ok) throw new Error('Status unavailable');
    controller.value = await response.json(); disconnected.value = false;
    if (awaitingOperation.value && (Date.parse(controller.value.operation?.startedAt || '') >= requestedAfter || controller.value.lastRequestError)) awaitingOperation.value = false;
    if (nextOffset.value === null || history.value.length <= 50) { history.value = controller.value.history || []; nextOffset.value = history.value.length === 50 ? 50 : null; }
    const current = controller.value.operation?.state || '';
    if (previousState && current !== previousState && terminal.includes(current)) emit('changed');
    previousState = current;
  } catch { disconnected.value = true; }
}
async function submit() {
  if (busy.value || confirmation.value !== requiredText.value) return;
  busy.value = true; error.value = '';
  try {
    const target = operationKind.value === 'install' ? props.release.version : operation.value.id;
    let reauth;
    if (method.value === 'passkey') {
      const options = await api('/reauth/options', 'POST', { action: operationKind.value === 'install' ? 'install-update' : 'rollback-update', target });
      reauth = { method: 'passkey', credential: await startAuthentication({ optionsJSON: options }) };
    } else reauth = { method: 'password', password: password.value, totp: totp.value };
    await api(`/system-updates/${operationKind.value}`, 'POST', { ...(operationKind.value === 'install' ? { version: target } : { operationId: target }), confirmation: confirmation.value, reauth });
    awaitingOperation.value = true; requestedAfter = Date.now() - 1000;
    close(); await refresh(); emit('changed');
  } catch (failure) { error.value = failure.message || 'The operation could not be started'; }
  finally { busy.value = false; password.value = ''; totp.value = ''; }
}
async function loadOlder() {
  try {
    const result = await api('/system-updates/history?offset=' + nextOffset.value);
    history.value = [...history.value, ...result.items]; nextOffset.value = result.nextOffset;
  } catch (failure) { error.value = failure.message || 'History is unavailable'; }
}
onMounted(() => { refresh(); timer = setInterval(() => { if (Date.now() - lastRefresh >= (running.value || awaitingOperation.value || disconnected.value ? 2500 : 15000)) refresh(); }, 1000); });
onUnmounted(() => { clearInterval(timer); password.value = ''; totp.value = ''; });
</script>

<template>
  <v-card class="pa-6">
    <div class="d-flex flex-wrap align-center justify-space-between ga-3 mb-3">
      <h3 class="text-h6">Installation and recovery</h3>
      <v-btn prepend-icon="mdi-refresh" variant="text" @click="refresh">Refresh progress</v-btn>
    </div>
    <v-alert v-if="disconnected" type="info" variant="tonal" class="mb-4">Reconnecting to the Gateway. The host updater continues independently while the Admin container is replaced.</v-alert>
    <v-alert v-else-if="controller && !controller.available" type="warning" variant="tonal" class="mb-4">The host updater is not enabled. Configure the trusted release key and run <code>./gateway updater-enable</code> as the rootless Gateway user.</v-alert>
    <v-alert v-if="controller?.lastRequestError" type="error" variant="tonal" class="mb-4">The host rejected the request before it could start. Refresh release information and review the host service status.</v-alert>
    <v-alert v-if="awaitingOperation" type="info" variant="tonal" class="mb-4">Request accepted. Waiting for the host operation to appear.</v-alert>
    <template v-if="operation">
      <div class="d-flex align-center ga-3 mb-3"><v-chip :color="stateColor(operation.state)">{{ operation.state.replaceAll('_', ' ') }}</v-chip><span>{{ operation.previousVersion }} → {{ operation.version }}</span></div>
      <v-progress-linear v-if="running" indeterminate color="primary" class="mb-4" aria-label="Gateway update in progress" />
      <v-alert v-if="operation.errorCode" :type="operation.state === 'ROLLED_BACK' ? 'warning' : 'error'" variant="tonal" class="mb-4">{{ operation.errorCode }}. {{ operation.state === 'ROLLED_BACK' ? 'The previous installation was restored and passed its health checks. Sign in again if your session was invalidated.' : operation.state === 'RECOVERY_REQUIRED' ? 'Automatic recovery stopped safely. Use the host recovery CLI; persistent data and snapshots have been retained.' : 'The update did not complete. Review its recorded stages before retrying.' }}</v-alert>
      <details class="mb-4"><summary>Operation stages</summary><ol class="pl-6 mt-2"><li v-for="(event, index) in operation.events" :key="index">{{ event.state.replaceAll('_', ' ') }} · <DateTime :value="event.at" /></li></ol></details>
    </template>
    <div class="d-flex flex-wrap ga-3">
      <v-btn color="primary" prepend-icon="mdi-download-outline" :disabled="!release?.installable || !controller?.available || running || awaitingOperation || controller?.maintenance" @click="review('install')">Review update</v-btn>
      <v-btn color="warning" variant="tonal" prepend-icon="mdi-backup-restore" :disabled="!controller?.canRollback || running || awaitingOperation" @click="review('rollback')">Review rollback</v-btn>
    </div>
    <p class="text-body-2 text-medium-emphasis mt-3">Updates disconnect MQTT clients. A verified snapshot is taken before migrations and image activation. Rollback is offered only while the recovery point remains available and persistent data has not changed after commit.</p>
  </v-card>
  <v-card class="pa-6 mt-4">
    <h3 class="text-h6 mb-3">Version history</h3>
    <DataList :headers="headers" :items="history" item-value="id" no-data-text="No update operations have been recorded.">
      <template #item.version="{ item }"><span>{{ item.previousVersion }} → {{ item.version }}</span><div class="text-caption text-medium-emphasis">{{ item.kind }}</div></template>
      <template #item.state="{ item }"><v-chip size="small" :color="stateColor(item.state)">{{ item.state.replaceAll('_', ' ') }}</v-chip></template>
      <template #item.startedAt="{ item }"><DateTime :value="item.startedAt" /></template>
      <template #item.duration="{ item }">{{ duration(item) }}</template>
      <template #item.snapshotAvailable="{ item }">{{ item.snapshotAvailable ? 'Recorded' : 'Not created' }}</template>
      <template #item.details="{ item }"><v-btn size="small" variant="text" aria-label="View operation details" @click="selectedHistory = item">Details</v-btn></template>
    </DataList>
    <v-btn v-if="nextOffset !== null" variant="text" @click="loadOlder">Load older operations</v-btn>
    <v-alert v-if="error && !dialog" type="error" variant="tonal">{{ error }}</v-alert>
  </v-card>
  <v-dialog :model-value="!!selectedHistory" max-width="680" @update:model-value="selectedHistory = null">
    <v-card v-if="selectedHistory" class="pa-6"><h2 class="text-h6 mb-3">Operation details</h2><p>{{ selectedHistory.previousVersion }} → {{ selectedHistory.version }} · {{ selectedHistory.state }}</p><p v-if="selectedHistory.errorCode" class="mt-2">{{ selectedHistory.errorCode }}</p><ol class="pl-6 my-4"><li v-for="(event, index) in selectedHistory.events" :key="index">{{ event.state.replaceAll('_', ' ') }} · <DateTime :value="event.at" /></li></ol><v-btn @click="selectedHistory = null">Close</v-btn></v-card>
  </v-dialog>
  <v-dialog :persistent="busy" v-model="dialog" max-width="620" @after-leave="password = ''; totp = ''">
    <v-card class="pa-6">
      <h2 class="text-h5 mb-4">{{ operationKind === 'install' ? 'Install Gateway update' : 'Roll back Gateway release' }}</h2>
      <v-alert type="warning" variant="tonal" class="mb-4">MQTT connections will disconnect. {{ operationKind === 'install' ? 'The updater verifies the signed release, snapshots persistent state, and restores the previous installation if pre-commit validation fails.' : 'The updater creates a fresh safety snapshot before restoring the previous release. Active administrative sessions are invalidated during restoration.' }}</v-alert>
      <p class="mb-2">Type the confirmation to continue:</p>
      <v-btn class="mb-4" prepend-icon="mdi-content-copy" color="primary" variant="tonal" size="small" @click="copy(requiredText)">{{ requiredText }}</v-btn>
      <v-form @submit.prevent="submit">
        <v-text-field v-model="confirmation" label="Confirmation" autocomplete="off" :disabled="busy" />
        <v-select v-if="methods.length > 1" v-model="method" :items="methods" label="Verify your identity" :disabled="busy" />
        <template v-if="method === 'password'"><v-text-field v-model="password" type="password" label="Current password" autocomplete="current-password" :disabled="busy" required /><v-text-field v-if="state.user?.totpEnabled" v-model="totp" label="Authenticator code" autocomplete="one-time-code" inputmode="numeric" maxlength="6" :disabled="busy" required /></template>
        <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
        <div class="d-flex justify-end ga-2"><v-btn :disabled="busy" @click="close">Cancel</v-btn><v-btn type="submit" :color="operationKind === 'install' ? 'primary' : 'warning'" :loading="busy" :disabled="busy || confirmation !== requiredText || !methods.length" :prepend-icon="method === 'passkey' ? 'mdi-fingerprint' : 'mdi-shield-lock-outline'">{{ method === 'passkey' ? 'Verify with passkey and continue' : 'Verify and continue' }}</v-btn></div>
      </v-form>
    </v-card>
  </v-dialog>
</template>
