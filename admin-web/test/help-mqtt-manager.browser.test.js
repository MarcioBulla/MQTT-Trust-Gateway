import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { chromium } from '@playwright/test';
import { helpTopicById } from '../frontend/help/help-topics.js';

const frontend = path.resolve('frontend');
const screenshots = path.join(frontend, 'public/screenshots');
const chromiumPath = '/bin/chromium';

test('MQTT Manager Help maps its UI, includes both palettes, and follows contextual Read more', { skip: await fs.stat(chromiumPath).then(() => false).catch(() => true), timeout: 30_000 }, async () => {
  const topic = helpTopicById['mqtt-manager'];
  assert.ok(topic);
  assert.equal(topic.visualGuide.length, 19);
  assert.match(topic.steps.join(' '), /QoS 0 is at most once, QoS 1 is at least once and may duplicate, and QoS 2 completes the MQTT exactly-once exchange/i);
  assert.match(topic.visualGuide[10].description, /not proof that each subscriber application consumed the message/i);
  assert.equal(topic.themeScreenshots.light.theme, 'Light');
  assert.equal(topic.themeScreenshots.dark.theme, 'Dark');
  for (const mode of ['light', 'dark']) {
    const file = path.join(screenshots, `mqtt-manager-help-${mode}.png`);
    const image = await fs.readFile(file);
    assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${mode} screenshot must be a PNG`);
    assert.equal(image.readUInt32BE(16), 3360, `${mode} screenshot should preserve the 2x native capture width`);
  }
  const pageSource = await fs.readFile(path.join(frontend, 'pages/Mqtt.vue'), 'utf8');
  assert.match(pageSource, /HelpButton topic-id="mqtt-manager"/);
  const captureSource = await fs.readFile(path.resolve('scripts/capture-mqtt-manager-help.mjs'), 'utf8');
  assert.match(captureSource, /SyntheticEventSource/);
  assert.match(captureSource, /api\/sensitive\/reveal/);
  assert.match(captureSource, /deviceScaleFactor: 2/);
  assert.doesNotMatch(captureSource, /startMqtt|publishMessage|mqtt-service/);
  assert.match(captureSource, /port: 8080, strictPort: true/);

  const token = crypto.randomBytes(6).toString('hex');
  const htmlPath = path.join(frontend, `__mqtt_help_test_${token}.html`);
  const jsPath = path.join(frontend, `__mqtt_help_test_${token}.js`);
  const html = '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MQTT Help test</title></head><body><div id="app"></div><script type="module" src="/' + path.basename(jsPath) + '"></script></body></html>';
  const script = `
    import { createApp, defineComponent, h } from 'vue';
    import { createVuetify } from 'vuetify';
    import * as components from 'vuetify/components';
    import * as directives from 'vuetify/directives';
    import { createRouter, createWebHashHistory, RouterView } from 'vue-router';
    import HelpButton from '/components/HelpButton.vue';
    import Help from '/pages/Help.vue';
    const themes = {
      light: { dark: false, colors: { primary: '#1867c0', background: '#f5f7fa', surface: '#ffffff', 'on-surface': '#111827' } },
      dark: { dark: true, colors: { primary: '#2196f3', background: '#0e131b', surface: '#212121', 'on-surface': '#f9fafb' } },
      oled: { dark: true, colors: { primary: '#2196f3', background: '#000000', surface: '#101010', 'on-surface': '#f9fafb' } },
    };
    const vuetify = createVuetify({ components, directives, theme: { defaultTheme: 'light', themes } });
    window.__theme = vuetify.theme;
    const router = createRouter({ history: createWebHashHistory(), routes: [
      { path: '/', component: { render: () => h('p', 'Home') } },
      { path: '/help/:topicId', name: 'help-topic', component: Help, props: route => ({ topicId: String(route.params.topicId) }) },
    ] });
    const App = defineComponent({ setup() { return () => h('v-app', [
      h(HelpButton, { topicId: 'mqtt-manager' }),
      h('button', { id: 'dark-theme', onClick: () => vuetify.theme.change('dark') }, 'Dark'),
      h('button', { id: 'oled-theme', onClick: () => vuetify.theme.change('oled') }, 'OLED'),
      h(RouterView),
    ]); } });
    createApp(App).use(vuetify).use(router).mount('#app');
  `;
  await fs.writeFile(htmlPath, html);
  await fs.writeFile(jsPath, script);
  const server = await createServer({ configFile: false, root: frontend, plugins: [vue()], server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  let browser;
  try {
    await server.listen();
    const address = server.httpServer.address();
    browser = await chromium.launch({ headless: true, executablePath: chromiumPath, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`http://127.0.0.1:${address.port}/${path.basename(htmlPath)}`);
    const helpButton = page.getByRole('button', { name: `Help: ${topic.title}` });
    await helpButton.click();
    await page.getByRole('dialog', { name: `${topic.title} help preview` }).getByRole('link', { name: /Read more/ }).waitFor();
    const popupPromise = page.waitForEvent('popup');
    await page.getByRole('dialog', { name: `${topic.title} help preview` }).getByRole('link', { name: /Read more/ }).click();
    const article = await popupPromise;
    await article.getByRole('heading', { name: topic.title, exact: true }).waitFor();
    const image = article.locator('.help-guide-image');
    await image.waitFor();
    await image.evaluate((node) => node.decode());
    assert.match(await image.getAttribute('src'), /mqtt-manager-help-light\.png$/);
    assert.equal(await image.evaluate((node) => node.naturalWidth > 0), true);
    assert.equal(await article.getByRole('list', { name: 'Numbered MQTT Manager controls and table guide' }).locator('li').count(), 19);
    await article.locator('#dark-theme').click();
    await article.waitForFunction(() => document.querySelector('.help-guide-image')?.getAttribute('src')?.endsWith('mqtt-manager-help-dark.png'));
    assert.equal(await image.evaluate((node) => node.naturalWidth > 0), true);
    await article.locator('#oled-theme').click();
    await article.waitForFunction(() => document.querySelector('.help-guide-image')?.getAttribute('src')?.endsWith('mqtt-manager-help-dark.png'));
  } finally {
    await browser?.close();
    await server.close();
    await fs.rm(htmlPath, { force: true });
    await fs.rm(jsPath, { force: true });
  }
});
