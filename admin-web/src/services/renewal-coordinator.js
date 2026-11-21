import {
  decodeRenewalMessage, encodeRenewalMessage, newRenewalId, renewalLimits, configuredRenewalTopics,
} from './renewal-protocol.js';

const terminal = new Set(['confirmed', 'rejected', 'rolled_back']);

// The transport must subscribe with retain-as-published and enforce directional
// broker ACLs. The store must persist each operation before publication.
export function createRenewalCoordinator({ store, publish, issueClient, authorize, now = Date.now }) {
  let queue = Promise.resolve();
  function serialize(action) {
    const result = queue.then(action);
    queue = result.catch(() => {});
    return result;
  }

  function send(operation, kind, fields = {}) {
    return publish(
      configuredRenewalTopics(operation.deviceId, operation.topics)[kind],
      encodeRenewalMessage({ request_id: operation.id, ...fields }),
      { qos: 1, retain: false },
    );
  }

  function install(operation) {
    return send(operation, 'install', { type: operation.type, pem: operation.pem });
  }

  function expire(operation) {
    if (now() < operation.deadline) return false;
    store.save({ ...operation, status: 'rolled_back', error: 'deadline_exceeded', finishedAt: now() });
    return true;
  }

  return {
    resume() {
      return serialize(async () => {
        for (const operation of store.listPending()) {
          if (expire(operation)) continue;
          if (!(await authorize(operation.deviceId, operation))) {
            store.save({ ...operation, status: 'rejected', error: 'authorization_removed', finishedAt: now() });
            continue;
          }
          try {
            if (operation.status === 'testing') await send(operation, 'confirm');
            else if (operation.type === 'ca') {
              await send(operation, 'request');
              await install(operation);
            } else if (operation.pem) await install(operation);
            else await send(operation, 'request');
          } catch {
            store.save({ ...operation, error: 'publish_failed' });
          }
        }
      });
    },

    expirePending() {
      return serialize(() => {
        for (const operation of store.listPending()) expire(operation);
      });
    },

    begin(deviceId, { type, pem, targetId, topics } = {}) {
      return serialize(async () => {
        if (!['client', 'ca'].includes(type)) throw new Error('Invalid renewal type');
        topics = configuredRenewalTopics(deviceId, topics);
        if (!(await authorize(deviceId, { type, targetId }))) throw new Error('Renewal not authorized');
        const pending = store.pendingForDevice(deviceId);
        if (pending && !expire(pending)) throw new Error('Renewal already pending');
        const id = newRenewalId();
        if (type === 'ca') {
          if (!pem) throw new Error('CA certificate required');
          encodeRenewalMessage({ request_id: id, type, pem });
        }
        const operation = {
          id, deviceId, type, targetId, topics, pem: type === 'ca' ? pem : undefined,
          status: 'requested', createdAt: now(), deadline: now() + renewalLimits.installMs,
        };
        store.save(operation);
        await send(operation, 'request');
        if (type === 'ca') await install(operation);
        return id;
      });
    },

    receive(deviceId, kind, payload, packet) {
      return serialize(async () => {
        const message = decodeRenewalMessage(payload, packet, kind);
        if (!message) return;
        let operation = store.get(message.request_id);
        if (!operation || operation.deviceId !== deviceId || terminal.has(operation.status) ||
            expire(operation) || !(await authorize(deviceId, operation))) return;

        if (kind === 'csr') {
          if (operation.type !== 'client' || !['requested', 'staged'].includes(operation.status)) return;
          if (!operation.pem) {
            // issueClient must validate the CSR signature and exact CN and
            // return the same issuance for retries of this operation ID.
            const pem = await issueClient(operation, message.pem);
            encodeRenewalMessage({ request_id: operation.id, type: 'client', pem });
            operation = { ...operation, pem };
            if (expire(operation)) return;
            store.save(operation);
          }
          await install(operation);
          return;
        }

        const status = message.status;
        if (status === 'rejected' || status === 'rolled_back') {
          store.save({ ...operation, status, error: status, finishedAt: now() });
        } else if (status === 'staged' && operation.pem && operation.status === 'requested') {
          store.save({ ...operation, status });
        } else if (status === 'testing' && operation.pem) {
          if (operation.status !== 'testing') {
            operation = { ...operation, status, deadline: now() + renewalLimits.confirmMs };
            store.save(operation);
          }
          await send(operation, 'confirm');
        } else if (status === 'confirmed' && operation.status === 'testing') {
          store.save({ ...operation, status, error: undefined, finishedAt: now() });
        }
      });
    },
  };
}
