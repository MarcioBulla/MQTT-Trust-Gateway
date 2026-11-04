<script setup>
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { helpTopicById } from '../help/help-topics';

const props = defineProps({ topicId: { type: String, required: true } });
const router = useRouter();
const topic = computed(() => helpTopicById[props.topicId]);
const articleHref = computed(() => topic.value ? router.resolve({ name: 'help-topic', params: { topicId: topic.value.id } }).href : '/help');
</script>

<template>
  <v-menu v-if="topic" location="bottom" :close-on-content-click="false" max-width="360">
    <template #activator="{ props: menuProps }">
      <v-btn
        v-bind="menuProps"
        type="button"
        icon="mdi-help-circle-outline"
        variant="text"
        size="small"
        :aria-label="`Help: ${topic.title}`"
        :aria-haspopup="'dialog'"
      />
    </template>
    <v-card class="pa-4" role="dialog" :aria-label="`${topic.title} help preview`">
      <div class="d-flex align-center ga-2 mb-2">
        <v-icon icon="mdi-help-circle-outline" color="primary" />
        <h3 class="text-subtitle-1 font-weight-bold">{{ topic.title }}</h3>
      </div>
      <p class="text-body-2 mb-3">{{ topic.shortSummary }}</p>
      <v-alert v-if="topic.caution" type="warning" variant="tonal" density="compact" class="mb-3">
        {{ topic.caution }}
      </v-alert>
      <a class="text-primary font-weight-medium" :href="articleHref" target="_blank" rel="noopener noreferrer">
        Read more <v-icon icon="mdi-open-in-new" size="small" aria-hidden="true" />
        <span class="sr-only">(opens the full Help article in a new tab)</span>
      </a>
    </v-card>
  </v-menu>
</template>

<style scoped>
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
</style>
