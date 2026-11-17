<script setup>
// Forward Vuetify props, events and slots so each list keeps its own filters,
// sorting and cell renderers while sharing layout and pagination defaults.
import { computed, onUnmounted, ref, watch } from 'vue';
import { api, state } from '../api';

defineOptions({ inheritAttrs: false });
const props = defineProps({
  headers: { type: Array, default: () => [] },
  minWidth: { type: String, default: '1000px' },
  tableId: { type: String, default: '' },
});

const storageKey = computed(() => props.tableId ? `mqtt-trust-gateway.table-columns.${props.tableId}` : '');
const selectedColumns = ref([]);
const columnOrder = ref([]);
const columnWidths = ref({});
let saveTimer;
const configurableHeaders = computed(() => props.headers.filter((header) => header.title && header.key && header.hideable !== false));
const fixedHeaders = computed(() => props.headers.filter((header) => !header.title || !header.key || header.hideable === false));
const defaultColumnKeys = computed(() => configurableHeaders.value
  .filter((header) => header.defaultVisible !== false)
  .map((header) => header.key));
function loadColumns() {
  const defaultKeys = defaultColumnKeys.value, defaultOrder = configurableHeaders.value.map((header) => header.key);
  const stored = state.user?.presentation?.tableColumns?.[props.tableId];
  if (stored?.visible && stored?.order) {
    selectedColumns.value = defaultOrder.filter((key) => stored.visible.includes(key));
    columnOrder.value = [...defaultOrder.filter((key) => stored.order.includes(key)), ...defaultOrder.filter((key) => !stored.order.includes(key))];
    columnWidths.value = Object.fromEntries(Object.entries(stored.widths || {}).filter(([key, width]) => defaultOrder.includes(key) && Number.isInteger(width) && width >= 100 && width <= 900));
    return;
  }
  if (!storageKey.value || !globalThis.localStorage) { selectedColumns.value = defaultKeys; columnOrder.value = defaultOrder; columnWidths.value = {}; return; }
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey.value) || '[]');
    selectedColumns.value = Array.isArray(saved) ? defaultKeys.filter((key) => saved.includes(key)) : defaultOrder.filter((key) => saved?.visible?.includes(key));
    columnOrder.value = Array.isArray(saved) ? defaultOrder : [...defaultOrder.filter((key) => saved?.order?.includes(key)), ...defaultOrder.filter((key) => !saved?.order?.includes(key))];
    columnWidths.value = Array.isArray(saved) ? {} : Object.fromEntries(Object.entries(saved?.widths || {}).filter(([key, width]) => defaultOrder.includes(key) && Number.isInteger(width) && width >= 100 && width <= 900));
  } catch { selectedColumns.value = defaultKeys; }
  if (!columnOrder.value.length) columnOrder.value = defaultOrder;
  if (!selectedColumns.value.length && defaultKeys.length) selectedColumns.value = defaultKeys;
}
function preferences() { return { visible: selectedColumns.value, order: columnOrder.value, widths: columnWidths.value }; }
function saveColumns() {
  if (!storageKey.value || !globalThis.localStorage) return;
  localStorage.setItem(storageKey.value, JSON.stringify(preferences()));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (!state.user || !props.tableId) return;
    const presentation = JSON.parse(JSON.stringify(state.user.presentation || {}));
    presentation.tableColumns ||= {};
    presentation.tableColumns[props.tableId] = preferences();
    try {
      const result = await api('/me/preferences', 'PATCH', { timeZone: state.user.timeZone || 'auto', presentation });
      if (result?.user) state.user = result.user;
    } catch {}
  }, 350);
}
function toggleColumn(key) {
  if (selectedColumns.value.includes(key)) {
    if (selectedColumns.value.length === 1) return;
    selectedColumns.value = selectedColumns.value.filter((item) => item !== key);
  } else selectedColumns.value = [...selectedColumns.value, key];
  saveColumns();
}
function resetColumns() {
  selectedColumns.value = defaultColumnKeys.value;
  columnOrder.value = configurableHeaders.value.map((header) => header.key);
  columnWidths.value = {};
  saveColumns();
}
const visibleHeaders = computed(() => props.headers.filter((header) => fixedHeaders.value.includes(header) || selectedColumns.value.includes(header.key)));
watch(() => [storageKey.value, props.headers], loadColumns, { immediate: true, deep: true });
onUnmounted(() => { clearTimeout(saveTimer); });
</script>

<template>
  <div class="gateway-data-list-wrapper">
    <div v-if="tableId && configurableHeaders.length" class="d-flex justify-end px-2 pt-2">
      <v-menu location="bottom end" :close-on-content-click="false">
        <template #activator="{ props: menuProps }">
          <v-tooltip text="Choose visible columns" location="top">
            <template #activator="{ props: tooltipProps }">
              <v-btn v-bind="{ ...menuProps, ...tooltipProps }" icon="mdi-view-column-outline" variant="text" size="small" aria-label="Choose visible columns" />
            </template>
          </v-tooltip>
        </template>
        <v-card min-width="260" class="pa-2">
          <div class="d-flex align-center justify-space-between px-2 py-1"><span class="text-subtitle-2">Visible columns</span><v-btn size="x-small" variant="text" @click="resetColumns">Reset</v-btn></div>
          <v-list density="compact">
            <v-list-item v-for="header in configurableHeaders" :key="header.key" :title="header.title" :disabled="selectedColumns.length === 1 && selectedColumns.includes(header.key)" @click="toggleColumn(header.key)">
              <template #prepend><v-checkbox-btn :model-value="selectedColumns.includes(header.key)" :aria-label="`${selectedColumns.includes(header.key) ? 'Hide' : 'Show'} ${header.title} column`" /></template>
            </v-list-item>
          </v-list>
        </v-card>
      </v-menu>
    </div>
    <v-data-table
      class="gateway-data-list"
      :style="{ '--list-min-width': minWidth }"
      :headers="visibleHeaders"
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
  </div>
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
