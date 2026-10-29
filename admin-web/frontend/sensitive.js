import { reactive, ref, watch } from 'vue';
import { api, state, registerStepUpHandler } from './api';

export const revealScopes = reactive({});
export const requestedScope = ref(null);
export const revealTitles = {
  infrastructure: 'Connection details', devices: 'Devices and certificates',
  mqtt: 'MQTT messages', audit: 'Audit events and service logs',
};
const timers = new Map();
let epoch = 0, revoking = Promise.resolve();
export function isRevealed(scope) {
  const grant = revealScopes[scope];
  return Boolean(grant && performance.now() < grant.deadline);
}
function clearData(scope) {
  clearTimeout(timers.get(scope)); timers.delete(scope);
  delete revealScopes[scope];
  if (scope === 'devices' && state.brokerChanges?.changes)
    state.brokerChanges.changes = state.brokerChanges.changes.map(({ certificateSerial, detail, ...change }) => ({ ...change, hasCertificateSerial: Boolean(certificateSerial || change.hasCertificateSerial) }));
  state.error = ''; state.notice = '';
}
export function hideSensitive(scope = 'all', { invalidate = true, closeDialog = true } = {}) {
  if (invalidate) epoch++;
  if (closeDialog) requestedScope.value = null;
  for (const key of scope === 'all' ? Object.keys(revealScopes) : [scope]) clearData(key);
  // A failed revoke never keeps values visible; server grants independently expire.
  revoking = revoking.catch(() => {}).then(() => fetch('/api/sensitive/hide', {
    method: 'POST', credentials: 'same-origin', keepalive: true,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope }),
  })).then(() => {}).catch(() => {});
  return revoking;
}
export async function requestReveal(scope) {
  if (!revealTitles[scope]) return;
  await revoking;
  if (state.user && !document.hidden) {
    try { await authorizeReveal(scope, async () => undefined); }
    catch { requestedScope.value = scope; }
  }
}
export async function authorizeReveal(scope, proofFactory) {
  const generation = epoch, userId = state.user?.id;
  const reauth = await proofFactory();
  await revoking;
  if (generation !== epoch || document.hidden || state.user?.id !== userId) throw new Error('Reveal canceled');
  const grant = await api('/sensitive/reveal', 'POST', { scope, reauth });
  if (generation !== epoch || document.hidden || state.user?.id !== userId) {
    await hideSensitive(scope); throw new Error('Reveal canceled');
  }
  const duration = Math.max(0, grant.expiresInMs ?? grant.expiresAt - Date.now());
  revealScopes[scope] = { deadline: performance.now() + duration, generation: ++epoch };
  state.sensitiveScopes = revealScopes;
  clearTimeout(timers.get(scope));
  timers.set(scope, setTimeout(() => hideSensitive(scope), duration));
  requestedScope.value = null;
}
export async function sensitiveFetch(scope, url) {
  const grant = revealScopes[scope];
  if (!isRevealed(scope)) return null;
  const result = await api(url);
  return isRevealed(scope) && revealScopes[scope] === grant ? result : null;
}
watch(() => state.user?.id, (next, previous) => {
  if (next !== previous) hideSensitive();
}, { flush: 'sync' });
document.addEventListener('visibilitychange', () => { if (document.hidden) hideSensitive(); });
window.addEventListener('pagehide', () => hideSensitive());
window.addEventListener('pageshow', (event) => { if (event.persisted) hideSensitive(); });
window.addEventListener('blur', () => {
  if (Object.keys(revealScopes).length) hideSensitive('all', { invalidate: !requestedScope.value, closeDialog: !requestedScope.value });
});

// Await the existing modal instead of leaving protected actions at an error message.
export async function ensureSensitive(scope) {
  if (isRevealed(scope)) return;
  await requestReveal(scope);
  if (isRevealed(scope)) return;
  if (requestedScope.value !== scope) throw new Error('Verification canceled');
  await new Promise((resolve, reject) => {
    const stop = watch([() => revealScopes[scope], requestedScope, () => state.user?.id], () => {
      if (isRevealed(scope)) { stop(); resolve(); }
      else if (requestedScope.value !== scope || !state.user) { stop(); reject(new Error('Verification canceled')); }
    }, { flush: 'post' });
  });
}

registerStepUpHandler(ensureSensitive);
