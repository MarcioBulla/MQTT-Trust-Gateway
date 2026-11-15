import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { chromium } from '@playwright/test';

test('Device Health Check and uptime render synthetic configuration, coverage and UTC tooltips', {
  skip: !existsSync('/bin/chromium'), timeout: 90000,
}, async () => {
  const root = path.resolve('frontend');
  const token = String(Date.now());
  const html = path.join(root, `__device_health_${token}.html`);
  const entry = path.join(root, `__device_health_${token}.js`);
  let server;
  let browser;
  try {
    await fs.writeFile(html, `<html><body><div id="app"></div><script type="module" src="/${path.basename(entry)}"></script></body></html>`);
    await fs.writeFile(entry, `
    import { createApp, defineComponent, h } from 'vue';
    import { createVuetify } from 'vuetify';
    import * as components from 'vuetify/components';
    import * as directives from 'vuetify/directives';
    import { createRouter, createWebHashHistory } from 'vue-router';
    import DeviceUptime from '/components/DeviceUptime.vue';
    import DeviceHealth from '/components/DeviceHealth.vue';
    const day = (date, values) => ({ date, online: 0, offline: 0, unknown: 0, complete: true, endState: 'online', uptime: 0, ...values });
    const health = {
      status: 'online', uptime: 96.5, unknown: true,
      days: Array.from({ length: 30 }, (_, index) => {
        const date = new Date(Date.UTC(2026, 9, 15 + index)).toISOString().slice(0, 10);
        if (index === 0) return day(date, { online: 86400000, uptime: 100 });
        if (index === 1) return day(date, { online: 3600000, unknown: 82800000, complete: false, uptime: null });
        if (index === 2) return day(date, { online: 43200000, offline: 43200000, endState: 'offline', uptime: 50 });
        return day(date, { online: 86400000, uptime: 100 });
      }),
    };
    const vuetify = createVuetify({ components, directives });
    const router = createRouter({ history: createWebHashHistory(), routes: [
      { path: '/', component: { render: () => h('div') } },
      { path: '/help/:topicId', name: 'help-topic', component: { render: () => h('div') } },
    ] });
    const App = defineComponent({ setup() { return () => h('v-app', [
      h('section', { id: 'uptime-enabled' }, [h('h2', 'Enabled device'), h(DeviceUptime, { health })]),
      h('section', { id: 'uptime-disabled' }, [h('h2', 'Disabled device'), h(DeviceUptime, { health: { status: 'disabled' } })]),
      h(DeviceHealth, { deviceId: 'synthetic-device' }),
    ]); } });
    createApp(App).use(vuetify).use(router).mount('#app');
    `);
    server = await createServer({ configFile: false, root, plugins: [vue()], server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
    await server.listen();
    browser = await chromium.launch({ executablePath: '/bin/chromium', headless: true, timeout: 45000, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10000);
    page.setDefaultNavigationTimeout(45000);
    page.on('pageerror', (error) => console.error('Health UI browser error:', error.message));
    await page.route('**/api/devices/synthetic-device/health', async (route) => {
      assert.equal(route.request().method(), 'GET');
      await route.fulfill({ json: {
      config: { enabled: true, topic: 'gateway/health/synthetic-device/status', onlinePayload: 'online', offlinePayload: 'offline', readers: [], offlineGrace: 30, recoveryStability: 5 },
      readerCandidates: [{ id: 'health-reader', label: 'Health reader (health-reader)' }],
        status: 'unknown',
      } });
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/${path.basename(html)}`, { waitUntil: 'domcontentloaded' });

    const uptime = page.locator('#uptime-enabled');
    await uptime.locator('.uptime-bar').first().waitFor();
    assert.equal(await uptime.locator('.uptime-bar').count(), 30);
    assert.equal(await uptime.locator('.uptime .text-caption').count(), 0, 'the uptime cell shows bars without a percentage label');
    await page.locator('#uptime-disabled').getByText('—', { exact: true }).waitFor();
    const firstBar = uptime.locator('.uptime-bar').nth(0);
    assert.equal(await firstBar.getAttribute('aria-label'), '2026-10-15: 100.0% uptime');
    await firstBar.hover();
    const tooltip = page.locator('.v-overlay--active .v-overlay__content');
    await tooltip.waitFor();
    assert.match(await tooltip.innerText(), /2026-10-15 UTC · Ended Online/);
    const partialOnlineBar = uptime.locator('.uptime-bar').nth(1);
    assert.equal(await partialOnlineBar.getAttribute('aria-label'), '2026-10-16: unknown');
    assert.match(await partialOnlineBar.getAttribute('style'), /success/, 'a partial day ending online is green');
    await partialOnlineBar.hover();
    await tooltip.waitFor();
    assert.match(await tooltip.innerText(), /2026-10-16 UTC · Ended Online/);
    assert.match(await tooltip.innerText(), /Unknown 23:00/);
    const offlineBar = uptime.locator('.uptime-bar').nth(2);
    assert.match(await offlineBar.getAttribute('style'), /error/, 'a day ending offline is red');

    const form = page.locator('.v-card').filter({ has: page.getByRole('heading', { name: 'Health Check' }) });
    const healthTopicInput = form.getByRole('textbox', { name: /Health Topic/ });
    await healthTopicInput.waitFor();
    assert.equal(await healthTopicInput.inputValue(), 'gateway/health/synthetic-device/status');
    assert.equal(await form.getByRole('textbox', { name: 'Online Payload' }).inputValue(), 'online');
    assert.equal(await form.getByRole('textbox', { name: /Offline Payload/ }).inputValue(), 'offline');
    await form.getByRole('combobox', { name: 'Allow other identities to read this status topic' }).waitFor();
    await form.getByText('Current Status:').waitFor();
    await form.getByText('Current Status:').locator('..').getByText('unknown', { exact: true }).waitFor();
    await form.getByText('MQTT LWT + Retain + QoS 1', { exact: true }).waitFor();
    await form.getByText('Expected Keep Alive:').waitFor();
    await form.getByText('60 seconds', { exact: false }).waitFor();
    await form.getByText('Advanced Settings', { exact: true }).click();
    assert.equal(await form.getByLabel('Offline Grace Period (seconds)').inputValue(), '30');
    assert.equal(await form.getByLabel('Recovery Stability Period (seconds)').inputValue(), '5');
  } finally {
    try {
      await browser?.close();
    } finally {
      try {
        if (server) {
          server.httpServer?.closeAllConnections();
          await server.close();
        }
      } finally {
        await Promise.all([fs.rm(html, { force: true }), fs.rm(entry, { force: true })]);
      }
    }
  }
});
