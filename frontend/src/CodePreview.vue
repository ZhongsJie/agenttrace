<script setup>
import {computed} from 'vue';
import Icon from './Icon.vue';
import InspectorCodeLines from './InspectorCodeLines.vue';

const props = defineProps({source: null, title: String, language: String, hint: String, codeId: String});
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
        <button type="button" data-code-action="copy" :data-code-id="codeId" title="复制原文" :aria-label="`复制${doc.title}原文`" @click="emit('copy', $event)">
          <Icon name="copy" />
        </button>
        <button type="button" data-code-action="expand" :data-code-id="codeId" @click="emit('inspect', $event)">展开</button>
      </div>
    </div>
    <p v-if="view.warning" class="code-warning">{{ view.warning }}</p>
    <pre class="code-preview code-wrap"><InspectorCodeLines :lines="view.lines.slice(0, previewLimit)" /></pre>
    <button v-if="view.lineCount > previewLimit" type="button" class="code-truncation" data-code-action="expand" :data-code-id="codeId" @click="emit('inspect', $event)">
      仅预览前 {{ previewLimit }} / {{ view.lineCount }} 行，展开查看完整内容
    </button>
  </section>
</template>
