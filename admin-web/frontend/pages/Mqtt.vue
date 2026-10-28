<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { api, action, state } from '../api';
const messages = ref([]),
  retained = ref([]),
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
    .filter((m) => m.topic.includes(filter.value))
    .slice()
    .reverse(),
);
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
  const d = await api('/mqtt/history');
  messages.value = d.messages;
  retained.value = d.retained;
  limit.value = d.historyLimit;
}
onMounted(() =>
  action(async () => {
    await load();
    stream = new EventSource('/api/mqtt/events');
    stream.onmessage = (e) => {
      if (paused.value) return;
      const m = JSON.parse(e.data);
      messages.value.push(m);
      messages.value = messages.value.slice(-limit.value);
      if (m.retain) {
        retained.value = retained.value.filter((r) => r.topic !== m.topic);
        if (m.bytes) retained.value.push(m);
      }
    };
    stream.onerror = () => {
      state.error = 'Live stream interrupted; reconnecting. Sign in again if your session expired.';
    };
  }),
);
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
        <v-data-table :headers="headers" :items="filtered" :items-per-page="10" class="mt-3"
          ><template #item.payload="{ item }">
            <pre class="py-2"
              >{{ format(item) }}{{ item.truncated ? ' [truncated]' : '' }}</pre></template
          ><template #item.timestamp="{ item }"
            ><span class="text-caption">{{ item.timestamp }}</span></template
          ><template #item.retain="{ item }">{{
            item.retain ? 'Yes' : 'No'
          }}</template></v-data-table
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
          Default subscription: # at QoS 2. The buffer is bounded and cleared on admin restart.
          MQTT 5 preserves live retain flags, including retained deletion updates.
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
    ><div class="d-flex justify-space-between">
      <h2 class="text-h6">Observed retained messages</h2>
      <v-btn size="small" @click="action(load)">Refresh</v-btn>
    </div>
    <p class="text-caption text-medium-emphasis my-3">
      Live MQTT 5 retained snapshot, refreshed on backend reconnect. Maximum 1,000 topics.
    </p>
    <v-list
      ><v-list-item v-for="m in retained" :key="m.topic" :title="m.topic" :subtitle="m.text"
        ><template #append
          ><v-btn size="small" color="error" variant="text" @click="clearTopic = m.topic"
            >Remove retained</v-btn
          ></template
        ></v-list-item
      ></v-list
    >
    <p v-if="!retained.length">No retained messages observed.</p></v-card
  >
  <v-dialog :model-value="!!clearTopic" max-width="550" @update:model-value="clearTopic = null"
    ><v-card class="pa-6"
      ><h2 class="text-h5 mb-3">Remove retained message</h2>
      <p class="mb-4">Type the exact topic to confirm: {{ clearTopic }}</p>
      <v-text-field v-model="confirmation" label="Confirm topic" />
      <div class="d-flex justify-end ga-2">
        <v-btn @click="clearTopic = null">Cancel</v-btn
        ><v-btn color="error" :disabled="confirmation !== clearTopic" @click="removeRetained"
          >Remove</v-btn
        >
      </div></v-card
    ></v-dialog
  >
</template>
