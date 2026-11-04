<script setup>
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { helpTopics, helpTopicById } from '../help/help-topics';

const props = defineProps({ topicId: { type: String, default: '' } });
const router = useRouter();
const search = ref('');
const topic = computed(() => helpTopicById[props.topicId]);
const categories = computed(() => [...new Set(helpTopics.map((item) => item.category))]);
const visibleTopics = computed(() => helpTopics.filter((item) => `${item.title} ${item.shortSummary} ${item.category}`.toLowerCase().includes(search.value.trim().toLowerCase())));
function goBack() {
  if (window.history.length > 1 && document.referrer && new URL(document.referrer).origin === window.location.origin) router.back();
  else router.push('/help');
}
</script>

<template>
  <main>
    <template v-if="!topicId || !topic">
      <div class="d-flex flex-wrap align-center justify-space-between ga-3 mb-5">
        <div>
          <div class="text-overline text-primary">MQTT TRUST GATEWAY</div>
          <h1 class="text-h4 font-weight-bold">Help</h1>
          <p class="text-body-1 text-medium-emphasis mt-2">Guides for device identities and certificate provisioning.</p>
        </div>
      </div>
      <v-text-field v-model="search" label="Search Help" prepend-inner-icon="mdi-magnify" clearable class="mb-5" />
      <section v-for="category in categories" :key="category" class="mb-8" :aria-labelledby="`category-${category}`">
        <h2 :id="`category-${category}`" class="text-h5 mb-3">{{ category }}</h2>
        <v-row>
          <v-col v-for="item in visibleTopics.filter((entry) => entry.category === category)" :key="item.id" cols="12" md="6" xl="4">
            <v-card :to="{ name: 'help-topic', params: { topicId: item.id } }" class="h-100 pa-4 help-topic-card">
              <div class="d-flex align-center ga-2 mb-2"><v-icon icon="mdi-book-open-page-variant-outline" color="primary" /><h3 class="text-h6">{{ item.title }}</h3></div>
              <p class="text-body-2 text-medium-emphasis mb-3">{{ item.shortSummary }}</p>
              <span class="text-primary font-weight-medium">Open guide <v-icon icon="mdi-arrow-right" size="small" /></span>
            </v-card>
          </v-col>
        </v-row>
      </section>
      <v-alert v-if="!visibleTopics.length" type="info" variant="tonal">No Help articles match “{{ search }}”.</v-alert>
    </template>

    <template v-else>
      <div class="d-flex flex-wrap align-center ga-3 mb-5">
        <v-btn prepend-icon="mdi-arrow-left" variant="text" @click="goBack">Help index</v-btn>
        <v-chip size="small" color="primary" variant="tonal">{{ topic.category }}</v-chip>
      </div>
      <article class="help-article">
        <h1 class="text-h4 font-weight-bold mb-3">{{ topic.title }}</h1>
        <p class="text-body-1 text-medium-emphasis mb-6">{{ topic.overview }}</p>
        <v-alert v-if="topic.caution" type="warning" variant="tonal" class="mb-6">{{ topic.caution }}</v-alert>

        <section class="mb-7"><h2 class="text-h5 mb-2">When to use this</h2><p>{{ topic.when }}</p></section>
        <section class="mb-7"><h2 class="text-h5 mb-2">Before you begin</h2><ul><li v-for="item in topic.prerequisites" :key="item">{{ item }}</li></ul></section>
        <section class="mb-7"><h2 class="text-h5 mb-2">Workflow</h2><ol><li v-for="item in topic.steps" :key="item">{{ item }}</li></ol></section>

        <section class="mb-7">
          <h2 class="text-h5 mb-2">Sequence</h2>
          <p class="text-body-2 text-medium-emphasis">Text description of the exchange:</p>
          <ol class="sequence-list"><li v-for="(item, index) in topic.sequence" :key="item"><span class="sequence-index">{{ index + 1 }}</span>{{ item }}</li></ol>
          <details class="mt-3">
            <summary class="text-primary">Mermaid sequence diagram source</summary>
            <pre class="code-block mt-2" tabindex="0" :aria-label="`${topic.title} Mermaid diagram source`">{{ topic.mermaid }}</pre>
          </details>
        </section>

        <section class="mb-7"><h2 class="text-h5 mb-2">Files and key ownership</h2><ul><li v-for="item in topic.artifacts" :key="item">{{ item }}</li></ul></section>
        <section v-if="topic.lifecycle" class="mb-7"><h2 class="text-h5 mb-2">Validity, renewal, and revocation</h2><p>{{ topic.lifecycle }}</p></section>

        <section v-if="topic.linux?.length" class="mb-7">
          <h2 class="text-h5 mb-2">Linux host (OpenSSL)</h2>
          <p class="text-body-2 text-medium-emphasis mb-3">These commands are host-side examples, not Gateway commands. Run them in a private working directory. Generated private keys are secrets: keep restrictive permissions and do not commit them.</p>
          <v-card v-for="example in topic.linux" :key="example.label" class="pa-4 mb-3">
            <h3 class="text-subtitle-2 font-weight-bold mb-2">{{ example.label }}</h3>
            <pre class="code-block" tabindex="0"><code>{{ example.code }}</code></pre>
          </v-card>
        </section>

        <section v-if="topic.zephyr" class="mb-7">
          <h2 class="text-h5 mb-2">Zephyr RTOS</h2>
          <p>{{ topic.zephyr }}</p>
          <p class="text-body-2 text-medium-emphasis mt-2">Zephyr MCP verification is currently unavailable because its configured server requires reconnection. Check the linked release documentation against your selected Zephyr version, board, Kconfig, and TLS backend before using an API snippet in production.</p>
          <ul class="mt-2"><li v-for="source in topic.sources" :key="source.href"><a :href="source.href" target="_blank" rel="noopener noreferrer">{{ source.label }} <span class="sr-only">(opens in a new tab)</span></a></li></ul>
        </section>

        <section v-if="topic.relatedTopicIds.length" class="mb-7"><h2 class="text-h5 mb-2">Related guides</h2><ul><li v-for="id in topic.relatedTopicIds" :key="id"><router-link :to="{ name: 'help-topic', params: { topicId: id } }">{{ helpTopicById[id]?.title }}</router-link></li></ul></section>
      </article>
    </template>
  </main>
</template>

<style scoped>
.help-topic-card { transition: border-color .15s ease; }
.help-topic-card:hover, .help-topic-card:focus-visible { border-color: rgb(var(--v-theme-primary)); }
.help-article { max-width: 920px; }
.help-article p, .help-article li { line-height: 1.65; }
.help-article ul, .help-article ol { padding-inline-start: 1.5rem; }
.help-article li + li { margin-top: .35rem; }
.code-block { overflow-x: auto; padding: 1rem; border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity)); border-radius: .5rem; font-family: var(--v-font-mono, monospace); font-size: .875rem; white-space: pre; }
.sequence-list { list-style: none; padding: 0 !important; }
.sequence-list li { display: flex; align-items: flex-start; gap: .75rem; margin-block: .65rem; }
.sequence-index { display: inline-flex; flex: 0 0 1.65rem; height: 1.65rem; align-items: center; justify-content: center; border-radius: 50%; background: rgba(var(--v-theme-primary), .14); color: rgb(var(--v-theme-primary)); font-size: .8rem; font-weight: 700; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
</style>
