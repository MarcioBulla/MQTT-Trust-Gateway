<script setup>
import { revealScopes } from '../sensitive';
import SensitiveValue from '../components/SensitiveValue.vue';
import DateTime from '../components/DateTime.vue';
import { formatDateTime } from '../date-time';
import RowActions from '../components/RowActions.vue';
import DataList from '../components/DataList.vue';
import { ref, computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import { api, action, state, copy } from '../api';
import { certificateMethods } from '../certificate-methods';
const props = defineProps({ licenses: Boolean });
const emit = defineEmits(['add-certificate']);
const router = useRouter();
const devices = ref([]),
  archived = ref([]),
  certs = ref([]),
  search = ref(''),
  filter = ref('All'),
  dialog = ref(false),
  issueDialog = ref(false),
  confirm = ref(null),
  details = ref(null),
  tab = ref('active'),
  confirmText = ref(''),
  labelSearch = ref(''),
  labelColor = ref('blue'),
  labelMenuDevice = ref(null);
const form = ref({ id: '', name: '', description: '', labels: '' }),
  issue = ref({ deviceId: '', csr: '', days: 90, previous: null });
const headers = [
  { title: 'Name', key: 'name', width: '180px', maxWidth: '200px' },
  { title: 'Labels', key: 'labels', width: '170px', maxWidth: '190px' },
  { title: 'Provisioning', key: 'latestCertificate.provisioningMethod', width: '145px', maxWidth: '160px' },
  { title: 'Algorithm', key: 'latestCertificate.algorithm', width: '145px', maxWidth: '160px' },
  { title: 'Status', key: 'latestCertificate.status', width: '150px', maxWidth: '170px' },
  { title: 'Authorization', key: 'enabled', width: '130px', maxWidth: '145px' },
  { title: '', key: 'actions', width: '145px', maxWidth: '150px', sortable: false },
];
const identityRows = computed(() => devices.value.map((device) => ({
  ...device,
  latestCertificate: [...(device.certificates || [])].sort((a, b) =>
    Number(isUsableCertificate(b)) - Number(isUsableCertificate(a)) || Date.parse(b.issuedAt || 0) - Date.parse(a.issuedAt || 0))[0] || null,
})));
function isUsableCertificate(certificate) {
  return ['active', 'expiring'].includes(certificate.status) && certificate.brokerTrusted !== false && Date.parse(certificate.validTo) > Date.now();
}
const labelColors = [
  { title: 'Blue', value: 'blue' }, { title: 'Teal', value: 'teal' },
  { title: 'Green', value: 'green' }, { title: 'Amber', value: 'amber' },
  { title: 'Orange', value: 'orange' }, { title: 'Red', value: 'red' },
  { title: 'Purple', value: 'purple' }, { title: 'Grey', value: 'grey' },
];
const certHeaders = [
  { title: 'Device', key: 'deviceId', width: '150px', maxWidth: '170px' },
  { title: 'Labels', key: 'labels', width: '190px', maxWidth: '210px' },
  { title: 'Serial', key: 'serial', width: '150px', maxWidth: '170px' },
  { title: 'Issued', key: 'issuedAt', width: '160px', maxWidth: '180px' },
  { title: 'Expires', key: 'validTo', width: '160px', maxWidth: '180px' },
  { title: 'Status', key: 'status', width: '130px', maxWidth: '150px' },
  { title: '', key: 'actions', width: '145px', maxWidth: '150px', sortable: false },
];
const archivedHeaders = [
  { title: 'Device', key: 'id' }, { title: 'Archived', key: 'archivedAt' },
  { title: 'Scheduled deletion', key: 'scheduledDeletionAt' }, { title: 'Days remaining', key: 'daysRemaining' },
  { title: '', key: 'actions', sortable: false, width: '64px' },
];
const load = () =>
  action(async () => {
    const grant = revealScopes.devices;
    const [d, a, c, s] = await Promise.all([api('/devices'), api('/devices?status=archived'), api('/certificates'), api('/status')]);
    if (!d || !a || !c || revealScopes.devices !== grant) return;
    devices.value = d.devices;
    archived.value = a.devices.map((item) => ({ ...item, daysRemaining: Math.max(0, Math.ceil((Date.parse(item.scheduledDeletionAt) - Date.now()) / 86400000)) }));
    certs.value = c.certificates;
    issue.value.days = s.defaultDays;
  });
watch(() => revealScopes.devices, () => {
  devices.value = []; archived.value = []; certs.value = []; details.value = null; confirm.value = null;
  load();
}, { immediate: true, flush: 'sync' });
defineExpose({ reload: load });
function create() {
  action(async () => {
    await api('/devices', 'POST', { ...form.value, labels: form.value.labels.split(',').map((label) => label.trim()).filter(Boolean) });
    dialog.value = false;
    form.value = { id: '', name: '', description: '', labels: '' };
    await load();
  }, 'Device registered');
}
function updateAuthorization(device, enabled) {
  if (enabled) {
    if (!canAuthorize(device)) return;
    confirm.value = { device, action: 'approve' };
    return;
  }
  action(async () => {
    await api(`/devices/${device.id}`, 'PATCH', { enabled: false });
    await load();
  }, 'Authorization change saved. Apply pending broker changes to enforce it.');
}
const canAuthorize = (device) => {
  const credentials = device.certificates || [];
  return credentials.some(isUsableCertificate);
};
const isAuthorized = (device) => device.enabled && device.trusted !== false && canAuthorize(device);
const labelValue = (label) => typeof label === 'string' ? { name: label, color: 'primary' } : { name: label.name, color: label.color || 'primary' };
const allLabels = computed(() => {
  const labels = new Map();
  for (const device of [...devices.value, ...archived.value]) {
    for (const rawLabel of device.labels || []) {
      const label = labelValue(rawLabel);
      if (label.name && !labels.has(label.name.toLocaleLowerCase())) labels.set(label.name.toLocaleLowerCase(), label);
    }
  }
  return [...labels.values()].sort((a, b) => a.name.localeCompare(b.name));
});
function labelsFor(device) { return (device.labels || []).map(labelValue).filter((label) => label.name); }
function filteredLabels(device) {
  const attached = new Set(labelsFor(device).map((label) => label.name.toLocaleLowerCase()));
  return allLabels.value.filter((label) => !attached.has(label.name.toLocaleLowerCase()) && label.name.toLocaleLowerCase().includes(labelSearch.value.trim().toLocaleLowerCase()));
}
function canCreateLabel() {
  const name = labelSearch.value.trim();
  return name && !allLabels.value.some((label) => label.name.toLocaleLowerCase() === name.toLocaleLowerCase());
}
function openLabelMenu(device, open) {
  if (open) { labelMenuDevice.value = device; labelSearch.value = ''; labelColor.value = 'blue'; }
  else if (labelMenuDevice.value?.id === device.id) labelMenuDevice.value = null;
}
async function saveDeviceLabels(device, labels) {
  action(async () => {
    await api(`/devices/${device.id}`, 'PATCH', { labels });
    await load();
    return 'Device labels updated.';
  });
}
function attachLabel(device, label) {
  const current = labelsFor(device);
  if (current.some((item) => item.name.toLocaleLowerCase() === label.name.toLocaleLowerCase())) return;
  saveDeviceLabels(device, [...current, label]);
  labelSearch.value = '';
}
function createLabel(device) {
  const name = labelSearch.value.trim().slice(0, 40);
  if (!name || !canCreateLabel()) return;
  attachLabel(device, { name, color: labelColor.value });
}
function removeLabel(device, name) {
  saveDeviceLabels(device, labelsFor(device).filter((label) => label.name !== name));
}
const connectionColor = (status) => ({ connected: 'success', online: 'success', offline: 'error', disconnected: 'error' })[String(status || '').toLowerCase()] || 'medium-emphasis';
function openIssue(id, previous = null) {
  issue.value = { deviceId: id, previous, csr: '', days: issue.value.days };
  issueDialog.value = true;
}
function editCredentials(deviceId) {
  router.push(`/devices/${encodeURIComponent(deviceId)}/certificates`);
}
function sign() {
  action(async () => {
    const i = issue.value;
    await api(i.previous ? `/certificates/${i.previous}/renew` : '/certificates/sign', 'POST', {
      deviceId: i.deviceId,
      csr: i.csr || undefined,
      days: Number(i.days),
    });
    issueDialog.value = false;
    await load();
  }, 'Certificate issued. Download it from the certificate history.');
}
function executeConfirm() {
  action(async () => {
    const c = confirm.value;
    if (c.license) {
      const result = await api(`/certificates/${c.license.id}${c.action === 'archive' ? '/archive' : ''}`, c.action === 'archive' ? 'POST' : 'DELETE', { confirm: confirmText.value });
      if (result.identityBlocked) state.notice = result.message;
    }
    else if (c.cert) await api(`/certificates/${c.cert.id}/revoke`, 'POST', {});
    else if (c.action === 'archive') await api(`/devices/${c.device.id}/archive`, 'POST', { confirm: confirmText.value });
    else if (c.action === 'delete') await api(`/devices/${c.device.id}`, 'DELETE', { confirm: confirmText.value });
    else if (c.action === 'restore') await api(`/devices/${c.device.id}/restore`, 'POST', {});
    else if (c.action === 'approve') await api(`/devices/${c.device.id}/approve`, 'POST', { confirm: c.device.id });
    else await api(`/devices/${c.device.id}`, 'PATCH', { enabled: !c.device.enabled });
    confirm.value = null;
    confirmText.value = '';
    await load();
  }, 'Changes saved. Use Restart Broker in the top bar to apply pending changes.');
}
const color = (s) =>
  ({ active: 'success', expiring: 'warning', revoked: 'error', expired: 'error', untrusted: 'warning', pending_external_signature: 'info' })[s] || 'default';
const confirmationPhrase = () =>
  confirm.value?.license ? `${confirm.value.action === 'archive' ? 'ARCHIVE' : 'DELETE'} ${confirm.value.license.serial || confirm.value.license.id}` : confirm.value?.action === 'archive'
    ? confirm.value.device.id
    : confirm.value?.action === 'delete'
      ? `DELETE ${confirm.value.device.id}`
      : '';
const licenseDevice = (id) =>
  devices.value.find((device) => device.id === id) ||
  archived.value.find((device) => device.id === id) ||
  { id, enabled: false, status: 'unknown' };
function searchRows(_value, query, item) {
  const row = item?.raw || item || {};
  const device = row.deviceId ? licenseDevice(row.deviceId) : row;
  const certificate = row.latestCertificate || row;
  return [row.name, row.id, row.deviceId, device.name, device.description,
    certificate.serial, certificate.provisioningMethod, certificate.issuerName,
    certificate.algorithm, certificate.status, certificate.validTo,
    ...labelsFor(device).map((label) => label.name),
    ...(device.certificates || []).map((entry) => [entry.serial, entry.provisioningMethod, entry.issuerName].filter(Boolean).join(' '))]
    .filter((value) => value != null).join(' ').toLocaleLowerCase().includes(String(query).trim().toLocaleLowerCase());
}
const licenseCounts = (status) =>
  certs.value.filter((certificate) => !certificate.licenseArchivedAt && !certificate.licenseDeletedAt).filter((certificate) => status === 'inactive'
    ? ['expired', 'revoked', 'blocked'].includes(certificate.status)
    : certificate.status === status).length;
</script>
<template>
  <div class="d-flex flex-wrap align-center justify-space-between ga-4 mb-6">
    <div>
      <div class="text-overline text-primary">IDENTITY & ACCESS</div>
      <h1 class="text-h4 font-weight-bold">
        {{ props.licenses ? 'Device licenses' : 'Trusted devices' }}
      </h1>
      <p class="text-medium-emphasis mt-2 page-intro">
        {{
          props.licenses
            ? 'Certificate validity is the authorization period. Renewals receive new serials; revoked records remain in history.'
            : 'Register identities, issue certificates from device CSRs, and control MQTT access.'
        }}
      </p>
    </div>
    <div v-if="!props.licenses" class="d-flex flex-wrap ga-2">
      <v-menu><template #activator="{ props: menuProps }"><v-btn v-bind="menuProps" variant="tonal" prepend-icon="mdi-certificate-outline">Add certificate</v-btn></template><v-list><v-list-item v-for="method in certificateMethods" :key="method.value" :title="method.title" @click="emit('add-certificate', method.value)" /></v-list></v-menu>
      <v-btn color="primary" prepend-icon="mdi-plus" @click="dialog = true">Register device</v-btn>
    </div>
  </div>
  <v-row v-if="props.licenses" class="mb-4" dense>
    <v-col v-for="item in [{ key: 'active', label: 'Active licenses', icon: 'mdi-shield-check-outline', color: 'success' }, { key: 'expiring', label: 'Expiring soon', icon: 'mdi-clock-alert-outline', color: 'warning' }, { key: 'inactive', label: 'Expired or revoked', icon: 'mdi-shield-off-outline', color: 'error' }]" :key="item.key" cols="12" sm="4">
      <v-card class="pa-4 h-100"><div class="d-flex align-center ga-3"><v-avatar :color="item.color" variant="tonal" rounded="lg"><v-icon :icon="item.icon" /></v-avatar><div><div class="text-caption text-medium-emphasis">{{ item.label }}</div><div class="text-h5 font-weight-bold">{{ licenseCounts(item.key) }}</div></div></div></v-card>
    </v-col>
  </v-row>
  <v-card class="pa-4"
    ><v-tabs v-if="props.licenses" v-model="tab" class="mb-3"><v-tab value="active">Active licenses</v-tab><v-tab value="archived">Archived licenses</v-tab></v-tabs><v-tabs v-if="!props.licenses" v-model="tab" class="mb-3" @update:model-value="load"><v-tab value="active">Active ({{ devices.length }})</v-tab><v-tab value="archived">Archived ({{ archived.length }})</v-tab></v-tabs>
    <div class="d-flex align-center ga-3 flex-wrap">
      <v-text-field
        v-model="search"
        :label="props.licenses ? 'Search licenses' : 'Search devices or certificates'"
        prepend-inner-icon="mdi-magnify"
        hide-details
        max-width="440"
      /><v-select
        v-if="props.licenses"
        v-model="filter"
        :items="['All', 'active', 'expiring', 'expired', 'revoked']"
        label="Certificate status"
        hide-details
        max-width="220"
      /><v-btn icon="mdi-refresh" aria-label="Refresh devices" @click="load" />
    </div>
    <DataList
      v-if="!props.licenses && tab === 'active'"
      :headers="headers"
      :items="identityRows"
      :search="search" :custom-filter="searchRows"
      :loading="!!state.busy"
      class="mt-4 identity-table" min-width="1100px"
    >
      <template #item.name="{ item }"><v-tooltip :text="`ID: ${item.id}`" location="top" :open-delay="650" :close-delay="150"><template #activator="{ props: tooltipProps }"><v-btn v-bind="tooltipProps" variant="text" density="compact" :class="['name-copy', 'text-none', 'px-0', `text-${connectionColor(item.connectionStatus)}`]" :aria-label="`Copy device name ${item.name || item.id}`" @click="copy(item.name || item.id)">{{ item.name || item.id }}</v-btn></template></v-tooltip></template>
      <template #item.labels="{ item }"><div class="d-flex flex-wrap align-center ga-1"><v-chip v-for="rawLabel in item.labels || []" :key="labelValue(rawLabel).name" size="small" closable :color="labelValue(rawLabel).color" variant="tonal" @click:close="removeLabel(item, labelValue(rawLabel).name)">{{ labelValue(rawLabel).name }}</v-chip><v-menu location="bottom start" :close-on-content-click="false" @update:model-value="openLabelMenu(item, $event)"><template #activator="{ props: menuProps }"><v-btn v-bind="menuProps" icon="mdi-plus" size="x-small" variant="text" color="medium-emphasis" class="label-add-btn" :aria-label="`Add label to ${item.name || item.id}`" /></template><v-card width="300" class="pa-3"><v-text-field v-model="labelSearch" label="Search labels" prepend-inner-icon="mdi-magnify" density="compact" hide-details autofocus /><v-list v-if="filteredLabels(item).length" density="compact" max-height="180" class="overflow-y-auto mt-2"><v-list-item v-for="label in filteredLabels(item)" :key="label.name" :title="label.name" @click="attachLabel(item, label)"><template #prepend><v-icon icon="mdi-circle" :color="label.color" size="small" /></template></v-list-item></v-list><p v-else-if="!canCreateLabel()" class="text-caption text-medium-emphasis mt-3 mb-0">No available matching labels.</p><div v-if="canCreateLabel()" class="mt-3"><v-select v-model="labelColor" :items="labelColors" label="Label color" density="compact" hide-details class="mb-3"><template #selection="{ item: colorItem }"><span class="d-flex align-center ga-2"><v-icon icon="mdi-circle" :color="colorItem.value" size="small" />{{ colorItem.title }}</span></template><template #item="{ props: colorProps, item: colorItem }"><v-list-item v-bind="colorProps"><template #prepend><v-icon icon="mdi-circle" :color="colorItem.value" size="small" /></template></v-list-item></template></v-select><v-btn block color="primary" prepend-icon="mdi-plus" @click="createLabel(item)">Create “{{ labelSearch.trim().slice(0, 40) }}”</v-btn></div></v-card></v-menu></div></template>
      <template #item.latestCertificate.provisioningMethod="{ item }"><v-tooltip v-if="item.latestCertificate" :text="`Issuer: ${item.latestCertificate.issuerName || item.latestCertificate.issuer || 'Unknown'}${item.latestCertificate.brokerTrusted === false ? ' (not trusted)' : ''}`" location="top"><template #activator="{ props: tooltipProps }"><span v-bind="tooltipProps">{{ item.latestCertificate.provisioningMethod || '—' }}</span></template></v-tooltip><span v-else class="text-medium-emphasis">—</span></template>
      <template #item.latestCertificate.algorithm="{ item }">{{ item.latestCertificate?.algorithm || '—' }}</template>
      <template #item.latestCertificate.status="{ item }"><v-tooltip v-if="item.latestCertificate" :text="`Expires ${formatDateTime(item.latestCertificate.validTo)}`" location="top"><template #activator="{ props: tooltipProps }"><v-chip v-bind="tooltipProps" size="small" :color="color(item.latestCertificate.status)">{{ item.latestCertificate.status }}</v-chip></template></v-tooltip><v-chip v-else size="small" color="warning">No certificate</v-chip></template>
      <template #item.enabled="{ item }"><div class="d-flex align-center ga-2"><v-switch :model-value="isAuthorized(item)" :disabled="!canAuthorize(item) && !isAuthorized(item)" color="success" density="compact" hide-details :aria-label="`Authorize ${item.id} for MQTT`" @update:model-value="updateAuthorization(item, $event)" /><span class="text-caption">{{ isAuthorized(item) ? 'Authorized' : canAuthorize(item) ? 'Disabled' : 'No valid credential' }}</span></div></template>
      <template #item.actions="{ item }"><div class="d-flex align-center justify-end ga-1"><v-btn size="small" variant="tonal" prepend-icon="mdi-pencil-outline" @click="editCredentials(item.id)">Edit</v-btn><RowActions label="Device actions" :disabled="!!state.busy">
        <v-list-item prepend-icon="mdi-information-outline" title="Details" @click="details = item" />
        <v-list-item v-if="item.latestCertificate?.canDownload" prepend-icon="mdi-download" title="Download certificate" :href="`/api/certificates/${item.latestCertificate.id}/download`" />
        <v-list-item v-if="item.latestCertificate && ['active', 'expiring', 'untrusted'].includes(item.latestCertificate.status)" prepend-icon="mdi-autorenew" title="Renew / replace certificate" @click="openIssue(item.id, item.latestCertificate.id)" />
        <v-list-item v-if="item.latestCertificate && ['active', 'expiring', 'untrusted'].includes(item.latestCertificate.status)" prepend-icon="mdi-cancel" title="Revoke certificate" @click="confirm = { cert: item.latestCertificate }" />
        <v-list-item prepend-icon="mdi-certificate-plus" title="Issue certificate" :disabled="item.status !== 'active'" @click="openIssue(item.id)" />
        <v-list-item prepend-icon="mdi-shield-check-outline" :title="isAuthorized(item) ? 'Disable authorization' : 'Approve & authorize'" :disabled="!isAuthorized(item) && !canAuthorize(item)" @click="isAuthorized(item) ? updateAuthorization(item, false) : updateAuthorization(item, true)" />
        <v-list-item prepend-icon="mdi-archive-arrow-down-outline" title="Archive device" @click="confirm = { device: item, action: 'archive' }" />
        <v-list-item prepend-icon="mdi-delete-forever-outline" title="Delete device" class="text-error" @click="confirm = { device: item, action: 'delete' }" />
        </RowActions></div></template>
    </DataList>
    <DataList v-if="!props.licenses && tab === 'archived'" :headers="archivedHeaders" :items="archived" :search="search" :custom-filter="searchRows" :loading="!!state.busy" class="mt-4">
      <template #item.archivedAt="{ item }"><DateTime :value="item.archivedAt" /></template>
      <template #item.scheduledDeletionAt="{ item }"><DateTime :value="item.scheduledDeletionAt" /></template>
      <template #item.daysRemaining="{ item }"><v-chip size="small" :color="item.daysRemaining <= 3 ? 'warning' : 'default'">{{ item.daysRemaining }} days</v-chip></template>
      <template #item.actions="{ item }"><RowActions label="Archived device actions" :disabled="!!state.busy"><v-list-item title="Restore device" prepend-icon="mdi-restore" @click="confirm = { device: item, action: 'restore' }" /><v-list-item title="Delete now" prepend-icon="mdi-delete-forever-outline" class="text-error" @click="confirm = { device: item, action: 'delete' }" /></RowActions></template>
    </DataList>
    <DataList
      v-if="props.licenses"
      :headers="certHeaders"
      :items="certs.filter((c) => !c.licenseDeletedAt && (tab === 'archived' ? !!c.licenseArchivedAt : !c.licenseArchivedAt) && (filter === 'All' || c.status === filter))"
      :search="search" :custom-filter="searchRows"
      :loading="!!state.busy"
      class="mt-4 identity-table" min-width="1100px"
    >
      <template #item.labels="{ item }"><div class="d-flex flex-wrap align-center ga-1"><v-chip v-for="rawLabel in licenseDevice(item.deviceId).labels || []" :key="labelValue(rawLabel).name" size="small" :closable="licenseDevice(item.deviceId).status === 'active'" :color="labelValue(rawLabel).color" variant="tonal" @click:close="removeLabel(licenseDevice(item.deviceId), labelValue(rawLabel).name)">{{ labelValue(rawLabel).name }}</v-chip><v-menu v-if="licenseDevice(item.deviceId).status === 'active'" location="bottom start" :close-on-content-click="false" @update:model-value="openLabelMenu(licenseDevice(item.deviceId), $event)"><template #activator="{ props: menuProps }"><v-btn v-bind="menuProps" icon="mdi-plus" size="x-small" variant="text" color="medium-emphasis" class="label-add-btn" :aria-label="`Add label to ${licenseDevice(item.deviceId).name || item.deviceId}`" /></template><v-card width="300" class="pa-3"><v-text-field v-model="labelSearch" label="Search labels" prepend-inner-icon="mdi-magnify" density="compact" hide-details autofocus /><v-list v-if="filteredLabels(licenseDevice(item.deviceId)).length" density="compact" max-height="180" class="overflow-y-auto mt-2"><v-list-item v-for="label in filteredLabels(licenseDevice(item.deviceId))" :key="label.name" :title="label.name" @click="attachLabel(licenseDevice(item.deviceId), label)"><template #prepend><v-icon icon="mdi-circle" :color="label.color" size="small" /></template></v-list-item></v-list><p v-else-if="!canCreateLabel()" class="text-caption text-medium-emphasis mt-3 mb-0">No available matching labels.</p><div v-if="canCreateLabel()" class="mt-3"><v-select v-model="labelColor" :items="labelColors" label="Label color" density="compact" hide-details class="mb-3"><template #selection="{ item: colorItem }"><span class="d-flex align-center ga-2"><v-icon icon="mdi-circle" :color="colorItem.value" size="small" />{{ colorItem.title }}</span></template><template #item="{ props: colorProps, item: colorItem }"><v-list-item v-bind="colorProps"><template #prepend><v-icon icon="mdi-circle" :color="colorItem.value" size="small" /></template></v-list-item></template></v-select><v-btn block color="primary" prepend-icon="mdi-plus" @click="createLabel(licenseDevice(item.deviceId))">Create “{{ labelSearch.trim().slice(0, 40) }}”</v-btn></div></v-card></v-menu></div></template>
      <template #item.issuedAt="{ item }"><DateTime :value="item.issuedAt" /></template>
      <template #item.validTo="{ item }"><DateTime :value="item.validTo" /></template>
      <template #item.serial="{ item }"
        ><span class="mono text-caption"><SensitiveValue scope="devices" :value="item.serial" label="Certificate serial" /></span></template
      ><template #item.status="{ item }"
        ><v-chip size="small" :color="color(item.status)">{{ item.status }}</v-chip></template
      >
      <template #item.actions="{ item }"><div class="d-flex align-center justify-end ga-1"><v-btn size="small" variant="tonal" prepend-icon="mdi-pencil-outline" @click="editCredentials(item.deviceId)">Edit</v-btn><RowActions label="License actions" :disabled="!!state.busy">
        <v-list-item v-if="item.canDownload" prepend-icon="mdi-download" title="Download certificate" :href="`/api/certificates/${item.id}/download`" />
        <v-list-item prepend-icon="mdi-autorenew" title="Renew / replace" @click="openIssue(item.deviceId, item.id)" />
        <v-list-item v-if="item.status !== 'revoked'" prepend-icon="mdi-cancel" title="Revoke certificate" class="text-error" @click="confirm = { cert: item }" />
        <v-list-item v-if="!item.licenseArchivedAt" prepend-icon="mdi-archive-arrow-down-outline" title="Archive license" @click="confirm = { license: item, action: 'archive' }" />
        <v-list-item prepend-icon="mdi-delete-forever-outline" title="Delete license" class="text-error" @click="confirm = { license: item, action: 'delete' }" />
      </RowActions></div></template>
    </DataList>
  </v-card>
  <v-alert type="info" variant="tonal" class="mt-5"
    >{{ props.licenses ? 'A certificate’s validity period defines its license period. Renewing issues a new certificate and preserves the previous record. Revocation blocks the identity at the broker.' : 'Device status and last activity are unavailable without a verified broker connection feed. Disabled devices have no topic authorization. Revocation also rejects the certificate at TLS authentication.' }}</v-alert
  >
  <v-dialog v-model="dialog" max-width="550"
    ><v-card class="pa-6"
      ><h2 class="text-h5 mb-5">Register device</h2>
      <v-form @submit.prevent="create"
        ><v-text-field
          v-model="form.id"
          label="Identifier"
          hint="Letters, digits, dots, underscores, hyphens; max 64"
          pattern="[A-Za-z0-9._-]{1,64}"
          required
          maxlength="64"
        /><v-text-field v-model="form.name" label="Name" maxlength="100" /><v-text-field v-model="form.labels" label="Labels" hint="Optional; separate labels with commas" persistent-hint /><v-textarea
          v-model="form.description"
          label="Description"
          maxlength="1000"
        />
        <div class="d-flex justify-end ga-2">
          <v-btn @click="dialog = false">Cancel</v-btn
          ><v-btn color="primary" type="submit" :loading="!!state.busy">Register</v-btn>
        </div></v-form
      ></v-card
    ></v-dialog
  >
  <v-dialog v-model="issueDialog" max-width="720"
    ><v-card class="pa-6"
      ><h2 class="text-h5 mb-3">
        {{ issue.previous ? 'Renew' : 'Issue' }} certificate · {{ issue.deviceId }}
      </h2>
      <p class="text-body-2 mb-4">
        Generate the private key on the device. Paste a signed PEM CSR. A renewal can reuse the
        previous CSR when this field is empty.
      </p>
      <v-form @submit.prevent="sign"
        ><v-textarea
          v-model="issue.csr"
          label="Certificate signing request (PEM)"
          rows="9"
          :required="!issue.previous"
        /><v-text-field
          v-model="issue.days"
          label="Validity in days"
          type="number"
          min="1"
          required
        />
        <div class="d-flex justify-end ga-2">
          <v-btn @click="issueDialog = false">Cancel</v-btn
          ><v-btn color="primary" type="submit" :loading="!!state.busy">Issue certificate</v-btn>
        </div></v-form
      ></v-card
    ></v-dialog
  >
  <v-dialog :model-value="!!confirm" max-width="520" @update:model-value="confirm = null"
    ><v-card class="pa-6"
      ><h2 class="text-h5 mb-3">{{ confirm?.license ? (confirm.action === 'archive' ? 'Archive license' : 'Delete license') : confirm?.action === 'archive' ? 'Archive device' : confirm?.action === 'restore' ? 'Restore device' : confirm?.action === 'delete' ? 'Permanently delete device' : confirm?.cert ? 'Revoke certificate' : 'Confirm authorization change' }}</h2>
      <p v-if="confirm?.license">{{ confirm.action === 'archive' ? 'Archive' : 'Delete' }} this license for {{ confirm.license.deviceId }}? The device is preserved. The certificate is revoked; security evidence remains. Apply pending broker changes to enforce it.</p>
      <p v-else-if="confirm?.cert">
        Permanently revoke {{ confirm.cert.deviceId }} certificate {{ confirm.cert.serial }}?
      </p>
      <p v-else-if="confirm?.action === 'archive'">Archive {{ confirm?.device?.id }}? MQTT access stops when pending broker changes are applied. The device will be deleted in 30 days unless restored.</p>
      <p v-else-if="confirm?.action === 'restore'">Restore {{ confirm?.device?.id }}? It remains disabled until explicitly approved.</p>
      <p v-else-if="confirm?.action === 'delete'">Permanently delete {{ confirm?.device?.id }} now? Audit evidence remains and the identifier can never be reused.</p>
      <p v-else-if="confirm?.action === 'approve'">Approve {{ confirm?.device?.id }} and allow it to connect to MQTT? Explicit approval is required to enable this device.</p>
      <p v-else>Change access for {{ confirm?.device?.id }}?</p>
      <template v-if="confirm?.action === 'archive' || confirm?.action === 'delete'">
        <div class="d-flex align-center flex-wrap ga-2 mt-5 mb-2">
          <span>Type</span><v-btn prepend-icon="mdi-content-copy" size="small" color="primary" variant="tonal" rounded="pill" class="confirmation-copy-button" :aria-label="`Copy ${confirmationPhrase()} to clipboard`" title="Copy confirmation text" @click="copy(confirmationPhrase())">{{ confirmationPhrase() }}</v-btn><span>to confirm.</span>
        </div>
        <v-text-field v-model="confirmText" label="Enter confirmation" autocomplete="off" autocapitalize="off" spellcheck="false" />
      </template>
      <v-alert v-if="confirm?.action === 'delete'" type="error" variant="tonal" class="mb-4">This action cannot be undone.</v-alert>

      <div class="d-flex justify-end ga-2">
        <v-btn @click="confirm = null">Cancel</v-btn
        ><v-btn color="error" :disabled="['archive', 'delete'].includes(confirm?.action) && confirmText !== confirmationPhrase()" :loading="!!state.busy" @click="executeConfirm">{{ confirm?.license ? (confirm.action === 'archive' ? 'Archive license' : 'Delete license') : confirm?.action === 'archive' ? 'Archive device' : confirm?.action === 'delete' ? 'Confirm delete' : 'Confirm' }}</v-btn>
      </div></v-card
    ></v-dialog
  >
  <v-dialog :model-value="!!details" max-width="750" @update:model-value="details = null"
    ><v-card class="pa-6"
      ><h2 class="text-h5 mb-3">{{ details?.name }}</h2>
      <p>{{ details?.description }}</p>
      <p class="mt-2">
        ID: {{ details?.id }} · Connection: unavailable · Last activity: unavailable
      </p>
      <h3 class="mt-5 mb-3">Certificate history</h3>
      <v-list
        ><v-list-item
          v-for="c in details?.certificates"
          :key="c.id"
          :subtitle="`${c.status} · ${formatDateTime(c.validFrom)} → ${formatDateTime(c.validTo)}`"><template #title><SensitiveValue scope="devices" :value="c.serial" label="Certificate serial" /></template></v-list-item></v-list
      ><v-btn @click="details = null">Close</v-btn></v-card
    ></v-dialog
  >
</template>

<style scoped>
.name-copy { max-width: 100%; white-space: normal; text-align: left; overflow-wrap: anywhere; }
.label-add-btn { opacity: .68; transition: opacity .15s, color .15s; }
.label-add-btn:hover, .label-add-btn:focus-visible { opacity: 1; color: rgb(var(--v-theme-primary)) !important; }
.confirmation-copy-button { max-width: 100%; height: auto !important; min-height: 32px; padding-block: 6px; white-space: normal; }
.confirmation-copy-button :deep(.v-btn__content) { white-space: normal; overflow-wrap: anywhere; text-align: left; }
</style>
