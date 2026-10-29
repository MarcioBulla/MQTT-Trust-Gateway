<script setup>
import { computed } from 'vue';
import { isRevealed, requestReveal, hideSensitive } from '../sensitive';

const props = defineProps({
  scope: { type: String, required: true },
  value: { default: null },
  label: { type: String, default: 'Sensitive information' },
  showEye: { type: Boolean, default: false },
});
const visible = computed(() => isRevealed(props.scope));
function toggle() {
  if (visible.value) hideSensitive(props.scope);
  else requestReveal(props.scope);
}
</script>

<template>
  <span class="sensitive-value" :class="{ 'sensitive-value--hidden': !visible }">
    <span v-if="!visible" class="sensitive-value__mask" aria-label="Hidden sensitive information">••••••</span>
    <slot v-else>{{ value ?? '—' }}</slot>
    <v-btn v-if="showEye" :icon="visible ? 'mdi-eye-outline' : 'mdi-eye-off-outline'" size="x-small" variant="text"
      :aria-label="`${visible ? 'Hide' : 'Show'} ${label}`" :aria-pressed="visible" @click="toggle">
      <v-icon :icon="visible ? 'mdi-eye-outline' : 'mdi-eye-off-outline'" />
      <v-tooltip activator="parent" location="top">{{ visible ? 'Hide' : 'Show' }} {{ label }}</v-tooltip>
    </v-btn>
  </span>
</template>

<style scoped>
.sensitive-value { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; }
.sensitive-value__mask { letter-spacing: .16em; color: rgb(var(--v-theme-on-surface)); opacity: .55; user-select: none; white-space: nowrap; }
</style>
