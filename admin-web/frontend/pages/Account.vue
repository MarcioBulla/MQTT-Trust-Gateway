<script setup>
import { themePresets, effectiveThemeColors } from '../../shared/theme-presets.js';
import { useTheme } from 'vuetify';
import { defaultPresentation } from '../../shared/presentation-preferences.js';
import { hideSensitive, revealScopes, isRevealed, sensitiveFetch } from '../sensitive';
import DateTime from '../components/DateTime.vue';
import { browserTimeZone, formatDateTime } from '../date-time';
import { normalizeTimeZone } from '../../shared/time-zone.js';
import DataList from '../components/DataList.vue';
import { ref, computed, watch, onUnmounted } from 'vue';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { api, action, state, refreshUser } from '../api';
import RuntimeLogs from '../components/RuntimeLogs.vue';
const accountTab = ref('general'), auditSearch = ref('');
const presentation = ref(JSON.parse(JSON.stringify(state.user?.presentation || defaultPresentation())));
const colorFields = [{ key: 'primary', title: 'Accent' }, { key: 'background', title: 'Background' }, { key: 'surface', title: 'Cards' }, { key: 'received', title: 'Received chart' }, { key: 'sent', title: 'Sent chart' }];
const theme = useTheme();
const presetOptions = [{ title: 'Custom', value: 'custom' }, { title: 'Gateway default', value: 'default' }, ...themePresets.map(item => ({ title: `${item.title} — ${item.lightVariant} / ${item.darkVariant}`, value: item.id }))].sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }));
function selectPreset(id) {
  if (id === 'custom') return;
  const themes = id === 'default' ? defaultPresentation().themes : themePresets.find(item => item.id === id)?.themes;
  if (themes) presentation.value.themes = JSON.parse(JSON.stringify(themes));
}
function previewColors(value) {
  for (const mode of ['light', 'dark']) Object.assign(theme.themes.value[mode].colors, effectiveThemeColors(value, mode));
}
watch(presentation, value => {
  const expected = value.preset === 'default' ? defaultPresentation().themes : themePresets.find(item => item.id === value.preset)?.themes;
  if (expected && JSON.stringify(expected) !== JSON.stringify(value.themes)) value.preset = 'custom';
  previewColors(value);
}, { deep: true, immediate: true });
onUnmounted(() => previewColors(state.user?.presentation || defaultPresentation()));
function resetColors() { presentation.value.preset = 'default'; presentation.value.themes = defaultPresentation().themes; }
const timeZone = ref(state.user?.timeZone || 'auto');
const availableZones = [...new Set(['UTC', browserTimeZone, state.user?.timeZone, ...(Intl.supportedValuesOf?.('timeZone') || [])].filter((zone) => zone && zone !== 'auto'))];
const timeZoneOptions = [{ title: `Automatic (${browserTimeZone})`, value: 'auto' }, ...availableZones.map((zone) => ({ title: zone.replaceAll('_', ' '), value: zone }))];
const zoneIsValid = computed(() => { try { normalizeTimeZone(timeZone.value); return true; } catch { return false; } });
const timePreview = computed(() => {
  if (!zoneIsValid.value) return 'Select a valid time zone';
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'long', timeZone: timeZone.value === 'auto' ? browserTimeZone : timeZone.value }).format(new Date());
});
function savePreferences() {
  return action(async () => {
    const result = await api('/me/preferences', 'PATCH', { timeZone: timeZone.value, presentation: presentation.value });
    state.user = result.user;
    timeZone.value = result.user.timeZone;
  }, 'Display preferences saved');
}

const visibilitySeconds = ref(state.user?.sensitivePreferences?.timeoutSeconds || 60);
const visibilityRequireAuth = ref(state.user?.sensitivePreferences?.requireAuthentication !== false);
const visibilityMethod = ref(state.user?.passkeys?.length ? 'passkey' : 'password');
const visibilityPassword = ref(''), visibilityTotp = ref('');
async function saveVisibilityPreferences() {
  await action(async () => {
    let reauth;
    if (visibilityMethod.value === 'passkey') {
      const options = await api('/reauth/options', 'POST', { action: 'sensitive-settings' });
      reauth = { method: 'passkey', credential: await startAuthentication({ optionsJSON: options }) };
    } else reauth = { method: 'password', password: visibilityPassword.value, totp: visibilityTotp.value };
    try {
      const result = await api('/me/sensitive-preferences', 'PATCH', { timeoutSeconds: Number(visibilitySeconds.value), requireAuthentication: visibilityRequireAuth.value, reauth });
      await hideSensitive();
      state.user = result.user;
    } finally { visibilityPassword.value = ''; visibilityTotp.value = ''; }
  }, 'Sensitive information preferences saved');
}
const totpSetupPassword = ref('');
async function beginTotpSetup() {
  await action(async () => {
    let reauth;
    if (state.user?.passkeys?.length) {
      const options = await api('/reauth/options', 'POST', { action: 'enable-totp' });
      reauth = { method: 'passkey', credential: await startAuthentication({ optionsJSON: options }) };
    } else {
      reauth = { method: 'password', password: totpSetupPassword.value };
    }
    try { setup.value = await api('/me/totp/options', 'POST', { reauth }); }
    finally { totpSetupPassword.value = ''; }
  });
}
const registrationMethod = ref('passkey'), registrationPassword = ref(''), registrationTotp = ref('');
const registrationMethods = computed(() => [
  ...(state.user?.passkeys?.length ? [{ title: 'Existing passkey', value: 'passkey' }] : []),
  ...(state.user?.hasPassword && (state.user?.totpEnabled || !state.user?.passkeys?.length) ? [{ title: state.user?.totpEnabled ? 'Password + authenticator code' : 'Password', value: 'password' }] : []),
]);
watch(registrationMethods, (methods) => { if (!methods.some(m => m.value === registrationMethod.value)) registrationMethod.value = methods[0]?.value || ''; }, { immediate: true });
const passwordMethod = ref(state.user?.passkeys?.length && !state.user?.totpEnabled ? 'passkey' : 'password'),
  passwordTotp = ref(''),
  changingPassword = ref(false);
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
  ...(state.user?.hasPassword && (state.user?.totpEnabled || !state.user?.passkeys?.length)
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
  removalMethod.value = state.user?.passkeys?.length && !state.user?.totpEnabled ? 'passkey' : 'password';
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
    hideSensitive();
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
    let reauth;
    if (registrationMethod.value === 'passkey') {
      const options = await api('/reauth/options', 'POST', { action: 'add-passkey' });
      const credential = await startAuthentication({ optionsJSON: options });
      reauth = { method: 'passkey', credential };
    } else {
      reauth = { method: 'password', password: registrationPassword.value, totp: registrationTotp.value };
    }
    const options = await api('/passkeys/options', 'POST', { reauth });
    registrationPassword.value = '';
    registrationTotp.value = '';
    const credential = await startRegistration({ optionsJSON: options });
    await api('/passkeys/verify', 'POST', { credential, name: name.value });
    hideSensitive();
    await refreshUser();
  }, 'Passkey registered').finally(() => {
    registeringPasskey.value = false;
    registrationPassword.value = '';
    registrationTotp.value = '';
  });
}
async function changePassword() {
  if (changingPassword.value) return;
  changingPassword.value = true;
  await action(async () => {
    const newPassword = password.value;
    if (newPassword.length < 12 || newPassword.length > 256)
      throw new Error('Password must contain 12–256 characters');
    let reauth;
    if (passwordMethod.value === 'passkey') {
      const options = await api('/reauth/options', 'POST', { action: 'change-password' });
      const credential = await startAuthentication({ optionsJSON: options });
      reauth = { method: 'passkey', credential };
    } else {
      reauth = { method: 'password', password: currentPassword.value, totp: passwordTotp.value };
    }
    await api('/me/password', 'POST', { password: newPassword, reauth });
    currentPassword.value = '';
    password.value = '';
    passwordTotp.value = '';
    hideSensitive();
    await refreshUser();
  }, 'Password updated; other sessions signed out');
  currentPassword.value = '';
  passwordTotp.value = '';
  changingPassword.value = false;
}
function loadAudit() {
  return action(async () => {
    const response = await sensitiveFetch('audit', '/audit');
    entries.value = response?.entries || [];
  });
}
watch([() => revealScopes.audit, accountTab], () => {
  entries.value = [];
  if (!['audit', 'logs'].includes(accountTab.value)) {
    if (isRevealed('audit')) hideSensitive('audit');
    return;
  }
  if (accountTab.value === 'audit' && isRevealed('audit')) loadAudit();
}, { flush: 'sync' });
</script>
<template>
  <div class="text-overline text-primary">ADMINISTRATION</div>
  <h1 class="text-h4 font-weight-bold mb-6">Settings</h1>
  <v-tabs v-model="accountTab" class="mb-5"><v-tab value="general">General</v-tab><v-tab value="security">Account security</v-tab><v-tab value="audit">Recent audit events</v-tab><v-tab value="logs">Logs</v-tab></v-tabs>
  <v-card v-if="accountTab === 'general'" class="pa-6" max-width="720">
    <h2 class="text-h6 mb-2">Date and time</h2>
    <p class="text-body-2 text-medium-emphasis mb-5">Choose the time zone used for messages, certificates and audit events. Your preference is saved to your account; stored timestamps and certificate validity remain in UTC.</p>
    <v-form @submit.prevent="savePreferences"><v-autocomplete v-model="timeZone" :items="timeZoneOptions" label="Display time zone" auto-select-first :rules="[() => zoneIsValid || 'Select a valid time zone']" />
    <p class="text-body-2 mb-5">Preview: {{ timePreview }}</p>
    <v-divider class="my-5" /><h2 class="text-h6 mb-4">Overview charts</h2>
    <v-select v-model="presentation.charts.days" label="Visible history" :items="[{ title: 'Last 24 hours', value: 1 }, { title: 'Last 3 days', value: 3 }, { title: 'Last 7 days', value: 7 }]" />
    <v-select v-model="presentation.charts.unit" label="Y-axis unit" :items="[{ title: 'Messages per minute (msg/min)', value: 'minute' }, { title: 'Messages per hour (msg/hour)', value: 'hour' }]" />
    <v-select v-model="presentation.charts.refreshSeconds" label="Refresh interval" :items="[5, 15, 30, 60].map(value => ({ title: `${value} seconds`, value }))" />
    <v-switch v-model="presentation.charts.showFailures" color="primary" label="Show failure markers" />
    <p class="text-caption text-medium-emphasis mb-4">Seven days of aggregate history are retained. Missing observations appear as gaps.</p>
    <v-divider class="my-5" /><div class="d-flex align-center justify-space-between mb-4"><h2 class="text-h6">Theme colors</h2><v-btn size="small" variant="text" @click="resetColors">Restore default colors</v-btn></div>
    <v-select v-model="presentation.preset" :items="presetOptions" label="Color preset" @update:model-value="selectPreset" />
    <v-switch v-model="presentation.oled" color="primary" label="OLED / True Black" hint="Dark mode only. Uses a pure black background and dark surfaces while preserving accent colors." persistent-hint class="mb-4" />
    <p class="text-caption text-medium-emphasis mb-4">Changes preview immediately. Save preferences to keep them. All preset colors remain editable.</p>
    <v-expansion-panels class="mb-5"><v-expansion-panel v-for="mode in ['light', 'dark']" :key="mode" :title="mode === 'light' ? 'Light mode' : 'Dark mode'"><v-expansion-panel-text><v-row dense><v-col v-for="field in colorFields" :key="field.key" cols="12" sm="6"><v-text-field v-model="presentation.themes[mode][field.key]" :label="`${mode === 'light' ? 'Light' : 'Dark'} ${field.title}`" type="color" /></v-col></v-row></v-expansion-panel-text></v-expansion-panel></v-expansion-panels>
    <v-btn type="submit" color="primary" :disabled="!zoneIsValid" :loading="!!state.busy">Save preferences</v-btn></v-form>
  </v-card>
  <v-card v-if="accountTab === 'general'" class="pa-6 mt-4" max-width="720"><v-chip color="warning" size="small" class="mb-3">WIP</v-chip><h2 class="text-h6">SMTP email settings</h2><p class="text-medium-emphasis mt-2">SMTP configuration and device offline email alerts are planned. Email delivery is not available yet.</p></v-card>
  <div v-show="accountTab === 'security'">
    <v-card class="pa-6 mb-5">
      <h2 class="text-h6 mb-3">Sensitive information visibility</h2>
      <p class="text-body-2 mb-4">Information starts hidden. After verification, you can reveal other sections without another prompt until the verification timeout ends. Each revealed section is hidden automatically after the selected timeout.</p>
      <v-form @submit.prevent="saveVisibilityPreferences">
        <v-text-field v-model.number="visibilitySeconds" label="Visibility and verification timeout (seconds)" type="number" min="1" max="300" required />
        <v-switch v-model="visibilityRequireAuth" color="error" label="Require additional authentication to reveal sensitive information" />
        <v-alert v-if="!visibilityRequireAuth" type="error" variant="tonal" class="mb-4">Additional verification is disabled. Anyone using your signed-in session can reveal operational information. Automatic hiding remains enabled.</v-alert>
        <v-select v-model="visibilityMethod" :items="removalMethods" label="Authorize this policy change with" />
        <template v-if="visibilityMethod === 'password'">
          <v-text-field v-model="visibilityPassword" label="Current password" type="password" autocomplete="current-password" required />
          <v-text-field v-if="state.user?.totpEnabled" v-model="visibilityTotp" label="Authenticator code" autocomplete="one-time-code" inputmode="numeric" maxlength="6" required />
        </template>
        <v-btn type="submit" color="primary" :loading="!!state.busy">Save visibility settings</v-btn>
      </v-form>
    </v-card>
  <v-row
    ><v-col cols="12" md="6"
      ><v-card class="pa-6 h-100"
        ><h2 class="text-h6 mb-4">Password · {{ state.user?.username }}</h2>
        <p class="text-body-2 mb-4">Confirm your identity with your current password or a registered passkey. Other sessions are signed out after the change.</p>
        <v-form @submit.prevent="changePassword">
          <v-select v-if="removalMethods.length > 1" v-model="passwordMethod" :items="removalMethods" label="Authorize password change with" :disabled="changingPassword" />
          <p v-else-if="passwordMethod === 'passkey'" class="text-body-2 mb-4">Your passkey will authorize this password change.</p>
          <v-text-field
            v-if="passwordMethod === 'password'"
            v-model="currentPassword" :disabled="changingPassword" required
            persistent-placeholder
            name="currentPassword"
            label="Current password"
            type="password"
            autocomplete="current-password"
          /><v-text-field v-if="passwordMethod === 'password' && state.user?.totpEnabled" v-model="passwordTotp" label="Authenticator code" name="totp" autocomplete="one-time-code" inputmode="numeric" maxlength="6" :disabled="changingPassword" required />
          <v-text-field
            v-model="password" :disabled="changingPassword"
            persistent-placeholder
            name="newPassword"
            label="New password (12–256 characters)"
            type="password"
            autocomplete="new-password"
            minlength="12"
            maxlength="256"
            required
          /><v-btn type="submit" color="primary" :loading="changingPassword" :disabled="!!state.busy || changingPassword" :prepend-icon="passwordMethod === 'passkey' ? 'mdi-fingerprint' : 'mdi-lock-reset'"
            >{{ passwordMethod === 'passkey' ? 'Authorize with passkey and update' : 'Update password' }}</v-btn
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
        <v-alert v-if="!registrationMethods.length" type="info" variant="tonal" class="mb-4">Use an existing passkey or enable your authenticator to authorize registration.</v-alert>
        <v-select v-if="registrationMethods.length" v-model="registrationMethod" :items="registrationMethods" label="Authorize registration with" />
        <template v-if="registrationMethod === 'password'">
          <v-text-field v-model="registrationPassword" type="password" label="Current password" autocomplete="current-password" />
          <v-text-field v-if="state.user?.totpEnabled" v-model="registrationTotp" label="Authenticator code" autocomplete="one-time-code" inputmode="numeric" maxlength="6" />
        </template>
        <v-text-field v-model="name" label="Passkey name" maxlength="64" /><v-btn
          prepend-icon="mdi-fingerprint"
          color="primary"
          :loading="registeringPasskey"
          :disabled="registeringPasskey || !registrationMethods.length"
          @click="addPasskey"
          >Register passkey</v-btn
        ><v-list
          ><v-list-item
            v-for="p in state.user?.passkeys"
            :key="p.id"
            :title="p.name"
            :subtitle="formatDateTime(p.createdAt)"
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
      ><v-text-field v-if="!setup && !state.user?.passkeys?.length" v-model="totpSetupPassword" type="password" autocomplete="current-password" label="Current password to authorize authenticator setup" /><v-btn
        v-if="!setup"
        color="primary"
        @click="beginTotpSetup"
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
              hideSensitive();
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
    <DataList :headers="headers" :items="entries" :search="auditSearch" :loading="!!state.busy" :items-per-page="15"><template #item.at="{ item }"><DateTime :value="item.at" /></template></DataList></v-card>
  <RuntimeLogs v-if="accountTab === 'logs'" />

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
