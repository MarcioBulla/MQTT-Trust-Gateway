import { connectMqtt, mqttClientStatus, publishMqttMessage } from './mqtt/client.js';
import { monthlyCleanupStatus, startMonthlyMessageCleanup } from './mqtt/monthly-cleanup.js';
import {
  clearTopicMessages,
  listObservedTopics,
  observedTopicCount,
  removeObservedTopic,
  topicMessages,
} from './mqtt/topic-store.js';

export { startMonthlyMessageCleanup };

export function mqttConnectionStatus() {
  return {
    ...mqttClientStatus(),
    observedTopics: observedTopicCount(),
    ...monthlyCleanupStatus(),
  };
}

export async function listTopics() {
  await connectMqtt();
  return listObservedTopics();
}

export { clearTopicMessages, topicMessages };

export async function removeTopic(topicName) {
  return removeObservedTopic(topicName);
}

export async function publishMessage({ topic, payload, qos, retain }) {
  await publishMqttMessage({ topic, payload, qos, retain });
}
