<script setup>
import { ref } from 'vue';

const props = defineProps({ modelValue: { type: String, default: '' }, accept: { type: String, default: '' }, label: { type: String, required: true } });
const emit = defineEmits(['update:modelValue']);
const input = ref(null), dragging = ref(false), fileName = ref('');
async function read(file) {
  if (!file) return;
  fileName.value = file.name;
  emit('update:modelValue', await file.text());
}
function changed(event) { read(event.target.files?.[0]); event.target.value = ''; }
function dropped(event) { dragging.value = false; read(event.dataTransfer?.files?.[0]); }
</script>

<template>
  <div class="d-flex flex-wrap align-center ga-3 mb-2">
    <v-btn variant="tonal" prepend-icon="mdi-file-upload-outline" @click="input?.click()">Choose file</v-btn>
    <div class="file-drop-zone flex-grow-1" :class="{ 'file-drop-zone--active': dragging }" role="button" tabindex="0"
      @click="input?.click()" @keydown.enter="input?.click()" @keydown.space.prevent="input?.click()"
      @dragenter.prevent="dragging = true" @dragover.prevent="dragging = true" @dragleave.prevent="dragging = false" @drop.prevent="dropped">
      <v-icon icon="mdi-tray-arrow-down" class="mr-2" />
      <span>{{ fileName || `Drop ${label} here, or choose a file` }}</span>
    </div>
    <input ref="input" type="file" :accept="accept" class="d-none" @change="changed" />
  </div>
</template>

<style scoped>
.file-drop-zone { min-height: 42px; display: flex; align-items: center; padding: 8px 14px; border: 1px dashed rgba(var(--v-theme-on-surface), .38); border-radius: 8px; color: rgba(var(--v-theme-on-surface), .72); cursor: pointer; transition: border-color .15s, background .15s; }
.file-drop-zone:hover, .file-drop-zone--active { border-color: rgb(var(--v-theme-primary)); background: rgba(var(--v-theme-primary), .08); }
</style>
