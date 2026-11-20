<script setup>
defineProps({lines: {type: Array, required: true}});
</script>

<template>
  <code><span v-for="(line, index) in lines" :key="index" class="code-line">
    <span class="code-gutter" aria-hidden="true">{{ index + 1 }}</span>
    <span v-if="line" class="code-text" v-html="line"></span>
    <span v-else class="code-text">&#8203;</span>
  </span></code>
</template>
