import { themePresets } from './theme-presets.js';
export const defaultPresentation = () => ({
  preset: 'custom', oled: false,
  charts: { unit: 'minute', days: 7, refreshSeconds: 15, showFailures: true },
  themes: {
    light: { primary: '#1867C0', background: '#F5F7FA', surface: '#FFFFFF', received: '#1867C0', sent: '#4CAF50' },
    dark: { primary: '#2196F3', background: '#0E131B', surface: '#212121', received: '#2196F3', sent: '#4CAF50' },
  },
});
export function normalizePresentation(value) {
  const defaults = defaultPresentation();
  if (value === undefined) return defaults;
  if (!value || ![1, 3, 7].includes(value.charts?.days) || ![5, 15, 30, 60].includes(value.charts?.refreshSeconds) || typeof value.charts?.showFailures !== 'boolean' || (value.charts?.unit !== undefined && !['minute', 'hour'].includes(value.charts.unit)))
    throw new Error('Invalid chart preferences');
  const preset = value.preset ?? 'custom', oled = value.oled ?? false;
  if (!['custom', 'default', ...themePresets.map(item => item.id)].includes(preset) || typeof oled !== 'boolean') throw new Error('Invalid theme preset or OLED preference');
  const result = { preset, oled, charts: { unit: value.charts.unit || 'minute', days: value.charts.days, refreshSeconds: value.charts.refreshSeconds, showFailures: value.charts.showFailures }, themes: {} };
  for (const name of ['light', 'dark']) {
    result.themes[name] = {};
    for (const field of Object.keys(defaults.themes[name])) {
      const color = value.themes?.[name]?.[field];
      if (typeof color !== 'string' || !/^#[0-9a-f]{6}$/i.test(color)) throw new Error('Colors must use #RRGGBB format');
      result.themes[name][field] = color.toUpperCase();
    }
  }
  return result;
}
