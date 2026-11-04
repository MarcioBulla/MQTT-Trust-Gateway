import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { chromium } from '@playwright/test';
import { helpTopics } from '../frontend/help/help-topics.js';

const chromiumPath = '/bin/chromium';

test('all Help workflow and exchange diagrams render interactively in Chromium across themes and mobile', {
  skip: !existsSync(chromiumPath),
  timeout: 30_000,
}, async () => {
  const frontend = path.resolve('frontend');
  const expectedDiagrams = helpTopics.length * 2;
  const token = crypto.randomBytes(6).toString('hex');
  const htmlPath = path.join(frontend, `__help_diagrams_${token}.html`);
  const jsPath = path.join(frontend, `__help_diagrams_${token}.js`);
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Help diagrams</title></head><body><div id="app"></div><script type="module" src="/${path.basename(jsPath)}"></script></body></html>`;
  const script = `
    import { createApp, h } from 'vue';
    import { createVuetify } from 'vuetify';
    import * as vuetifyComponents from 'vuetify/components';
    import MermaidDiagram from '/components/MermaidDiagram.vue';
    import { helpTopics } from '/help/help-topics.js';
    const themes = {
      light: { dark: false, colors: { primary: '#123abc', background: '#ffffff', surface: '#f3f4f6', 'on-surface': '#111827', 'chart-received': '#0891b2', 'chart-sent': '#15803d' } },
      dark: { dark: true, colors: { primary: '#c4b5fd', background: '#20212b', surface: '#30313e', 'on-surface': '#f9fafb', 'chart-received': '#67e8f9', 'chart-sent': '#86efac' } },
      oled: { dark: true, colors: { primary: '#f0abfc', background: '#000000', surface: '#0d0d0d', 'on-surface': '#f9fafb', 'chart-received': '#67e8f9', 'chart-sent': '#86efac' } },
    };
    const vuetify = createVuetify({ components: vuetifyComponents, theme: { defaultTheme: 'dark', themes } });
    window.__helpTheme = vuetify.theme;
    createApp({ render: () => h('main', helpTopics.map(topic => h('section', { id: topic.id }, [h('h2', topic.title), h(MermaidDiagram, { source: topic.workflowMermaid, title: topic.title + ' workflow' }), h(MermaidDiagram, { source: topic.mermaid, title: topic.title + ' exchange' })]))) }).use(vuetify).mount('#app');
  `;
  await fs.writeFile(htmlPath, html);
  await fs.writeFile(jsPath, script);
  const server = await createServer({ configFile: false, root: frontend, plugins: [vue()], server: { host: '127.0.0.1', port: 0, strictPort: false, hmr: false } });
  let browser;
  try {
    await server.listen();
    const address = server.httpServer.address();
    browser = await chromium.launch({ headless: true, executablePath: chromiumPath, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${address.port}/${path.basename(htmlPath)}`);
    await page.waitForFunction((expected) => document.querySelectorAll('.diagram-scroll svg').length + [...document.querySelectorAll('.diagram-frame')].filter((frame) => frame.innerText.includes('could not be rendered')).length === expected, expectedDiagrams, { timeout: 12_000 });
    const renderFailures = await page.locator('.diagram-frame').filter({ hasText: 'could not be rendered' }).count();
    const failedTopic = renderFailures ? await page.locator('.diagram-frame').filter({ hasText: 'could not be rendered' }).first().evaluate((frame) => frame.closest('section')?.id || 'unknown') : 'none';
    assert.equal(renderFailures, 0, `Diagram ${failedTopic} parse/render errors: ${errors.map((item) => item.split('\n')[0]).join(' | ')}`);
    assert.equal(await page.locator('main > section').count(), helpTopics.length);
    assert.equal(await page.locator('.diagram-scroll svg').count(), expectedDiagrams);
    assert.equal(await page.locator('.diagram-scroll svg script, .diagram-scroll svg foreignObject, .diagram-scroll svg iframe, .diagram-scroll svg a').count(), 0);
    const labels = await page.locator('.diagram-scroll svg text').allTextContents();
    const normalizedLabels = labels.map((label) => label.replace(/\s+/g, '').toLowerCase());
    assert.ok(normalizedLabels.some((label) => label.includes('registerdeviceid')), 'Workflow diagram should include the registration action');
    assert.ok(normalizedLabels.some((label) => label.includes('device.csr')), 'Exchange diagram should include a certificate artifact');

    const firstWidget = page.locator('.diagram-widget').first();
    const svg = firstWidget.locator('svg');
    const initialWidth = await svg.evaluate((node) => node.getBoundingClientRect().width);
    await firstWidget.getByRole('button', { name: /Zoom in/ }).click();
    const enlargedWidth = await svg.evaluate((node) => node.getBoundingClientRect().width);
    assert.ok(enlargedWidth > initialWidth, `Zoom in should enlarge diagram (${initialWidth} → ${enlargedWidth})`);
    await firstWidget.getByRole('button', { name: 'Fit diagram to view' }).click();
    const desktopFittedWidth = await svg.evaluate((node) => node.getBoundingClientRect().width);
    assert.ok(desktopFittedWidth < enlargedWidth, 'Fit should reduce the enlarged diagram');
    for (let i = 0; i < 7; i++) await firstWidget.getByRole('button', { name: /Zoom in/ }).click();
    const scrollArea = firstWidget.locator('.diagram-scroll');
    await scrollArea.scrollIntoViewIfNeeded();
    const box = await scrollArea.boundingBox();
    await page.mouse.move(box.x + 240, box.y + 80);
    await page.mouse.down();
    await page.mouse.move(box.x + 100, box.y + 80, { steps: 5 });
    await page.mouse.up();
    assert.ok(await scrollArea.evaluate((node) => node.scrollLeft) > 0, 'Dragging should pan the enlarged diagram');
    await firstWidget.getByRole('button', { name: 'Reset diagram zoom and position' }).click();
    const resetWidth = await svg.evaluate((node) => node.getBoundingClientRect().width);
    assert.ok(Math.abs(resetWidth - initialWidth) < 2, 'Reset should restore initial diagram size');
    await firstWidget.getByRole('button', { name: /Enlarge/ }).click();
    await page.getByRole('region', { name: /Enlarged .* diagram/ }).waitFor({ timeout: 4_000 });
    await page.getByRole('button', { name: 'Close enlarged diagram' }).click();

    await page.evaluate(() => { window.__helpTheme.change('light'); });
    await page.waitForFunction(() => document.querySelector('.diagram-scroll svg')?.innerHTML.toLowerCase().includes('#123abc'), null, { timeout: 5_000 });
    await page.evaluate(() => { window.__helpTheme.change('oled'); });
    await page.waitForFunction(() => document.querySelector('.diagram-scroll svg')?.innerHTML.toLowerCase().includes('#0d0d0d'), null, { timeout: 5_000 });

    await page.setViewportSize({ width: 375, height: 850 });
    await page.waitForTimeout(200);
    const widths = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, frame: document.querySelector('.diagram-frame').clientWidth }));
    assert.ok(widths.document <= widths.viewport, `Page overflows horizontally: ${JSON.stringify(widths)}`);
    assert.ok(widths.frame <= widths.viewport, `Diagram frame overflows horizontally: ${JSON.stringify(widths)}`);
    const mobileWidget = page.locator('.diagram-widget').first();
    const mobileHost = mobileWidget.locator('.diagram-scroll').first();
    const defaultMobileWidth = await mobileHost.locator('svg').evaluate((node) => node.getBoundingClientRect().width);
    assert.ok(defaultMobileWidth <= (await mobileHost.evaluate((host) => host.clientWidth)), `Default mobile view should fit the available width (${JSON.stringify(await mobileHost.evaluate((host) => ({width:host.clientWidth,scroll:host.scrollWidth,svg:host.querySelector('svg')?.getBoundingClientRect().width,wrap:host.querySelector('.diagram-svg')?.getBoundingClientRect().width,zoom:host.closest('.diagram-widget')?.querySelector('.zoom-level')?.textContent,viewBox:host.querySelector('svg')?.getAttribute('viewBox')})) )})`);
    for (let i = 0; i < 7; i++) await mobileWidget.getByRole('button', { name: /Zoom in/ }).click();
    const scrollable = await mobileHost.evaluate((host) => host.scrollWidth > host.clientWidth);
    assert.ok(scrollable, 'A narrow viewport should preserve horizontal diagram scrolling');
    await mobileHost.scrollIntoViewIfNeeded();
    const panBox = await mobileHost.boundingBox();
    await page.mouse.move(panBox.x + panBox.width - 24, panBox.y + 60);
    await page.mouse.down();
    await page.mouse.move(panBox.x + panBox.width - 144, panBox.y + 60, { steps: 3 });
    await page.mouse.up();
    assert.ok(await mobileHost.evaluate((host) => host.scrollLeft > 0), 'Dragging the diagram should pan horizontally');
    await mobileWidget.getByRole('button', { name: 'Fit diagram to view' }).click();
    const fittedWidth = await mobileHost.locator('svg').evaluate((node) => node.getBoundingClientRect().width);
    assert.ok(fittedWidth <= (await mobileHost.evaluate((host) => host.clientWidth)), 'Fit should make the diagram fit on a narrow viewport');
    await mobileHost.focus();
    const beforeKeyboardZoom = await mobileHost.locator('svg').evaluate((node) => node.getBoundingClientRect().width);
    await mobileHost.press('+');
    const afterKeyboardZoom = await mobileHost.locator('svg').evaluate((node) => node.getBoundingClientRect().width);
    assert.ok(afterKeyboardZoom > beforeKeyboardZoom, 'Keyboard plus should zoom the focused diagram');
    assert.deepEqual(errors, []);
  } finally {
    if (browser) await browser.close();
    await server.close();
    await fs.rm(htmlPath, { force: true });
    await fs.rm(jsPath, { force: true });
  }
});
