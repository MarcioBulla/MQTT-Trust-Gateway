import { computed } from 'vue';
import { state } from './api';
import { normalizeTimeZone, timestampParts } from '../shared/time-zone.js';
export const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
export const displayTimeZone = computed(() => {
  try {
    const zone = normalizeTimeZone(state.user?.timeZone || 'auto');
    return zone === 'auto' ? browserTimeZone : zone;
  } catch {
    return browserTimeZone;
  }
});
export function formatDateTime(value) {
  const parts = timestampParts(value, displayTimeZone.value);
  return parts ? `${parts.date}, ${parts.time} ${parts.zone}` : '—';
}
