<script setup>
import { computed } from 'vue';
import { displayTimeZone } from '../date-time';
import { timestampParts } from '../../shared/time-zone.js';
const props = defineProps({ value: { type: [String, Number], default: null } });
const parts = computed(() => timestampParts(props.value, displayTimeZone.value));
</script>
<template>
  <time
    v-if="parts"
    :datetime="parts.iso"
    :title="`${displayTimeZone}\nUTC: ${parts.iso}`"
    class="date-time"
  >
    <span>{{ parts.date }}</span>
    <span class="text-caption text-medium-emphasis">{{ parts.time }} {{ parts.zone }}</span>
  </time>
  <span v-else class="text-medium-emphasis">—</span>
</template>
<style scoped>
.date-time {
  display: inline-flex;
  flex-direction: column;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
  line-height: 1.5;
  padding-block: 4px;
}
</style>
