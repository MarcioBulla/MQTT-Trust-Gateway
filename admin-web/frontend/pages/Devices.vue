<script setup>
import { ref, onMounted } from 'vue';
import { api, action, state } from '../api';
const props = defineProps({ licenses: Boolean });
const devices = ref([]),
  certs = ref([]),
  search = ref(''),
  filter = ref('All'),
  dialog = ref(false),
  issueDialog = ref(false),
  confirm = ref(null),
  details = ref(null);
const form = ref({ id: '', name: '', description: '' }),
  issue = ref({ deviceId: '', csr: '', days: 90, previous: null });
const headers = [
  { title: 'Device', key: 'id' },
  { title: 'Name', key: 'name' },
  { title: 'Authorization', key: 'enabled' },
  { title: 'Connection', key: 'connectionStatus' },
  { title: 'Actions', key: 'actions', sortable: false },
];
const certHeaders = [
  { title: 'Device', key: 'deviceId' },
  { title: 'Serial', key: 'serial' },
  { title: 'Issued', key: 'issuedAt' },
  { title: 'Expires', key: 'validTo' },
  { title: 'Status', key: 'status' },
  { title: 'Actions', key: 'actions', sortable: false },
];
const load = () =>
  action(async () => {
    const [d, c, s] = await Promise.all([api('/devices'), api('/certificates'), api('/status')]);
    devices.value = d.devices;
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
    else await api(`/devices/${c.device.id}`, 'PATCH', { enabled: !c.device.enabled });
    confirm.value = null;
    await load();
  }, 'Authorization updated. Check broker revision on Overview.');
}
const color = (s) =>
  ({ active: 'success', expiring: 'warning', revoked: 'error', expired: 'error' })[s] || 'default';
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
  <v-card class="pa-4"
    ><div class="d-flex ga-3 flex-wrap">
      <v-text-field
        v-model="search"
        label="Search devices or certificates"
        prepend-inner-icon="mdi-magnify"
        hide-details
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
      v-if="!props.licenses"
      :headers="headers"
      :items="devices"
      :search="search"
      :loading="!!state.busy"
      class="mt-4"
    >
      <template #item.enabled="{ item }"
        ><v-chip size="small" :color="item.enabled ? 'success' : 'error'">{{
          item.enabled ? 'Enabled' : 'Disabled'
        }}</v-chip></template
      ><template #item.connectionStatus>Unavailable</template>
      <template #item.actions="{ item }"
        ><v-btn size="small" variant="text" @click="details = item">Details</v-btn
        ><v-btn size="small" variant="text" :disabled="!item.enabled" @click="openIssue(item.id)"
          >Issue</v-btn
        ><v-btn
          size="small"
          variant="text"
          :color="item.enabled ? 'error' : 'success'"
          @click="confirm = { device: item }"
          >{{ item.enabled ? 'Disable' : 'Enable' }}</v-btn
        ></template
      >
    </v-data-table>
    <v-data-table
      v-else
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
        ><v-btn
          v-if="item.canDownload"
          size="small"
          variant="text"
          :href="`/api/certificates/${item.id}/download`"
          >Download</v-btn
        ><v-btn size="small" variant="text" @click="openIssue(item.deviceId, item.id)">Renew</v-btn
        ><v-btn
          v-if="item.status !== 'revoked'"
          size="small"
          color="error"
          variant="text"
          @click="confirm = { cert: item }"
          >Revoke</v-btn
        ></template
      >
    </v-data-table>
  </v-card>
  <v-alert type="info" variant="tonal" class="mt-5"
    >Device status and last activity are unavailable without a verified broker connection feed.
    Disabled devices have no topic authorization. Revocation also rejects the certificate at TLS
    authentication.</v-alert
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
      ><h2 class="text-h5 mb-3">Confirm authorization change</h2>
      <p v-if="confirm?.cert">
        Permanently revoke {{ confirm.cert.deviceId }} certificate {{ confirm.cert.serial }}?
      </p>
      <p v-else>Change access for {{ confirm?.device?.id }}?</p>
      <v-alert type="warning" variant="tonal" class="my-4"
        >The broker will restart to apply access changes. All current MQTT sessions will disconnect
        and eligible clients can reconnect.</v-alert
      >
      <div class="d-flex justify-end ga-2">
        <v-btn @click="confirm = null">Cancel</v-btn
        ><v-btn color="error" :loading="!!state.busy" @click="executeConfirm">Confirm</v-btn>
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
