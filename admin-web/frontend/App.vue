<script setup>
import { ref, onMounted, onUnmounted } from 'vue';
import { useTheme } from 'vuetify';
import { startAuthentication } from '@simplewebauthn/browser';
import { api, state, action, refreshUser, copy, refreshBrokerChanges, applyBrokerChanges } from './api';
const theme = useTheme(),
  drawer = ref(null),
  username = ref(''),
  password = ref(''),
  setupToken = ref(''),
  totp = ref(''),
  passkeyPending = ref(false);
const links = [
  ['/', 'Overview', 'mdi-view-dashboard-outline'],
  ['/devices', 'Devices & certificates', 'mdi-chip'],
  ['/licenses', 'Licenses', 'mdi-certificate-outline'],
  ['/mqtt', 'MQTT Manager', 'mdi-message-processing-outline'],
  ['/settings', 'Settings', 'mdi-cog-outline'],
];
const required = (v) => !!v || 'Required';
function toggleTheme() {
  const name = theme.global.name.value === 'dark' ? 'light' : 'dark';
  theme.global.name.value = name;
  localStorage.setItem('theme', name);
}
function login() {
  action(async () => {
    await api(state.hasAdmin ? '/login/password' : '/bootstrap', 'POST', {
      username: username.value,
      password: password.value,
      setupToken: setupToken.value,
      totp: totp.value,
    });
    password.value = '';
    setupToken.value = '';
    totp.value = '';
    await refreshUser();
  });
}
function passkey() {
  if (passkeyPending.value) return;
  passkeyPending.value = true;
  action(async () => {
    const options = await api('/login/options', 'POST', { username: username.value });
    const credential = await startAuthentication({ optionsJSON: options });
    await api('/login/verify', 'POST', { username: username.value, credential });
    await refreshUser();
  }).finally(() => {
    passkeyPending.value = false;
  });
}
let brokerPoll;
onMounted(() => {
  action(refreshUser);
  brokerPoll = setInterval(() => refreshBrokerChanges().catch(() => {}), 5000);
});
onUnmounted(() => clearInterval(brokerPoll));
</script>
<template>
  <v-app>
    <v-navigation-drawer v-if="state.user" v-model="drawer">
      <div class="pa-6">
        <div class="d-flex align-center ga-3">
          <img src="/MyMosquitto.svg" alt="" width="40" height="40" class="flex-shrink-0" />
          <div>
            <div class="text-overline text-primary">MQTT / TRUST</div>
            <div class="text-subtitle-1 font-weight-bold">Gateway console</div>
          </div>
        </div>
        <div class="text-caption text-medium-emphasis mt-1">
          Local control. Verified identities.
        </div>
      </div>
      <v-divider /><v-list nav class="pa-3"
        ><v-list-item
          v-for="[to, title, icon] in links"
          :key="to"
          :to="to"
          :title="title"
          :prepend-icon="icon"
          color="primary"
      /></v-list>
      <template #append
        ><div class="pa-4 text-caption text-medium-emphasis">
          Two services. Your infrastructure.
        </div></template
      >
    </v-navigation-drawer>
    <v-app-bar flat border
      ><v-app-bar-nav-icon v-if="state.user" @click="drawer = !drawer" /><v-app-bar-title
        class="font-weight-bold"
        ><span class="d-flex align-center ga-3"
          ><img
            src="/MyMosquitto.svg"
            alt=""
            width="36"
            height="36"
            class="flex-shrink-0"
            :class="{ 'd-lg-none': state.user }"
          /><span class="text-truncate">MQTT Trust Gateway</span></span
        ></v-app-bar-title
      ><v-tooltip v-if="state.user && (state.brokerChanges?.pendingChanges || state.brokerChanges?.applying)" :text="state.brokerChanges.pendingChanges ? 'Restart once to apply all pending broker changes.' : 'Waiting for broker acknowledgement.'" location="bottom"><template #activator="{ props: restartProps }"><v-btn v-bind="restartProps" color="amber" variant="flat" prepend-icon="mdi-restart" size="small" class="mr-2" :loading="state.brokerChanges.applying" :disabled="!!state.busy || state.brokerChanges.applying" @click="action(applyBrokerChanges)">Restart Broker</v-btn></template></v-tooltip><v-btn icon="mdi-theme-light-dark" aria-label="Toggle theme" @click="toggleTheme" /><v-btn
        v-if="state.user"
        prepend-icon="mdi-logout"
        @click="
          action(async () => {
            await api('/logout', 'POST', {});
            state.user = null;
          })
        "
        >Sign out</v-btn
      ></v-app-bar
    >

    <v-main
      ><v-progress-linear v-if="state.busy" indeterminate color="primary" aria-label="Loading" />
      <v-container fluid class="pa-4 pa-md-8 content">
        <v-alert
          v-if="state.error"
          type="error"
          closable
          class="mb-5"
          @click:close="state.error = ''"
          >{{ state.error }}</v-alert
        >
        <router-view v-if="state.user" />
        <v-card v-else class="login mx-auto pa-6 pa-md-9 mt-8" max-width="480">
          <div class="text-overline text-primary">ADMINISTRATIVE ACCESS</div>
          <h1 class="text-h4 font-weight-bold mb-3">
            {{ state.hasAdmin ? 'Welcome back' : 'Create your administrator' }}
          </h1>
          <p class="text-medium-emphasis mb-6">
            {{
              state.hasAdmin
                ? 'Sign in to manage trusted devices and messages.'
                : 'Choose a username and a password with at least 12 characters. There are no default credentials.'
            }}
          </p>
          <v-alert
            v-if="!state.hasAdmin && state.bootstrapHelp"
            type="info"
            variant="tonal"
            class="mb-6"
          >
            <h2 class="text-subtitle-1 font-weight-bold mb-2">Find your bootstrap token</h2>
            <p class="text-body-2 mb-3">
              On the computer running the gateway, open a terminal as the user who installed it and
              run:
            </p>
            <pre class="mono">{{ state.bootstrapHelp.command }}</pre>
            <v-btn
              size="small"
              variant="text"
              prepend-icon="mdi-content-copy"
              class="my-2"
              @click="copy(state.bootstrapHelp.command)"
              >Copy command</v-btn
            >
            <p class="text-body-2">Paste the command's output into Bootstrap token below.</p>
          </v-alert>
          <v-form
            id="admin-auth-form"
            :key="state.hasAdmin ? 'login' : 'bootstrap'"
            :name="state.hasAdmin ? 'login' : 'registration'"
            autocomplete="on"
            method="post"
            :action="state.hasAdmin ? '/api/login/password' : '/api/bootstrap'"
            @submit.prevent="login"
            ><v-text-field
              id="admin-username"
              persistent-placeholder
              name="username"
              v-model="username"
              label="Username"
              type="text"
              autocomplete="username"
              autocapitalize="none"
              :spellcheck="false"
              :rules="[required]"
              required
              maxlength="64"
            /><v-text-field
              id="admin-password"
              persistent-placeholder
              name="password"
              v-model="password"
              label="Password"
              type="password"
              :autocomplete="state.hasAdmin ? 'current-password' : 'new-password'"
              :rules="[required]"
              required
              :minlength="state.hasAdmin ? 1 : 12"
              maxlength="256"
            /><v-text-field
              v-if="state.hasAdmin"
              id="admin-totp"
              persistent-placeholder
              name="totp"
              v-model="totp"
              label="Authenticator code (if enabled)"
              type="text"
              autocomplete="one-time-code"
              inputmode="numeric"
              pattern="[0-9]{6}"
              :spellcheck="false"
              maxlength="6"
            /><v-text-field
              v-if="!state.hasAdmin"
              id="admin-bootstrap-token"
              persistent-placeholder
              name="setupToken"
              v-model="setupToken"
              label="Bootstrap token"
              type="password"
              autocomplete="off"
              required
            /><v-btn type="submit" color="primary" block size="large" :loading="!!state.busy">{{
              state.hasAdmin ? 'Sign in' : 'Create administrator'
            }}</v-btn
            ><v-btn
              v-if="state.hasAdmin"
              class="mt-3"
              block
              variant="tonal"
              prepend-icon="mdi-fingerprint"
              :disabled="!username || !!state.busy || passkeyPending"
              :loading="passkeyPending"
              @click="passkey"
              >Sign in with a passkey</v-btn
            ></v-form
          >
          <p class="text-caption text-medium-emphasis mt-5">
            Passkeys require HTTPS or localhost. Remote administration requires HTTPS.
          </p>
        </v-card>
      </v-container>
    </v-main>
    <v-snackbar
      :model-value="!!state.notice"
      :timeout="3500"
      @update:model-value="state.notice = ''"
      >{{ state.notice
      }}<template #actions><v-btn @click="state.notice = ''">Close</v-btn></template></v-snackbar
    >
  </v-app>
</template>
<style>
.connection-table td {
  padding: 10px 8px !important;
}
.connection-table td:last-child {
  width: 36px;
}
.content {
  max-width: 1600px;
}
.v-theme--light {
  --v-theme-background: 245, 247, 250;
}
.v-theme--dark {
  --v-theme-background: 14, 19, 27;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 13px;
  line-height: 1.6;
}
.v-table {
  background: transparent;
}
.v-btn {
  text-transform: none;
  letter-spacing: normal;
}
.page-intro {
  max-width: 760px;
}
.metric {
  font-size: 2rem;
  font-weight: 700;
}
.mono {
  font-family: monospace;
  overflow-wrap: anywhere;
}
</style>
