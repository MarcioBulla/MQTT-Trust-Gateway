import fs from 'node:fs/promises';
import mqtt from 'mqtt';
import { env } from '../../config.js';
import { ensureTopicsLoaded, rememberTopic } from './topic-store.js';

let client = null;
let connecting = null;
let lastError = '';

async function mqttOptions() {
  return {
    clientId: `${env.adminMqttClientId}-${process.pid}`,
    cert: await fs.readFile(env.adminMqttCertFile),
    key: await fs.readFile(env.adminMqttKeyFile),
    servername: env.mqttDomain,
    reconnectPeriod: 5000,
    connectTimeout: 10000,
    rejectUnauthorized: true,
  };
}

export async function connectMqtt() {
  if (client?.connected) return client;
  if (connecting) return connecting;

  connecting = new Promise(async (resolve, reject) => {
    try {
      await ensureTopicsLoaded();
      const instance = mqtt.connect(`mqtts://${env.mqttDomain}:${env.mqttTlsPort}`, await mqttOptions());
      let settled = false;
      const fail = (error) => {
        lastError = error.message;
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        client = null;
        instance.end(true);
        reject(error);
      };
      const timeout = setTimeout(() => fail(new Error('MQTT connection timed out')), 12000);
      client = instance;
      instance.on('message', rememberTopic);
      instance.on('error', (error) => { lastError = error.message; });
      instance.once('error', fail);
      instance.on('close', () => {
        if (client === instance && !instance.connected) client = null;
      });
      instance.on('connect', () => {
        lastError = '';
        instance.subscribe('#', { qos: 0 }, (error) => {
          if (error) return fail(error);
          if (settled) return undefined;
          settled = true;
          clearTimeout(timeout);
          return resolve(instance);
        });
      });
    } catch (error) {
      lastError = error.message;
      reject(error);
    }
  }).finally(() => { connecting = null; });

  return connecting;
}

export async function publishMqttMessage({ topic, payload, qos = 0, retain = false }) {
  const instance = await connectMqtt();
  await new Promise((resolve, reject) => {
    instance.publish(topic, payload, { qos, retain }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function setMqttLastError(error) {
  lastError = error.message || String(error);
}

export function mqttClientStatus() {
  return {
    connected: Boolean(client?.connected),
    lastError,
    adminClientId: env.adminMqttClientId,
  };
}
