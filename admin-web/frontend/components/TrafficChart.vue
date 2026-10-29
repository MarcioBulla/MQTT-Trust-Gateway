<script setup>
import { chartMessageRate } from '../../shared/traffic-rate.js';
import { computed } from 'vue';
import { formatDateTime, displayTimeZone } from '../date-time';
const props = defineProps({ title: String, icon: String, color: { type: String, default: 'primary' }, metric: String, traffic: Object, failures: Boolean });
const samples = computed(() => props.traffic?.series || []);
const rate = value => chartMessageRate(value, props.traffic?.intervalSeconds || 3600, props.traffic?.displayUnit || 'minute');
const total = computed(() => props.traffic?.counters?.[props.metric]);
const tickStep = computed(() => {
  const target = Math.max(0.04, ...samples.value.map(sample => rate(sample[props.metric]) || 0)) / 4;
  const magnitude = 10 ** Math.floor(Math.log10(target));
  return [1, 2, 5, 10].map(value => value * magnitude).find(value => value >= target);
});
const max = computed(() => tickStep.value * 4);
const ticks = computed(() => Array.from({ length: 5 }, (_, index) => tickStep.value * index));
const tickLabel = value => new Intl.NumberFormat('en', { notation: value >= 10000 ? 'compact' : 'standard', maximumFractionDigits: value > 0 && value < 0.1 ? 3 : 2 }).format(value);
const rangeEnd = computed(() => props.traffic?.windowEnd || samples.value.at(-1)?.timestamp || Date.now());
const rangeStart = computed(() => props.traffic?.windowStart || rangeEnd.value - 7 * 86400000);
const x = timestamp => 62 + Math.max(0, Math.min(1, (timestamp - rangeStart.value) / Math.max(1, rangeEnd.value - rangeStart.value))) * 526;
const xTicks = computed(() => Array.from({ length: (props.traffic?.retentionDays || 7) + 1 }, (_, index) => ({ timestamp: rangeStart.value + index * (rangeEnd.value - rangeStart.value) / (props.traffic?.retentionDays || 7), index })));
const dayLabel = timestamp => new Intl.DateTimeFormat('en-GB', { timeZone: displayTimeZone.value, day: '2-digit', month: 'short' }).format(timestamp);
const unit = computed(() => props.traffic?.displayUnit === 'hour' ? 'msg/hour' : 'msg/min');
const yPosition = value => 112 - value * 92 / max.value;
const y = value => yPosition(rate(value) || 0);
const segments = computed(() => {
  const result = []; let points = [];
  for (const sample of samples.value) {
    if (sample[props.metric] == null) { if (points.length) result.push(points.join(' ')); points = []; }
    else points.push(`${x(sample.timestamp)},${y(sample[props.metric])}`);
  }
  if (points.length) result.push(points.join(' '));
  return result;
});
const observed = computed(() => samples.value.filter(sample => sample[props.metric] != null));
const warnings = computed(() => samples.value.flatMap((sample, index) => props.failures && (sample.dropped || sample.publicationFailures) ? [{ ...sample, x: x(sample.timestamp), y: y(sample[props.metric] || 0) }] : []));
const stale = computed(() => !props.traffic?.available);
</script>
<template>
  <v-card class="pa-5 h-100">
    <div class="d-flex align-center justify-space-between ga-3">
      <div class="d-flex align-center ga-3"><v-avatar :color="color" variant="tonal" rounded="lg"><v-icon :icon="icon" /></v-avatar><div><div class="text-body-2 text-medium-emphasis">{{ title }}</div><div class="text-h5 font-weight-bold">{{ total == null ? '—' : total.toLocaleString() }}</div></div></div>
      <v-chip v-if="stale" size="x-small" variant="tonal">{{ total == null ? 'Waiting for broker' : 'Telemetry delayed' }}</v-chip>
      <v-chip v-else size="x-small" color="success" variant="tonal">Live</v-chip>
    </div>
    <svg viewBox="0 0 600 130" class="traffic-chart mt-4" role="img" :aria-label="`${title}, ${unit}`" :style="{ color: `rgb(var(--v-theme-${color}))` }">
      <title>{{ title }} — {{ unit }}</title>
      <text x="52" y="10" text-anchor="end" class="chart-label">{{ unit }}</text>
      <g v-for="tick in ticks" :key="tick" class="chart-y-tick">
        <path :d="`M58 ${yPosition(tick)}H588`" class="chart-grid" />
        <text x="52" :y="yPosition(tick) + 3" text-anchor="end" class="chart-label"><title>{{ tick.toLocaleString() }} {{ unit }}</title>{{ tickLabel(tick) }}</text>
      </g>
      <polyline v-for="(points, index) in segments" :key="index" :points="points" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />
      <circle v-if="observed.length === 1" :cx="x(observed[0].timestamp)" :cy="y(observed[0][metric])" r="3" fill="currentColor" />
      <circle v-for="point in warnings" :key="point.timestamp" :cx="point.x" :cy="point.y" r="5" class="chart-warning"><title>{{ formatDateTime(point.timestamp) }} · Broker drops: {{ point.dropped }} · Admin publication failures: {{ point.publicationFailures }}</title></circle>
      <g v-for="tick in xTicks" :key="tick.index" class="chart-x-tick">
        <path :d="`M${x(tick.timestamp)} 112v4`" class="chart-grid" />
        <text :x="x(tick.timestamp)" y="128" :text-anchor="tick.index === 0 ? 'start' : tick.index === (traffic?.retentionDays || 7) ? 'end' : 'middle'" class="chart-label"><title>{{ formatDateTime(tick.timestamp) }}</title>{{ dayLabel(tick.timestamp) }}</text>
      </g>
    </svg>
    <div class="text-caption text-medium-emphasis mt-2">Broker total since restart · {{ unit === 'msg/min' ? 'hourly average in msg/min (count ÷ 60)' : 'hourly counts in msg/hour' }} · last {{ traffic?.retentionDays || 7 }} days · gaps mean no observations</div>
    <div v-if="failures" class="text-caption text-medium-emphasis mt-2"><span class="text-error">●</span> Broker queue drops or admin publication failures. Subscriber acknowledgement failures are not individually observable.</div>
  </v-card>
</template>
<style scoped>
.traffic-chart { display: block; width: 100%; height: 145px; overflow: visible; }
.chart-grid { stroke: rgb(var(--v-theme-on-surface)); opacity: .08; fill: none; }
.chart-label { fill: rgb(var(--v-theme-on-surface)); opacity: .55; font-size: 10px; }
.chart-warning { fill: rgb(var(--v-theme-error)); stroke: rgb(var(--v-theme-surface)); stroke-width: 2; }
</style>
