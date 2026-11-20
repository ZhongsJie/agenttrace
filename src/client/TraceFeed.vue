<script setup>
import {computed} from 'vue';
import Icon from './Icon.vue';
import FeedCode from './FeedCode.vue';
import TracePayload from './TracePayload.vue';
import {duration, number, textOf} from './presentation.js';

const props = defineProps({
  active: {type: Object, required: true},
  query: String,
  turn: [String, Number],
  status: Object,
  serverMode: Boolean,
});
const emit = defineEmits(['inspect', 'copy', 'choose-trace']);
const labels = {completed: 'Completed', failed: 'Failed', error: 'Error', cancelled: 'Canceled', canceled: 'Canceled', running: 'Running', incomplete: 'Incomplete'};
const traceStatus = status => Object.hasOwn(labels, status) ? labels[status] : status || 'Unknown status';
const info = computed(() => props.active.traceInfo);
const missing = computed(() => {
  const {status, serverMode} = props;
  const title = 'No matching Codex trace for this session';
  if (!serverMode) return {title, detail: 'This offline report cannot check the local trace directory. Run npm start and check the directory in Settings at the bottom left.'};
  if (!status) return {title, detail: 'Trace directory scan status is unavailable. Open Settings at the bottom left to check the directory, then refresh the session list.'};
  if (!status.configured) return {title: 'No trace directory configured', detail: 'Set the trace directory in Settings at the bottom left, or set CODEX_ROLLOUT_TRACE_ROOT before starting the viewer for the first time.'};
  if (status.warnings.length) return {title: 'Trace directory scan warnings', detail: `Configured directory: ${status.directory}. ${status.warnings.join('; ')}. Check the directory in Settings at the bottom left, then refresh the session list.`};
  return {title, detail: `The configured directory (${status.directory}) contains ${status.bundles} trace bundles, but none match this exact session ID. Check the directory and confirm that trace collection was enabled for this session.`};
});
const turnId = computed(() => props.active.session.turns[Number(props.turn) - 1]?.id);
const includesQuery = fields => !props.query || fields.filter(Boolean).join(' ').toLowerCase().includes(props.query);
const matches = item => (props.turn === 'all' || (turnId.value != null && item.turnId === turnId.value)) && includesQuery([
  item.id, item.threadId, item.turnId, item.model, item.provider, item.name, item.type, item.agentPath, item.requestPath, item.responsePath,
]);
const threads = computed(() => info.value.threads.filter(item => includesQuery([item.id, item.agentPath, item.model, item.provider])));
const events = computed(() => info.value.events.filter(matches));
const lines = computed(() => info.value.source.split(/\r?\n/));
const payloads = computed(() => Object.values(info.value.payloads));
const traceUsage = computed(() => {
  const totals = info.value.inferences.map(span => span.tokenUsage?.total_tokens).filter(Number.isFinite);
  return totals.length ? totals.reduce((a, b) => a + b, 0) : null;
});

const sections = computed(() => {
  const {inferences, tools} = info.value;
  return [
    {id: 'requests', title: 'Model requests and responses', total: inferences.length, empty: 'No matching model requests.', cards: inferences.filter(matches).map(span => ({
      span,
      title: span.model || 'Unknown model',
      facts: [
        ['Request-to-response time', duration(span.durationMs)],
        ['Tokens for this request', number(span.tokenUsage?.total_tokens)],
        ['Input / output', `${number(span.tokenUsage?.input_tokens)} / ${number(span.tokenUsage?.output_tokens)}`],
      ],
      location: `Source: L${span.startLine ?? '?'} to L${span.endLine ?? '?'} · ${span.provider || 'Unknown provider'}`,
      payloads: [['Request payload', span.requestPath], ['Response payload', span.responsePath]],
    }))},
    {id: 'tools', title: 'Tool execution stages', total: tools.length, empty: 'No matching tool calls.', cards: tools.filter(matches).map(span => ({
      span,
      title: span.name || 'Unknown tool',
      facts: [
        ['Dispatch-to-result time', duration(span.durationMs)],
        ['Runtime event duration', duration(span.runtimeDurationMs)],
        ['Tool-reported duration', Number.isFinite(span.reportedExecutionMs) ? `${span.reportedExecutionMs.toFixed(6)} ms` : 'Unknown'],
      ],
      payloads: [['Tool arguments', span.invocationPath], ...(span.runtimePaths || []).map((path, index) => [`Runtime ${index + 1}`, path]), ['Tool result', span.resultPath]],
    }))},
  ];
});
const manifest = computed(() => ({source: info.value.manifest, title: 'Trace Manifest', language: 'json', scope: 'session'}));
const inspect = (spec, opener) => emit('inspect', spec, opener);
const copy = (text, opener) => emit('copy', text, opener);

function openTrace(event) {
  inspect({source: info.value.source, title: 'Raw trace.jsonl', language: 'jsonl', scope: 'session'}, event.currentTarget);
}

function openEvent(entry, event) {
  const {line, raw} = entry;
  inspect({source: lines.value[line - 1] || textOf(raw), title: `Trace event · L${line}`, language: 'json', scope: 'session', line}, event.currentTarget);
}
</script>

<template>
  <div v-if="!info" class="empty-state">
    <div class="empty-icon"><Icon name="folder" /></div>
    <h2>{{ missing.title }}</h2>
    <p>{{ missing.detail }} To collect traces, set CODEX_ROLLOUT_TRACE_ROOT when starting Codex. Missing records do not tell the viewer whether collection was enabled. The variable uses ROLLOUT, not ROOLOUT. Configuring the directory now will not collect traces retroactively.</p>
  </div>
  <section v-else class="trace-analysis">
    <header class="trace-analysis-heading">
      <div>
        <h2>Codex Trace</h2>
        <label v-if="active.traces?.length > 1" class="trace-selector-label">Trace recording
          <select id="trace-selector" class="compact-select" aria-label="Select a trace for this session" :value="active.traceIndex ?? 0"
            @change="emit('choose-trace', Number($event.target.value))">
            <option v-for="(item, index) in active.traces" :key="item.key ?? index" :value="index">{{ item.bundle.name || item.traceInfo.traceId || String(index + 1) }}</option>
          </select>
        </label>
        <p>This analysis covers the full session, regardless of replay position. Requests, responses, and runtime stages each use their own timing measurements.</p>
      </div>
      <button type="button" class="mini-button trace-document-button" @click="openTrace">View trace.jsonl</button>
    </header>
    <div class="trace-identities"><span>Trace {{ info.traceId || 'Unknown' }}</span><span>Rollout {{ info.rolloutId || info.rootThreadId || 'Unknown' }}</span></div>
    <div class="trace-summary">
      <div><span>Model requests</span><strong>{{ info.inferences.length }}</strong></div>
      <div><span>Tool calls</span><strong>{{ info.tools.length }}</strong></div>
      <div><span>Threads</span><strong>{{ info.threads.length }}</strong></div>
      <div><span>Recorded response tokens</span><strong>{{ number(traceUsage) }}</strong></div>
    </div>
    <p class="panel-note">Trace response usage is totaled once per model call. Do not add it to rollout usage. The total includes only recorded responses; missing usage is not estimated. Dispatch intervals, runtime event intervals, and tool-reported durations measure different things. Request snapshots do not give the exact time of user submission.</p>
    <section v-for="section in sections" :key="section.id" class="trace-analysis-section">
      <h2>{{ section.title }} <small>{{ section.cards.length }} / {{ section.total }}</small></h2>
      <p v-if="!section.cards.length" class="diagnostic-note">{{ section.empty }}</p>
      <article v-for="(card, index) in section.cards" :key="`${card.span.id}:${card.span.threadId}:${card.span.turnId}:${index}`" class="trace-call-card">
        <header><div><h3>{{ card.title }}</h3><p class="trace-call-id">{{ card.span.id }}</p></div><span class="trace-status">{{ traceStatus(card.span.status) }}</span></header>
        <div class="trace-call-meta"><span class="trace-thread">{{ card.span.threadId || 'Unknown thread' }}</span><span>{{ card.span.turnId || 'Unknown turn' }}</span></div>
        <div class="trace-facts"><div v-for="[label, value] in card.facts" :key="label"><span>{{ label }}</span><strong>{{ value }}</strong></div></div>
        <p v-if="card.location" class="trace-source-location">{{ card.location }}</p>
        <div class="trace-payload-actions">
          <TracePayload v-for="[label, path] in card.payloads" :key="label" :path="path" :label="label" :payloads="info.payloads" @inspect="inspect" />
        </div>
      </article>
    </section>
    <section class="trace-analysis-section">
      <h2>Threads <small>{{ threads.length }} / {{ info.threads.length }}</small></h2>
      <div class="trace-thread-list">
        <article v-for="thread in threads" :key="thread.id">
          <div>
            <strong>{{ thread.agentPath || 'Agent path not recorded' }}</strong><p>{{ thread.id }}</p>
            <small>{{ thread.model || 'Unknown model' }} · {{ thread.provider || 'Unknown provider' }}</small>
          </div>
          <TracePayload :path="thread.metadataPath" label="Thread metadata" :payloads="info.payloads" @inspect="inspect" />
        </article>
        <p v-if="!threads.length" class="diagnostic-note">No matching threads.</p>
      </div>
    </section>
    <details class="trace-inventory">
      <summary>Raw events · {{ info.events.length }}</summary>
      <div class="trace-event-list">
        <div v-for="event in events" :key="event.line">
          <span>L{{ event.line }}</span><strong>{{ event.type }}</strong><small>{{ event.threadId || '' }}</small>
          <button type="button" class="mini-button trace-document-button" @click="openEvent(event, $event)">View record</button>
        </div>
        <p v-if="!events.length" class="diagnostic-note">No matching events.</p>
      </div>
    </details>
    <details class="trace-inventory">
      <summary>Associated payload files · {{ payloads.length }}</summary>
      <div class="trace-payload-inventory">
        <div v-for="payload in payloads" :key="payload.path">
          <code>{{ payload.path }}</code><span v-if="payload.error" class="trace-payload-missing">{{ payload.error }}</span>
          <TracePayload :path="payload.path" label="View payload" :payloads="info.payloads" @inspect="inspect" />
        </div>
        <p v-if="!payloads.length" class="diagnostic-note">No associated payloads available.</p>
      </div>
    </details>
    <details class="trace-inventory">
      <summary>Manifest</summary><FeedCode :spec="manifest" @inspect="inspect" @copy="copy" />
    </details>
    <section v-if="info.diagnostics.length" class="trace-diagnostics">
      <h2>Parsing diagnostics</h2><ul><li v-for="message in info.diagnostics" :key="message">{{ message }}</li></ul>
    </section>
  </section>
</template>
