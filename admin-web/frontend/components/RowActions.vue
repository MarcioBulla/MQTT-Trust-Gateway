<script setup>
defineProps({ label: { type: String, default: 'Row actions' }, disabled: Boolean });
</script>

<template>
  <v-menu location="bottom end">
    <template #activator="{ props }">
      <v-btn
        v-bind="props"
        icon="mdi-dots-vertical"
        variant="text"
        size="small"
        :aria-label="label"
        :disabled="disabled"
      />
    </template>
    <v-list density="compact"><slot /></v-list>
  </v-menu>
</template>
