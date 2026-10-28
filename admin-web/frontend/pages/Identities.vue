<script setup>
import { ref } from 'vue';
import Devices from './Devices.vue';
import Certificates from './Certificates.vue';

const certificateManager = ref(null);
function openCertificate(method) { certificateManager.value?.open(method); }
</script>

<template>
  <Devices @add-certificate="openCertificate" />
  <v-divider class="my-8" />
  <Certificates ref="certificateManager" embedded />
</template>
