<script setup>
import SensitiveValue from '../components/SensitiveValue.vue';
import { revealScopes, isRevealed, sensitiveFetch } from '../sensitive';
import DateTime from '../components/DateTime.vue';
import { formatDateTime } from '../date-time';
import RowActions from '../components/RowActions.vue';
import DataList from '../components/DataList.vue';
import { ref, computed, watch, onUnmounted } from 'vue';
import { api, action, state, copy } from '../api';
const messages = ref([]),
  retained = ref([]),
  retainedSearch = ref(''),
  retainedDetails = ref(null),
  paused = ref(false),
  filter = ref(''),
  subscription = ref('#'),
  mode = ref('Text'),
  limit = ref(200),
  clearTopic = ref(null),
  confirmation = ref('');
let stream;
const pub = ref({ topic: '', payload: '', qos: 1, retain: false, encoding: 'text' });
const filtered = computed(() =>
  messages.value
    .filter((m) => (m.topic || '').includes(filter.value))
    .slice()
    .reverse(),
);
const retainedHeaders = [
  { title: 'Topic', key: 'topic', width: '280px' },
  { title: 'Payload', key: 'text', width: '340px' },
  { title: 'QoS', key: 'qos', width: '80px' },
  { title: 'Size', key: 'bytes', width: '90px' },
  { title: 'Received', key: 'timestamp', width: '200px' },
  { title: '', key: 'actions', sortable: false, width: '64px' },
];
function confirmRetainedRemoval(message) {
  confirmation.value = '';
  clearTopic.value = message.topic;
}
const headers = [
  { title: 'Received', key: 'timestamp' },
  { title: 'Topic', key: 'topic' },
  { title: 'Payload', key: 'payload' },
  { title: 'QoS', key: 'qos' },
  { title: 'Retain', key: 'retain' },
];
function format(m) {
  if (mode.value === 'Base64') return m.base64;
  if (mode.value === 'JSON') {
    try {
      return JSON.stringify(JSON.parse(m.text), null, 2);
    } catch {
      return m.text;
    }
  }
  return m.text;
}
async function load() {
  const grant = revealScopes.mqtt;
  const d = await api('/mqtt/history');
  if (revealScopes.mqtt !== grant) return;
  messages.value = d.messages;
  retained.value = d.retained;
  limit.value = d.historyLimit;
}
watch(() => revealScopes.mqtt, () => {
  stream?.close(); messages.value = []; retained.value = []; retainedDetails.value = null; clearTopic.value = null;
  action(async () => {
    await load();
      stream = new EventSource('/api/mqtt/events');
    stream.onmessage = (e) => {
      if (paused.value) return;
      const incoming = JSON.parse(e.data);
      const m = isRevealed('mqtt') ? incoming : { id: incoming.id, timestamp: incoming.timestamp, qos: incoming.qos, retain: incoming.retain, bytes: incoming.bytes };
      messages.value.push(m);
      messages.value = messages.value.slice(-limit.value);
      if (m.retain && isRevealed('mqtt')) {
        retained.value = retained.value.filter((r) => r.topic !== m.topic);
        if (m.bytes) retained.value.push(m);
      }
    };
    stream.onerror = () => {
      state.error = 'Live stream interrupted; reconnecting. Sign in again if your session expired.';
    };
  });
}, { immediate: true, flush: 'sync' });
onUnmounted(() => stream?.close());
function publish() {
  action(async () => {
    await api('/mqtt/publish', 'POST', pub.value);
    await load();
  }, 'Publication sent');
}
function removeRetained() {
  action(async () => {
    await api('/mqtt/retained', 'DELETE', { topic: clearTopic.value, confirm: confirmation.value });
    clearTopic.value = null;
    confirmation.value = '';
    await load();
  }, 'Retained message removed');
}
</script>
<template>
  <div class="text-overline text-primary">OBSERVE & PUBLISH</div>
  <h1 class="text-h4 font-weight-bold mb-2">MQTT Manager</h1>
  <p class="text-medium-emphasis mb-6">
    Authenticated backend bridge. Broker credentials stay on the server.
  </p>
  <v-row
    ><v-col cols="12" lg="8"
      ><v-card class="pa-5"
        ><div class="d-flex align-center ga-3 flex-wrap mb-4">
          <h2 class="text-h6 mr-auto">Live messages</h2>
          <v-chip size="small" :color="paused ? 'warning' : 'success'">{{
            paused ? 'Paused' : 'Live'
          }}</v-chip
          ><v-btn variant="tonal" @click="paused = !paused">{{ paused ? 'Resume' : 'Pause' }}</v-btn
          ><v-btn
            @click="
              action(async () => {
                await api('/mqtt/history', 'DELETE', {});
                messages = [];
              }, 'History cleared')
            "
            >Clear history</v-btn
          >
        </div>
        <div class="d-flex ga-3 flex-wrap">
          <v-text-field v-model="filter" label="Filter observed topic" hide-details /><v-select
            v-model="mode"
            :items="['Text', 'JSON', 'Base64']"
            label="Payload format"
            hide-details
            max-width="180"
          />
        </div>
        <DataList
          :headers="headers"
          :items="filtered"
          :items-per-page="10"
          class="mt-3"
          :loading="!!state.busy"
          min-width="850px"
          ><template #item.topic="{ item }"><SensitiveValue scope="mqtt" :value="item.topic" label="Message topic" /></template><template #item.payload="{ item }"><SensitiveValue scope="mqtt" label="Message payload">
            <pre class="py-2"
              >{{ format(item) }}{{ item.truncated ? ' [truncated]' : '' }}</pre></SensitiveValue></template
          ><template #item.timestamp="{ item }"
            ><DateTime :value="item.timestamp" /></template
          ><template #item.retain="{ item }">{{ item.retain ? 'Yes' : 'No' }}</template></DataList
        >
        <v-form
          class="d-flex ga-3 mt-4"
          @submit.prevent="
            action(
              () => api('/mqtt/subscribe', 'POST', { filter: subscription }),
              'Subscription active',
            )
          "
          ><v-text-field
            v-model="subscription"
            label="Subscription filter (+ and # supported)"
            required
            hide-details
          /><v-btn type="submit" color="primary">Subscribe</v-btn></v-form
        >
        <p class="text-caption text-medium-emphasis mt-3">
          Default subscription: # at QoS 2. The buffer is bounded and cleared on admin restart. MQTT
          5 preserves live retain flags, including retained deletion updates.
        </p>
      </v-card></v-col
    ><v-col cols="12" lg="4"
      ><v-card class="pa-5"
        ><h2 class="text-h6 mb-4">Publish a message</h2>
        <v-form @submit.prevent="publish"
          ><v-text-field v-model="pub.topic" label="Topic" required maxlength="256" /><v-textarea
            v-model="pub.payload"
            label="Payload"
            rows="5"
          /><v-select
            v-model="pub.encoding"
            :items="['text', 'base64']"
            label="Encoding"
          /><v-select v-model="pub.qos" :items="[0, 1, 2]" label="QoS" /><v-switch
            v-model="pub.retain"
            label="Retain message"
            color="primary"
            hide-details
          /><v-btn block color="primary" type="submit" :loading="!!state.busy" class="mt-3"
            >Publish</v-btn
          ></v-form
        ></v-card
      >
      <v-card class="pa-5 mt-4"
        ><h2 class="text-h6 mb-4">History retention</h2>
        <v-form
          @submit.prevent="
            action(
              () => api('/mqtt/settings', 'PATCH', { historyLimit: Number(limit) }),
              'History limit saved',
            )
          "
          ><v-text-field
            v-model="limit"
            type="number"
            label="Maximum messages"
            min="10"
            max="2000"
            required
          /><v-btn type="submit">Save limit</v-btn></v-form
        ></v-card
      >
    </v-col></v-row
  >
  <v-card class="pa-5 mt-5"
    ><div class="d-flex align-center justify-space-between ga-3 flex-wrap">
      <h2 class="text-h6">Observed retained messages</h2>
      <v-btn
        icon="mdi-refresh"
        size="small"
        variant="text"
        aria-label="Refresh retained messages"
        :loading="!!state.busy"
        @click="action(load)"
      />
    </div>
    <p class="text-caption text-medium-emphasis my-3">
      Live MQTT 5 retained snapshot, refreshed on backend reconnect. Maximum 1,000 topics.
    </p>
    <div class="d-flex align-center ga-3 flex-wrap mb-4">
      <v-text-field
        v-model="retainedSearch"
        label="Search retained topics or payloads"
        prepend-inner-icon="mdi-magnify"
        hide-details
        clearable
        max-width="440"
      />
      <v-chip size="small" variant="tonal">{{ retained.length }} topics</v-chip>
    </div>
    <DataList
      :headers="retainedHeaders"
      :items="retained"
      item-value="topic"
      :search="retainedSearch || ''"
      :loading="!!state.busy"
      no-data-text="No retained messages found."
      min-width="1050px"
      aria-label="Observed retained messages"
    >
      <template #item.topic="{ item }"
        ><v-tooltip text="Copy topic" location="top" :open-delay="650"
          ><template #activator="{ props }"
            ><v-btn
              v-bind="props"
              class="list-copy text-none"
              variant="text"
              density="compact"
              :aria-label="`Copy topic ${item.topic}`"
              @click="copy(item.topic)"
              >{{ item.topic }}</v-btn
            ></template
          ></v-tooltip
        ></template
      >
      <template #item.text="{ item }">
        <pre class="retained-payload py-2"
          >{{ format(item) }}{{ item.truncated ? ' [truncated]' : '' }}</pre>
      </template>
      <template #item.qos="{ item }"
        ><v-chip size="small" variant="tonal">{{ item.qos }}</v-chip></template
      >
      <template #item.bytes="{ item }">{{ item.bytes }} B</template>
      <template #item.timestamp="{ item }"
        ><DateTime :value="item.timestamp" /></template
      >
      <template #item.actions="{ item }"
        ><RowActions :label="`Actions for ${item.topic}`" :disabled="!!state.busy">
          <v-list-item
            title="Details"
            prepend-icon="mdi-information-outline"
            @click="retainedDetails = item"
          />
          <v-list-item
            title="Copy topic"
            prepend-icon="mdi-content-copy"
            @click="copy(item.topic)"
          />
          <v-list-item
            title="Remove retained"
            prepend-icon="mdi-delete-outline"
            class="text-error"
            @click="confirmRetainedRemoval(item)"
          /> </RowActions
      ></template>
    </DataList>
  </v-card>
  <v-dialog
    :model-value="!!retainedDetails"
    max-width="720"
    @update:model-value="retainedDetails = null"
    ><v-card v-if="retainedDetails" class="pa-6">
      <h2 class="text-h5 mb-4">Retained message details</h2>
      <div class="text-caption text-medium-emphasis">Topic</div>
      <p class="text-break mb-4">{{ retainedDetails.topic }}</p>
      <div class="d-flex flex-wrap ga-2 mb-4">
        <v-chip size="small">QoS {{ retainedDetails.qos }}</v-chip
        ><v-chip size="small">{{ retainedDetails.bytes }} B</v-chip>
      </div>
      <p class="text-caption text-medium-emphasis mb-4">Received {{ formatDateTime(retainedDetails.timestamp) }}</p>
      <pre class="retained-detail-payload"
        >{{ format(retainedDetails) }}{{ retainedDetails.truncated ? ' [truncated]' : '' }}</pre>
      <div class="d-flex justify-end mt-5">
        <v-btn @click="retainedDetails = null">Close</v-btn>
      </div>
    </v-card></v-dialog
  >
  <v-dialog :model-value="!!clearTopic" max-width="550" @update:model-value="clearTopic = null"
    ><v-card class="pa-6"
      ><h2 class="text-h5 mb-3">Remove retained message</h2>
      <p class="mb-4">
        Remove the stored message from this topic? Subscribers will no longer receive it as a
        retained message.
      </p>
      <div class="d-flex align-center flex-wrap ga-2 mb-3">
        <span>Type</span
        ><v-btn
          prepend-icon="mdi-content-copy"
          size="small"
          color="primary"
          variant="tonal"
          rounded="pill"
          class="confirmation-copy-button"
          :aria-label="`Copy ${clearTopic} to clipboard`"
          @click="copy(clearTopic)"
          >{{ clearTopic }}</v-btn
        ><span>to confirm.</span>
      </div>
      <v-text-field
        v-model="confirmation"
        label="Confirm topic"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
      />
      <div class="d-flex justify-end ga-2">
        <v-btn @click="clearTopic = null">Cancel</v-btn
        ><v-btn
          color="error"
          :loading="!!state.busy"
          :disabled="confirmation !== clearTopic"
          @click="removeRetained"
          >Remove</v-btn
        >
      </div></v-card
    ></v-dialog
  >
</template>

<style scoped>
.retained-payload {
  max-height: 120px;
  overflow-y: auto;
}
.retained-detail-payload {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 50vh;
  overflow-y: auto;
}
.confirmation-copy-button {
  max-width: 100%;
  height: auto !important;
  min-height: 32px;
  padding-block: 6px;
  white-space: normal;
}
.confirmation-copy-button :deep(.v-btn__content) {
  white-space: normal;
  overflow-wrap: anywhere;
  text-align: left;
}
</style>
