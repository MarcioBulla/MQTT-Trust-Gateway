import { test } from 'node:test';
import assert from 'node:assert/strict';
import { themePresets, effectiveThemeColors } from '../shared/theme-presets.js';
import { defaultPresentation, normalizePresentation } from '../shared/presentation-preferences.js';

test('all fourteen presets contain valid editable light and dark palettes', () => {
 assert.equal(themePresets.length,14);
 assert.equal(new Set(themePresets.map(preset=>preset.id)).size,14);
 for(const preset of themePresets) {
  const value={...defaultPresentation(),preset:preset.id,themes:JSON.parse(JSON.stringify(preset.themes))};
  assert.equal(normalizePresentation(value).preset,preset.id);
  for(const mode of ['light','dark']) for(const color of Object.values(value.themes[mode])) assert.match(color,/^#[0-9A-F]{6}$/);
 }
});
test('OLED overrides only dark background/surface, preserves custom accents and never mutates stored palettes', () => {
 const value=defaultPresentation();value.themes=JSON.parse(JSON.stringify(themePresets[0].themes));value.oled=true;
 value.themes.dark.primary='#123456';const original=JSON.stringify(value);
 const dark=effectiveThemeColors(value,'dark'),light=effectiveThemeColors(value,'light');
 assert.equal(dark.background,'#000000');assert.equal(dark.surface,'#0D0D0D');assert.equal(dark.primary,'#123456');
 assert.equal(light.background,value.themes.light.background);assert.equal(value.oled,true);
 assert.equal(JSON.stringify(value),original);
 value.oled=false;assert.equal(effectiveThemeColors(value,'dark').background,value.themes.dark.background);
});
test('legacy preferences preserve custom colors and reject unsupported preset/OLED input', () => {
 const value=defaultPresentation();delete value.preset;delete value.oled;
 assert.equal(normalizePresentation(value).preset,'custom');assert.equal(normalizePresentation(value).oled,false);
 assert.throws(()=>normalizePresentation({...value,preset:'unknown'}));
 assert.throws(()=>normalizePresentation({...value,oled:'true'}));
});
