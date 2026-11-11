// Browser fixture with synthetic identities and an in-memory API.
import express from 'express';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { defaultPresentation } from '../../shared/presentation-preferences.js';

let rules = { mode: 'all', publish: [], subscribe: [] }, submitted;
const user = { id: 'preview', username: 'preview', hasPassword: true, totpEnabled: true, passkeys: [], timeZone: 'auto', presentation: defaultPresentation() };
const app = express(); app.use(express.json());
app.use('/api', (req, res) => {
  if (req.path === '/bootstrap') return res.json({ hasAdmin: true, user });
  if (req.path === '/broker/status') return res.json({ pendingChanges: false });
  if (req.path === '/sensitive/reveal') return res.json({ expiresInMs: 60000 });
  if (req.path === '/devices') return res.json({ devices: [{ id: 'AutoBootWeb', name: 'AutoBootWeb', status: 'active' }] });
  if (req.path === '/certificates') return res.json({ certificates: [] });
  if (req.path === '/trusted-cas') return res.json({ trustedCas: [] });
  if (req.path === '/devices/AutoBootWeb/rules') {
    if (req.method === 'PUT') { submitted = req.body; rules = req.body; }
    return res.json({ rules });
  }
  return res.json({ ok: true });
});
app.use(express.static(new URL('../../dist', import.meta.url).pathname));
const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/bin/chromium', headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/#/devices/AutoBootWeb/certificates`);
  await page.getByRole('tab', { name: 'Rules', exact: true }).click();
  await page.getByText('All topics (#)', { exact: true }).waitFor();
  await page.getByLabel('Only configured topic filters').check();
  await page.getByLabel('Publish topic filters').fill('AutoBoot/command/+');
  await page.getByLabel('Subscribe topic filters').fill('AutoBoot/state\nAutoBoot/availability\nAutoBoot/result');
  await page.getByRole('button', { name: 'Save rules' }).click();
  await page.getByText('Rules saved. Apply pending broker changes to enforce them.').waitFor();
  assert.deepEqual(submitted, { mode: 'custom', publish: ['AutoBoot/command/+'], subscribe: ['AutoBoot/state', 'AutoBoot/availability', 'AutoBoot/result'] });
  await page.getByRole('button', { name: 'Help: Configure device topic rules' }).click();
  await page.getByRole('link', { name: /Read more/ }).waitFor();
  assert.equal(await page.getByRole('link', { name: /Read more/ }).count(), 1);
  console.log('Device Rules browser workflow passed.');
} finally { await browser.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
