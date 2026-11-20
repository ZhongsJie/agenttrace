<script setup>
import {computed} from 'vue';
import Icon from './Icon.vue';
import InspectorCodeLines from './InspectorCodeLines.vue';

const props = defineProps({source: null, title: String, language: String, hint: String});
const emit = defineEmits(['inspect', 'copy']);
const previewLimit = 80;
const doc = computed(() => globalThis.AgentFormat.document(props.source, props));
const view = computed(() => globalThis.AgentFormat.present(doc.value));
</script>

<template>
  <section class="code-view">
    <div class="code-toolbar">
      <span class="code-title">{{ doc.title }}</span>
      <span class="code-language">{{ view.language }}</span>
      <div class="code-actions">
        <button type="button" title="Copy original" :aria-label="`Copy original: ${doc.title}`" @click="emit('copy', $event)">
          <Icon name="copy" />
        </button>
        <button type="button" @click="emit('inspect', $event)">Expand</button>
      </div>
    </div>
    <p v-if="view.warning" class="code-warning">{{ view.warning }}</p>
    <pre class="code-preview code-wrap"><InspectorCodeLines :lines="view.lines.slice(0, previewLimit)" /></pre>
    <button v-if="view.lineCount > previewLimit" type="button" class="code-truncation" @click="emit('inspect', $event)">
      Showing the first {{ previewLimit }} of {{ view.lineCount }} lines. Expand to view the full content.
    </button>
  </section>
</template>
