<script setup>
import { computed, ref, watch } from 'vue';
import { startAuthentication } from '@simplewebauthn/browser';
import { useRouter } from 'vue-router';
import { api, state } from '../api';
import { requestedScope, revealTitles, authorizeReveal, hideSensitive } from '../sensitive';
const router = useRouter();
const method = ref('passkey'), password = ref(''), totp = ref(''), error = ref(''), busy = ref(false);
const methods = computed(() => [
  ...(state.user?.hasPassword && state.user?.totpEnabled ? [{ title: 'Password + authenticator code', value: 'password' }] : []),
  ...(state.user?.passkeys?.length ? [{ title: 'Passkey', value: 'passkey' }] : []),
]);
watch(requestedScope, () => { password.value = ''; totp.value = ''; error.value = ''; method.value = methods.value.find((item) => item.value === 'passkey')?.value || methods.value[0]?.value || ''; });
function cancel() { hideSensitive(); password.value = ''; totp.value = ''; error.value = ''; }
async function submit() {
  if (busy.value || !requestedScope.value) return;
  busy.value = true; error.value = '';
  const scope = requestedScope.value;
  try {
    await authorizeReveal(scope, async () => {
      if (method.value === 'passkey') {
        const options = await api('/reauth/options', 'POST', { action: 'reveal', target: scope });
        return { method: 'passkey', credential: await startAuthentication({ optionsJSON: options }) };
      }
      return { method: 'password', password: password.value, totp: totp.value };
    });
  } catch { error.value = 'Additional authentication failed or was canceled. Please try again.'; }
  finally { password.value = ''; totp.value = ''; busy.value = false; }
}
</script>
<template>
  <v-dialog :model-value="!!requestedScope" max-width="500" @update:model-value="value => { if (!value) cancel(); }">
    <v-card class="pa-6">
      <h2 class="text-h5 mb-2">Reveal sensitive information</h2>
      <p class="text-body-2 text-medium-emphasis mb-4">{{ revealTitles[requestedScope] }}. Confirm your identity for temporary access. Information hides automatically when access expires or you leave this view.</p>
      <v-alert v-if="!methods.length" type="info" variant="tonal" class="mb-4">Set up a passkey, or both a password and TOTP, in Account security before revealing sensitive information.</v-alert>
      <v-form v-else @submit.prevent="submit">
        <v-select v-if="methods.length > 1" v-model="method" :items="methods" label="Verification method" :disabled="busy" />
        <template v-if="method === 'password'">
          <input :value="state.user?.username" name="username" autocomplete="username" readonly class="d-none" />
          <v-text-field v-model="password" label="Current password" name="password" type="password" autocomplete="current-password" :disabled="busy" required />
          <v-text-field v-model="totp" label="Authenticator code" name="totp" autocomplete="one-time-code" inputmode="numeric" minlength="6" maxlength="6" :disabled="busy" required />
        </template>
        <v-alert v-if="error" type="error" variant="tonal" class="mb-4">{{ error }}</v-alert>
        <div class="d-flex justify-end ga-2"><v-btn @click="cancel">Cancel</v-btn><v-btn type="submit" color="primary" :loading="busy" :disabled="busy" :prepend-icon="method === 'passkey' ? 'mdi-fingerprint' : 'mdi-shield-lock-outline'">{{ method === 'passkey' ? 'Verify with passkey' : 'Verify and reveal' }}</v-btn></div>
      </v-form>
      <div v-if="!methods.length" class="d-flex justify-end ga-2"><v-btn @click="cancel">Close</v-btn><v-btn color="primary" @click="cancel(); router.push('/settings')">Open Settings</v-btn></div>
    </v-card>
  </v-dialog>
</template>
