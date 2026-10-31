import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('protected downloads request step-up, retry in place, and cancel without navigation', async () => {
  let clicks = 0, filename = '', requests = 0, proofs = 0;
  globalThis.document = {
    addEventListener() {},
    createElement() { return { set download(value) { filename = value; }, click() { clicks++; } }; },
  };
  const source = (await fs.readFile(new URL('../frontend/api.js', import.meta.url), 'utf8'))
    .replace("import { reactive } from 'vue';", 'const reactive = (value) => value;');
  const api = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.cache, 'no-store');
    requests++;
    return requests === 1 ? Response.json({ stepUpRequired: true, scope: 'devices' }, { status: 403 }) : new Response('public-chain');
  };
  api.registerStepUpHandler(async (scope) => { assert.equal(scope, 'devices'); proofs++; });
  await api.downloadApiFile('/certificates/test/chain', 'client-ca.crt');
  assert.equal(proofs, 1); assert.equal(requests, 2); assert.equal(clicks, 1); assert.equal(filename, 'client-ca.crt');
  requests = 0;
  api.registerStepUpHandler(async () => { throw new Error('Verification canceled'); });
  await assert.rejects(api.downloadApiFile('/certificates/test/chain', 'client-ca.crt'), /canceled/);
  assert.equal(requests, 1); assert.equal(clicks, 1);
});
