<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { useTheme } from 'vuetify';

const props = defineProps({
  source: { type: String, required: true },
  title: { type: String, required: true },
});

const theme = useTheme();
const svgMarkup = ref('');
const renderError = ref(false);
const enlarged = ref(false);
const enlargeTrigger = ref(null);
const scale = ref(1);
const naturalWidth = ref(1000);
const scrollHost = ref(null);
const enlargedScrollHost = ref(null);
const rendererId = `help-diagram-${crypto.randomUUID()}`;
let mermaid;
let unmounted = false;
let requestNumber = 0;
let drag = null;
let diagramRenderQueue = Promise.resolve();
let activeThemeKey = '';
const minScale = 0.5;
const maxScale = 2.5;
let manuallyZoomed = false;
let resizeObserver;

const scaledSvgStyle = computed(() => ({ width: `${Math.round(naturalWidth.value * scale.value)}px`, maxWidth: 'none', height: 'auto' }));
const zoomPercent = computed(() => `${Math.round(scale.value * 100)}%`);

function themeColors() {
  const palette = theme.global.current.value.colors;
  const primary = safeColor(palette.primary);
  const surface = safeColor(palette.surface, primary);
  const background = safeColor(palette.background, surface);
  const text = safeColor(palette['on-surface'], primary);
  const received = safeColor(palette['chart-received'], primary);
  const sent = safeColor(palette['chart-sent'], received);
  return {
    background, primaryColor: surface, primaryTextColor: text, primaryBorderColor: primary,
    lineColor: primary, textColor: text, mainBkg: surface, secondBkg: background,
    tertiaryColor: background, tertiaryTextColor: text, secondaryColor: received,
    secondaryBorderColor: sent, actorBkg: surface, actorBorder: primary,
    actorTextColor: text, actorLineColor: primary, signalColor: primary,
    signalTextColor: text, noteBkgColor: background, noteTextColor: text,
    noteBorderColor: primary, labelBoxBkgColor: surface, labelBoxBorderColor: primary,
    labelTextColor: text, loopTextColor: text, activationBorderColor: primary,
    activationBkgColor: surface, sequenceNumberColor: text,
  };
}

function safeColor(value, fallback = '#000000') {
  return typeof value === 'string' && /^#[\da-f]{3,8}$/i.test(value) ? value : fallback;
}

function cleanSvg(svg) {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const root = parsed.documentElement;
  if (parsed.querySelector('parsererror') || root.localName !== 'svg') throw new Error('Mermaid did not return a valid SVG.');
  for (const unsafe of root.querySelectorAll('script,foreignObject,iframe,object,embed,image,a')) unsafe.remove();
  for (const element of [root, ...root.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on')) element.removeAttribute(attribute.name);
      if ((name === 'href' || name.endsWith(':href')) && !attribute.value.startsWith('#')) element.removeAttribute(attribute.name);
    }
  }
  return new XMLSerializer().serializeToString(root);
}

function render() {
  const current = ++requestNumber;
  const source = props.source;
  const variables = themeColors();
  renderError.value = false;
  svgMarkup.value = '';
  scale.value = 1;
  diagramRenderQueue = diagramRenderQueue.catch(() => {}).then(async () => {
    if (unmounted || current !== requestNumber || !mermaid) return;
    if (!source.trim() || source.length > 8000) {
      throw new Error('This diagram is outside the allowed static Help formats.');
    }
    const themeKey = JSON.stringify(variables);
    if (activeThemeKey !== themeKey) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        htmlLabels: false,
        maxTextSize: 8000,
        flowchart: { htmlLabels: false, useMaxWidth: false, curve: 'basis' },
        sequence: { useMaxWidth: false, wrap: true, showSequenceNumbers: true, diagramMarginX: 24, diagramMarginY: 20 },
        themeVariables: { ...variables, fontSize: '16px' },
      });
      activeThemeKey = themeKey;
    }
    const { svg } = await mermaid.render(`${rendererId}-${current}`, source);
    if (unmounted || current !== requestNumber) return;
    svgMarkup.value = cleanSvg(svg);
    await nextTick();
    measureSvg();
    await nextTick();
    fitDiagram();
  }).catch(() => {
    if (current === requestNumber) renderError.value = true;
  });
  return diagramRenderQueue;
}

function measureSvg() {
  const svg = scrollHost.value?.querySelector('svg');
  const viewBoxWidth = Number(svg?.viewBox?.baseVal?.width || 0);
  const attributeWidth = Number.parseFloat(svg?.getAttribute('width') || '');
  naturalWidth.value = Math.max(1, Math.ceil(viewBoxWidth || attributeWidth || 1000));
}

function changeZoom(amount) {
  manuallyZoomed = true;
  scale.value = Math.min(maxScale, Math.max(minScale, Math.round((scale.value + amount) * 100) / 100));
}

function resetZoom() {
  manuallyZoomed = false;
  fitDiagram();
  for (const host of [scrollHost.value, enlargedScrollHost.value]) {
    if (host) { host.scrollLeft = 0; host.scrollTop = 0; }
  }
}

function fitDiagram() {
  const host = enlarged.value ? enlargedScrollHost.value : scrollHost.value;
  if (!host) return;
  manuallyZoomed = false;
  scale.value = Math.min(1, Math.max(0.05, (host.clientWidth - 40) / naturalWidth.value));
  host.scrollLeft = 0;
  host.scrollTop = 0;
}

function handleKeydown(event, host) {
  if (event.target !== host) return;
  if (event.key === '+' || event.key === '=') { event.preventDefault(); changeZoom(0.15); }
  else if (event.key === '-') { event.preventDefault(); changeZoom(-0.15); }
  else if (event.key === 'Home') { event.preventDefault(); resetZoom(); }
  else if (event.key.startsWith('Arrow')) {
    event.preventDefault();
    const step = event.shiftKey ? 140 : 60;
    if (event.key === 'ArrowLeft') host.scrollLeft -= step;
    if (event.key === 'ArrowRight') host.scrollLeft += step;
    if (event.key === 'ArrowUp') host.scrollTop -= step;
    if (event.key === 'ArrowDown') host.scrollTop += step;
  }
}

function beginPan(event, host) {
  if (event.pointerType === 'touch' || event.button !== 0 || !event.target.closest('svg')) return;
  drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: host.scrollLeft, top: host.scrollTop, host };
  host.classList.add('is-panning');
  host.setPointerCapture(event.pointerId);
}

function movePan(event) {
  if (!drag || drag.id !== event.pointerId) return;
  drag.host.scrollLeft = drag.left - (event.clientX - drag.x);
  drag.host.scrollTop = drag.top - (event.clientY - drag.y);
}

function endPan(event) {
  if (!drag || drag.id !== event.pointerId) return;
  drag.host.classList.remove('is-panning');
  drag = null;
}

function openEnlarged(event) {
  enlargeTrigger.value = event.currentTarget;
  manuallyZoomed = false;
  scale.value = 1;
  enlarged.value = true;
  nextTick(() => enlargedScrollHost.value?.focus());
}

function handleEnlargedEnter() {
  if (enlargedScrollHost.value) resizeObserver?.observe(enlargedScrollHost.value);
  fitDiagram();
}

function restoreFocus() {
  if (enlargedScrollHost.value) resizeObserver?.unobserve(enlargedScrollHost.value);
  enlargeTrigger.value?.focus?.();
  enlargeTrigger.value = null;
}

onMounted(async () => {
  try {
    const module = await import('mermaid');
    if (unmounted) return;
    mermaid = module.default;
    await render();
    if (scrollHost.value && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        if (!manuallyZoomed) requestAnimationFrame(() => { if (!unmounted && !manuallyZoomed) fitDiagram(); });
      });
      resizeObserver.observe(scrollHost.value);
    }
  } catch {
    renderError.value = true;
  }
});
watch(() => [props.source, theme.global.name.value, theme.global.current.value.colors], () => { if (mermaid) render(); }, { deep: true });
watch(scrollHost, (host, previous) => {
  if (previous) resizeObserver?.unobserve(previous);
  if (host) resizeObserver?.observe(host);
});
onUnmounted(() => { unmounted = true; requestNumber++; resizeObserver?.disconnect(); });
</script>

<template>
  <section class="diagram-widget" :aria-label="`${title} diagram controls`">
    <div class="diagram-toolbar" role="toolbar" :aria-label="`${title} diagram controls`">
      <v-btn icon="mdi-minus" size="small" variant="tonal" color="primary" :aria-label="`Zoom out ${title} diagram`" :title="`Zoom out (${zoomPercent})`" :disabled="scale <= minScale" @click="changeZoom(-0.15)" />
      <span class="zoom-level" aria-live="polite">{{ zoomPercent }}</span>
      <v-btn icon="mdi-plus" size="small" variant="tonal" color="primary" :aria-label="`Zoom in ${title} diagram`" :title="`Zoom in (${zoomPercent})`" :disabled="scale >= maxScale" @click="changeZoom(0.15)" />
      <v-btn prepend-icon="mdi-fit-to-screen-outline" size="small" variant="text" color="primary" aria-label="Fit diagram to view" @click="fitDiagram">Fit</v-btn>
      <v-btn prepend-icon="mdi-restore" size="small" variant="text" color="primary" aria-label="Reset diagram zoom and position" @click="resetZoom">Reset</v-btn>
      <v-spacer />
      <v-btn icon="mdi-fullscreen" size="small" variant="tonal" color="primary" :aria-label="`Enlarge ${title} diagram`" title="Enlarge diagram" @click="openEnlarged" />
    </div>
    <p class="diagram-hint text-caption text-medium-emphasis">Drag the diagram to pan. Use arrow keys to pan, + / − to zoom, or choose Fit and Enlarge.</p>
    <div class="diagram-frame">
      <div v-if="renderError" class="text-body-2 text-medium-emphasis pa-3" role="status">The diagram could not be rendered. Use the text description above.</div>
      <div v-else-if="!svgMarkup" class="text-body-2 text-medium-emphasis pa-3" role="status">Rendering diagram…</div>
      <div v-else ref="scrollHost" class="diagram-scroll" tabindex="0" role="region" :aria-label="`${title} diagram; use arrows to pan, plus or minus to zoom, or the toolbar controls`" @keydown="handleKeydown($event, scrollHost)" @pointerdown="beginPan($event, scrollHost)" @pointermove="movePan" @pointerup="endPan" @pointercancel="endPan" @lostpointercapture="endPan">
        <div class="diagram-canvas"><div class="diagram-svg" :style="scaledSvgStyle" v-html="svgMarkup" /></div>
      </div>
    </div>

    <v-dialog v-model="enlarged" fullscreen scrollable @after-enter="handleEnlargedEnter" @after-leave="restoreFocus">
      <v-card class="diagram-dialog-card">
        <v-toolbar color="surface" density="comfortable">
          <v-toolbar-title>{{ title }} diagram</v-toolbar-title>
          <v-btn icon="mdi-minus" variant="text" :aria-label="`Zoom out ${title} diagram`" @click="changeZoom(-0.15)" />
          <span class="zoom-level">{{ zoomPercent }}</span>
          <v-btn icon="mdi-plus" variant="text" :aria-label="`Zoom in ${title} diagram`" @click="changeZoom(0.15)" />
          <v-btn prepend-icon="mdi-fit-to-screen-outline" variant="text" aria-label="Fit diagram to view" @click="fitDiagram">Fit</v-btn>
          <v-btn prepend-icon="mdi-restore" variant="text" aria-label="Reset diagram zoom and position" @click="resetZoom">Reset</v-btn>
          <v-btn icon="mdi-fullscreen-exit" variant="text" aria-label="Close enlarged diagram" @click="enlarged = false" />
        </v-toolbar>
        <v-card-text class="pa-0">
          <div v-if="svgMarkup" ref="enlargedScrollHost" class="diagram-scroll diagram-scroll-enlarged" tabindex="0" role="region" :aria-label="`Enlarged ${title} diagram; use arrows to pan, plus or minus to zoom`" @keydown="handleKeydown($event, enlargedScrollHost)" @pointerdown="beginPan($event, enlargedScrollHost)" @pointermove="movePan" @pointerup="endPan" @pointercancel="endPan" @lostpointercapture="endPan">
            <div class="diagram-canvas"><div class="diagram-svg" :style="scaledSvgStyle" v-html="svgMarkup" /></div>
          </div>
        </v-card-text>
      </v-card>
    </v-dialog>
  </section>
</template>

<style scoped>
.diagram-widget { width: 100%; }
.diagram-toolbar { display: flex; align-items: center; gap: .25rem; min-height: 44px; margin-bottom: .35rem; }
.diagram-hint { margin: 0 0 .5rem .25rem; }
.zoom-level { min-width: 3.5rem; text-align: center; font-size: .8rem; color: rgb(var(--v-theme-on-surface)); font-variant-numeric: tabular-nums; }
.diagram-frame { max-width: 100%; overflow: hidden; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: .75rem; background: rgb(var(--v-theme-surface)); }
.diagram-scroll { max-width: 100%; max-height: 70vh; overflow: auto; overscroll-behavior: contain; padding: 1rem; touch-action: pan-x pan-y; }
.diagram-scroll-enlarged { max-width: 100vw; max-height: calc(100vh - 64px); width: 100%; height: calc(100vh - 64px); padding: 1.5rem; }
.diagram-canvas { width: max-content; min-width: 100%; min-height: 100%; }
.diagram-svg :deep(svg) { display: block; width: 100%; height: auto; }
.diagram-scroll:focus-visible { outline: 2px solid rgb(var(--v-theme-primary)); outline-offset: -2px; }
.diagram-scroll svg { cursor: grab; }
.diagram-scroll.is-panning, .diagram-scroll.is-panning svg { cursor: grabbing; user-select: none; }
.diagram-dialog-card { background: rgb(var(--v-theme-background)); }
@media (max-width: 600px) { .diagram-toolbar { flex-wrap: wrap; } .diagram-scroll { max-height: 60vh; padding: .65rem; } }
</style>
