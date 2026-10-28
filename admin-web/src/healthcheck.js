// Local liveness probe only: never sends credentials or contacts external hosts.
import http from 'node:http';
import https from 'node:https';
const tls = Boolean(process.env.ADMIN_TLS_CERT && process.env.ADMIN_TLS_KEY);
const request = (tls ? https : http).get(
  {
    host: '127.0.0.1',
    port: process.env.ADMIN_APP_PORT || 8080,
    path: '/healthz',
    timeout: 3000,
    rejectUnauthorized: false,
  },
  (response) => {
    response.resume();
    process.exitCode = response.statusCode === 200 ? 0 : 1;
  },
);
request.on('error', () => {
  process.exitCode = 1;
});
request.on('timeout', () => {
  request.destroy();
  process.exitCode = 1;
});
