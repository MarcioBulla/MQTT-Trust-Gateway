import { post, requestJson } from './api.js';
import { setNotice } from './notice.js';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

export async function loadStatus() {
  const data = await requestJson('/api/status');
  document.getElementById('status').textContent = JSON.stringify(data, null, 2);
}

export async function loadTopics() {
  const data = await requestJson('/api/mqtt/topics');
  const list = document.getElementById('topicList');
  if (!data.topics.length) {
    list.innerHTML = '<p class="muted">No topics observed yet.</p>';
    return;
  }
  list.innerHTML = data.topics.map((topic) => (
    '<div class="topic-row">' +
      '<div><div class="topic-name">' + escapeHtml(topic.name) + '</div>' +
      '<div class="topic-meta">' + escapeHtml(topic.messages + ' messages | ' + topic.updatedAt + ' | ' + topic.lastPayload) + '</div></div>' +
      '<button class="secondary" type="button" data-topic="' + escapeHtml(topic.name) + '">Use</button>' +
    '</div>'
  )).join('');
  document.querySelectorAll('[data-topic]').forEach((button) => {
    button.addEventListener('click', () => { document.getElementById('publishTopic').value = button.dataset.topic; });
  });
}

export async function publishMessage() {
  await post('/api/mqtt/publish', {
    topic: document.getElementById('publishTopic').value,
    payload: document.getElementById('publishPayload').value,
    qos: Number(document.getElementById('publishQos').value),
    retain: document.getElementById('publishRetain').checked,
  });
  setNotice('MQTT message published.', 'ok');
  await loadTopics();
}
