<script setup>
import {computed} from 'vue';
import CodePreview from './CodePreview.vue';
import Icon from './Icon.vue';
import {clock, duration, modelName, number} from './presentation.js';

const props = defineProps({active: Object, tab: String, selectedStepId: Number, preferences: Object});
const emit = defineEmits(['change-tab', 'preference', 'inspect', 'browse', 'copy']);
const tabs = {overview: 'Overview', metrics: 'Metrics', details: 'Details'};
const options = [
  {id: 'show-content', key: 'content', label: 'Conversation content'},
  {id: 'show-reasoning', key: 'reasoning', label: 'Reasoning'},
  {id: 'show-context', key: 'contexts', label: 'System events and context'},
];
const eventLabels = {
  thread_settings_applied: 'Session settings applied', token_count: 'Token usage updated',
  system: 'System prompt', developer: 'Developer prompt', context: 'Context compaction',
};
const eventOrigins = {client_event: 'Client event'};
const session = computed(() => props.active?.session);
const model = computed(() => props.active?.model);
const metrics = computed(() => model.value?.metrics);
const usage = computed(() => metrics.value?.tokens);
const records = computed(() => props.active?.rawRecords ?? []);
const invalidCount = computed(() => records.value.filter(record => !record.valid).length);
const selected = computed(() => model.value?.steps.find(step => step.id === props.selectedStepId));

const overview = computed(() => [
  ['clock', 'Recorded span', duration(metrics.value?.recordedDurationMs)],
  ['layers', 'Turns', metrics.value?.turns],
  ['message', 'Messages', metrics.value?.messages],
  ['cube', 'Tool calls', metrics.value?.toolCalls],
]);
const executionFacts = computed(() => {
  const stats = metrics.value;
  return [
    ['Recorded span', duration(stats.recordedDurationMs)],
    ['Turns', stats.turns],
    ...session.value.turns.map((turn, index) => [`Turn ${index + 1} reported duration`, duration(turn.duration)]),
    ['Plain-text messages', stats.messages],
    ['Tool calls', stats.toolCalls],
    ['Overlapping tool calls', session.value.tools.filter(tool => tool.parallel).length],
    ['Replay timing', model.value.timing === 'recorded' ? 'Log timestamps' : 'Evenly spaced intervals'],
  ];
});
const details = computed(() => {
  const {meta, context, records, warnings} = session.value;
  return [
    ['Session ID', meta.id || meta.session_id],
    ['Model', modelName(props.active)],
    ['Provider', meta.model_provider || meta.model_provider_id],
    ['CLI', meta.cli_version],
    ['Working directory', context.cwd || meta.cwd],
    ['Raw records', records.length],
    ['Parse warnings', warnings.length],
  ];
});
const selectedDocuments = computed(() => {
  const step = selected.value;
  const record = records.value.find(item => item.line === step.line);
  const location = {line: step.line, scope: 'session'};
  return [
    ...(record ? [{id: `selected-record-${step.id}`, spec: {source: record.source, title: 'Raw event record', language: record.valid ? 'json' : 'text', ...location}}] : []),
    {id: `selected-content-${step.id}`, spec: {source: step.body, title: 'Event content', ...location}},
  ];
});
const sessionDocuments = computed(() => [
  {id: 'session-meta', spec: {source: session.value.meta, title: 'Session metadata', language: 'json', scope: 'session'}},
  {id: 'turn-context', spec: {source: session.value.context, title: 'Turn context', language: 'json', scope: 'session'}},
]);
const chart = computed(() => {
  const usage = metrics.value.usage.filter(point => Number.isFinite(point.totalTokens));
  if (!usage.length) return null;
  const max = usage.reduce((max, point) => Math.max(max, point.totalTokens), 1);
  const first = usage[0].atMs;
  const last = usage[usage.length - 1].atMs;
  const points = usage.map(point => [last > first ? (point.atMs - first) / (last - first) * 300 : 150, 76 - point.totalTokens / max * 64]);
  const line = points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(' ');
  const area = `M${points[0][0]},82 L${points.map(([x, y]) => `${x},${y}`).join(' L')} L${points[points.length - 1][0]},82 Z`;
  return {first, last, points, line, area};
});
const toolMax = computed(() => metrics.value.toolTotals.reduce((max, tool) => Math.max(max, tool.totalDurationMs), 1));

function selectedTitle(step) {
  return (Object.hasOwn(eventLabels, step.title) && eventLabels[step.title]) ||
    (Object.hasOwn(eventLabels, step.kind) && eventLabels[step.kind]) || step.title || step.kind;
}

function selectedSource(step) {
  const origin = Object.hasOwn(eventOrigins, step.origin) ? eventOrigins[step.origin] : step.origin || 'Record';
  return `L${step.line} · +${duration(step.atMs)} · ${origin}`;
}

function copyOriginal(spec, event) {
  const {source} = globalThis.AgentFormat.document(spec.source);
  emit('copy', source, event.currentTarget);
}
</script>

<template>
  <aside class="inspector panel">
    <div class="inspector-tabs" role="tablist" aria-label="Session analysis">
      <button v-for="(label, name) in tabs" :key="name" type="button" :data-inspector="name" :class="{active: tab === name}" role="tab"
        :aria-selected="tab === name" @click="emit('change-tab', name)">{{ label }}</button>
    </div>
    <div class="inspector-scroll">
      <div id="inspector-body" :key="active?.id">
        <section v-if="!active || tab === 'overview'" class="inspector-section">
          <h2>Session Overview</h2>
          <p class="section-caption">{{ session ? `Full session statistics · Raw records: ${session.records.length}` : 'Import a log to see execution statistics and raw context for the full session.' }}</p>
          <div class="overview-grid">
            <div v-for="[name, label, value] in overview" :key="name" class="overview-card">
              <span class="metric-icon"><Icon :name="name" /></span>
              <div><span class="label">{{ label }}</span><strong>{{ value ?? 'Unknown' }}</strong></div>
            </div>
          </div>
        </section>
        <template v-if="active && (tab === 'overview' || tab === 'metrics')">
          <section v-if="tab === 'metrics'" class="inspector-section">
            <h2>Full execution metrics</h2>
            <p class="section-caption">These statistics cover the full session, regardless of search filters or replay position.</p>
            <dl class="facts-list">
              <div v-for="[label, value] in executionFacts" :key="label" class="fact"><dt>{{ label }}</dt><dd>{{ value ?? 'Unknown' }}</dd></div>
            </dl>
          </section>
          <section class="inspector-section">
            <h2>Token Usage</h2>
            <div class="token-summary">
              <div class="token-total"><span>Total</span><strong>{{ number(usage?.total_tokens) }}</strong></div>
              <div class="token-breakdown">
                <div><span class="legend-label"><i class="legend-square"></i>Input / cached input</span><b>{{ number(usage?.input_tokens) }} / {{ number(usage?.cached_input_tokens) }}</b></div>
                <div><span class="legend-label"><i class="legend-square output"></i>Output / reasoning</span><b>{{ number(usage?.output_tokens) }} / {{ number(usage?.reasoning_output_tokens) }}</b></div>
              </div>
            </div>
            <template v-if="chart">
              <div class="token-chart">
                <svg viewBox="0 0 300 86" preserveAspectRatio="none" role="img" :aria-label="`Cumulative token usage, based on ${chart.points.length} recorded snapshots`">
                  <defs><linearGradient id="usage-gradient" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#7660f8" stop-opacity=".22"/><stop offset="1" stop-color="#7660f8" stop-opacity=".02"/></linearGradient></defs>
                  <path :d="chart.area" fill="url(#usage-gradient)"/>
                  <path d="M0 82H300" stroke="var(--border)" stroke-width="1"/>
                  <polyline :points="chart.line" fill="none" stroke="#7254ff" stroke-width="2" vector-effect="non-scaling-stroke"/>
                  <circle v-for="([x, y], index) in chart.points" :key="index" :cx="x" :cy="y" r="1.6" fill="#7254ff"/>
                </svg>
              </div>
              <div class="chart-caption"><span>+{{ clock(chart.first) }}</span><span>Usage snapshots: {{ chart.points.length }}</span><span>+{{ clock(chart.last) }}</span></div>
            </template>
            <p v-else class="diagnostic-note">No token usage snapshots to plot.</p>
          </section>
          <section class="inspector-section">
            <h2>Tool call durations</h2>
            <div class="tool-time-list">
              <div v-for="tool in metrics.toolTotals" :key="tool.name" class="tool-time-item">
                <div class="tool-time-heading">
                  <Icon name="tools" /><strong :title="tool.name">{{ tool.name }}</strong><span>×{{ tool.count }}</span>
                  <b>{{ tool.knownCount ? duration(tool.totalDurationMs) : 'Unknown' }}</b>
                </div>
                <div class="tool-time-rail"><i :style="{width: `${tool.knownCount ? tool.totalDurationMs / toolMax * 100 : 0}%`}"></i></div>
                <p v-if="tool.unknownCount" class="tool-time-footnote">Calls excluded from the total due to incomplete timing: {{ tool.unknownCount }}.</p>
              </div>
              <p v-if="!metrics.toolTotals.length" class="diagnostic-note">No tool calls.</p>
            </div>
          </section>
          <p v-if="tab === 'metrics'" class="diagnostic-note">Parallel tool calls can overlap, so their combined durations do not measure the total elapsed session time.</p>
        </template>
        <template v-else-if="active">
          <section class="inspector-section">
            <h2>Session Details</h2>
            <p class="section-caption">Raw information for the full session, regardless of replay position.</p>
            <dl class="facts-list">
              <div v-for="[label, value] in details" :key="label" class="fact"><dt>{{ label }}</dt><dd>{{ value ?? 'Unknown' }}</dd></div>
            </dl>
          </section>
          <section v-if="selected" :key="selected.id" class="selected-event-view">
            <div class="selected-event-heading">
              <div><h3>{{ selectedTitle(selected) }}</h3><p>{{ selectedSource(selected) }}</p></div>
              <button type="button" class="mini-button" @click="emit('browse', selected.line, $event.currentTarget)">View in raw records</button>
            </div>
            <CodePreview v-for="{id, spec} in selectedDocuments" :key="id" :source="spec.source" :title="spec.title" :language="spec.language"
              @inspect="emit('inspect', spec, $event.currentTarget)" @copy="copyOriginal(spec, $event)" />
          </section>
          <p v-else class="diagnostic-note">Select an event in Events or on the timeline to see its formatted content and the corresponding raw record.</p>
          <p v-if="session.warnings.length" class="diagnostic-note warning">{{ session.warnings.join('\n') }}</p>
          <p v-else class="diagnostic-note">No invalid JSONL lines found.</p>
          <details v-for="{id, spec} in sessionDocuments" :key="id" class="detail-disclosure">
            <summary>{{ spec.title }}</summary>
            <CodePreview :source="spec.source" :title="spec.title" :language="spec.language"
              @inspect="emit('inspect', spec, $event.currentTarget)" @copy="copyOriginal(spec, $event)" />
          </details>
          <section class="raw-records-launcher">
            <div><h3>All raw records</h3><p>Non-empty records: {{ records.length }} · Invalid JSON: {{ invalidCount }}</p></div>
            <button type="button" class="button secondary" @click="emit('browse', 0, $event.currentTarget)">Browse raw records</button>
            <p class="diagnostic-note">Browse, search, and filter records by line in a larger viewer that preserves original line numbers and unparsed records.</p>
          </section>
        </template>
      </div>
      <section class="display-options">
        <h2>Display options</h2>
        <label v-for="option in options" :key="option.key"><input :id="option.id" type="checkbox" :checked="preferences?.[option.key]"
          @change="emit('preference', option.key, $event.target.checked)">{{ option.label }}</label>
        <div class="privacy-note"><span id="info-icon"><Icon name="info" /></span><p>Log timestamps do not measure how long the model took to generate a message. These statistics cover the full session, regardless of replay position.</p></div>
      </section>
    </div>
  </aside>
</template>
