<script setup>
defineProps({name: String});
const shapes = {
  search: [['circle', {cx: '8.5', cy: '8.5', r: '5.5'}], ['path', {d: 'm13 13 4.5 4.5'}]],
  sun: [['circle', {cx: '10', cy: '10', r: '3.3'}], ['path', {d: 'M10 1v1.5M10 17.5V19M1 10h1.5m15 0H19M3.6 3.6l1.1 1.1m10.6 10.6 1.1 1.1M3.6 16.4l1.1-1.1M15.3 4.7l1.1-1.1'}]],
  moon: [['path', {d: 'M17.3 12.1A7.5 7.5 0 0 1 7.9 2.7 7.5 7.5 0 1 0 17.3 12.1Z'}]],
  export: [['path', {d: 'M10 13V2m-4 4 4-4 4 4M4 10H2.5V18h15v-8H16'}]],
  file: [['path', {d: 'M5 2h7l4 4v12H5Zm7 0v5h4M8 11h5m-5 3h5'}]],
  folder: [['path', {d: 'M2 5h6l2 2h8v10H2Z'}]],
  play: [['path', {d: 'm7 4 9 6-9 6Z', fill: 'currentColor', stroke: 'none'}]],
  pause: [['path', {d: 'M6 4h3v12H6Zm5 0h3v12h-3Z', fill: 'currentColor', stroke: 'none'}]],
  previous: [['path', {d: 'M5 5v10m9-10-7 5 7 5Z', fill: 'currentColor'}]],
  next: [['path', {d: 'M15 5v10M6 5l7 5-7 5Z', fill: 'currentColor'}]],
  clock: [['circle', {cx: '10', cy: '10', r: '7.5'}], ['path', {d: 'M10 5v5l3 2'}]],
  layers: [['path', {d: 'm10 2 8 5-8 5-8-5Zm-8 9 8 5 8-5M2 15l8 5 8-5'}]],
  message: [['path', {d: 'M17 9.3a7 7 0 0 1-7 7 8 8 0 0 1-3-.6L2 18l1.8-4.5A7 7 0 1 1 17 9.3Z'}], ['path', {d: 'M6.5 9h.1m3.4 0h.1m3.4 0h.1'}]],
  cube: [['path', {d: 'm10 2 7 4v8l-7 4-7-4V6Zm0 8 7-4M10 10 3 6m7 4v8'}]],
  tools: [['path', {d: 'M12 3a5 5 0 0 0-5 6l-5 5a2.3 2.3 0 0 0 3 3l5-5a5 5 0 0 0 6-6l-3 3-3-3Z'}]],
  token: [['rect', {x: '5', y: '3', width: '11', height: '15', rx: '2'}], ['path', {d: 'M8 3V1h5v2m-5 5h5m-5 4h5m-5 3h3'}]],
  copy: [['rect', {x: '7', y: '3', width: '10', height: '11', rx: '2'}], ['path', {d: 'M13 16v1H3V7h1'}]],
  check: [['circle', {cx: '10', cy: '10', r: '7.4'}], ['path', {d: 'm6.4 10 2.3 2.5 4.9-5'}]],
  info: [['circle', {cx: '10', cy: '10', r: '7.6'}], ['path', {d: 'M10 9v5m0-8h.01'}]],
  shield: [['path', {d: 'M10 2 3 5v5c0 4 7 8 7 8s7-4 7-8V5Zm-3 8 2 2 4-4'}]],
  bot: [['rect', {x: '4', y: '6', width: '12', height: '10', rx: '4'}], ['path', {d: 'M10 3v3M8 3h4M1.5 10v3m17-3v3M7 10h.01m6 0h.01M7.5 13h5'}]],
  chevron: [['path', {d: 'm5 7.5 5 5 5-5'}]],
  activity: [['path', {d: 'M1 10h4l3-7 4 14 3-7h4'}]],
};
</script>

<template>
  <svg viewBox="0 0 20 20" aria-hidden="true">
    <component :is="tag" v-for="([tag, attrs], index) in shapes[name] || shapes.file" :key="index" v-bind="attrs"/>
  </svg>
</template>
