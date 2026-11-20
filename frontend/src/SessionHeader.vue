<script setup>
defineProps({header: {type: Object, required: true}});

const iconPaths = {
  model: 'm10 2 7 4v8l-7 4-7-4V6Zm0 8 7-4M10 10 3 6m7 4v8',
  cli: 'M1 10h4l3-7 4 14 3-7h4',
  provider: 'm10 2 8 5-8 5-8-5Zm-8 9 8 5 8-5M2 15l8 5 8-5',
};
</script>

<template>
  <div class="session-title-area">
    <h1 id="session-name" :title="header.filename">{{ header.title }}</h1>
    <div id="session-chips" class="session-chips">
      <span v-if="!header.session" class="meta-chip">Codex rollout · JSONL</span>
      <template v-else>
        <span class="meta-chip source-chip">{{ header.session.source }}</span>
        <span v-for="(label, name) in header.session.chips" :key="name" class="meta-chip">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path :d="iconPaths[name]" /></svg>{{ label }}
        </span>
      </template>
    </div>
  </div>
  <div id="session-summary" class="session-summary">
    <template v-if="header.session">
      <span v-for="(value, label) in header.session.metrics" :key="label">{{ label }}<b>{{ value }}</b></span>
    </template>
    <span v-else-if="header.hint">{{ header.hint }}</span>
  </div>
</template>
