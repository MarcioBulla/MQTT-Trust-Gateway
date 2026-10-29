<script setup>
// Forward Vuetify props, events and slots so each list keeps its own filters,
// sorting and cell renderers while sharing layout and pagination defaults.
defineOptions({ inheritAttrs: false });
defineProps({ minWidth: { type: String, default: '1000px' } });
</script>

<template>
  <v-data-table
    class="gateway-data-list"
    :style="{ '--list-min-width': minWidth }"
    density="comfortable"
    hover
    show-current-page
    :items-per-page="10"
    :items-per-page-options="[10, 15, 25, 50, 100]"
    no-data-text="No records found."
    loading-text="Loading records…"
    v-bind="$attrs"
  >
    <template v-for="(_, name) in $slots" #[name]="slotProps">
      <slot :name="name" v-bind="slotProps || {}" />
    </template>
  </v-data-table>
</template>

<style scoped>
.gateway-data-list :deep(table) {
  table-layout: fixed;
  min-width: var(--list-min-width);
}
.gateway-data-list :deep(th),
.gateway-data-list :deep(td) {
  white-space: normal !important;
  overflow-wrap: anywhere;
  word-break: normal;
  vertical-align: top;
}
.gateway-data-list :deep(td:last-child > *) {
  max-width: 100%;
}
.gateway-data-list :deep(pre) {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.gateway-data-list :deep(.list-copy) {
  max-width: 100%;
  height: auto;
  min-height: 28px;
  white-space: normal;
  text-align: left;
  padding-inline: 0;
}
.gateway-data-list :deep(.list-copy .v-btn__content) {
  white-space: normal;
  overflow-wrap: anywhere;
}
.gateway-data-list :deep(.v-data-table-footer) {
  flex-wrap: wrap;
  gap: 8px;
}
</style>
