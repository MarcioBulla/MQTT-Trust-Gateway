<script setup>
import { ref, computed, onMounted } from 'vue';
import { api, action, state, copy } from '../api';
const props = defineProps({ licenses: Boolean });
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
  { title: 'Issuer', key: 'latestCertificate.issuerName', width: '170px', maxWidth: '190px' },
  { title: 'Algorithm', key: 'latestCertificate.algorithm', width: '145px', maxWidth: '160px' },
  { title: 'Credential', key: 'latestCertificate.status', width: '150px', maxWidth: '170px' },
  { title: 'Authorization', key: 'enabled', width: '130px', maxWidth: '145px' },
  { title: '', key: 'actions', width: '64px', maxWidth: '64px', sortable: false },
];
const identityRows = computed(() => devices.value.map((device) => ({
  ...device,
  latestCertificate: [...(device.certificates || [])].sort((a, b) => Date.parse(b.issuedAt || 0) - Date.parse(a.issuedAt || 0))[0] || null,
})));
const labelColors = [
  { title: 'Blue', value: 'blue' }, { title: 'Teal', value: 'teal' },
  { title: 'Green', value: 'green' }, { title: 'Amber', value: 'amber' },
  { title: 'Orange', value: 'orange' }, { title: 'Red', value: 'red' },
  { title: 'Purple', value: 'purple' }, { title: 'Grey', value: 'grey' },
];
const certHeaders = [
  { title: 'Device', key: 'deviceId' },
  { title: 'Serial', key: 'serial' },
  { title: 'Issued', key: 'issuedAt' },
  { title: 'Expires', key: 'validTo' },
  { title: 'Status', key: 'status' },
  { title: 'Actions', key: 'actions', sortable: false },
];
const archivedHeaders = [
  { title: 'Device', key: 'id' }, { title: 'Archived (UTC)', key: 'archivedAt' },
  { title: 'Scheduled deletion (UTC)', key: 'scheduledDeletionAt' }, { title: 'Days remaining', key: 'daysRemaining' },
  { title: 'Actions', key: 'actions', sortable: false },
];
const load = () =>
  action(async () => {
    const [d, a, c, s] = await Promise.all([api('/devices'), api('/devices?status=archived'), api('/certificates'), api('/status')]);
    devices.value = d.devices;
    archived.value = a.devices.map((item) => ({ ...item, daysRemaining: Math.max(0, Math.ceil((Date.parse(item.scheduledDeletionAt) - Date.now()) / 86400000)) }));
    certs.value = c.certificates;
    issue.value.days = s.defaultDays;
  });
onMounted(load);
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
  }, 'Device authorization disabled. Broker sessions are being disconnected.');
}
const canAuthorize = (device) => {
  const credentials = device.certificates || [];
  return !credentials.length || credentials.some((certificate) =>
    ['active', 'expiring'].includes(certificate.status) && certificate.brokerTrusted !== false && Date.parse(certificate.validTo) > Date.now());
};
const isAuthorized = (device) => device.enabled && device.trusted !== false;
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
    if (c.cert) await api(`/certificates/${c.cert.id}/revoke`, 'POST', {});
    else if (c.action === 'archive') await api(`/devices/${c.device.id}/archive`, 'POST', { confirm: confirmText.value });
    else if (c.action === 'delete') await api(`/devices/${c.device.id}`, 'DELETE', { confirm: confirmText.value });
    else if (c.action === 'restore') await api(`/devices/${c.device.id}/restore`, 'POST', {});
    else if (c.action === 'approve') await api(`/devices/${c.device.id}/approve`, 'POST', { confirm: c.device.id });
    else await api(`/devices/${c.device.id}`, 'PATCH', { enabled: !c.device.enabled });
    confirm.value = null;
    confirmText.value = '';
    await load();
  }, 'Authorization updated. Check broker revision on Overview.');
}
const color = (s) =>
  ({ active: 'success', expiring: 'warning', revoked: 'error', expired: 'error', untrusted: 'warning', pending_external_signature: 'info' })[s] || 'default';
const confirmationPhrase = () =>
  confirm.value?.action === 'archive'
    ? confirm.value.device.id
    : confirm.value?.action === 'delete'
      ? `DELETE ${confirm.value.device.id}`
      : '';
const licenseDevice = (id) =>
  devices.value.find((device) => device.id === id) ||
  archived.value.find((device) => device.id === id) ||
  { id, enabled: false, status: 'unknown' };
const licenseCounts = (status) =>
  certs.value.filter((certificate) => status === 'inactive'
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
    <v-btn v-if="!props.licenses" color="primary" prepend-icon="mdi-plus" @click="dialog = true"
      >Register device</v-btn
    >
  </div>
  <v-row v-if="props.licenses" class="mb-4" dense>
    <v-col v-for="item in [{ key: 'active', label: 'Active licenses', icon: 'mdi-shield-check-outline', color: 'success' }, { key: 'expiring', label: 'Expiring soon', icon: 'mdi-clock-alert-outline', color: 'warning' }, { key: 'inactive', label: 'Expired or revoked', icon: 'mdi-shield-off-outline', color: 'error' }]" :key="item.key" cols="12" sm="4">
      <v-card class="pa-4 h-100"><div class="d-flex align-center ga-3"><v-avatar :color="item.color" variant="tonal" rounded="lg"><v-icon :icon="item.icon" /></v-avatar><div><div class="text-caption text-medium-emphasis">{{ item.label }}</div><div class="text-h5 font-weight-bold">{{ licenseCounts(item.key) }}</div></div></div></v-card>
    </v-col>
  </v-row>
  <v-card class="pa-4"
    ><v-tabs v-if="!props.licenses" v-model="tab" class="mb-3" @update:model-value="load"><v-tab value="active">Active ({{ devices.length }})</v-tab><v-tab value="archived">Archived ({{ archived.length }})</v-tab></v-tabs>
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
    <v-data-table
      v-if="!props.licenses && tab === 'active'"
      :headers="headers"
      :items="identityRows"
      :search="search"
      :loading="!!state.busy"
      class="mt-4 identity-table"
    >
      <template #item.name="{ item }"><v-tooltip :text="`ID: ${item.id}`" location="top" :open-delay="650" :close-delay="150"><template #activator="{ props: tooltipProps }"><v-btn v-bind="tooltipProps" variant="text" density="compact" :class="['name-copy', 'text-none', 'px-0', `text-${connectionColor(item.connectionStatus)}`]" :aria-label="`Copy device name ${item.name || item.id}`" @click="copy(item.name || item.id)">{{ item.name || item.id }}</v-btn></template></v-tooltip></template>
      <template #item.labels="{ item }"><div class="d-flex flex-wrap align-center ga-1"><v-chip v-for="rawLabel in item.labels || []" :key="labelValue(rawLabel).name" size="small" closable :color="labelValue(rawLabel).color" variant="tonal" @click:close="removeLabel(item, labelValue(rawLabel).name)">{{ labelValue(rawLabel).name }}</v-chip><v-menu location="bottom start" :close-on-content-click="false" @update:model-value="openLabelMenu(item, $event)"><template #activator="{ props: menuProps }"><v-btn v-bind="menuProps" icon="mdi-plus" size="x-small" variant="tonal" color="primary" :aria-label="`Add label to ${item.name || item.id}`" /></template><v-card width="300" class="pa-3"><v-text-field v-model="labelSearch" label="Search labels" prepend-inner-icon="mdi-magnify" density="compact" hide-details autofocus /><v-list v-if="filteredLabels(item).length" density="compact" max-height="180" class="overflow-y-auto mt-2"><v-list-item v-for="label in filteredLabels(item)" :key="label.name" :title="label.name" @click="attachLabel(item, label)"><template #prepend><v-icon icon="mdi-circle" :color="label.color" size="small" /></template></v-list-item></v-list><p v-else-if="!canCreateLabel()" class="text-caption text-medium-emphasis mt-3 mb-0">No available matching labels.</p><div v-if="canCreateLabel()" class="mt-3"><v-select v-model="labelColor" :items="labelColors" label="Label color" density="compact" hide-details class="mb-3"><template #selection="{ item: colorItem }"><span class="d-flex align-center ga-2"><v-icon icon="mdi-circle" :color="colorItem.value" size="small" />{{ colorItem.title }}</span></template><template #item="{ props: colorProps, item: colorItem }"><v-list-item v-bind="colorProps"><template #prepend><v-icon icon="mdi-circle" :color="colorItem.value" size="small" /></template></v-list-item></template></v-select><v-btn block color="primary" prepend-icon="mdi-plus" @click="createLabel(item)">Create “{{ labelSearch.trim().slice(0, 40) }}”</v-btn></div></v-card></v-menu></div><span v-if="!item.labels?.length" class="text-caption text-medium-emphasis">Add label</span></template>
      <template #item.latestCertificate.provisioningMethod="{ item }">{{ item.latestCertificate?.provisioningMethod || '—' }}</template>
      <template #item.latestCertificate.issuerName="{ item }"><span>{{ item.latestCertificate?.issuerName || item.latestCertificate?.issuer || '—' }}</span><span v-if="item.latestCertificate?.brokerTrusted === false" class="text-warning"> (not trusted)</span></template>
      <template #item.latestCertificate.algorithm="{ item }">{{ item.latestCertificate?.algorithm || '—' }}</template>
      <template #item.latestCertificate.status="{ item }"><div v-if="item.latestCertificate" class="d-flex flex-column align-start ga-1"><v-chip size="small" :color="color(item.latestCertificate.status)">{{ item.latestCertificate.status }}</v-chip><span class="text-caption text-medium-emphasis">Expires {{ item.latestCertificate.validTo || '—' }}</span></div><span v-else class="text-medium-emphasis">No certificate</span></template>
      <template #item.enabled="{ item }"><div class="d-flex align-center ga-2"><v-switch :model-value="isAuthorized(item)" :disabled="!canAuthorize(item) && !isAuthorized(item)" color="success" density="compact" hide-details :aria-label="`Authorize ${item.id} for MQTT`" @update:model-value="updateAuthorization(item, $event)" /><span class="text-caption">{{ isAuthorized(item) ? 'Authorized' : canAuthorize(item) ? 'Disabled' : 'No valid credential' }}</span></div></template>
      <template #item.actions="{ item }"
        ><v-menu location="bottom end"><template #activator="{ props: menuProps }"><v-btn v-bind="menuProps" icon="mdi-dots-vertical" variant="text" size="small" aria-label="Device actions" /></template><v-list density="compact">
        <v-list-item prepend-icon="mdi-information-outline" title="Details" @click="details = item" />
        <v-list-item v-if="item.latestCertificate?.canDownload" prepend-icon="mdi-download" title="Download certificate" :href="`/api/certificates/${item.latestCertificate.id}/download`" />
        <v-list-item v-if="item.latestCertificate && ['active', 'expiring', 'untrusted'].includes(item.latestCertificate.status)" prepend-icon="mdi-autorenew" title="Renew / replace certificate" @click="openIssue(item.id, item.latestCertificate.id)" />
        <v-list-item v-if="item.latestCertificate && ['active', 'expiring', 'untrusted'].includes(item.latestCertificate.status)" prepend-icon="mdi-cancel" title="Revoke certificate" @click="confirm = { cert: item.latestCertificate }" />
        <v-list-item prepend-icon="mdi-certificate-plus" title="Issue certificate" :disabled="item.status !== 'active'" @click="openIssue(item.id)" />
        <v-list-item prepend-icon="mdi-shield-check-outline" :title="isAuthorized(item) ? 'Disable authorization' : 'Approve & authorize'" :disabled="!isAuthorized(item) && !canAuthorize(item)" @click="isAuthorized(item) ? updateAuthorization(item, false) : updateAuthorization(item, true)" />
        <v-list-item prepend-icon="mdi-archive-arrow-down-outline" title="Archive device" @click="confirm = { device: item, action: 'archive' }" />
        <v-list-item prepend-icon="mdi-delete-forever-outline" title="Delete device" class="text-error" @click="confirm = { device: item, action: 'delete' }" />
        </v-list></v-menu
        ></template
      >
    </v-data-table>
    <v-data-table v-if="!props.licenses && tab === 'archived'" :headers="archivedHeaders" :items="archived" :search="search" :loading="!!state.busy" class="mt-4">
      <template #item.daysRemaining="{ item }"><v-chip size="small" :color="item.daysRemaining <= 3 ? 'warning' : 'default'">{{ item.daysRemaining }} days</v-chip></template>
      <template #item.actions="{ item }"><div class="d-flex flex-wrap ga-1"><v-btn size="small" color="primary" variant="tonal" prepend-icon="mdi-restore" @click="confirm = { device: item, action: 'restore' }">Restore</v-btn><v-btn size="small" color="error" variant="tonal" prepend-icon="mdi-delete-forever-outline" @click="confirm = { device: item, action: 'delete' }">Delete now</v-btn></div></template>
    </v-data-table>
    <v-data-table
      v-if="props.licenses"
      :headers="certHeaders"
      :items="certs.filter((c) => filter === 'All' || c.status === filter)"
      :search="search"
      :loading="!!state.busy"
      class="mt-4"
    >
      <template #item.serial="{ item }"
        ><span class="mono text-caption">{{ item.serial }}</span></template
      ><template #item.status="{ item }"
        ><v-chip size="small" :color="color(item.status)">{{ item.status }}</v-chip></template
      >
      <template #item.actions="{ item }"
        ><div class="d-flex flex-wrap ga-1"><v-btn
          v-if="item.canDownload"
          size="small"
          variant="tonal"
          prepend-icon="mdi-download"
          :href="`/api/certificates/${item.id}/download`"
          >Download</v-btn
        ><v-btn size="small" variant="tonal" prepend-icon="mdi-autorenew" @click="openIssue(item.deviceId, item.id)">Renew / replace</v-btn
        ><v-btn
          v-if="item.status !== 'revoked'"
          size="small"
          color="error"
          variant="tonal"
          prepend-icon="mdi-cancel"
          @click="confirm = { cert: item }"
          >Revoke</v-btn
        ><v-btn v-if="licenseDevice(item.deviceId).status === 'active'" size="small" color="warning" variant="tonal" prepend-icon="mdi-archive-arrow-down-outline" @click="confirm = { device: licenseDevice(item.deviceId), action: 'archive' }">Archive device</v-btn><v-btn size="small" color="error" variant="tonal" prepend-icon="mdi-delete-forever-outline" @click="confirm = { device: licenseDevice(item.deviceId), action: 'delete' }">Delete device</v-btn></div></template
      >
    </v-data-table>
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
      ><h2 class="text-h5 mb-3">{{ confirm?.action === 'archive' ? 'Archive device' : confirm?.action === 'restore' ? 'Restore device' : confirm?.action === 'delete' ? 'Permanently delete device' : confirm?.cert ? 'Revoke certificate' : 'Confirm authorization change' }}</h2>
      <p v-if="confirm?.cert">
        Permanently revoke {{ confirm.cert.deviceId }} certificate {{ confirm.cert.serial }}?
      </p>
      <p v-else-if="confirm?.action === 'archive'">Archive {{ confirm?.device?.id }}? MQTT access stops immediately. The device will be deleted in 30 days unless restored.</p>
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
      <v-alert type="warning" variant="tonal" class="my-4"
        >The broker will restart to apply access changes. All current MQTT sessions will disconnect
        and eligible clients can reconnect.</v-alert
      >
      <div class="d-flex justify-end ga-2">
        <v-btn @click="confirm = null">Cancel</v-btn
        ><v-btn color="error" :disabled="['archive', 'delete'].includes(confirm?.action) && confirmText !== confirmationPhrase()" :loading="!!state.busy" @click="executeConfirm">{{ confirm?.action === 'archive' ? 'Archive device' : confirm?.action === 'delete' ? 'Confirm delete' : 'Confirm' }}</v-btn>
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
          :title="c.serial"
          :subtitle="`${c.status} · ${c.validFrom} → ${c.validTo}`" /></v-list
      ><v-btn @click="details = null">Close</v-btn></v-card
    ></v-dialog
  >
</template>

<style scoped>
.identity-table :deep(table) { table-layout: fixed; min-width: 1280px; }
.identity-table :deep(th),
.identity-table :deep(td) { white-space: normal !important; overflow-wrap: anywhere; word-break: normal; vertical-align: top; }
.identity-table :deep(td:last-child > *) { max-width: 100%; }
.name-copy { max-width: 100%; white-space: normal; text-align: left; overflow-wrap: anywhere; }
.confirmation-copy-button { max-width: 100%; height: auto !important; min-height: 32px; padding-block: 6px; white-space: normal; }
.confirmation-copy-button :deep(.v-btn__content) { white-space: normal; overflow-wrap: anywhere; text-align: left; }
</style>
