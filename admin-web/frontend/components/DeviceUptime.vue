<script setup>
const props = defineProps({ health: { type: Object, default: null } });
const duration = (ms) => {
  const minutes = Math.round(ms / 60000);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};
const finalStatus = (day) => !(day.online + day.offline) ? 'Unknown' : `${day.endState[0].toUpperCase()}${day.endState.slice(1)}`;
function color(day) {
  if (!(day.online + day.offline)) return 'rgba(var(--v-theme-on-surface), 0.3)';
  if (day.endState === 'offline') return 'rgb(var(--v-theme-error))';
  if (day.offline) return 'rgb(var(--v-theme-warning))';
  if (day.endState === 'online') return 'rgb(var(--v-theme-success))';
  return 'rgb(var(--v-theme-warning))';
}
</script>
<template>
  <span v-if="!props.health || props.health.status === 'disabled'">—</span>
  <div v-else class="uptime d-flex align-center ga-2">
    <div class="uptime-bars"><v-tooltip v-for="day in props.health.days" :key="day.date" location="top">
      <template #activator="{ props: tooltip }"><span v-bind="tooltip" class="uptime-bar" :style="{ background: color(day) }" tabindex="0" :aria-label="`${day.date}: ${day.uptime === null ? 'unknown' : `${day.uptime.toFixed(1)}% uptime`}`" /></template>
      <span>{{ day.date }} UTC · Ended {{ finalStatus(day) }}<br>Online {{ duration(day.online) }} · Offline {{ duration(day.offline) }} · Unknown {{ duration(day.unknown) }}</span>
    </v-tooltip></div>
  </div>
</template>
<style scoped>
.uptime-bars { display: flex; gap: 2px; }
.uptime-bar { display: inline-block; width: 5px; height: 27px; border-radius: 2px; }
</style>
