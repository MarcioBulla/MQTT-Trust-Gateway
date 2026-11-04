import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { chromium } from '@playwright/test';

test('update review requires confirmation and password, displays history and reconnects without losing operation state', { skip: !existsSync('/bin/chromium'), timeout:30000 }, async () => {
  const root=path.resolve('frontend'), token=String(Date.now());
  const html=path.join(root,`__updates_${token}.html`), entry=path.join(root,`__updates_${token}.js`);
  await fs.writeFile(html,`<html><body><div id="app"></div><script type="module" src="/${path.basename(entry)}"></script></body></html>`);
  await fs.writeFile(entry,`import {createApp,h} from 'vue';import {createVuetify} from 'vuetify';import * as components from 'vuetify/components';import UpdateOperations from '/components/UpdateOperations.vue';import {state} from '/api.js';state.user={username:'demo',hasPassword:true,passkeys:[]};createApp({render:()=>h(UpdateOperations,{release:{version:'1.1.0',installable:true}})}).use(createVuetify({components})).mount('#app');`);
  const server=await createServer({configFile:false,root,plugins:[vue()],server:{host:'127.0.0.1',port:0,hmr:false}});
  let browser;
  const operation={id:'synthetic-operation',state:'COMPLETED',version:'1.0.2',previousVersion:'1.0.1',kind:'install',startedAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:05Z',snapshotAvailable:true,events:[{state:'HEALTH_CHECKING',at:'2026-01-01T00:00:04Z'}]};
  const progress={available:true,operation,history:[operation],canRollback:false};
  let submitted;
  try {
    await server.listen(); browser=await chromium.launch({executablePath:'/bin/chromium',headless:true,args:['--no-sandbox']});
    const page=await browser.newPage();
    await page.route('**/api/**',async route=>{
      const url=new URL(route.request().url());
      if(url.pathname.endsWith('/progress')) return route.fulfill({json:progress});
      if(url.pathname.endsWith('/install')) {submitted=route.request().postDataJSON();return route.fulfill({status:202,json:{accepted:true}});}
      return route.fulfill({json:{}});
    });
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/${path.basename(html)}`);
    await page.getByRole('button',{name:'Review update',exact:true}).click();
    assert.equal(await page.getByRole('button',{name:'Verify and continue',exact:true}).isDisabled(),true);
    await page.getByLabel('Confirmation',{exact:true}).fill('INSTALL 1.1.0');
    await page.getByLabel('Current password',{exact:true}).fill('synthetic-browser-proof');
    await page.getByRole('button',{name:'Verify and continue',exact:true}).click();
    await page.waitForFunction(()=>!document.querySelector('.v-dialog .v-card'));
    assert.equal(submitted.version,'1.1.0');assert.equal(submitted.reauth.method,'password');
    assert.equal(await page.locator('input[type=password]').count(),0);
    await page.getByRole('button',{name:'View operation details'}).click();
    await page.getByRole('heading',{name:'Operation details'}).waitFor();
    assert.match(await page.locator('.v-dialog').innerText(),/HEALTH CHECKING/);
    await page.getByRole('button',{name:'Close',exact:true}).click();
    progress.operation={...operation,state:'INSTALLING',version:'1.1.0'};
    await page.getByRole('button',{name:'Refresh progress'}).click();
    await page.getByRole('progressbar').waitFor();
    await page.reload();await page.getByRole('progressbar').waitFor();
  } finally {
    if(browser) await browser.close();await server.close();await fs.rm(html,{force:true});await fs.rm(entry,{force:true});
  }
});
