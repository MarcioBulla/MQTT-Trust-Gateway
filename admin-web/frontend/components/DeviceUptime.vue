<script setup>
const props = defineProps({ health: { type: Object, default: null } });
const duration = (ms) => `${(ms / 3600000).toFixed(1)} h`;
function color(day) {
  if (!day.complete || day.unknown || !(day.online + day.offline)) return 'rgba(var(--v-theme-on-surface), 0.3)';
  if (!day.offline) return 'rgb(var(--v-theme-success))';
  if (!day.online) return 'rgb(var(--v-theme-error))';
  return 'rgb(var(--v-theme-warning))';
}
</script>
<template>
  <span v-if="!props.health || props.health.status === 'disabled'">—</span>
  <div v-else class="uptime d-flex align-center ga-2">
    <div class="uptime-bars"><v-tooltip v-for="day in props.health.days" :key="day.date" location="top">
      <template #activator="{ props: tooltip }"><span v-bind="tooltip" class="uptime-bar" :style="{ background: color(day) }" tabindex="0" :aria-label="`${day.date}: ${day.uptime === null ? 'unknown' : `${day.uptime.toFixed(1)}% uptime`}`" /></template>
      <span>{{ day.date }} UTC · {{ day.uptime === null ? 'Unknown' : `${day.uptime.toFixed(1)}%` }}<br>Online {{ duration(day.online) }} · Offline {{ duration(day.offline) }} · Unknown {{ duration(day.unknown) }}<br>{{ day.complete ? 'Complete day' : 'Incomplete coverage' }}</span>
    </v-tooltip></div>
    <v-tooltip v-if="props.health.uptime !== null" location="top"><template #activator="{ props: tooltip }"><span v-bind="tooltip" class="text-medium-emphasis text-caption">{{ props.health.uptime.toFixed(1) }}%</span></template><span>Uptime excludes unknown time. {{ props.health.unknown ? 'Coverage is incomplete.' : 'Coverage is complete.' }}</span></v-tooltip>
  </div>
</template>
<style scoped>
.uptime-bars { display: flex; gap: 2px; }
.uptime-bar { display: inline-block; width: 5px; height: 27px; border-radius: 2px; }
</style>
