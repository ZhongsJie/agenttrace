<script setup>
import CodePreview from './CodePreview.vue';
import {textOf} from './presentation.js';

defineProps({spec: {type: Object, required: true}});
const emit = defineEmits(['inspect', 'copy']);
</script>

<template>
  <CodePreview :source="spec.source" :title="spec.title" :language="spec.language" :hint="spec.hint"
    @inspect="emit('inspect', spec, $event.currentTarget)" @copy="emit('copy', textOf(spec.source), $event.currentTarget)" />
</template>
