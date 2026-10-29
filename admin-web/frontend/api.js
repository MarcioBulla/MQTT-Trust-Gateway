import { reactive } from 'vue';
export const state = reactive({
  user: null,
  hasAdmin: true,
  bootstrapHelp: null,
  busy: 0,
  notice: '',
  error: '',
  brokerChanges: null,
});
let shiftClick = false, brokerMutation = 0;
document.addEventListener('click', (event) => {
  shiftClick = event.shiftKey;
  setTimeout(() => { shiftClick = false; }, 0);
}, true);
export function markBrokerMutation() { brokerMutation++; }
export async function refreshBrokerChanges() {
  if (!state.user) return;
  const response = await fetch('/api/broker/status', { credentials: 'same-origin' });
  if (response.ok) state.brokerChanges = await response.json();
}
export async function applyBrokerChanges() {
  state.brokerChanges = await api('/broker/apply', 'POST', {});
}
export async function api(url, method = 'GET', body) {
  state.busy++;
  try {
    const response = await fetch(`/api${url}`, {
      method,
      credentials: 'same-origin',
      headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401) state.user = null;
      throw new Error(data.error || 'Request failed');
    }
    if (method !== 'GET' && /^\/(devices|certificates|trusted-cas)(\/|$)/.test(url)) markBrokerMutation();
    return data;
  } finally {
    state.busy--;
  }
}
export async function action(fn, success = '') {
  const immediate = shiftClick, previousMutation = brokerMutation, previousPending = state.brokerChanges?.pendingRevision;
  state.error = '';
  try {
    const result = await fn();
    if (brokerMutation !== previousMutation) {
      await refreshBrokerChanges();
      if (immediate && state.brokerChanges?.pendingChanges && state.brokerChanges.pendingRevision !== previousPending) {
        await applyBrokerChanges();
        if (success) success = 'Changes applied. Waiting for the broker to confirm.';
      }
    }
    state.notice = success;
    return result;
  } catch (e) {
    state.error = e.message;
  }
}
export async function refreshUser() {
  const data = await api('/bootstrap');
  state.user = data.user;
  state.hasAdmin = data.hasAdmin;
  state.bootstrapHelp = data.bootstrapHelp;
  await refreshBrokerChanges();
}
export async function copy(value) {
  return action(async () => {
    if (!navigator.clipboard)
      throw new Error('Clipboard requires HTTPS or localhost. Select and copy manually.');
    await navigator.clipboard.writeText(value);
  }, 'Copied to clipboard');
}
