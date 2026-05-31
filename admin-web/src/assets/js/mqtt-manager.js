import { post, requestJson } from './api.js';
import { setNotice } from './notice.js';

let cachedTopics = [];
let selectedTopic = '';

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
  cachedTopics = data.topics;
  renderTopics();
}

function filteredTopics() {
  const search = document.getElementById('topicSearch').value.trim().toLowerCase();
  const sort = document.getElementById('topicSort').value;
  const filtered = cachedTopics.filter((topic) => {
    if (!search) return true;
    return topic.name.toLowerCase().includes(search) || String(topic.lastPayload || '').toLowerCase().includes(search);
  });

  return filtered.sort((a, b) => {
    if (sort === 'updatedAsc') return a.updatedAt.localeCompare(b.updatedAt);
    if (sort === 'nameAsc') return a.name.localeCompare(b.name);
    if (sort === 'nameDesc') return b.name.localeCompare(a.name);
    if (sort === 'messagesDesc') return b.messages - a.messages;
    if (sort === 'messagesAsc') return a.messages - b.messages;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

function renderTopics() {
  const list = document.getElementById('topicList');
  const topics = filteredTopics();
  if (!topics.length) {
    list.innerHTML = '<p class="muted">No topics observed yet.</p>';
    return;
  }
  list.innerHTML = topics.map((topic) => (
    '<div class="topic-row' + (topic.name === selectedTopic ? ' selected' : '') + '">' +
      '<div><div class="topic-name">' + escapeHtml(topic.name) + '</div>' +
      '<div class="topic-meta">' + escapeHtml(topic.messages + ' messages | ' + topic.updatedAt + ' | ' + topic.lastPayload) + '</div></div>' +
      '<div class="topic-actions">' +
        '<button class="secondary" type="button" data-view-topic="' + escapeHtml(topic.name) + '"><span class="nf">&#xf06e;</span> View</button>' +
        '<button class="secondary" type="button" data-topic="' + escapeHtml(topic.name) + '"><span class="nf">&#xf1d8;</span> Use</button>' +
      '</div>' +
    '</div>'
  )).join('');
  document.querySelectorAll('[data-topic]').forEach((button) => {
    button.addEventListener('click', () => { document.getElementById('publishTopic').value = button.dataset.topic; });
  });
  document.querySelectorAll('[data-view-topic]').forEach((button) => {
    button.addEventListener('click', () => loadTopicMessages(button.dataset.viewTopic));
  });
}

export async function loadTopicMessages(topic) {
  selectedTopic = topic;
  renderTopics();
  const data = await requestJson('/api/mqtt/messages?topic=' + encodeURIComponent(topic));
  const target = document.getElementById('topicMessages');
  if (!data.messages.length) {
    target.innerHTML = '<section class="panel nested"><h3>' + escapeHtml(topic) + '</h3><p class="muted">No message history yet.</p></section>';
    return;
  }
  target.innerHTML = '<section class="panel nested"><h3>' + escapeHtml(topic) + '</h3>' + data.messages.map((message) => (
    '<div class="message-row">' +
      '<div class="topic-meta">' + escapeHtml(message.receivedAt + ' | ' + message.payloadBytes + ' bytes') + '</div>' +
      '<pre>' + escapeHtml(message.payload) + '</pre>' +
    '</div>'
  )).join('') + '</section>';
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
  const topic = document.getElementById('publishTopic').value;
  if (topic) await loadTopicMessages(topic);
}

export function bindTopicTools() {
  document.getElementById('topicSearch').addEventListener('input', renderTopics);
  document.getElementById('topicSort').addEventListener('change', renderTopics);
}
