<script setup>
import {computed} from 'vue';

const props = defineProps({path: String, label: {type: String, required: true}, payloads: {type: Object, required: true}});
const emit = defineEmits(['inspect']);
const payload = computed(() => props.path ? props.payloads[props.path] : null);

function open(event) {
  const {source, error} = payload.value;
  emit('inspect', {source, title: `${props.label} · ${props.path}`, language: error ? 'text' : 'json', scope: 'session'}, event.currentTarget);
}
</script>

<template>
  <span v-if="!path" class="trace-payload-missing">{{ label }} not recorded</span>
  <span v-else-if="payload?.source == null" class="trace-payload-missing">{{ label }} missing · {{ path }}</span>
  <button v-else type="button" class="mini-button trace-document-button" @click="open">{{ label }}</button>
</template>
