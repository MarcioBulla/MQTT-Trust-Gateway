import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { after, before, test } from 'node:test';
import http from 'node:http';

const execFile = promisify(execFileCallback);
let server;
let port;
let status = 200;
let requestedPath;

before(async () => {
  server = http.createServer((req, res) => {
    requestedPath = req.url;
    res.writeHead(status, { 'content-type': 'application/json' }).end('{"status":"ready"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function runProbe() {
  try {
    await execFile(process.execPath, ['src/healthcheck.js'], {
      cwd: new URL('..', import.meta.url).pathname,
      env: { ...process.env, ADMIN_APP_PORT: String(port) },
    });
    return 0;
  } catch (error) {
    return error.code;
  }
}

test('Podman probe checks the local readiness endpoint', async () => {
  status = 200;
  assert.equal(await runProbe(), 0);
  assert.equal(requestedPath, '/ready');
});

test('Podman probe reports unavailable readiness as unhealthy', async () => {
  status = 503;
  assert.equal(await runProbe(), 1);
});
