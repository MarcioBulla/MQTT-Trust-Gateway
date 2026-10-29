// Chromium captures of the actual application with isolated demo account/device data.
// Optional local broker monitoring uses existing credentials in place; nothing is copied or changed.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import argon2 from 'argon2';
import { chromium } from '@playwright/test';
const root = fileURLToPath(new URL('../../', import.meta.url));
const source = path.resolve(process.env.CAPTURE_SOURCE_RUNTIME || path.join(root, 'runtime/live'));
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-release-capture-'));
const output = path.join(root, 'docs/screenshots');
await fs.mkdir(output, { recursive: true });
await fs.mkdir(path.join(directory, 'broker'), { mode: 0o700 });
await fs.mkdir(path.join(directory, 'ca'), { mode: 0o700 });
process.env.ADMIN_DATA_DIR = directory;
process.env.CA_DIR = path.join(directory, 'ca');
process.env.BROKER_CONFIG_DIR = path.join(directory, 'broker');
process.env.MQTT_HOST = 'localhost';
process.env.PUBLIC_URL = 'http://localhost:8080';
for (const name of ['mqtt-client.crt', 'mqtt-client.key']) await fs.symlink(path.join(source, 'admin', name), path.join(directory, name));
for (const name of ['ca.crt', 'server.crt']) await fs.copyFile(path.join(source, 'broker', name), path.join(directory, 'broker', name));
await fs.copyFile(path.join(source, 'admin/ca/ca.crt'), path.join(directory, 'ca/ca.crt'));
await fs.writeFile(path.join(directory, 'broker/revision'), 'demo-applied');
await fs.writeFile(path.join(directory, 'broker/applied-revision'), 'demo-applied');
const { env } = await import('../src/config.js');
const { loadDb, saveDb, sqlite, exclusive } = await import('../src/db.js');
const { registerAdminRoutes } = await import('../src/routes/admin-routes.js');
const { startMqtt, stopMqtt, publishMessage, mqttConnectionStatus } = await import('../src/services/mqtt-service.js');
const { defaultPresentation } = await import('../shared/presentation-preferences.js');
const { themePresets } = await import('../shared/theme-presets.js');
const password = crypto.randomBytes(24).toString('base64url');
const presentation = defaultPresentation();
presentation.preset = 'catppuccin';
presentation.themes = structuredClone(themePresets.find(preset => preset.id === 'catppuccin').themes);
const db = loadDb(), now = Date.now();
db.users.push({ id: crypto.randomBytes(16).toString('base64url'), username: 'DemoAdmin', passwordHash: await argon2.hash(password), credentials: [], timeZone: 'UTC', presentation });
for (const [id, name, label, color, days, enabled] of [
 ['weather-station', 'Weather station', 'Outdoor', 'blue', 180, true],
 ['energy-meter', 'Energy meter', 'Utility', 'teal', 90, true],
 ['greenhouse', 'Greenhouse sensor', 'Garden', 'green', 14, true],
 ['workbench', 'Workbench monitor', 'Lab', 'purple', -2, false],
]) {
 db.devices.push({ id, name, description: 'Screenshot demonstration device', labels: [{ name: label, color }], enabled, trusted: enabled, status: 'active', createdAt: new Date(now-86400000*15).toISOString() });
 db.certificates.push({ id: crypto.randomUUID(), deviceId: id, provisioningMethod: 'gateway-generated', issuer: 'local', issuerName: 'CN=MQTT Trust Gateway CA', subject: `CN=${id}`, serial: crypto.randomBytes(16).toString('hex'), fingerprint: crypto.randomBytes(32).toString('hex'), algorithm: 'ECDSA-prime256v1', status: 'active', brokerTrusted: true, issuedAt: new Date(now-86400000*15).toISOString(), validFrom: new Date(now-86400000*15).toISOString(), validTo: new Date(now+86400000*days).toISOString() });
}
saveDb(db);
const app = express(); app.use(express.json());
app.use('/api', (req,res,next) => {
 res.set('Cache-Control','no-store');
 if (req.path.endsWith('/events')) return next();
 exclusive(() => new Promise(resolve => {res.once('finish',resolve);res.once('close',resolve);next();})).catch(next);
});
registerAdminRoutes(app);
app.use(express.static(path.join(root,'admin-web/dist')));
app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:error.message}));
const server = app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
const origin = `http://localhost:${server.address().port}`;env.origin=origin;env.allowedOrigins=[origin];
let browser;
try {
 startMqtt();
 for(let attempt=0;attempt<30&&!mqttConnectionStatus().connected;attempt++)await new Promise(resolve=>setTimeout(resolve,300));
 if(!mqttConnectionStatus().connected)throw new Error('Local broker must be running for the release captures');
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/bin/chromium',headless:true});
 const context=await browser.newContext({viewport:{width:1600,height:1100},deviceScaleFactor:1,colorScheme:'dark'});
 await context.addInitScript(()=>localStorage.setItem('theme','dark'));
 const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 const screenshot=async name=>{await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:path.join(output,name+'.png'),fullPage:true,animations:'disabled'});};
 await page.goto(origin);await page.getByRole('heading',{name:'Welcome back'}).waitFor();
 await screenshot('login');
 await page.getByLabel('Username',{exact:true}).fill('DemoAdmin');
 await page.getByLabel('Password',{exact:true}).fill(password);
 await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await page.getByRole('heading',{name:'Your trust boundary'}).waitFor();
 for(const qos of [0,1,2])await publishMessage({topic:'devices/release-preview/example',payload:JSON.stringify({example:true,qos}),qos,retain:false});
 await page.getByRole('button',{name:'Refresh status',exact:true}).click();
 await page.getByText('Messages received',{exact:true}).waitFor();await screenshot('overview');
 await page.getByRole('link',{name:'Devices & certificates',exact:true}).click();
 await page.getByText('Weather station',{exact:true}).waitFor();await screenshot('devices-certificates');
 await page.getByRole('link',{name:'MQTT Manager',exact:true}).click();
 await page.getByRole('heading',{name:/Live messages/i}).waitFor();
 await page.locator('.sensitive-value__mask').first().waitFor();await screenshot('mqtt-manager');
 await page.getByRole('link',{name:'Settings',exact:true}).click();
 await page.getByText('Theme colors',{exact:true}).waitFor();await screenshot('settings-general');
 await page.getByRole('tab',{name:'Account security',exact:true}).click();
 await page.getByText('Sensitive information visibility',{exact:true}).waitFor();await screenshot('settings-security');
 if(errors.length)throw new Error(errors.join('\n'));
 console.log('Captured six real Chromium screenshots using isolated demo data. Sensitive values remain masked.');
} finally {
 await browser?.close();await stopMqtt();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));sqlite.close();await fs.rm(directory,{recursive:true,force:true});
}
