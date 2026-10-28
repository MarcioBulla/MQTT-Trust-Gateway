import { reactive } from 'vue';
export const state = reactive({
  user: null,
  hasAdmin: true,
  bootstrapHelp: null,
  busy: 0,
  notice: '',
  error: '',
});
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
    return data;
  } finally {
    state.busy--;
  }
}
export async function action(fn, success = '') {
  state.error = '';
  try {
    const result = await fn();
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
}
export async function copy(value) {
  return action(async () => {
    if (!navigator.clipboard)
      throw new Error('Clipboard requires HTTPS or localhost. Select and copy manually.');
    await navigator.clipboard.writeText(value);
  }, 'Copied to clipboard');
}
