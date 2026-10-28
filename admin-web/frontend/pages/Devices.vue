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
  confirmText = ref('');
const form = ref({ id: '', name: '', description: '' }),
  issue = ref({ deviceId: '', csr: '', days: 90, previous: null });
const headers = [
  { title: 'Device', key: 'id' },
  { title: 'Name', key: 'name' },
  { title: 'Provisioning', key: 'latestCertificate.provisioningMethod' },
  { title: 'Issuer', key: 'latestCertificate.issuerName' },
  { title: 'Algorithm', key: 'latestCertificate.algorithm' },
  { title: 'Expires', key: 'latestCertificate.validTo' },
  { title: 'Certificate', key: 'latestCertificate.status' },
  { title: 'Authorization', key: 'enabled' },
  { title: 'Connection', key: 'connectionStatus' },
  { title: 'Actions', key: 'actions', sortable: false },
];
const identityRows = computed(() => devices.value.map((device) => ({
  ...device,
  latestCertificate: [...(device.certificates || [])].sort((a, b) => Date.parse(b.issuedAt || 0) - Date.parse(a.issuedAt || 0))[0] || null,
})));
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
    await api('/devices', 'POST', form.value);
    dialog.value = false;
    form.value = { id: '', name: '', description: '' };
    await load();
  }, 'Device registered');
}
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
      class="mt-4"
    >
      <template #item.enabled="{ item }"
        ><v-chip size="small" :color="item.enabled && item.trusted !== false ? 'success' : 'warning'">{{
          item.enabled && item.trusted !== false ? 'Approved' : 'Approval required'
        }}</v-chip></template
      ><template #item.connectionStatus>Unavailable</template>
      <template #item.latestCertificate.provisioningMethod="{ item }">{{ item.latestCertificate?.provisioningMethod || '—' }}</template>
      <template #item.latestCertificate.issuerName="{ item }"><span>{{ item.latestCertificate?.issuerName || item.latestCertificate?.issuer || '—' }}</span><span v-if="item.latestCertificate?.brokerTrusted === false" class="text-warning"> (not trusted)</span></template>
      <template #item.latestCertificate.algorithm="{ item }">{{ item.latestCertificate?.algorithm || '—' }}</template>
      <template #item.latestCertificate.validTo="{ item }">{{ item.latestCertificate?.validTo || '—' }}</template>
      <template #item.latestCertificate.status="{ item }"><v-chip v-if="item.latestCertificate" size="small" :color="color(item.latestCertificate.status)">{{ item.latestCertificate.status }}</v-chip><span v-else class="text-medium-emphasis">No certificate</span></template>
      <template #item.actions="{ item }"
        ><div class="d-flex flex-wrap ga-1"><v-btn size="small" variant="tonal" prepend-icon="mdi-information-outline" @click="details = item">Details</v-btn
        ><v-btn
          v-if="item.latestCertificate?.canDownload"
          size="small"
          variant="tonal"
          prepend-icon="mdi-download"
          :href="`/api/certificates/${item.latestCertificate.id}/download`"
          >Certificate</v-btn
        ><v-btn
          v-if="item.latestCertificate && ['active', 'expiring', 'untrusted'].includes(item.latestCertificate.status)"
          size="small"
          variant="tonal"
          prepend-icon="mdi-autorenew"
          @click="openIssue(item.id, item.latestCertificate.id)"
          >Renew</v-btn
        ><v-btn
          v-if="item.latestCertificate && ['active', 'expiring', 'untrusted'].includes(item.latestCertificate.status)"
          size="small"
          color="error"
          variant="tonal"
          prepend-icon="mdi-cancel"
          @click="confirm = { cert: item.latestCertificate }"
          >Revoke</v-btn
        ><v-btn
          size="small"
          variant="tonal"
          prepend-icon="mdi-certificate-plus"
          :disabled="!item.enabled"
          @click="openIssue(item.id)"
          >Issue</v-btn
        ><v-btn
          size="small"
          variant="tonal"
          prepend-icon="mdi-shield-check-outline"
          :color="item.enabled ? 'warning' : 'success'"
          @click="confirm = { device: item, action: item.enabled ? 'disable' : 'approve' }"
          >{{ item.enabled ? 'Disable' : 'Approve & enable' }}</v-btn
        ><v-btn size="small" color="warning" variant="tonal" prepend-icon="mdi-archive-arrow-down-outline" @click="confirm = { device: item, action: 'archive' }">Archive</v-btn
        ><v-btn size="small" color="error" variant="tonal" prepend-icon="mdi-delete-forever-outline" @click="confirm = { device: item, action: 'delete' }">Delete</v-btn></div
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
        /><v-text-field v-model="form.name" label="Name" maxlength="100" /><v-textarea
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
      <p v-else>Change access for {{ confirm?.device?.id }}?</p>
      <template v-if="confirm?.action === 'archive' || confirm?.action === 'delete'">
        <div class="d-flex align-center flex-wrap ga-2 mt-5 mb-2">
          <span>Type</span><v-btn icon="mdi-content-copy" size="small" color="primary" variant="tonal" rounded="lg" :aria-label="`Copy ${confirmationPhrase()} to clipboard`" title="Copy confirmation text" @click="copy(confirmationPhrase())" /><v-chip label size="small" class="font-weight-medium">{{ confirmationPhrase() }}</v-chip><span>to confirm.</span>
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
