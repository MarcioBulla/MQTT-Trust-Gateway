<script setup>
import { ref, onMounted, onUnmounted, computed, watch } from 'vue';
import { formatDateTime } from './date-time';
import { useRoute } from 'vue-router';
import SensitiveValue from './components/SensitiveValue.vue';
import StepUpAuthDialog from './components/StepUpAuthDialog.vue';
import { hideSensitive, requestReveal, isRevealed, revealScopes } from './sensitive';
import { effectiveThemeColors } from '../shared/theme-presets.js';
import { defaultPresentation } from '../shared/presentation-preferences.js';
import { useDisplay, useTheme } from 'vuetify';
import { startAuthentication } from '@simplewebauthn/browser';
import { api, state, action, refreshUser, copy, refreshBrokerChanges, applyBrokerChanges } from './api';
const { mobile } = useDisplay(),
  theme = useTheme(),
  drawer = ref(null),
  rail = ref(localStorage.getItem('navigationRail') === 'true'),
  username = ref(''),
  password = ref(''),
  setupToken = ref(''),
  totp = ref(''),
  passkeyPending = ref(false);
const railMode = computed(() => rail.value && !mobile.value);
watch(rail, value => localStorage.setItem('navigationRail', String(value)));
watch(() => state.user?.presentation, value => {
  const preferences = value || defaultPresentation();
  for (const name of ['light', 'dark']) {
    Object.assign(theme.themes.value[name].colors, effectiveThemeColors(preferences, name));
  }
}, { immediate: true, deep: true });
const route = useRoute();
const routeScope = computed(() => /^\/(devices|licenses)(\/|$)/.test(route.path) ? 'devices' : route.path === '/mqtt' ? 'mqtt' : route.path === '/settings' ? 'audit' : 'infrastructure');
const currentInformationVisible = computed(() => { void revealScopes[routeScope.value]; return isRevealed(routeScope.value); });
watch(() => route.fullPath, () => hideSensitive(), { flush: 'sync' });
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
function toggleRail() {
  rail.value = !rail.value;
}
function closeMobileDrawer() {
  if (mobile.value) drawer.value = false;
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
    <v-navigation-drawer
      v-if="state.user"
      v-model="drawer"
      :rail="railMode"
      :class="{ 'drawer--rail': railMode }"
      :width="288"
      :rail-width="76"
    >
      <div class="drawer-header" :class="{ 'drawer-header--rail': railMode }">
        <div class="drawer-brand">
          <img src="/MyMosquitto.svg" alt="" width="40" height="40" class="flex-shrink-0" />
          <div v-if="!railMode" class="drawer-brand-copy">
            <div class="text-overline text-primary">MQTT / TRUST</div>
            <div class="text-subtitle-1 font-weight-bold">Gateway console</div>
          </div>
        </div>
        <v-tooltip v-if="!mobile" :text="railMode ? 'Expand sidebar' : 'Collapse sidebar'" location="right">
          <template #activator="{ props }">
            <v-btn
              v-bind="props"
              :icon="railMode ? 'mdi-chevron-right' : 'mdi-chevron-left'"
              :aria-label="railMode ? 'Expand sidebar' : 'Collapse sidebar'"
              variant="text"
              size="small"
              @click="toggleRail"
            />
          </template>
        </v-tooltip>
      </div>
      <div v-if="!railMode" class="text-caption text-medium-emphasis font-italic px-6 pb-4">
        From beginner to beginner
      </div>
      <v-divider /><v-list nav class="pa-3"
        ><v-tooltip
          v-for="[to, title, icon] in links"
          :key="to"
          :text="title"
          location="right"
          :disabled="!railMode"
        ><template #activator="{ props }"><v-list-item
          v-bind="props"
          :to="to"
          :title="railMode ? undefined : title"
          :aria-label="title"
          :prepend-icon="icon"
          color="primary"
          @click="closeMobileDrawer"
        /></template></v-tooltip></v-list>
      <template #append>
        <div class="drawer-footer" :class="{ 'drawer-footer--rail': railMode }">
          <v-tooltip text="Open MQTT Trust Gateway on GitHub" location="right">
            <template #activator="{ props }">
              <v-btn
                v-bind="props"
                href="https://github.com/MarcioBulla/MQTT-Trust-Gateway"
                target="_blank"
                rel="noopener noreferrer"
                :aria-label="railMode ? 'Open MQTT Trust Gateway on GitHub' : undefined"
                :block="!railMode"
                variant="text"
                class="github-link"
              >
                <v-icon v-if="railMode" icon="mdi-github" />
                <template v-else><v-icon start icon="mdi-github" />GitHub repository</template>
              </v-btn>
            </template>
          </v-tooltip>
          <div v-if="!railMode" class="text-caption text-medium-emphasis mt-2">
            Two services. Your infrastructure.
          </div>
        </div>
      </template>
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
      ><v-tooltip v-if="state.user && (state.brokerChanges?.pendingChanges || state.brokerChanges?.applying)" location="bottom" interactive max-width="460" :open-delay="250">
        <template #activator="{ props: restartProps }"><v-btn v-bind="restartProps" color="amber" variant="flat" prepend-icon="mdi-restart" size="small" class="mr-2" :loading="state.brokerChanges.applying" :disabled="!!state.busy || state.brokerChanges.applying" @click="action(applyBrokerChanges)">Restart Broker</v-btn></template>
        <div v-if="state.brokerChanges.pendingChanges" class="pending-changes-tooltip">
          <div class="font-weight-bold mb-2">Pending broker changes<span v-if="state.brokerChanges.changes?.length"> ({{ state.brokerChanges.changes.length }})</span></div>
          <ol v-if="state.brokerChanges.changes?.length" class="pending-changes-list">
            <li v-for="change in state.brokerChanges.changes" :key="change.id"><div class="font-weight-medium">{{ change.summary }}</div><div v-if="change.deviceId" class="text-caption pending-change-detail">Device: <strong>{{ change.deviceName || change.deviceId }}</strong><span v-if="change.deviceName && change.deviceName !== change.deviceId"> ({{ change.deviceId }})</span></div><div v-if="change.certificateSerial || change.hasCertificateSerial" class="text-caption pending-change-detail">Serial: <SensitiveValue scope="devices" :value="change.certificateSerial" label="Certificate serial" /></div><div v-else-if="!change.deviceId || !change.action?.startsWith('device.')" class="text-caption pending-change-detail">{{ change.detail }}</div><div class="text-caption opacity-70">{{ change.actor }} · {{ formatDateTime(change.at) }}</div></li>
          </ol>
          <p v-else class="mb-2">Broker configuration has pending changes. Details are unavailable for this earlier update.</p>
          <div class="text-caption mt-2">Restart once to apply these changes. Current MQTT sessions will disconnect.</div>
        </div>
        <span v-else>Waiting for broker acknowledgement.</span>
      </v-tooltip><v-btn v-if="state.user" :icon="currentInformationVisible ? 'mdi-eye' : 'mdi-eye-off'" :aria-label="currentInformationVisible ? 'Hide sensitive information' : 'Show sensitive information'" @click="currentInformationVisible ? hideSensitive() : requestReveal(routeScope)"><v-icon :icon="currentInformationVisible ? 'mdi-eye' : 'mdi-eye-off'" /><v-tooltip activator="parent" location="bottom">{{ currentInformationVisible ? 'Hide sensitive information' : 'Show sensitive information' }}</v-tooltip></v-btn><v-btn icon="mdi-theme-light-dark" aria-label="Toggle theme" @click="toggleTheme" /><v-btn
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

    <StepUpAuthDialog v-if="state.user" /><v-main
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
.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 20px 16px 12px 24px;
}
.drawer-brand {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.drawer-header--rail {
  flex-direction: column;
  justify-content: center;
  padding: 16px 8px 12px;
}
.drawer-footer {
  padding: 16px;
}
.v-navigation-drawer__append {
  flex: 0 0 auto;
  margin-top: auto;
}
.drawer--rail .v-navigation-drawer__append {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  height: 68px;
  overflow: visible;
}
.drawer-footer--rail {
  display: flex;
  justify-content: center;
  padding: 8px 8px 20px;
  min-height: 68px;
}
.drawer-footer--rail .github-link {
  width: 44px;
  height: 44px;
}
.github-link {
  max-width: 100%;
}
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

}
.v-theme--dark {

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

<style scoped>
.pending-changes-tooltip { text-align: left; }
.pending-changes-list { padding-left: 20px; max-height: 320px; overflow-y: auto; }
.pending-changes-list li { padding-right: 8px; margin-bottom: 10px; }
.pending-change-detail { overflow-wrap: anywhere; }
</style>
