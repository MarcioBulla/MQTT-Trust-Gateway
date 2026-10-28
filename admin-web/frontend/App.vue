<script setup>
import { ref, onMounted } from 'vue';
import { useTheme } from 'vuetify';
import { startAuthentication } from '@simplewebauthn/browser';
import { api, state, action, refreshUser, copy } from './api';
const theme = useTheme(),
  drawer = ref(null),
  username = ref(''),
  password = ref(''),
  setupToken = ref(''),
  totp = ref('');
const links = [
  ['/', 'Overview', 'mdi-view-dashboard-outline'],
  ['/devices', 'Devices', 'mdi-chip'],
  ['/licenses', 'Licenses', 'mdi-certificate-outline'],
  ['/mqtt', 'MQTT Manager', 'mdi-message-processing-outline'],
  ['/account', 'Account & audit', 'mdi-account-circle-outline'],
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
  action(async () => {
    const options = await api('/login/options', 'POST', { username: username.value });
    const credential = await startAuthentication({ optionsJSON: options });
    await api('/login/verify', 'POST', { username: username.value, credential });
    await refreshUser();
  });
}
onMounted(() => action(refreshUser));
</script>
<template>
  <v-app>
    <v-navigation-drawer v-if="state.user" v-model="drawer">
      <div class="pa-6">
        <div class="text-overline text-primary">MQTT / TRUST</div>
        <div class="text-h6 font-weight-bold">Gateway console</div>
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
        >MQTT Trust Gateway</v-app-bar-title
      ><v-btn icon="mdi-theme-light-dark" aria-label="Toggle theme" @click="toggleTheme" /><v-btn
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
            <p class="text-body-2">File location on that computer:</p>
            <p class="mono text-body-2 my-2">{{ state.bootstrapHelp.hostFile }}</p>
            <p class="text-body-2">
              Relative paths start in the gateway checkout. Paste the command's output into
              Bootstrap token below. The file is deleted after your administrator is created.
            </p>
          </v-alert>
          <v-form @submit.prevent="login"
            ><v-text-field
              v-model="username"
              label="Username"
              autocomplete="username"
              :rules="[required]"
              required
              maxlength="64"
            /><v-text-field
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
              v-model="totp"
              label="Authenticator code (if enabled)"
              autocomplete="one-time-code"
              inputmode="numeric"
              maxlength="6"
            /><v-text-field
              v-if="!state.hasAdmin"
              v-model="setupToken"
              label="Bootstrap token"
              type="password"
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
              :disabled="!username || !!state.busy"
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
