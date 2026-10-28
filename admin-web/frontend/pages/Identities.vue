<script setup>
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Devices from './Devices.vue';
import Certificates from './Certificates.vue';

const route = useRoute();
const router = useRouter();
const tab = computed({
  get: () => route.query.view === 'certificates' ? 'certificates' : 'devices',
  set: (view) => router.replace({ path: '/devices', query: view === 'certificates' ? { view } : {} }),
});
</script>

<template>
  <v-tabs v-model="tab" class="mb-6" aria-label="Device and certificate management">
    <v-tab value="devices">Devices</v-tab>
    <v-tab value="certificates">Certificates &amp; identities</v-tab>
  </v-tabs>
  <Devices v-if="tab === 'devices'" />
  <Certificates v-else />
</template>
