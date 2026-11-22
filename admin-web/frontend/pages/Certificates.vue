<script setup>
import { revealScopes, ensureSensitive } from '../sensitive';
import SensitiveValue from '../components/SensitiveValue.vue';
import DateTime from '../components/DateTime.vue';
import { formatDateTime } from '../date-time';
import RowActions from '../components/RowActions.vue';
import DataList from '../components/DataList.vue';
import { computed, watch, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, action, state, copy, markBrokerMutation, downloadApiFile } from '../api';
import FileDrop from '../components/FileDrop.vue';
import HelpButton from '../components/HelpButton.vue';
import { licenseStatusLabel, mergeLicenseLabels } from '../license-rows.js';
import { certificateMethods } from '../certificate-methods';
import DeviceRules from '../components/DeviceRules.vue';
import DeviceHealth from '../components/DeviceHealth.vue';

const props = defineProps({ embedded: Boolean, deviceId: { type: String, default: '' } });
const emit = defineEmits(['updated']);
const router = useRouter();
const crtDialog = ref(null);
watch(() => props.deviceId, () => { crtDialog.value = null; });
const editTab = ref('licenses');
const renewal = ref(null), renewalDays = ref(90);
function submitRenewal() {
  action(async () => {
    const current = renewal.value;
    const result = await api(`/certificates/${current.id}/renew`, 'POST', {
      days: Number(renewalDays.value),
    });
    download('device.crt', result.certificate);
    renewal.value = null; await load();
  }, 'Certificate renewed with the selected certificate’s existing public key. Install it and keep using the matching private key.');
}
const devicesLoading = ref(false), deviceOptionsError = ref('');
let deviceRequest = 0;
const method = ref('generate'), dialog = ref(false), certificates = ref([]), devices = ref([]), trustedCas = ref([]),
  search = ref(''), form = ref({ deviceId: '', name: '', algorithm: 'ecdsa-p256', days: 90, csr: '', certificate: '', chain: '', privateKey: '', pendingId: '', previousId: '' }),
  details = ref(null),
  preview = ref(null), generatedPending = ref(null), caPem = ref(''), caConfirmation = ref(''),
  labelSearch = ref(''), labelColor = ref('blue'), labelMenuCertificate = ref(null);
const pending = computed(() => certificates.value.filter((item) => item.status === 'pending_external_signature' && (!props.deviceId || item.deviceId === props.deviceId)));
const displayedCertificates = computed(() => certificates.value.filter((item) => !props.deviceId || item.deviceId === props.deviceId));
const deviceOptions = computed(() => devices.value.map((device) => ({ title: `${device.name || device.id} · ${device.id}`, value: device.id, labels: device.labels || [] })));
const currentDevice = computed(() => devices.value.find((item) => item.id === props.deviceId) || null);
const mqttOperation = ref(null);
const mqttTopicFields = {
  request: 'CSR request topic', csr: 'CSR response topic', install: 'Certificate delivery topic',
  confirm: 'Confirmation topic', status: 'Device status topic',
};
const mqttTopics = ref({});
const mqttCnMode = ref('manual');
const mqttExpectedCn = ref('');
const mqttBeforeExpiry = ref('');
const mqttValidityDays = ref('');
watch([() => props.deviceId, () => currentDevice.value?.renewal?.mqttValidityDays], ([, days]) => {
  mqttValidityDays.value = days ?? '';
}, { immediate: true });
watch([() => props.deviceId, () => currentDevice.value?.renewal?.mqttCnPolicy], ([id, saved]) => {
  mqttCnMode.value = saved?.mode ?? 'manual';
  mqttExpectedCn.value = saved?.expectedCn ?? id ?? '';
  mqttBeforeExpiry.value = saved?.beforeExpiryDays ?? '';
}, { immediate: true });
function restoreMqttTopics() {
  mqttTopics.value = Object.fromEntries(Object.keys(mqttTopicFields)
    .map((kind) => [kind, `${props.deviceId}/pki/${kind}`]));
}
watch([() => props.deviceId, () => currentDevice.value?.renewal?.mqttTopics], ([, saved]) => {
  restoreMqttTopics();
  if (saved) mqttTopics.value = { ...saved };
}, { immediate: true });
const mqttRenewalPath = () => `/devices/${encodeURIComponent(props.deviceId)}/mqtt-renewals`;
watch(() => props.deviceId, () => { mqttOperation.value = null; });
watch([editTab, () => props.deviceId], ([tab, deviceId]) => {
  if (tab === 'renew' && deviceId) refreshMqttRenewal();
});
function startMqttRenewal() {
  action(async () => {
    await ensureSensitive('devices');
    const result = await api(mqttRenewalPath(), 'POST', { topics: { ...mqttTopics.value }, validityDays: mqttValidityDays.value === '' ? null : Number(mqttValidityDays.value), cnPolicy: { mode: mqttCnMode.value, expectedCn: mqttExpectedCn.value.trim(), beforeExpiryDays: mqttBeforeExpiry.value === '' ? null : Number(mqttBeforeExpiry.value) } });
    mqttOperation.value = { id: result.id, status: 'requested' };
  });
}
function approveMqttRenewal() {
  const { id, pendingCn: cn } = mqttOperation.value;
  action(async () => {
    await ensureSensitive('devices');
    mqttOperation.value = await api(`${mqttRenewalPath()}/${id}/approve`, 'POST', { cn });
  });
}
function refreshMqttRenewal() {
  action(async () => {
    const deviceId = props.deviceId;
    const id = mqttOperation.value?.id;
    const path = mqttRenewalPath();
    const operation = await api(id ? `${path}/${id}` : path);
    if (props.deviceId === deviceId) mqttOperation.value = operation;
  });
}
const labelColors = [
  { title: 'Blue', value: 'blue' }, { title: 'Teal', value: 'teal' },
  { title: 'Green', value: 'green' }, { title: 'Amber', value: 'amber' },
  { title: 'Orange', value: 'orange' }, { title: 'Red', value: 'red' },
  { title: 'Purple', value: 'purple' }, { title: 'Grey', value: 'grey' },
];
function displayDeviceName(id) { return devices.value.find((item) => item.id === id)?.name || id; }
const headers = computed(() => [
  ...(!props.deviceId ? [{ title: 'Device', key: 'deviceId', width: '150px' }] : []), { title: 'Labels', key: 'labels', width: '190px', maxWidth: '210px' },
  { title: 'Provisioning', key: 'provisioningMethod', width: '150px' },
  { title: 'Issuer', key: 'issuerName', width: '180px' }, { title: 'Algorithm', key: 'algorithm', width: '140px' },
  { title: 'Issued', key: 'issuedAt', width: '160px' }, { title: 'Expires', key: 'validTo', width: '160px' }, { title: 'Status', key: 'status', width: '135px', align: 'center' },
  { title: '', key: 'actions', width: '64px', sortable: false },
]);
const labelValue = (label) => typeof label === 'string' ? { name: label, color: 'primary' } : { name: label.name, color: label.color || 'primary' };
const allLabels = computed(() => {
  const labels = new Map();
  for (const device of devices.value) {
    for (const rawLabel of device.labels || []) {
      const label = labelValue(rawLabel);
      if (label.name && !labels.has(label.name.toLocaleLowerCase())) labels.set(label.name.toLocaleLowerCase(), label);
    }
  }
  for (const certificate of certificates.value) {
    for (const rawLabel of certificate.labels || []) {
      const label = labelValue(rawLabel);
      if (label.name && !labels.has(label.name.toLocaleLowerCase())) labels.set(label.name.toLocaleLowerCase(), label);
    }
  }
  return [...labels.values()].sort((a, b) => a.name.localeCompare(b.name));
});
function certificateOwnLabels(certificate) { return (certificate.labels || []).map(labelValue).filter((label) => label.name); }
function certificateLabels(certificate) {
  const device = devices.value.find((item) => item.id === certificate.deviceId);
  return mergeLicenseLabels(device?.labels || [], certificate.labels || []).map(labelValue).filter((label) => label.name);
}
function isDeviceLabel(certificate, name) {
  const device = devices.value.find((item) => item.id === certificate.deviceId);
  return (device?.labels || []).some((label) => labelValue(label).name.toLocaleLowerCase() === name.toLocaleLowerCase());
}
function hasOwnCertificateLabel(certificate, name) {
  return certificateOwnLabels(certificate).some((label) => label.name.toLocaleLowerCase() === name.toLocaleLowerCase());
}
function filteredCertificateLabels(certificate) {
  const attached = new Set(certificateLabels(certificate).map((label) => label.name.toLocaleLowerCase()));
  return allLabels.value.filter((label) => !attached.has(label.name.toLocaleLowerCase()) && label.name.toLocaleLowerCase().includes(labelSearch.value.trim().toLocaleLowerCase()));
}
function canCreateCertificateLabel() {
  const name = labelSearch.value.trim();
  return name && !allLabels.value.some((label) => label.name.toLocaleLowerCase() === name.toLocaleLowerCase());
}
function openCertificateLabelMenu(certificate, open) {
  if (open) { labelMenuCertificate.value = certificate; labelSearch.value = ''; labelColor.value = 'blue'; }
  else if (labelMenuCertificate.value?.id === certificate.id) labelMenuCertificate.value = null;
}
function saveCertificateLabels(certificate, labels) {
  action(async () => {
    const result = await api(`/certificates/${certificate.id}/labels`, 'PATCH', { labels });
    certificates.value = certificates.value.map((item) => item.id === certificate.id ? result.certificate : item);
    return 'Certificate labels updated.';
  });
}
function attachCertificateLabel(certificate, label) {
  const current = certificateOwnLabels(certificate);
  if (certificateLabels(certificate).some((item) => item.name.toLocaleLowerCase() === label.name.toLocaleLowerCase())) return;
  saveCertificateLabels(certificate, [...current, label]);
  labelSearch.value = '';
}
function createCertificateLabel(certificate) {
  const name = labelSearch.value.trim().slice(0, 40);
  if (!name || !canCreateCertificateLabel()) return;
  attachCertificateLabel(certificate, { name, color: labelColor.value });
}
function removeCertificateLabel(certificate, name) {
  saveCertificateLabels(certificate, certificateOwnLabels(certificate).filter((label) => label.name !== name));
}
async function reloadDeviceOptions() {
  const request = ++deviceRequest, grant = revealScopes.devices;
  devicesLoading.value = true;
  deviceOptionsError.value = '';
  try {
    const response = await api('/devices');
    if (!response) return;
    if (request === deviceRequest && revealScopes.devices === grant) devices.value = response.devices;
  } catch (error) {
    if (request === deviceRequest) deviceOptionsError.value = `Could not refresh devices: ${error.message}`;
    throw error;
  } finally {
    if (request === deviceRequest) devicesLoading.value = false;
  }
}
function refreshDeviceOptions() {
  // Keep the form and the selected identity intact; show failures in the dialog.
  return reloadDeviceOptions().catch(() => {});
}
async function load() {
  const grant = revealScopes.devices;
  const [c, , ca] = await Promise.all([api('/certificates'), reloadDeviceOptions(), api('/trusted-cas')]);
  if (!c || !ca || revealScopes.devices !== grant) return;
  certificates.value = c.certificates; trustedCas.value = ca.trustedCas;
  emit('updated');
}
watch(() => revealScopes.devices, () => {
  deviceRequest++; certificates.value = []; devices.value = []; trustedCas.value = []; details.value = null; crtDialog.value = null; preview.value = null; generatedPending.value = null;
  action(load);
}, { immediate: true, flush: 'sync' });
function open(methodName) {
  return withSensitiveReveal(() => openCertificateDialog(methodName));
}
async function withSensitiveReveal(callback) {
  try { await ensureSensitive('devices'); await callback(); } catch { /* Authorization was canceled. */ }
}
function openCertificateDialog(methodName) {
  method.value = methodName; preview.value = null; generatedPending.value = null;
  form.value = { deviceId: props.deviceId || '', name: currentDevice.value?.name || '', algorithm: 'ecdsa-p256', days: 90, csr: '', certificate: '', chain: '', privateKey: '', pendingId: '', previousId: '' };
  dialog.value = true;
  refreshDeviceOptions();
}
async function fileText(event, field) {
  const file = event.target.files?.[0];
  if (file) form.value[field] = await file.text();
}
function download(name, body) {
  const url = URL.createObjectURL(body instanceof Blob ? body : new Blob([body], { type: 'application/x-pem-file' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function postBlob(endpoint, body, filename) {
  await ensureSensitive('devices');
  const response = await fetch(`/api${endpoint}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) { const result = await response.json(); throw new Error(result.error || 'Request failed'); }
  markBrokerMutation();
  download(filename, await response.blob());
}
async function previewCsr() {
  const result = await api('/certificates/inspect-csr', 'POST', { csr: form.value.csr });
  preview.value = result;
}
function submit() {
  action(async () => {
    let success = '';
    if (method.value === 'generate') {
      await postBlob('/certificates/generate', { ...form.value, id: form.value.deviceId, bundle: true }, `${form.value.deviceId}-credentials.zip`);
      dialog.value = false;
      success = 'Certificate registered and ZIP downloaded. Store the private key securely, then approve MQTT authorization when ready.';
    } else if (method.value === 'sign') {
      if (!preview.value) await previewCsr();
      await api('/certificates/sign', 'POST', { deviceId: form.value.deviceId, csr: form.value.csr || undefined, days: Number(form.value.days) });
      dialog.value = false;
      success = 'CSR signed. The certificate is now in the shared identity registry.';
    } else if (method.value === 'external') {
      const created = await api('/certificates/external-csr', 'POST', { id: form.value.deviceId, name: form.value.name, algorithm: form.value.algorithm });
      generatedPending.value = created.record;
      download(`${form.value.deviceId}.csr`, created.csr);
      success = 'CSR generated. Download the matching private key once before its delivery expires.';
    } else {
      const result = await api('/certificates/import', 'POST', { deviceId: form.value.deviceId, name: form.value.name, certificate: form.value.certificate, chain: form.value.chain, privateKey: form.value.privateKey || undefined, pendingId: form.value.pendingId || undefined });
      success = result.message;
      dialog.value = false;
    }
    await load();
    return success;
  }).then((message) => { if (message) state.notice = message; });
}
async function deliverPendingKey() {
  action(async () => {
    await ensureSensitive('devices');
    const response = await fetch(`/api/certificates/${generatedPending.value.id}/private-key-once`, { credentials: 'same-origin' });
    if (!response.ok) throw new Error((await response.json()).error || 'Private-key download failed');
    download(`${generatedPending.value.deviceId}.key`, await response.blob());
    generatedPending.value = { ...generatedPending.value, keyDownloaded: true };
    return 'The private key was delivered once. Confirm that you stored it securely.';
  }).then((message) => { if (message) state.notice = message; });
}
async function confirmKeyReceived() {
  action(async () => {
    await api(`/certificates/${generatedPending.value.id}/private-key-received`, 'POST', {});
    generatedPending.value = null; dialog.value = false; await load();
    return 'Receipt confirmed. Import the certificate after the external CA signs the CSR.';
  }).then((message) => { if (message) state.notice = message; });
}
function importPending(item) { return withSensitiveReveal(() => { openCertificateDialog('import'); form.value.deviceId = item.deviceId; form.value.pendingId = item.id; }); }
function cancelPending(item) { return withSensitiveReveal(async () => {
  if (!confirm(`Cancel the pending external CSR for ${item.deviceId} and remove it from the certificate list? This removes the Gateway's pending key material. If you already downloaded the private key, delete your copy if it is no longer needed.`)) return;
  await action(async () => {
    await api(`/certificates/${item.id}/pending`, 'DELETE', {});
    await load();
  }, 'Pending external CSR cancelled and removed.');
}); }
function renew(item) { return withSensitiveReveal(() => { renewal.value = { id: item.id, deviceId: item.deviceId }; renewalDays.value = 90; }); }
function exportInfo(item) { return withSensitiveReveal(() => download(`${item.deviceId}-${item.serial || item.id}.json`, new Blob([JSON.stringify(item, null, 2)], { type: 'application/json' }))); }
function revoke(item) { return withSensitiveReveal(async () => {
  if (!confirm(`Revoke certificate ${item.serial}? Apply pending broker changes to enforce revocation.`)) return;
  await action(async () => { await api(`/certificates/${item.id}/revoke`, 'POST', {}); await load(); }, 'Revocation saved. Apply pending broker changes.');
}); }
function showDetails(item) { return withSensitiveReveal(() => { details.value = item; }); }
function copyCertificate(item) {
  return withSensitiveReveal(() => action(async () => {
    const grant = revealScopes.devices, deviceId = props.deviceId;
    const response = await fetch(`/api/certificates/${encodeURIComponent(item.id)}/download`, {
      credentials: 'same-origin', cache: 'no-store',
    });
    if (!response.ok) throw new Error('Certificate could not be loaded');
    const pem = await response.text();
    if (revealScopes.devices === grant && props.deviceId === deviceId)
      crtDialog.value = { deviceId: item.deviceId, pem };
  }));
}
function downloadCertificateFile(item, filename) { return withSensitiveReveal(() => action(() => downloadApiFile(`/certificates/${item.id}/${filename === 'client-ca.crt' ? 'chain' : 'download'}`, filename))); }
function trustCa() {
  action(async () => {
    await api('/trusted-cas', 'POST', { certificate: caPem.value, confirm: caConfirmation.value });
    caPem.value = ''; caConfirmation.value = ''; await load();
  }, 'CA trust change saved. Apply pending broker changes.');
}
function removeCa(item) { return withSensitiveReveal(async () => {
  if (!confirm(`Remove trust in ${item.subject}? Devices issued by this CA will be blocked when pending changes are applied.`)) return;
  await action(async () => { await api(`/trusted-cas/${item.id}`, 'DELETE', {}); await load(); }, 'CA trust removed.');
}); }
const statusColor = (status) => ({ active: 'success', expiring: 'warning', expired: 'error', revoked: 'error', untrusted: 'warning', pending_external_signature: 'info', blocked: 'error' })[status] || 'default';
defineExpose({ open });
</script>

<template>
  <div v-if="props.deviceId" class="d-flex flex-wrap align-center justify-space-between ga-4 mb-6">
    <div><v-btn variant="text" prepend-icon="mdi-arrow-left" class="mb-2" @click="router.push('/devices')">Devices &amp; certificates</v-btn><div class="text-overline text-primary">DEVICE CERTIFICATES</div><h1 class="text-h4 font-weight-bold">{{ currentDevice?.name || props.deviceId }}</h1><p class="text-medium-emphasis mt-2">ID: {{ props.deviceId }} · Manage this device’s certificates and provisioning history.</p></div>
    <v-menu v-if="editTab === 'licenses'"><template #activator="{ props: menuProps }"><v-btn v-bind="menuProps" color="primary" prepend-icon="mdi-plus">Add certificate</v-btn></template><v-list><v-list-item v-for="method in certificateMethods" :key="method.value" :title="method.title" @click="open(method.value)" /></v-list></v-menu>
  </div>
  <div v-else-if="!props.embedded" class="d-flex flex-wrap align-center justify-space-between ga-4 mb-6">
    <div><div class="text-overline text-primary">IDENTITY & CRYPTOGRAPHIC CREDENTIALS</div><h1 class="text-h4 font-weight-bold">Certificates and identities</h1><p class="text-medium-emphasis mt-2">Four enrollment methods share one device registry. Private keys are never recoverable after delivery.</p></div>
    <v-menu><template #activator="{ props: menuProps }"><v-btn v-bind="menuProps" color="primary" prepend-icon="mdi-plus">Add certificate</v-btn></template><v-list><v-list-item v-for="method in certificateMethods" :key="method.value" :title="method.title" @click="open(method.value)" /></v-list></v-menu>
  </div>
  <v-tabs v-if="props.deviceId" v-model="editTab" class="mb-5">
    <v-tab value="licenses">Licenses</v-tab>
    <v-tab value="rules">Rules</v-tab>
    <v-tab value="health">Health Check</v-tab>
    <v-tab value="renew">Renew</v-tab>
  </v-tabs>
  <DeviceRules v-if="props.deviceId && editTab === 'rules'" :device-id="props.deviceId" />
  <DeviceHealth v-if="props.deviceId && editTab === 'health'" :device-id="props.deviceId" />
  <v-card v-if="props.deviceId && editTab === 'renew'" class="pa-6">
    <div class="d-flex align-center ga-2 mb-5">
      <h2 class="text-h6">Renewal</h2>
      <HelpButton topic-id="device-renewal-planning" />
    </div>
    <v-card variant="outlined" class="pa-4 mb-4">
      <h3 class="text-subtitle-1 mb-3">Device certificate renewal over MQTT</h3>
      <p class="mb-3">The device must be authorized, use compatible custom topic rules, and listen for CSR requests.</p>
      <v-select v-model="mqttCnMode" :items="[{ title: 'Review and approve each CSR', value: 'manual' }, { title: 'Automatically accept a matching CN', value: 'automatic' }]" label="CSR approval policy" />
      <v-text-field v-if="mqttCnMode === 'automatic'" v-model="mqttExpectedCn" label="Expected CSR Common Name (CN)" maxlength="64" />
      <v-text-field v-if="mqttCnMode === 'automatic'" v-model="mqttBeforeExpiry" type="number" min="1" step="1"
        label="Attempt renewal before expiry (days)" hint="Leave blank to disable scheduled renewal." persistent-hint />
      <v-text-field v-model="mqttValidityDays" type="number" min="1" step="1" label="New certificate validity (days)" placeholder="Gateway default" persistent-placeholder />
      <p class="text-body-2 mb-3">Renewal settings are saved when you start a request. The issued certificate uses the registered Device ID for MQTT access.</p>
      <v-btn color="primary" :disabled="(mqttCnMode === 'automatic' && !mqttExpectedCn.trim()) || !currentDevice?.enabled || currentDevice?.trusted === false"
        :loading="!!state.busy" @click="startMqttRenewal">{{ mqttCnMode === 'automatic' ? 'Force automatic renewal' : 'Request CSR' }}</v-btn>
      <v-btn class="ml-2" variant="tonal" prepend-icon="mdi-refresh" :loading="!!state.busy" @click="refreshMqttRenewal">Refresh status</v-btn>
      <div v-if="mqttOperation" class="mt-4" role="status">
        <div>Request ID <code>{{ mqttOperation.id }}</code></div>
        <div>Status <strong>{{ mqttOperation.status }}</strong></div>
        <div v-if="mqttOperation.error">{{ mqttOperation.error }}</div>
        <div v-if="mqttOperation.pendingCn && mqttOperation.status === 'requested'">
          <p>CSR awaiting approval. Common Name: <code>{{ mqttOperation.pendingCn }}</code></p>
          <v-btn color="primary" :loading="!!state.busy" @click="approveMqttRenewal">Approve CSR and issue certificate</v-btn>
        </div>
      </div>
      <v-row class="mt-4">
        <v-col v-for="(label, kind) in mqttTopicFields" :key="kind" cols="12" md="6">
          <v-text-field v-model="mqttTopics[kind]" :label="label" maxlength="256" />
        </v-col>
      </v-row>
      <v-btn variant="text" @click="restoreMqttTopics">Restore defaults</v-btn>
    </v-card>
    <v-card variant="outlined" class="pa-4">
      <div class="d-flex align-center justify-space-between ga-3">
        <div class="d-flex flex-wrap align-center ga-2">
          <h3 class="text-subtitle-1">Gateway CA renewal</h3>
          <v-chip size="small" color="warning" variant="tonal">WIP</v-chip>
        </div>
        <v-switch disabled label="Enable automatic CA renewal" color="primary" hide-details />
      </div>
      <p class="text-body-2 text-medium-emphasis mt-3 mb-4">Create and migrate to a new Gateway CA before the current CA expires. The future workflow will track delivery, acknowledgment, and verified reconnection for every device.</p>
      <v-row>
        <v-col cols="12" md="5"><v-text-field disabled type="number" min="1" label="Attempt CA renewal before expiry (days)" placeholder="180" /></v-col>
        <v-col cols="12" md="7"><v-text-field disabled label="CA renewal announcement topic" placeholder="gateway/certificate/ca/renewal" /></v-col>
        <v-col cols="12"><v-textarea disabled label="CA renewal message template" rows="4" placeholder="Request ID, current CA reference, new CA certificate, and delivery instructions" /></v-col>
      </v-row>
    </v-card>
  </v-card>
  <v-alert v-if="!props.embedded && (!props.deviceId || editTab === 'licenses')" type="info" variant="tonal" class="mb-5">Importing a certificate does not automatically trust its issuer. External CAs must be added and explicitly approved below. Apply pending broker changes to enforce access and trust changes.</v-alert>
  <div v-if="props.embedded" class="d-flex flex-wrap align-center justify-space-between ga-3 mb-4">
    <div><h2 class="text-h6">Certificate provisioning</h2><p class="text-body-2 text-medium-emphasis mb-0">Manage credentials from the same device registry. Use Add certificate above to choose a method.</p></div>
  </div>
  <v-card v-if="!props.embedded && (!props.deviceId || editTab === 'licenses')" class="pa-4 mb-6"><v-text-field v-if="!props.deviceId" v-model="search" label="Search certificates" prepend-inner-icon="mdi-magnify" hide-details /><DataList :table-id="props.deviceId ? 'device-certificates' : 'certificates'" :headers="headers" :items="displayedCertificates" :search="search" :loading="!!state.busy" class="mt-4 certificate-table">
    <template #item.deviceId="{ item }"><v-tooltip :text="`Copy device ID: ${item.deviceId}`" location="top" :open-delay="500"><template #activator="{ props: tooltipProps }"><v-btn v-bind="tooltipProps" class="list-copy text-none" variant="text" density="compact" :aria-label="`Copy device ID ${item.deviceId}`" @click="copy(item.deviceId)">{{ displayDeviceName(item.deviceId) }}</v-btn></template></v-tooltip></template>
    <template #item.labels="{ item }"><div class="d-flex flex-wrap align-center ga-1"><v-chip v-for="label in certificateLabels(item)" :key="label.name" size="small" :closable="hasOwnCertificateLabel(item, label.name)" :style="isDeviceLabel(item, label.name) ? { border: '1.5px solid currentColor' } : undefined" :color="label.color" variant="tonal" @click:close="removeCertificateLabel(item, label.name)">{{ label.name }}</v-chip><v-menu v-if="!item.licenseArchivedAt && !item.licenseDeletedAt" location="bottom start" :close-on-content-click="false" @update:model-value="openCertificateLabelMenu(item, $event)"><template #activator="{ props: menuProps }"><v-btn v-bind="menuProps" icon="mdi-plus" size="x-small" variant="text" color="medium-emphasis" class="label-add-btn" :aria-label="`Add label to certificate ${item.id}`" /></template><v-card width="300" class="pa-3"><v-text-field v-model="labelSearch" label="Search labels" prepend-inner-icon="mdi-magnify" density="compact" hide-details autofocus /><v-list v-if="filteredCertificateLabels(item).length" density="compact" max-height="180" class="overflow-y-auto mt-2"><v-list-item v-for="label in filteredCertificateLabels(item)" :key="label.name" :title="label.name" @click="attachCertificateLabel(item, label)"><template #prepend><v-icon icon="mdi-circle" :color="label.color" size="small" /></template></v-list-item></v-list><p v-else-if="!canCreateCertificateLabel()" class="text-caption text-medium-emphasis mt-3 mb-0">No available matching labels.</p><div v-if="canCreateCertificateLabel()" class="mt-3"><v-select v-model="labelColor" :items="labelColors" label="Label color" density="compact" hide-details class="mb-3"><template #selection="{ item: colorItem }"><span class="d-flex align-center ga-2"><v-icon icon="mdi-circle" :color="colorItem.value" size="small" />{{ colorItem.title }}</span></template><template #item="{ props: colorProps, item: colorItem }"><v-list-item v-bind="colorProps"><template #prepend><v-icon icon="mdi-circle" :color="colorItem.value" size="small" /></template></v-list-item></template></v-select><v-btn block color="primary" prepend-icon="mdi-plus" @click="createCertificateLabel(item)">Create “{{ labelSearch.trim().slice(0, 40) }}”</v-btn></div></v-card></v-menu></div></template>
    <template #item.issuedAt="{ item }"><DateTime :value="item.issuedAt" /></template>
    <template #item.validTo="{ item }"><DateTime :value="item.validTo" /></template>
    <template #item.algorithm="{ item }">{{ item.algorithm || '—' }}</template>
    <template #item.issuerName="{ item }">{{ item.issuerName || item.issuer || '—' }} <span v-if="item.brokerTrusted === false" class="text-warning">(not trusted)</span></template>
    <template #item.status="{ item }"><div class="d-flex justify-center"><v-chip size="small" :color="item.licenseDeletedAt ? 'error' : statusColor(item.status)">{{ licenseStatusLabel(item) }}</v-chip></div></template>
    <template #item.actions="{ item }"><RowActions label="Certificate actions" :disabled="!!state.busy">
      <v-list-item title="Details" prepend-icon="mdi-information-outline" @click="showDetails(item)" />
      <v-list-item v-if="item.canDownload" title="Download certificate" prepend-icon="mdi-download" @click="downloadCertificateFile(item, 'device.crt')" />
      <v-list-item v-if="props.deviceId && item.canDownload" title="Copy certificate" prepend-icon="mdi-content-copy" @click="copyCertificate(item)" />
      <v-list-item v-if="item.canDownload" title="Issuer chain" prepend-icon="mdi-certificate-outline" @click="downloadCertificateFile(item, 'client-ca.crt')" />
      <v-list-item v-if="!item.licenseDeletedAt && item.status === 'pending_external_signature'" title="Import signed certificate" prepend-icon="mdi-file-sign" @click="importPending(item)" />
      <v-list-item v-if="!item.licenseDeletedAt && item.status === 'pending_external_signature'" title="Cancel pending CSR" prepend-icon="mdi-close-circle-outline" class="text-error" @click="cancelPending(item)" />
      <v-list-item v-if="!item.licenseDeletedAt && ['active', 'expiring'].includes(item.status) && ['local', 'legacy'].includes(item.issuer)" title="Renew" prepend-icon="mdi-autorenew" @click="renew(item)" />
      <v-list-item title="Export info" prepend-icon="mdi-export-variant" @click="exportInfo(item)" />
      <v-list-item v-if="!item.licenseDeletedAt && ['active', 'untrusted', 'expiring'].includes(item.status)" title="Revoke certificate" prepend-icon="mdi-cancel" class="text-error" @click="revoke(item)" />
    </RowActions></template>
  </DataList></v-card>
  <v-card v-if="!props.deviceId" class="pa-5"><h2 class="text-h6 mb-2">Trusted external CAs</h2><p class="text-body-2 text-medium-emphasis">Only approved CA certificates are added to the Mosquitto client trust bundle. Trust changes take effect after applying pending broker changes.</p><v-list v-if="trustedCas.length"><v-list-item v-for="ca in trustedCas" :key="ca.id" :title="ca.subject" ><template #subtitle><SensitiveValue scope="devices" :value="ca.fingerprint" label="CA fingerprint" /> · expires {{ formatDateTime(ca.validTo) }}</template><template #append><v-btn color="error" variant="tonal" prepend-icon="mdi-shield-remove-outline" @click="removeCa(ca)">Remove trust</v-btn></template></v-list-item></v-list><v-alert v-else type="info" variant="tonal" class="my-3">No external CAs are trusted.</v-alert><v-textarea v-model="caPem" label="External CA certificate (PEM)" rows="5" /><v-text-field v-model="caConfirmation" label="Type TRUST THIS CA to approve" /><v-btn color="primary" variant="flat" prepend-icon="mdi-shield-check-outline" :disabled="caConfirmation !== 'TRUST THIS CA' || !caPem" :loading="!!state.busy" @click="trustCa">Approve CA trust</v-btn></v-card>

  <v-dialog v-model="dialog" max-width="820" scrollable><v-card class="pa-6"><div class="d-flex align-center justify-space-between mb-4"><h2 class="text-h5">{{ certificateMethods.find((item) => item.value === method)?.title }}</h2><HelpButton :topic-id="({ generate: 'generate-complete-certificate', sign: 'sign-existing-csr', external: 'generate-csr-external-signing', import: 'import-certificate' })[method]" /></div>
    <template v-if="!generatedPending">
      <v-select v-if="method !== 'import'" v-model="form.deviceId" :items="deviceOptions" item-title="title" item-value="value" :return-object="false" label="Registered device" hint="Register a device first; the generated ID is its MQTT identity and certificate CN." :disabled="!!props.deviceId" :loading="devicesLoading" required>
        <template #item="{ props: optionProps, item: option }">
          <v-list-item v-bind="optionProps">
            <template #subtitle>
              <div class="d-flex flex-wrap ga-1 mt-1">
                <v-chip v-for="label in option.raw.labels || []" :key="typeof label === 'string' ? label : label.name"
                  size="x-small" variant="tonal" :color="typeof label === 'string' ? 'primary' : (label.color || 'primary')">
                  {{ typeof label === 'string' ? label : label.name }}
                </v-chip>
              </div>
            </template>
          </v-list-item>
        </template>
        <template #append><v-tooltip text="Refresh devices" location="top" :open-delay="500"><template #activator="{ props: refreshProps }"><v-btn v-bind="refreshProps" icon="mdi-refresh" variant="text" size="small" aria-label="Refresh device identities" :loading="devicesLoading" :disabled="devicesLoading" @click="refreshDeviceOptions" /></template></v-tooltip></template>
      </v-select>
      <v-combobox v-else v-model="form.deviceId" :items="deviceOptions" item-title="title" item-value="value" :return-object="false" label="Device identity / certificate CN" hint="Select a registered device or enter the Common Name from the existing certificate." :disabled="!!props.deviceId" :loading="devicesLoading">
        <template #item="{ props: optionProps, item: option }">
          <v-list-item v-bind="optionProps">
            <template #subtitle>
              <div class="d-flex flex-wrap ga-1 mt-1">
                <v-chip v-for="label in option.raw.labels || []" :key="typeof label === 'string' ? label : label.name"
                  size="x-small" variant="tonal" :color="typeof label === 'string' ? 'primary' : (label.color || 'primary')">
                  {{ typeof label === 'string' ? label : label.name }}
                </v-chip>
              </div>
            </template>
          </v-list-item>
        </template>
        <template #append><v-tooltip text="Refresh devices" location="top" :open-delay="500"><template #activator="{ props: refreshProps }"><v-btn v-bind="refreshProps" icon="mdi-refresh" variant="text" size="small" aria-label="Refresh device identities" :loading="devicesLoading" :disabled="devicesLoading" @click="refreshDeviceOptions" /></template></v-tooltip></template>
      </v-combobox>
      <v-alert v-if="deviceOptionsError" type="error" variant="tonal" density="compact" class="mb-4">{{ deviceOptionsError }}. Use Refresh devices to try again.</v-alert>
      <v-text-field v-if="method === 'external' || method === 'import'" v-model="form.name" label="Device name" />
      <v-select v-if="method === 'generate' || method === 'external'" v-model="form.algorithm" label="Key algorithm" :items="[{ title: 'ECDSA P-256 (recommended)', value: 'ecdsa-p256' }, { title: 'RSA-2048', value: 'rsa-2048' }]" />
      <v-text-field v-if="method === 'generate' || method === 'sign'" v-model.number="form.days" type="number" min="1" label="Certificate validity (days)" />
      <template v-if="method === 'sign'"><p class="text-body-2">Paste or drop a PEM CSR. The private key stays on the device; only the server-selected MQTT identity is signed.</p><FileDrop v-model="form.csr" accept=".csr,.pem" label="a CSR file" /><v-textarea v-model="form.csr" label="Certificate signing request (PEM)" rows="8" /><v-btn variant="tonal" :disabled="!form.csr" @click="action(previewCsr)">Inspect and validate CSR</v-btn><v-card v-if="preview" class="pa-3 mt-3"><div>Subject: {{ preview.subject }}</div><div>Public key: {{ preview.algorithm }}</div><div>SHA-256: {{ preview.publicKeyFingerprint }}</div></v-card></template>
      <template v-if="method === 'import'"><v-select v-if="pending.length" v-model="form.pendingId" label="Complete pending Gateway CSR (optional)" :items="pending.map((item) => ({ title: `${item.deviceId} · ${item.id}`, value: item.id }))" clearable /><FileDrop v-model="form.certificate" accept=".crt,.pem" label="a client certificate" /><v-textarea v-model="form.certificate" label="Client certificate (PEM)" rows="6" /><FileDrop v-model="form.chain" accept=".crt,.pem" label="a CA chain" /><v-textarea v-model="form.chain" label="Issuer chain (optional PEM)" rows="4" /><FileDrop v-model="form.privateKey" accept=".key,.pem" label="a matching private key" /><v-textarea v-model="form.privateKey" label="Matching private key (optional; validated then discarded)" rows="4" /></template>
      <v-alert v-if="method === 'generate'" type="warning" variant="tonal" class="my-4">The ZIP contains the private key and is returned once. Save it in protected device storage; the Gateway never stores a copy.</v-alert>
      <v-alert v-if="method === 'external'" type="info" variant="tonal" class="my-4">The private key is held in memory for up to 15 minutes and delivered once. Restarting the Gateway clears it; regenerate the CSR if delivery expires.</v-alert>
      <div class="d-flex justify-end ga-2 mt-4"><v-btn @click="dialog = false">Cancel</v-btn><v-btn color="primary" :loading="!!state.busy" @click="submit">{{ method === 'sign' ? 'Inspect and sign' : method === 'import' ? 'Validate and import' : method === 'external' ? 'Generate CSR' : 'Generate and download ZIP' }}</v-btn></div>
    </template>
    <template v-else><v-alert type="warning" variant="tonal">Download this private key now. The Gateway keeps no disk copy and cannot recover it. After saving it securely, confirm receipt.</v-alert><div class="d-flex ga-2 mt-4"><v-btn :disabled="generatedPending.keyDownloaded" @click="deliverPendingKey">Download private key once</v-btn><v-btn color="primary" :disabled="!generatedPending.keyDownloaded" @click="confirmKeyReceived">I stored this key securely</v-btn></div></template>
  </v-card></v-dialog>
  <v-dialog :model-value="!!renewal" max-width="680" @update:model-value="renewal = null"><v-card class="pa-6"><h2 class="text-h5 mb-3">Renew certificate · {{ renewal?.deviceId }}</h2><p class="text-body-2 mb-3">Renewal uses the selected certificate’s existing public key. Install the new certificate and keep using the matching private key; the Gateway never receives or stores it.</p><v-form @submit.prevent="submitRenewal"><v-text-field v-model.number="renewalDays" type="number" min="1" label="Validity from today (days)" required /><div class="d-flex justify-end ga-2"><v-btn @click="renewal = null">Cancel</v-btn><v-btn color="primary" type="submit" :loading="!!state.busy">Renew</v-btn></div></v-form></v-card></v-dialog>
  <v-dialog :model-value="!!crtDialog" max-width="760" @update:model-value="crtDialog = null">
    <v-card v-if="crtDialog" class="pa-6">
      <h2 class="text-h5 mb-3">Certificate · {{ crtDialog.deviceId }}</h2>
      <v-textarea :model-value="crtDialog.pem" label="Certificate (PEM)" rows="12" readonly class="mono" />
      <div class="d-flex justify-end ga-2">
        <v-btn @click="crtDialog = null">Close</v-btn>
        <v-btn color="primary" prepend-icon="mdi-content-copy" @click="copy(crtDialog.pem)">Copy</v-btn>
      </div>
    </v-card>
  </v-dialog>
  <v-dialog v-model="details" max-width="720"><v-card v-if="details" class="pa-6"><h2 class="text-h5 mb-4">{{ details.deviceId }} certificate</h2><v-table density="compact"><tbody><tr><th>Certificate ID</th><td><code>{{ details.id }}</code> <v-btn size="x-small" variant="text" icon="mdi-content-copy" aria-label="Copy certificate ID" @click="copy(details.id)" /></td></tr><tr><th>Provisioning</th><td>{{ details.provisioningMethod }}</td></tr><tr><th>Subject</th><td>{{ details.subject || 'Pending external signature' }}</td></tr><tr><th>SAN</th><td><SensitiveValue scope="devices" :value="details.san" label="Certificate san" /></td></tr><tr><th>Serial</th><td><SensitiveValue scope="devices" :value="details.serial" label="Certificate serial" /></td></tr><tr><th>SHA-256 fingerprint</th><td class="text-break"><SensitiveValue scope="devices" :value="details.fingerprint" label="Certificate fingerprint" /></td></tr><tr><th>Issuer</th><td>{{ details.issuerName || details.issuer || 'Pending' }}</td></tr><tr><th>Algorithm</th><td>{{ details.algorithm }}</td></tr><tr><th>Validity</th><td>{{ formatDateTime(details.validFrom) }} → {{ formatDateTime(details.validTo) }}</td></tr><tr><th>Certificate state</th><td>{{ details.status }}</td></tr><tr><th>Broker trust</th><td>{{ details.brokerTrusted === false ? 'Not trusted; cannot connect' : 'Trusted' }}</td></tr><tr><th>Renewed from</th><td>{{ details.renewedFrom || '—' }}</td></tr></tbody></v-table><div class="d-flex justify-end mt-5"><v-btn @click="details = null">Close</v-btn></div></v-card></v-dialog>
</template>
