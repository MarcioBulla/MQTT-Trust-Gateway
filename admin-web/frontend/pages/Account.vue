<script setup>
import { ref, onMounted, computed } from 'vue';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { api, action, state, refreshUser, copy } from '../api';
const accountTab = ref('security'), auditSearch = ref('');
const logCommands = [
  { title: 'Admin application', command: 'journalctl --user -u mqtt-admin.service -n 100 --no-pager' },
  { title: 'MQTT broker', command: 'journalctl --user -u mqtt-broker.service -n 100 --no-pager' },
  { title: 'Follow both services', command: 'journalctl --user -u mqtt-admin.service -u mqtt-broker.service -f' },
];
const currentPassword = ref(''),
  password = ref(''),
  name = ref(''),
  entries = ref([]),
  removing = ref(null),
  setup = ref(null),
  code = ref(''),
  registeringPasskey = ref(false),
  removalMethod = ref('password'),
  removalPassword = ref(''),
  removalTotp = ref(''),
  verifyingRemoval = ref(false);
const removalMethods = computed(() => [
  ...(state.user?.hasPassword
    ? [
        {
          title: state.user.totpEnabled ? 'Password + authenticator code' : 'Password',
          value: 'password',
        },
      ]
    : []),
  ...(state.user?.passkeys?.length ? [{ title: 'Passkey', value: 'passkey' }] : []),
]);
function openRemoval(target) {
  state.error = '';
  removalPassword.value = '';
  removalTotp.value = '';
  removalMethod.value = state.user?.hasPassword ? 'password' : 'passkey';
  removing.value = target;
}
function closeRemoval() {
  if (verifyingRemoval.value) return;
  removing.value = null;
  removalPassword.value = '';
  removalTotp.value = '';
}
async function confirmRemoval() {
  if (verifyingRemoval.value || !removing.value) return;
  verifyingRemoval.value = true;
  await action(async () => {
    const target = removing.value;
    let reauth;
    if (removalMethod.value === 'passkey') {
      const options = await api('/reauth/options', 'POST', {
        action: target.action,
        target: target.id || '',
      });
      const credential = await startAuthentication({ optionsJSON: options });
      reauth = { method: 'passkey', credential };
    } else {
      reauth = { method: 'password', password: removalPassword.value, totp: removalTotp.value };
    }
    await api(
      target.action === 'disable-totp' ? '/me/totp' : '/passkeys/' + encodeURIComponent(target.id),
      'DELETE',
      { reauth },
    );
    removing.value = null;
    await refreshUser();
  }, 'Authentication method removed; other sessions signed out');
  removalPassword.value = '';
  removalTotp.value = '';
  verifyingRemoval.value = false;
}
const headers = [
  { title: 'Time', key: 'at' },
  { title: 'Actor', key: 'actor' },
  { title: 'Action', key: 'action' },
  { title: 'Detail', key: 'detail' },
];
function addPasskey() {
  if (registeringPasskey.value) return;
  registeringPasskey.value = true;
  action(async () => {
    const options = await api('/passkeys/options', 'POST', {});
    const credential = await startRegistration({ optionsJSON: options });
    await api('/passkeys/verify', 'POST', { credential, name: name.value });
    await refreshUser();
  }, 'Passkey registered').finally(() => {
    registeringPasskey.value = false;
  });
}
function changePassword() {
  action(async () => {
    await api('/me/password', 'POST', {
      currentPassword: currentPassword.value,
      password: password.value,
    });
    currentPassword.value = '';
    password.value = '';
  }, 'Password updated; other sessions invalidated');
}
function loadAudit() {
  return action(async () => {
    entries.value = (await api('/audit')).entries;
  });
}
onMounted(loadAudit);
</script>
<template>
  <div class="text-overline text-primary">ADMINISTRATION</div>
  <h1 class="text-h4 font-weight-bold mb-6">Account & audit</h1>
  <v-tabs v-model="accountTab" class="mb-5"><v-tab value="security">Account security</v-tab><v-tab value="audit">Recent audit events</v-tab><v-tab value="logs">Logs</v-tab><v-tab value="smtp">SMTP · WIP</v-tab></v-tabs>
  <div v-show="accountTab === 'security'">
  <v-row
    ><v-col cols="12" md="6"
      ><v-card class="pa-6 h-100"
        ><h2 class="text-h6 mb-4">Password · {{ state.user?.username }}</h2>
        <v-form @submit.prevent="changePassword"
          ><v-text-field
            v-model="currentPassword"
            persistent-placeholder
            name="currentPassword"
            label="Current password"
            type="password"
            autocomplete="current-password"
          /><v-text-field
            v-model="password"
            persistent-placeholder
            name="newPassword"
            label="New password (12–256 characters)"
            type="password"
            autocomplete="new-password"
            minlength="12"
            maxlength="256"
            required
          /><v-btn type="submit" color="primary" :loading="!!state.busy"
            >Update password</v-btn
          ></v-form
        ></v-card
      ></v-col
    ><v-col cols="12" md="6"
      ><v-card class="pa-6 h-100"
        ><h2 class="text-h6 mb-3">Passkeys</h2>
        <p class="text-body-2 mb-4">
          Use HTTPS or localhost. Passkeys belong to this administrator and are verified against the
          configured public origin.
        </p>
        <v-text-field v-model="name" label="Passkey name" maxlength="64" /><v-btn
          prepend-icon="mdi-fingerprint"
          color="primary"
          :loading="registeringPasskey"
          :disabled="registeringPasskey"
          @click="addPasskey"
          >Register passkey</v-btn
        ><v-list
          ><v-list-item
            v-for="p in state.user?.passkeys"
            :key="p.id"
            :title="p.name"
            :subtitle="p.createdAt"
            ><template #append
              ><v-btn
                size="small"
                color="error"
                variant="text"
                @click="openRemoval({ ...p, action: 'remove-passkey' })"
                >Remove</v-btn
              ></template
            ></v-list-item
          ></v-list
        ></v-card
      ></v-col
    ></v-row
  >
  <v-card class="pa-6 mt-5"
    ><h2 class="text-h6 mb-3">Authenticator app (TOTP)</h2>
    <p class="mb-4">
      Add a second factor to password login using Google Authenticator, KeePassXC, or another TOTP
      app. Passkeys remain an independent sign-in method. Keep a passkey as a fallback.
    </p>
    <template v-if="!state.user?.totpEnabled"
      ><v-btn
        v-if="!setup"
        color="primary"
        @click="
          action(async () => {
            setup = await api('/me/totp/options', 'POST', {});
          })
        "
        >Set up authenticator</v-btn
      >
      <div v-if="setup">
        <img :src="setup.qr" alt="Authenticator setup QR code" width="280" height="280" />
        <p class="text-caption">Manual setup secret — store it only in your authenticator:</p>
        <p class="mono my-3" data-testid="totp-secret">{{ setup.secret }}</p>
        <p class="text-caption mb-3">SHA-1 · 6 digits · 30 seconds. Setup expires in 10 minutes.</p>
        <v-form
          @submit.prevent="
            action(async () => {
              await api('/me/totp/verify', 'POST', { code });
              setup = null;
              code = '';
              await refreshUser();
            }, 'Authenticator enabled')
          "
          ><v-text-field
            v-model="code"
            persistent-placeholder
            label="Verification code"
            autocomplete="one-time-code"
            inputmode="numeric"
            pattern="[0-9]{6}"
            required
            maxlength="6"
          /><v-btn type="submit" color="primary">Enable authenticator</v-btn></v-form
        >
      </div></template
    >
    <template v-else
      ><v-chip color="success" class="mb-3">Authenticator enabled</v-chip>
      <div>
        <v-btn
          color="error"
          variant="tonal"
          @click="openRemoval({ action: 'disable-totp', name: 'authenticator' })"
          >Disable authenticator</v-btn
        >
      </div>
    </template>
  </v-card>
  </div>
  <v-card v-if="accountTab === 'audit'" class="pa-5"
    ><h2 class="text-h6 mb-3">Recent audit events</h2>
    <div class="d-flex align-center ga-3 mb-4"><v-text-field v-model="auditSearch" label="Search audit events" prepend-inner-icon="mdi-magnify" hide-details /><v-btn icon="mdi-refresh" aria-label="Refresh audit events" @click="loadAudit" /></div>
    <v-data-table :headers="headers" :items="entries" :search="auditSearch" :items-per-page="15"
  /></v-card>
  <v-card v-if="accountTab === 'logs'" class="pa-6"><h2 class="text-h6 mb-3">Service logs</h2><p class="text-medium-emphasis mb-4">Run these commands on the host as the rootless Gateway user. Service logs are stored in the user journal; the web container has no access to the host journal.</p><div v-for="log in logCommands" :key="log.title" class="mb-5"><div class="text-subtitle-2 mb-2">{{ log.title }}</div><div class="d-flex align-center ga-3"><code class="text-break flex-grow-1">{{ log.command }}</code><v-btn icon="mdi-content-copy" variant="text" size="small" :aria-label="`Copy ${log.title} log command`" @click="copy(log.command)" /></div></div></v-card>
  <v-card v-if="accountTab === 'smtp'" class="pa-6"><v-chip color="warning" size="small" class="mb-3">WIP</v-chip><h2 class="text-h6">SMTP email settings</h2><p class="text-medium-emphasis mt-2">SMTP configuration and device offline email alerts are planned. Email delivery is not available yet.</p></v-card>
  <v-dialog
    :model-value="!!removing"
    :persistent="verifyingRemoval"
    max-width="500"
    @update:model-value="closeRemoval"
    ><v-card class="pa-6"
      ><h2 class="text-h5 mb-4">Remove {{ removing?.name }}?</h2>
      <p class="mb-4">
        Verify your identity again to remove this authentication method. Other sessions will be
        signed out.
      </p>
      <v-alert v-if="state.error" type="error" variant="tonal" class="mb-4">{{
        state.error
      }}</v-alert>
      <v-form id="reauth-form" autocomplete="on" @submit.prevent="confirmRemoval">
        <v-select
          v-model="removalMethod"
          :items="removalMethods"
          label="Verify using"
          :disabled="verifyingRemoval"
        />
        <template v-if="removalMethod === 'password'">
          <v-text-field
            :model-value="state.user?.username"
            persistent-placeholder
            name="username"
            label="Username"
            autocomplete="username"
            readonly
          />
          <v-text-field
            id="reauth-password"
            v-model="removalPassword"
            persistent-placeholder
            name="password"
            label="Current password"
            type="password"
            autocomplete="current-password"
            required
            :disabled="verifyingRemoval"
          />
          <v-text-field
            v-if="state.user?.totpEnabled"
            id="reauth-totp"
            v-model="removalTotp"
            persistent-placeholder
            name="totp"
            label="Fresh authenticator code"
            autocomplete="one-time-code"
            inputmode="numeric"
            pattern="[0-9]{6}"
            maxlength="6"
            required
            :disabled="verifyingRemoval"
            hint="A code already used to sign in cannot be reused."
          />
        </template>
        <p v-else class="text-body-2 mb-4">Confirm with a registered passkey when prompted.</p>
        <div class="d-flex justify-end ga-2">
          <v-btn :disabled="verifyingRemoval" @click="closeRemoval">Cancel</v-btn
          ><v-btn
            color="error"
            type="submit"
            :loading="verifyingRemoval"
            :disabled="!removalMethods.length"
            >Verify and remove</v-btn
          >
        </div>
      </v-form></v-card
    ></v-dialog
  >
</template>
