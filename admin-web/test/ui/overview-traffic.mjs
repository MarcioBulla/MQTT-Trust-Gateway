// Isolated browser fixture: no real accounts, keys or device provisioning. Build frontend before running.
import express from 'express';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { defaultPresentation } from '../../shared/presentation-preferences.js';
let savedPresentation = defaultPresentation();
const app=express();app.use(express.json());let verified=false,generations=0;
const traffic={intervalSeconds:3600,available:true,counters:{received:123,sent:240,dropped:1},series:[{timestamp:Date.now()-60000,received:2,sent:4,dropped:0,publicationFailures:0},{timestamp:Date.now(),received:4,sent:7,dropped:1,publicationFailures:0}]};
app.use('/api',(req,res)=>{
 if(req.path==='/me/preferences'){savedPresentation=req.body.presentation;return res.json({user:{id:'preview',username:'preview',hasPassword:true,totpEnabled:true,passkeys:[],timeZone:'auto',presentation:savedPresentation}});}
 if(req.path==='/bootstrap')return res.json({hasAdmin:true,user:{id:'preview',username:'preview',hasPassword:true,totpEnabled:true,passkeys:[],timeZone:'auto',presentation:savedPresentation}});
 if(req.path==='/broker/status')return res.json({pendingChanges:false});
 if(req.path==='/status')return res.json({registeredDevices:1,validCertificates:1,expiringCertificates:0,expiredCertificates:0,traffic,mqtt:{connected:true},ca:{validTo:'2027-01-01'},serverCertificate:{validTo:'2027-01-01'},enforcement:{applied:true},defaultDays:90});
 if(req.path==='/sensitive/reveal'){
  if(req.body.reauth?.password==='test-password'&&req.body.reauth?.totp==='123456'){verified=true;return res.json({expiresInMs:60000});}
  return res.status(403).json({error:'Additional authentication failed'});
 }
 if(req.path==='/sensitive/hide'){verified=false;return res.json({ok:true});}
 if(req.path==='/mqtt/history')return res.json({messages:[{id:'visible-metadata',timestamp:'2026-10-29T17:00:00Z',qos:2,retain:true,bytes:10}],retained:[],historyLimit:200});
 if(req.path==='/mqtt/events'){res.set({'Content-Type':'text/event-stream','Cache-Control':'no-store'});res.flushHeaders();return;}
 if(req.path==='/devices')return res.json({devices:req.query.status==='archived'?[]:[{id:'test-device',name:'Test device',labels:[],certificates:[],enabled:false,status:'active'}]});
 if(req.path==='/certificates')return res.json({certificates:[]});
 if(req.path==='/trusted-cas')return res.json({trustedCas:[]});
 if(req.path==='/certificates/generate'){
  if(!verified)return res.status(403).json({error:'Additional authentication required',stepUpRequired:true,scope:'devices'});
  generations++;return res.type('application/zip').send(Buffer.from('test-fixture-only'));
 }
 res.json({ok:true});
});app.use(express.static(new URL('../../dist', import.meta.url).pathname));
const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH || '/bin/chromium',headless:true});
try{
 const page=await browser.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/#/`);
 await page.getByText('Messages received',{exact:true}).waitFor();
 await page.getByRole('button',{name:'5. Connect using mTLS',exact:true}).click();
 await page.getByText('mosquitto_pub -h HOST -p PORT',{exact:false}).waitFor();
 await page.getByRole('button',{name:'8. Connect using WebSocket',exact:true}).click();
 await page.getByText('Use wss://HOST:PORT/mqtt',{exact:false}).waitFor();
 assert.equal(await page.locator('svg.traffic-chart').count(),2);
 assert.equal(await page.locator('.chart-y-tick').count(),10);
 assert.equal(await page.locator('.chart-y-tick path').first().getAttribute('d'), 'M58 112H588');
 assert.equal(await page.locator('.chart-y-tick path').nth(4).getAttribute('d'), 'M58 20H588');
 assert.equal(await page.locator('.chart-x-tick').count(),16);
 assert.equal(await page.getByText('msg/min',{exact:true}).count(),2);
 assert.equal(await page.locator('circle.chart-warning').count(),1);
 assert.equal(await page.locator('svg.traffic-chart polyline').count(),2);
 await page.goto(`http://127.0.0.1:${server.address().port}/#/devices`);
 await page.getByRole('button',{name:'Add certificate',exact:true}).click();
 await page.getByText('Generate complete certificate',{exact:true}).click();
 await page.getByRole('combobox',{name:'MQTT device identity'}).fill('test-device');
 await page.getByRole('combobox',{name:'MQTT device identity'}).press('Tab');
 await page.getByRole('button',{name:'Generate and download ZIP',exact:true}).click();
 const verification=page.getByRole('dialog').filter({has:page.getByRole('heading',{name:'Reveal sensitive information',exact:true})});
 await verification.waitFor();assert.equal(generations,0);
 await verification.getByRole('button',{name:'Cancel',exact:true}).click();
 assert.equal(generations,0);
 await page.getByRole('button',{name:'Generate and download ZIP',exact:true}).click();
 await verification.waitFor();
 await verification.getByLabel('Current password',{exact:true}).fill('test-password');
 await verification.getByLabel('Authenticator code',{exact:true}).fill('123456');
 const download=page.waitForEvent('download');
 await verification.getByRole('button',{name:'Verify and reveal',exact:true}).click();
 await download;assert.equal(generations,1);
 await page.goto(`http://127.0.0.1:${server.address().port}/#/settings`);
 await page.locator('.v-select').filter({hasText:'Visible history'}).click();
 await page.getByRole('option',{name:'Last 3 days',exact:true}).click();
 await page.locator('.v-select').filter({hasText:'Y-axis unit'}).click();
 await page.getByRole('option',{name:'Messages per hour (msg/hour)',exact:true}).click();
 await page.locator('.v-select').filter({hasText:'Color preset'}).click();
 await page.getByRole('option',{name:'Dracula — Alucard Classic / Dracula Classic',exact:true}).click();
 assert.equal(await page.locator('.v-application').evaluate(element=>getComputedStyle(element).getPropertyValue('--v-theme-background').replaceAll(' ','')),'255,251,235');
 await page.locator('.v-select').filter({hasText:'Color preset'}).click();
 await page.getByRole('option',{name:'Catppuccin — Latte / Mocha',exact:true}).click();
 await page.getByLabel('OLED / True Black',{exact:true}).check();
 await page.getByRole('button',{name:'Toggle theme',exact:true}).click();
 const darkBg = () => page.locator('.v-application').evaluate(element=>getComputedStyle(element).getPropertyValue('--v-theme-background').replaceAll(' ',''));
 assert.equal(await darkBg(),'0,0,0');
 await page.getByRole('button',{name:'Toggle theme',exact:true}).click();
 assert.equal(await darkBg(),'239,241,245');
 await page.getByRole('button',{name:'Dark mode',exact:true}).click();
 await page.getByLabel('Dark Accent',{exact:true}).fill('#663399');
 await page.getByRole('button',{name:'Save preferences',exact:true}).click();
 await page.getByText('Display preferences saved',{exact:true}).waitFor();
 assert.equal(savedPresentation.charts.days,3);
 assert.equal(savedPresentation.charts.unit,'hour');
 assert.equal(savedPresentation.oled,true);
 assert.equal(savedPresentation.preset,'custom');
 assert.equal(savedPresentation.themes.dark.primary.toUpperCase(),'#663399');
 await page.getByRole('button',{name:'Toggle theme',exact:true}).click();
 const primary=await page.locator('.v-application').evaluate(element=>getComputedStyle(element).getPropertyValue('--v-theme-primary').replaceAll(' ',''));
 assert.equal(primary,'102,51,153');
 await page.getByRole('link',{name:'Overview',exact:true}).click();
 await page.locator('svg.traffic-chart').first().waitFor();
 assert.equal(await page.locator('.chart-x-tick').count(),8);
 assert.equal(await page.getByText('msg/hour',{exact:true}).count(),2);
 await page.getByRole('link',{name:'MQTT Manager',exact:true}).click();
 await page.getByRole('heading',{name:/Live messages/i}).waitFor();
 await page.locator('.sensitive-value__mask').first().waitFor();
 const liveRow = page.locator('.gateway-data-list tbody tr').first();
 assert.ok((await liveRow.innerText()).includes('Yes'));
 assert.ok((await liveRow.innerText()).includes('2026'));
 assert.equal(await liveRow.locator('.sensitive-value__mask').count(),2);
 assert.deepEqual(errors,[]);
 console.log('Browser checks passed: two traffic charts, queue-drop marker, credential action opens verification, cancellation prevents issuance, successful verification resumes one ZIP generation.');
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
