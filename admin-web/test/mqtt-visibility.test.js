import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

test('live metadata stays visible, while topic and payload follow reveal authorization on every event', async () => {
 process.env.ADMIN_DATA_DIR = await fs.mkdtemp(path.join(os.tmpdir(), 'mqtt-visible-'));
 const { loadDb, saveDb, sqlite } = await import('../src/db.js');
 const { createSession, sessionKey } = await import('../src/auth.js');
 const { sensitiveGrants } = await import('../src/sensitive-grants.js');
 const { guardSensitiveApi } = await import('../src/sensitive-access.js');
 const { registerMqttRoutes } = await import('../src/routes/mqtt-routes.js');
 const { events } = await import('../src/services/mqtt-service.js');
 const db=loadDb(),user={id:'live-reader',username:'reader'};db.users.push(user);let cookie;
 createSession(db,user,{secure:false},{setHeader(_key,value){cookie=value.split(';')[0];}});saveDb(db);
 const app=express();app.use('/api',guardSensitiveApi);registerMqttRoutes(app);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const base=`http://127.0.0.1:${server.address().port}/api/mqtt`,controllers=[];
 const message={id:'message',timestamp:'2026-10-29T17:00:00Z',qos:2,retain:true,bytes:12,topic:'SECRET-TOPIC',text:'SECRET-PAYLOAD',base64:'SECRET-BASE64'};
 async function stream(session){const controller=new AbortController();controllers.push(controller);const response=await fetch(base+'/events',{headers:{Cookie:session},signal:controller.signal});assert.equal(response.status,200);return response.body.getReader();}
 async function read(reader){const pending=reader.read();events.emit('message',message);const item=await pending;return new TextDecoder().decode(item.value);}
 try {
  assert.equal((await fetch(base+'/history')).status,401);
  assert.equal((await fetch(base+'/history',{headers:{Cookie:cookie}})).status,200);
  const hidden=await stream(cookie),text=await read(hidden);
  assert.match(text,/2026-10-29T17:00:00Z/);assert.match(text,/"qos":2/);assert.match(text,/"retain":true/);assert.doesNotMatch(text,/SECRET/);
  const grant=sensitiveGrants.issue({userId:user.id,sessionId:sessionKey({headers:{cookie}}),scope:'mqtt'});
  const visible=await stream(cookie+`; sensitive_mqtt=${grant.token}`);
  assert.match(await read(visible),/SECRET-TOPIC/);
  sensitiveGrants.revoke(grant.token);
  assert.doesNotMatch(await read(visible),/SECRET/);
 } finally {for(const controller of controllers)controller.abort();server.closeAllConnections();await new Promise(r=>server.close(r));sqlite.close();}
});
