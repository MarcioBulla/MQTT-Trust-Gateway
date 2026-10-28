<script setup>
import { ref, onMounted } from 'vue';
import { startRegistration } from '@simplewebauthn/browser';
import { api, action, state, refreshUser } from '../api';
const currentPassword = ref(''),
  password = ref(''),
  name = ref(''),
  entries = ref([]),
  removing = ref(null),
  setup = ref(null),
  code = ref('');
const headers = [
  { title: 'Time', key: 'at' },
  { title: 'Actor', key: 'actor' },
  { title: 'Action', key: 'action' },
  { title: 'Detail', key: 'detail' },
];
function addPasskey() {
  action(async () => {
    const options = await api('/passkeys/options', 'POST', {});
    const credential = await startRegistration({ optionsJSON: options });
    await api('/passkeys/verify', 'POST', { credential, name: name.value });
    await refreshUser();
  }, 'Passkey registered');
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
onMounted(() =>
  action(async () => {
    entries.value = (await api('/audit')).entries;
  }),
);
</script>
<template>
  <div class="text-overline text-primary">ADMINISTRATION</div>
  <h1 class="text-h4 font-weight-bold mb-6">Account & audit</h1>
  <v-row
    ><v-col cols="12" md="6"
      ><v-card class="pa-6 h-100"
        ><h2 class="text-h6 mb-4">Password · {{ state.user?.username }}</h2>
        <v-form @submit.prevent="changePassword"
          ><v-text-field
            v-model="currentPassword"
            label="Current password"
            type="password"
            autocomplete="current-password"
          /><v-text-field
            v-model="password"
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
          @click="addPasskey"
          >Register passkey</v-btn
        ><v-list
          ><v-list-item
            v-for="p in state.user?.passkeys"
            :key="p.id"
            :title="p.name"
            :subtitle="p.createdAt"
            ><template #append
              ><v-btn size="small" color="error" variant="text" @click="removing = p"
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
      ><v-chip color="success" class="mb-3">Authenticator enabled</v-chip
      ><v-form
        @submit.prevent="
          action(async () => {
            await api('/me/totp', 'DELETE', { code });
            code = '';
            await refreshUser();
          }, 'Authenticator disabled')
        "
        ><v-text-field
          v-model="code"
          label="Current unused authenticator code"
          autocomplete="one-time-code"
          inputmode="numeric"
          pattern="[0-9]{6}"
          required
          maxlength="6"
        /><v-btn type="submit" color="error" variant="tonal">Disable authenticator</v-btn></v-form
      ></template
    >
  </v-card>
  <v-card class="pa-5 mt-5"
    ><h2 class="text-h6 mb-3">Recent audit events</h2>
    <v-data-table :headers="headers" :items="entries" :items-per-page="15"
  /></v-card>
  <v-dialog :model-value="!!removing" max-width="450" @update:model-value="removing = null"
    ><v-card class="pa-6"
      ><h2 class="text-h5 mb-4">Remove {{ removing?.name }}?</h2>
      <div class="d-flex justify-end ga-2">
        <v-btn @click="removing = null">Cancel</v-btn
        ><v-btn
          color="error"
          @click="
            action(async () => {
              await api('/passkeys/' + encodeURIComponent(removing.id), 'DELETE', {});
              removing = null;
              await refreshUser();
            }, 'Passkey removed')
          "
          >Remove</v-btn
        >
      </div></v-card
    ></v-dialog
  >
</template>
