import { configuredRenewalTopics } from './renewal-protocol.js';
import { topicRulesForDevice } from './topic-rules.js';

function matches(filter, topic) {
  const levels = topic.split('/');
  const filterLevels = filter.split('/');
  for (let i = 0; i < filterLevels.length; i++) {
    if (filterLevels[i] === '#') return true;
    if (i >= levels.length || (filterLevels[i] !== '+' && filterLevels[i] !== levels[i])) return false;
  }
  return levels.length === filterLevels.length;
}

// Mosquitto's file ACL deny overrides both read and write. Reserve the
// namespace for everyone else, and require compatible rules for its owner.
export function renewalAclForDevice(device, ownerIds, healthTopics = []) {
  const rules = topicRulesForDevice(device);
  const denies = [];
  const grants = [];
  for (const owner of ownerIds) {
    const ownerId = typeof owner === 'string' ? owner : owner.id;
    const topics = configuredRenewalTopics(ownerId, owner.renewal?.mqttTopics);
    if (device.id !== ownerId) {
      denies.push(...Object.values(topics).map((topic) => `topic deny ${topic}`));
      continue;
    }
    const incoming = [topics.request, topics.install, topics.confirm];
    const outgoing = [topics.csr, topics.status];
    if (rules.mode !== 'custom' ||
        rules.publish.some((filter) => incoming.some((topic) => matches(filter, topic))) ||
        rules.subscribe.some((filter) => outgoing.some((topic) => matches(filter, topic))) ||
        healthTopics.some(({ topic }) => Object.values(topics).includes(topic))) {
      throw new Error('PKI renewal requires custom topic rules with no conflicting grants or health topics');
    }
    grants.push(...incoming.map((topic) => `topic read ${topic}`),
      ...outgoing.map((topic) => `topic write ${topic}`));
  }
  return [...denies, ...grants].map((line) => `${line}\n`).join('');
}
