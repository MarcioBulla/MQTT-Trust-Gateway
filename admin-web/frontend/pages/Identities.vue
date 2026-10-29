<script setup>
import { ref } from 'vue';
import Devices from './Devices.vue';
import Certificates from './Certificates.vue';

const certificateManager = ref(null);
const deviceList = ref(null);
function openCertificate(method) { certificateManager.value?.open(method); }
function refreshDevices() { return deviceList.value?.reload(); }
</script>

<template>
  <Devices ref="deviceList" @add-certificate="openCertificate" />
  <v-divider class="my-8" />
  <Certificates ref="certificateManager" embedded @updated="refreshDevices" />
</template>
