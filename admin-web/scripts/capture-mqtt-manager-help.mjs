// Capture synthetic, isolated MQTT Manager Help screenshots. This fixture mocks
// the Gateway API and EventSource and never connects to Mosquitto or localhost:8080.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { chromium } from '@playwright/test';
import { defaultPresentation } from '../shared/presentation-preferences.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const frontend = path.join(root, 'frontend');
const output = path.join(frontend, 'public', 'screenshots');
await fs.mkdir(output, { recursive: true });
const token = crypto.randomBytes(8).toString('hex');
const htmlPath = path.join(frontend, `__mqtt_help_capture_${token}.html`);
await fs.writeFile(htmlPath, '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MQTT Manager Help capture</title></head><body><div id="app"></div><script type="module" src="/main.js"></script></body></html>');
const presentation = defaultPresentation();
presentation.preset = 'custom';
const mock = `
const presentation = ${JSON.stringify(presentation)};
const demoUser = { id: 'synthetic-demo-operator', username: 'Example Operator', presentation, timeZone: 'UTC', hasPassword: true, totpEnabled: false, sensitivePreferences: { timeoutSeconds: 60, requireAuthentication: true }, passkeys: [] };
const at = new Date('2026-01-15T12:34:56.000Z').toISOString();
const history = {
  historyLimit: 200,
  messages: [
    { id: 'demo-message-1', timestamp: at, topic: 'demo/temperature', text: '{"value":21.4,"unit":"C"}', base64: 'eyJ2YWx1ZSI6MjEuNCwidW5pdCI6IkMifQ==', qos: 1, retain: false, bytes: 26 },
    { id: 'demo-message-2', timestamp: at, topic: 'demo/door/state', text: 'closed', base64: 'Y2xvc2Vk', qos: 0, retain: false, bytes: 6 },
  ],
  retained: [ { id: 'demo-retained-1', timestamp: at, topic: 'demo/target/value', text: '{"example":true}', base64: 'eyJleGFtcGxlIjp0cnVlfQ==', qos: 1, retain: true, bytes: 16 } ],
};
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.startsWith('/api/')) return nativeFetch(input, init);
  const path = new URL(url, location.href).pathname;
  let body = {};
  if (path === '/api/bootstrap') body = { hasAdmin: true, user: demoUser, bootstrapHelp: null };
  else if (path === '/api/broker/status') body = { changes: [], revision: 'synthetic', appliedRevision: 'synthetic', pendingRevision: null, pendingChanges: false, applied: true, applying: false };
  else if (path === '/api/system-updates/config') body = { channel: 'stable', notifications: false };
  else if (path === '/api/system-updates/status') body = { installed: { version: 'synthetic' }, latest: { installable: false }, controller: { operation: null } };
  else if (path === '/api/mqtt/history') body = history;
  else if (path === '/api/sensitive/reveal') body = { expiresInMs: 60000 };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
};
window.EventSource = class SyntheticEventSource { constructor() { this.onmessage = null; this.onerror = null; } close() {} };
`;
let server;
let browser;
try {
  server = await createServer({ root: frontend, configFile: false, plugins: [vue()], server: { host: '127.0.0.1', port: 8080, strictPort: true, hmr: false } });
  await server.listen();
  const { port } = server.httpServer.address();
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/bin/chromium', headless: true, args: ['--no-sandbox'] });
  for (const mode of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width: 1680, height: 1400 }, deviceScaleFactor: 2, colorScheme: mode });
    await context.addInitScript(({ theme, mockSource }) => {
      localStorage.setItem('theme', theme);
      (0, eval)(mockSource);
    }, { theme: mode, mockSource: mock });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${port}/${path.basename(htmlPath)}#/mqtt`);
    await page.getByRole('heading', { name: 'MQTT Manager', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Live messages', exact: true }).waitFor();
    await page.getByRole('heading', { name: 'Observed retained messages', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Show sensitive information', exact: true }).click();
    await page.getByRole('button', { name: 'Hide sensitive information', exact: true }).waitFor();
    await page.getByText('demo/temperature', { exact: true }).waitFor();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(400);
    await page.waitForFunction(() => document.fonts.status === 'loaded');
    const markers = await page.evaluate(() => {
      const text = (selector, value) => [...document.querySelectorAll(selector)].find((node) => node.textContent.trim() === value);
      const label = (value) => [...document.querySelectorAll('label')].find((node) => node.textContent.trim() === value)?.closest('.v-input');
      const liveTitle = text('h2', 'Live messages');
      const liveCard = liveTitle?.closest('.v-card');
      const retainedTitle = text('h2', 'Observed retained messages');
      const retainedCard = retainedTitle?.closest('.v-card');
      const forms = [...document.querySelectorAll('form')];
      const publishForm = forms[1];
      const historyForm = forms[2];
      const buttons = [...document.querySelectorAll('button')];
      const button = (name) => buttons.find((node) => node.textContent.trim() === name || node.getAttribute('aria-label') === name);
      const union = (elements) => {
        const rects = elements.filter(Boolean).map((element) => element.getBoundingClientRect());
        if (!rects.length) return null;
        const left = Math.min(...rects.map((rect) => rect.left));
        const top = Math.min(...rects.map((rect) => rect.top));
        const right = Math.max(...rects.map((rect) => rect.right));
        const bottom = Math.max(...rects.map((rect) => rect.bottom));
        return { left, top, width: right-left, height: bottom-top };
      };
      const rect = (element) => { if (!element) return null; const r = element.getBoundingClientRect(); return { left:r.left, top:r.top, width:r.width, height:r.height }; };
      const liveHeader = liveCard?.querySelector('thead');
      const liveFooter = liveCard?.querySelector('.v-data-table-footer');
      const retainedHeader = retainedCard?.querySelector('thead');
      const retainedFooter = retainedCard?.querySelector('.v-data-table-footer');
      const retainedAction = retainedCard?.querySelector('tbody button[aria-label^="Actions for"]');
      return [
        rect(liveTitle?.parentElement), rect(label('Filter observed topic')), rect(label('Payload format')),
        rect(liveHeader), rect(liveFooter), rect(forms[0]?.querySelector('.v-input')),
        rect(button('Subscribe')), rect(label('Topic') && publishForm?.querySelector('.v-input')),
        rect(publishForm?.querySelector('textarea')?.closest('.v-input')),
        rect(label('Encoding')), rect(label('QoS')), rect(label('Retain message')),
        rect(button('Publish')), rect(historyForm?.querySelector('.v-input')), rect(button('Save limit')),
        union([retainedTitle?.parentElement, label('Search retained topics or payloads'), retainedCard?.querySelector('.v-chip')].filter(Boolean)),
        rect(retainedHeader), rect(retainedAction), rect(retainedFooter),
      ];
    });
    if (markers.some((rect) => !rect)) throw new Error(`Could not map all visual-guide callouts in ${mode} screenshot.`);
    await page.evaluate((rectangles) => {
      const color = getComputedStyle(document.querySelector('.v-application')).getPropertyValue('--v-theme-primary').trim() || '24 103 192';
      rectangles.forEach((rect, index) => {
        const badge = document.createElement('span');
        badge.className = 'mqtt-help-number';
        badge.textContent = String(index + 1);
        badge.style.cssText = `position:absolute;left:${Math.round(rect.left+scrollX+rect.width-15)}px;top:${Math.round(rect.top+scrollY-13)}px;width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:rgb(${color});color:#fff;font:700 16px/1 system-ui,sans-serif;border:2px solid #fff;box-shadow:0 2px 7px #0008;z-index:9999;pointer-events:none`;
        document.body.append(badge);
      });
    }, markers);
    await page.screenshot({ path: path.join(output, `mqtt-manager-help-${mode}.png`), fullPage: true, animations: 'disabled', scale: 'device' });
    if (errors.length) throw new Error(errors.join('\n'));
    await context.close();
  }
  console.log('Captured Light and Dark MQTT Manager screenshots from synthetic mock data; no broker or production API was contacted.');
} finally {
  await browser?.close();
  await server?.close();
  await fs.rm(htmlPath, { force: true });
}
