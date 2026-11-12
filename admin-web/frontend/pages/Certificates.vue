<script setup>
import { revealScopes, ensureSensitive } from '../sensitive';
import SensitiveValue from '../components/SensitiveValue.vue';
import DateTime from '../components/DateTime.vue';
import { formatDateTime } from '../date-time';
import RowActions from '../components/RowActions.vue';
import DataList from '../components/DataList.vue';
import { computed, watch, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, action, state, markBrokerMutation, downloadApiFile } from '../api';
import FileDrop from '../components/FileDrop.vue';
import HelpButton from '../components/HelpButton.vue';
import { licenseStatusLabel, mergeLicenseLabels } from '../license-rows.js';
import { certificateMethods } from '../certificate-methods';
import DeviceRules from '../components/DeviceRules.vue';

const props = defineProps({ embedded: Boolean, deviceId: { type: String, default: '' } });
const emit = defineEmits(['updated']);
const router = useRouter();
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
  preview = ref(null), generatedPending = ref(null), caPem = ref(''), caConfirmation = ref('');
const pending = computed(() => certificates.value.filter((item) => item.status === 'pending_external_signature' && (!props.deviceId || item.deviceId === props.deviceId)));
const displayedCertificates = computed(() => certificates.value.filter((item) => !props.deviceId || item.deviceId === props.deviceId));
const deviceOptions = computed(() => devices.value.map((device) => ({ title: `${device.name || device.id} · ${device.id}`, value: device.id })));
const currentDevice = computed(() => devices.value.find((item) => item.id === props.deviceId) || null);
const headers = [
  { title: 'Device', key: 'deviceId', width: '150px' }, { title: 'Labels', key: 'labels', width: '190px', maxWidth: '210px' },
  { title: 'Provisioning', key: 'provisioningMethod', width: '150px' },
  { title: 'Issuer', key: 'issuerName', width: '180px' }, { title: 'Algorithm', key: 'algorithm', width: '140px' },
  { title: 'Expires', key: 'validTo', width: '160px' }, { title: 'Status', key: 'status', width: '135px' },
  { title: '', key: 'actions', width: '64px', sortable: false },
];
const labelValue = (label) => typeof label === 'string' ? { name: label, color: 'primary' } : { name: label.name, color: label.color || 'primary' };
function certificateLabels(certificate) {
  const device = devices.value.find((item) => item.id === certificate.deviceId);
  return mergeLicenseLabels(device?.labels || [], certificate.labels || []).map(labelValue).filter((label) => label.name);
}
function isDeviceLabel(certificate, name) {
  const device = devices.value.find((item) => item.id === certificate.deviceId);
  return (device?.labels || []).some((label) => labelValue(label).name.toLocaleLowerCase() === name.toLocaleLowerCase());
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
  deviceRequest++; certificates.value = []; devices.value = []; trustedCas.value = []; details.value = null; preview.value = null; generatedPending.value = null;
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
  <v-tabs v-if="props.deviceId" v-model="editTab" class="mb-5"><v-tab value="licenses">Licenses</v-tab><v-tab value="rules">Rules</v-tab><v-tab value="health">Health Check · WIP</v-tab></v-tabs>
  <DeviceRules v-if="props.deviceId && editTab === 'rules'" :device-id="props.deviceId" />
  <v-card v-if="props.deviceId && editTab === 'health'" class="pa-6"><v-chip color="warning" size="small" class="mb-3">WIP</v-chip><h2 class="text-h6">Health Check</h2><p class="text-medium-emphasis mt-2">Device heartbeat monitoring and health checks are planned.</p></v-card>
  <v-alert v-if="!props.embedded && (!props.deviceId || editTab === 'licenses')" type="info" variant="tonal" class="mb-5">Importing a certificate does not automatically trust its issuer. External CAs must be added and explicitly approved below. Apply pending broker changes to enforce access and trust changes.</v-alert>
  <div v-if="props.embedded" class="d-flex flex-wrap align-center justify-space-between ga-3 mb-4">
    <div><h2 class="text-h6">Certificate provisioning</h2><p class="text-body-2 text-medium-emphasis mb-0">Manage credentials from the same device registry. Use Add certificate above to choose a method.</p></div>
  </div>
  <v-card v-if="!props.embedded && (!props.deviceId || editTab === 'licenses')" class="pa-4 mb-6"><v-text-field v-if="!props.deviceId" v-model="search" label="Search certificates" prepend-inner-icon="mdi-magnify" hide-details /><DataList :headers="headers" :items="displayedCertificates" :search="search" :loading="!!state.busy" class="mt-4 certificate-table">
    <template #item.labels="{ item }"><div class="d-flex flex-wrap ga-1"><v-chip v-for="label in certificateLabels(item)" :key="label.name" size="small" :style="isDeviceLabel(item, label.name) ? { border: '1.5px solid currentColor' } : undefined" :color="label.color" variant="tonal">{{ label.name }}</v-chip></div></template>
    <template #item.validTo="{ item }"><DateTime :value="item.validTo" /></template>
    <template #item.algorithm="{ item }">{{ item.algorithm || '—' }}</template>
    <template #item.issuerName="{ item }">{{ item.issuerName || item.issuer || '—' }} <span v-if="item.brokerTrusted === false" class="text-warning">(not trusted)</span></template>
    <template #item.status="{ item }"><v-chip size="small" :color="item.licenseDeletedAt ? 'error' : statusColor(item.status)">{{ licenseStatusLabel(item) }}</v-chip></template>
    <template #item.actions="{ item }"><RowActions label="Certificate actions" :disabled="!!state.busy">
      <v-list-item title="Details" prepend-icon="mdi-information-outline" @click="showDetails(item)" />
      <v-list-item v-if="item.canDownload" title="Download certificate" prepend-icon="mdi-download" @click="downloadCertificateFile(item, 'device.crt')" />
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
      <v-combobox v-model="form.deviceId" :items="deviceOptions" item-title="title" item-value="value" :return-object="false" label="MQTT device identity" hint="Search by name or ID, or enter a new device ID. The ID must match the certificate CN." :disabled="!!props.deviceId" :loading="devicesLoading" required>
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
  <v-dialog v-model="details" max-width="720"><v-card v-if="details" class="pa-6"><h2 class="text-h5 mb-4">{{ details.deviceId }} certificate</h2><v-table density="compact"><tbody><tr><th>Provisioning</th><td>{{ details.provisioningMethod }}</td></tr><tr><th>Subject</th><td>{{ details.subject || 'Pending external signature' }}</td></tr><tr><th>SAN</th><td><SensitiveValue scope="devices" :value="details.san" label="Certificate san" /></td></tr><tr><th>Serial</th><td><SensitiveValue scope="devices" :value="details.serial" label="Certificate serial" /></td></tr><tr><th>SHA-256 fingerprint</th><td class="text-break"><SensitiveValue scope="devices" :value="details.fingerprint" label="Certificate fingerprint" /></td></tr><tr><th>Issuer</th><td>{{ details.issuerName || details.issuer || 'Pending' }}</td></tr><tr><th>Algorithm</th><td>{{ details.algorithm }}</td></tr><tr><th>Validity</th><td>{{ formatDateTime(details.validFrom) }} → {{ formatDateTime(details.validTo) }}</td></tr><tr><th>Certificate state</th><td>{{ details.status }}</td></tr><tr><th>Broker trust</th><td>{{ details.brokerTrusted === false ? 'Not trusted; cannot connect' : 'Trusted' }}</td></tr><tr><th>Renewed from</th><td>{{ details.renewedFrom || '—' }}</td></tr></tbody></v-table><div class="d-flex justify-end mt-5"><v-btn @click="details = null">Close</v-btn></div></v-card></v-dialog>
</template>
