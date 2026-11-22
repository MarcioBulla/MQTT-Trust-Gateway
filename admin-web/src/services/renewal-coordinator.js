import {
  decodeRenewalMessage, encodeRenewalMessage, newRenewalId, renewalLimits, configuredRenewalTopics,
} from './renewal-protocol.js';

const terminal = new Set(['confirmed', 'rejected', 'rolled_back']);

// The transport must subscribe with retain-as-published and enforce directional
// broker ACLs. The store must persist each operation before publication.
export function createRenewalCoordinator({ store, publish, issueClient, inspectClient, authorize, now = Date.now }) {
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
    const installationExpired = ['requested', 'staged'].includes(operation.status);
    store.save({
      ...operation,
      status: installationExpired ? 'rejected' : 'rolled_back',
      error: installationExpired ? 'request_timeout' : 'confirmation_timeout',
      finishedAt: now(),
    });
    return true;
  }

  async function issueAndInstall(operation, csr, expectedCn) {
    let pem;
    try {
      pem = await issueClient(operation, csr, expectedCn);
    } catch (error) {
      if (error.code !== 'csr_cn_mismatch') throw error;
      store.save({ ...operation, status: 'rejected', error: 'csr_cn_mismatch', finishedAt: now() });
      return;
    }
    encodeRenewalMessage({ request_id: operation.id, type: 'client', pem });
    const { pendingCsr, pendingCn, ...approved } = operation;
    const next = { ...approved, pem };
    if (expire(next)) return;
    store.save(next);
    await install(next);
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
            else if (operation.pendingCsr) continue;
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

    begin(deviceId, { type, pem, targetId, topics, cnPolicy, validityDays, scheduled } = {}) {
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
          id, deviceId, type, targetId, topics, cnPolicy, validityDays, scheduled, pem: type === 'ca' ? pem : undefined,
          status: 'requested', createdAt: now(), deadline: now() + renewalLimits.installMs,
        };
        store.save(operation);
        await send(operation, 'request');
        if (type === 'ca') await install(operation);
        return id;
      });
    },

    approve(deviceId, id, cn) {
      return serialize(async () => {
        const operation = store.get(id);
        if (!operation || operation.deviceId !== deviceId || operation.status !== 'requested' ||
            !operation.pendingCsr || operation.pendingCn !== cn || expire(operation) ||
            !(await authorize(deviceId, operation)))
          throw Object.assign(new Error('CSR approval is no longer available'), { status: 409 });
        await issueAndInstall(operation, operation.pendingCsr, cn);
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
            if (operation.cnPolicy?.mode === 'manual') {
              if (operation.pendingCsr) return;
              const cn = await inspectClient(message.pem);
              if (!expire(operation)) store.save({ ...operation, pendingCsr: message.pem, pendingCn: cn });
              return;
            }
            await issueAndInstall(operation, message.pem, operation.cnPolicy?.expectedCn ?? deviceId);
          } else await install(operation);
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
