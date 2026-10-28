<script setup>
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { api, action, state } from '../api';
import FileDrop from '../components/FileDrop.vue';
import { certificateMethods } from '../certificate-methods';

const props = defineProps({ embedded: Boolean, deviceId: { type: String, default: '' } });
const router = useRouter();
const method = ref('generate'), dialog = ref(false), certificates = ref([]), devices = ref([]), trustedCas = ref([]),
  search = ref(''), form = ref({ deviceId: '', name: '', algorithm: 'ecdsa-p256', days: 90, csr: '', certificate: '', chain: '', privateKey: '', pendingId: '', previousId: '' }),
  details = ref(null),
  preview = ref(null), generatedPending = ref(null), caPem = ref(''), caConfirmation = ref('');
const pending = computed(() => certificates.value.filter((item) => item.status === 'pending_external_signature' && (!props.deviceId || item.deviceId === props.deviceId)));
const displayedCertificates = computed(() => certificates.value.filter((item) => !props.deviceId || item.deviceId === props.deviceId));
const currentDevice = computed(() => devices.value.find((item) => item.id === props.deviceId) || null);
const headers = [
  { title: 'Device', key: 'deviceId' }, { title: 'Provisioning', key: 'provisioningMethod' },
  { title: 'Issuer', key: 'issuerName' }, { title: 'Algorithm', key: 'algorithm' },
  { title: 'Expires', key: 'validTo' }, { title: 'Status', key: 'status' },
  { title: 'Actions', key: 'actions', sortable: false },
];
async function load() {
  const [c, d, ca] = await Promise.all([api('/certificates'), api('/devices'), api('/trusted-cas')]);
  certificates.value = c.certificates; devices.value = d.devices; trustedCas.value = ca.trustedCas;
}
onMounted(() => action(load));
function open(methodName) {
  method.value = methodName; preview.value = null; generatedPending.value = null;
  form.value = { deviceId: props.deviceId || '', name: currentDevice.value?.name || '', algorithm: 'ecdsa-p256', days: 90, csr: '', certificate: '', chain: '', privateKey: '', pendingId: '', previousId: '' };
  dialog.value = true;
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
  const response = await fetch(`/api${endpoint}`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) { const result = await response.json(); throw new Error(result.error || 'Request failed'); }
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
      success = 'Certificate and private key downloaded once. Store the key securely.';
    } else if (method.value === 'sign') {
      if (!form.value.previousId && !preview.value) await previewCsr();
      await api(form.value.previousId ? `/certificates/${form.value.previousId}/renew` : '/certificates/sign', 'POST', { deviceId: form.value.deviceId, csr: form.value.csr || undefined, days: Number(form.value.days) });
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
function importPending(item) { open('import'); form.value.deviceId = item.deviceId; form.value.pendingId = item.id; }
function renew(item) { open('sign'); form.value.deviceId = item.deviceId; form.value.previousId = item.id; }
function exportInfo(item) { download(`${item.deviceId}-${item.serial || item.id}.json`, new Blob([JSON.stringify(item, null, 2)], { type: 'application/json' })); }
function revoke(item) {
  if (!confirm(`Revoke certificate ${item.serial}? This blocks the complete MQTT identity and restarts the broker.`)) return;
  action(async () => { await api(`/certificates/${item.id}/revoke`, 'POST', {}); await load(); }, 'Certificate revoked; broker restart requested.');
}
function trustCa() {
  action(async () => {
    await api('/trusted-cas', 'POST', { certificate: caPem.value, confirm: caConfirmation.value });
    caPem.value = ''; caConfirmation.value = ''; await load();
  }, 'CA trust updated. The broker is restarting to apply its trust bundle.');
}
function removeCa(item) {
  if (!confirm(`Remove trust in ${item.subject}? Devices issued by this CA will be disconnected.`)) return;
  action(async () => { await api(`/trusted-cas/${item.id}`, 'DELETE', {}); await load(); }, 'CA trust removed.');
}
const statusColor = (status) => ({ active: 'success', expiring: 'warning', expired: 'error', revoked: 'error', untrusted: 'warning', pending_external_signature: 'info', blocked: 'error' })[status] || 'default';
defineExpose({ open });
</script>

<template>
  <div v-if="props.deviceId" class="d-flex flex-wrap align-center justify-space-between ga-4 mb-6">
    <div><v-btn variant="text" prepend-icon="mdi-arrow-left" class="mb-2" @click="router.push('/devices')">Devices &amp; certificates</v-btn><div class="text-overline text-primary">DEVICE CERTIFICATES</div><h1 class="text-h4 font-weight-bold">{{ currentDevice?.name || props.deviceId }}</h1><p class="text-medium-emphasis mt-2">ID: {{ props.deviceId }} · Manage this device’s certificates and provisioning history.</p></div>
    <v-menu><template #activator="{ props: menuProps }"><v-btn v-bind="menuProps" color="primary" prepend-icon="mdi-plus">Add certificate</v-btn></template><v-list><v-list-item v-for="method in certificateMethods" :key="method.value" :title="method.title" @click="open(method.value)" /></v-list></v-menu>
  </div>
  <div v-else-if="!props.embedded" class="d-flex flex-wrap align-center justify-space-between ga-4 mb-6">
    <div><div class="text-overline text-primary">IDENTITY & CRYPTOGRAPHIC CREDENTIALS</div><h1 class="text-h4 font-weight-bold">Certificates and identities</h1><p class="text-medium-emphasis mt-2">Four enrollment methods share one device registry. Private keys are never recoverable after delivery.</p></div>
    <v-menu><template #activator="{ props: menuProps }"><v-btn v-bind="menuProps" color="primary" prepend-icon="mdi-plus">Add certificate</v-btn></template><v-list><v-list-item v-for="method in certificateMethods" :key="method.value" :title="method.title" @click="open(method.value)" /></v-list></v-menu>
  </div>
  <v-alert v-if="!props.embedded" type="info" variant="tonal" class="mb-5">Importing a certificate does not automatically trust its issuer. External CAs must be added and explicitly approved below. MQTT revocation disables the full device identity and disconnects current broker sessions.</v-alert>
  <div v-if="props.embedded" class="d-flex flex-wrap align-center justify-space-between ga-3 mb-4">
    <div><h2 class="text-h6">Certificate provisioning</h2><p class="text-body-2 text-medium-emphasis mb-0">Manage credentials from the same device registry. Use Add certificate above to choose a method.</p></div>
  </div>
  <v-card v-if="!props.embedded" class="pa-4 mb-6"><v-text-field v-if="!props.deviceId" v-model="search" label="Search certificates" prepend-inner-icon="mdi-magnify" hide-details /><v-data-table :headers="headers" :items="displayedCertificates" :search="search" :loading="!!state.busy" class="mt-4">
    <template #item.algorithm="{ item }">{{ item.algorithm || '—' }}</template>
    <template #item.issuerName="{ item }">{{ item.issuerName || item.issuer || '—' }} <span v-if="item.brokerTrusted === false" class="text-warning">(not trusted)</span></template>
    <template #item.status="{ item }"><v-chip size="small" :color="statusColor(item.status)">{{ item.status }}</v-chip></template>
    <template #item.actions="{ item }"><div class="d-flex flex-wrap ga-1"><v-btn size="small" variant="tonal" prepend-icon="mdi-information-outline" @click="details = item">Details</v-btn><v-btn v-if="item.canDownload" size="small" variant="tonal" prepend-icon="mdi-download" :href="`/api/certificates/${item.id}/download`">Certificate</v-btn><v-btn v-if="item.certificate" size="small" variant="tonal" prepend-icon="mdi-certificate-outline" :href="`/api/certificates/${item.id}/chain`">Issuer chain</v-btn><v-btn v-if="item.status === 'pending_external_signature'" size="small" variant="tonal" prepend-icon="mdi-file-sign" @click="importPending(item)">Import signed certificate</v-btn><v-btn v-if="item.status === 'active' || item.status === 'untrusted' || item.status === 'expiring'" size="small" variant="tonal" prepend-icon="mdi-autorenew" @click="renew(item)">Renew / replace</v-btn><v-btn size="small" variant="tonal" prepend-icon="mdi-export-variant" @click="exportInfo(item)">Export info</v-btn><v-btn v-if="item.status === 'active' || item.status === 'untrusted' || item.status === 'expiring'" size="small" color="error" variant="tonal" prepend-icon="mdi-cancel" @click="revoke(item)">Revoke</v-btn></div></template>
  </v-data-table></v-card>
  <v-card v-if="!props.deviceId" class="pa-5"><h2 class="text-h6 mb-2">Trusted external CAs</h2><p class="text-body-2 text-medium-emphasis">Only approved CA certificates are added to the Mosquitto client trust bundle. Trust changes restart the broker.</p><v-list v-if="trustedCas.length"><v-list-item v-for="ca in trustedCas" :key="ca.id" :title="ca.subject" :subtitle="`SHA-256 ${ca.fingerprint} · expires ${ca.validTo}`"><template #append><v-btn color="error" variant="tonal" prepend-icon="mdi-shield-remove-outline" @click="removeCa(ca)">Remove trust</v-btn></template></v-list-item></v-list><v-alert v-else type="info" variant="tonal" class="my-3">No external CAs are trusted.</v-alert><v-textarea v-model="caPem" label="External CA certificate (PEM)" rows="5" /><v-text-field v-model="caConfirmation" label="Type TRUST THIS CA to approve" /><v-btn color="primary" variant="flat" prepend-icon="mdi-shield-check-outline" :disabled="caConfirmation !== 'TRUST THIS CA' || !caPem" :loading="!!state.busy" @click="trustCa">Approve CA trust</v-btn></v-card>

  <v-dialog v-model="dialog" max-width="820" scrollable><v-card class="pa-6"><h2 class="text-h5 mb-4">{{ certificateMethods.find((item) => item.value === method)?.title }}</h2>
    <template v-if="!generatedPending">
      <v-text-field v-model="form.deviceId" label="MQTT device identity" hint="Letters, digits, dots, underscores, and hyphens; this must match the certificate CN." :disabled="!!props.deviceId" required />
      <v-text-field v-if="method === 'external' || method === 'import'" v-model="form.name" label="Device name" />
      <v-select v-if="method === 'generate' || method === 'external'" v-model="form.algorithm" label="Key algorithm" :items="[{ title: 'ECDSA P-256 (recommended)', value: 'ecdsa-p256' }, { title: 'RSA-2048', value: 'rsa-2048' }]" />
      <v-text-field v-if="method === 'generate' || method === 'sign'" v-model.number="form.days" type="number" min="1" label="Certificate validity (days)" />
      <template v-if="method === 'sign'"><p class="text-body-2">{{ form.previousId ? 'Reuse this certificate record’s CSR to replace it with a new serial. For a key rotation, upload a new CSR instead.' : 'Paste or drop a PEM CSR. The private key stays on the device; only the server-selected MQTT identity is signed.' }}</p><FileDrop v-model="form.csr" accept=".csr,.pem" label="a CSR file" /><v-textarea v-model="form.csr" label="Certificate signing request (PEM)" rows="8" /><v-btn variant="tonal" :disabled="!form.csr" @click="action(previewCsr)">Inspect and validate CSR</v-btn><v-card v-if="preview" class="pa-3 mt-3"><div>Subject: {{ preview.subject }}</div><div>Public key: {{ preview.algorithm }}</div><div>SHA-256: {{ preview.publicKeyFingerprint }}</div></v-card></template>
      <template v-if="method === 'import'"><v-select v-if="pending.length" v-model="form.pendingId" label="Complete pending Gateway CSR (optional)" :items="pending.map((item) => ({ title: `${item.deviceId} · ${item.id}`, value: item.id }))" clearable /><FileDrop v-model="form.certificate" accept=".crt,.pem" label="a client certificate" /><v-textarea v-model="form.certificate" label="Client certificate (PEM)" rows="6" /><FileDrop v-model="form.chain" accept=".crt,.pem" label="a CA chain" /><v-textarea v-model="form.chain" label="Issuer chain (optional PEM)" rows="4" /><FileDrop v-model="form.privateKey" accept=".key,.pem" label="a matching private key" /><v-textarea v-model="form.privateKey" label="Matching private key (optional; validated then discarded)" rows="4" /></template>
      <v-alert v-if="method === 'generate'" type="warning" variant="tonal" class="my-4">The ZIP contains the private key and is returned once. Save it in protected device storage; the Gateway never stores a copy.</v-alert>
      <v-alert v-if="method === 'external'" type="info" variant="tonal" class="my-4">The private key is held in memory for up to 15 minutes and delivered once. Restarting the Gateway clears it; regenerate the CSR if delivery expires.</v-alert>
      <div class="d-flex justify-end ga-2 mt-4"><v-btn @click="dialog = false">Cancel</v-btn><v-btn color="primary" :loading="!!state.busy" @click="submit">{{ method === 'sign' ? 'Inspect and sign' : method === 'import' ? 'Validate and import' : method === 'external' ? 'Generate CSR' : 'Generate and download ZIP' }}</v-btn></div>
    </template>
    <template v-else><v-alert type="warning" variant="tonal">Download this private key now. The Gateway keeps no disk copy and cannot recover it. After saving it securely, confirm receipt.</v-alert><div class="d-flex ga-2 mt-4"><v-btn :disabled="generatedPending.keyDownloaded" @click="deliverPendingKey">Download private key once</v-btn><v-btn color="primary" :disabled="!generatedPending.keyDownloaded" @click="confirmKeyReceived">I stored this key securely</v-btn></div></template>
  </v-card></v-dialog>
  <v-dialog v-model="details" max-width="720"><v-card v-if="details" class="pa-6"><h2 class="text-h5 mb-4">{{ details.deviceId }} certificate</h2><v-table density="compact"><tbody><tr><th>Provisioning</th><td>{{ details.provisioningMethod }}</td></tr><tr><th>Subject</th><td>{{ details.subject || 'Pending external signature' }}</td></tr><tr><th>SAN</th><td>{{ details.san || 'None' }}</td></tr><tr><th>Serial</th><td>{{ details.serial || 'Pending' }}</td></tr><tr><th>SHA-256 fingerprint</th><td class="text-break">{{ details.fingerprint || 'Pending' }}</td></tr><tr><th>Issuer</th><td>{{ details.issuerName || details.issuer || 'Pending' }}</td></tr><tr><th>Algorithm</th><td>{{ details.algorithm }}</td></tr><tr><th>Validity</th><td>{{ details.validFrom || '—' }} → {{ details.validTo || '—' }}</td></tr><tr><th>Certificate state</th><td>{{ details.status }}</td></tr><tr><th>Broker trust</th><td>{{ details.brokerTrusted === false ? 'Not trusted; cannot connect' : 'Trusted' }}</td></tr><tr><th>Renewed from</th><td>{{ details.renewedFrom || '—' }}</td></tr></tbody></v-table><div class="d-flex justify-end mt-5"><v-btn @click="details = null">Close</v-btn></div></v-card></v-dialog>
</template>
