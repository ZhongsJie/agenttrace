<script setup>
import {computed, nextTick, reactive, ref, watch} from 'vue';
import Icon from './Icon.vue';
import FeedStep from './FeedStep.vue';
import TraceFeed from './TraceFeed.vue';
import {clock, modelName, number, textOf} from './presentation.js';

const props = defineProps({
  active: {type: Object, default: null},
  snapshot: {type: Object, default: null},
  tab: {type: String, default: 'conversation'},
  source: {type: String, default: 'modelItems'},
  query: {type: String, default: ''},
  turn: {type: [String, Number], default: 'all'},
  preferences: {type: Object, default: () => ({content: true, reasoning: true, contexts: false})},
  selectedStepId: {type: Number, default: null},
  traceStatus: {type: Object, default: null},
  serverMode: Boolean,
});
const emit = defineEmits(['seek', 'select', 'copy', 'inspect', 'browse', 'choose-trace']);

const feed = ref(null);
const expanded = reactive(new Set());
const messageKinds = new Set(['user', 'assistant', 'reasoning', 'tool', 'agent']);
const sourceNames = {modelItems: 'Model messages', clientMessages: 'Client messages'};
const usageFields = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const query = computed(() => props.query.trim().toLowerCase());
const model = computed(() => props.active?.model);
const traceInfo = computed(() => props.active?.traceInfo);
const durationReached = computed(() => props.snapshot?.state.positionMs >= model.value?.durationMs);
const replayEnded = computed(() => durationReached.value && props.snapshot?.state.status !== 'playing');
const tokens = computed(() => model.value?.metrics.tokens);
const usageNote = 'Usage is calculated from changes between cumulative snapshots. Duplicate notifications are counted only once. The first snapshot may include earlier usage.';

function matches({step, outputVisible}) {
  if (props.turn !== 'all' && String(step.turnIndex) !== String(props.turn)) return false;
  return !query.value || [step.title, textOf(step.body), outputVisible ? textOf(step.output) : '', step.callId]
    .join(' ').toLowerCase().includes(query.value);
}

function isNarrative({step}) {
  const {content, reasoning, contexts} = props.preferences;
  if (step.contextOnly) return contexts;
  if (step.kind === 'user' || step.kind === 'assistant') return content;
  if (step.kind === 'reasoning') return reasoning;
  if (step.kind === 'tool' || step.kind === 'agent') return true;
  return contexts && step.kind !== 'usage';
}

const projection = computed(previous => {
  const views = props.snapshot?.views;
  const view = {conversation: props.source, tools: 'tools', events: 'runtimeEvents', tokens: 'usage'}[props.tab];
  const next = views?.[view] || [];
  if (previous?.length === next.length && next.every((entry, index) => {
    const prior = previous[index];
    return entry.step === prior.step && entry.phase === prior.phase && entry.outputVisible === prior.outputVisible;
  })) return previous;
  return next;
});
const entries = computed(() => projection.value.filter(entry => {
  if (props.tab === 'conversation' && !isNarrative(entry)) return false;
  if (props.tab === 'tools' && entry.step.contextOnly && !props.preferences.contexts) return false;
  return matches(entry);
}));

const blocks = computed(() => {
  if (props.tab !== 'conversation') return [];
  const result = [];
  for (const entry of entries.value) {
    const {step} = entry;
    const kind = step.contextOnly || !messageKinds.has(step.kind) ? 'context' : step.kind === 'user' ? 'user' : 'agent';
    const last = result.at(-1);
    if (kind === 'agent' && last?.kind === 'agent' && last.first.threadId === step.threadId) last.entries.push(entry);
    else result.push({kind, first: step, entries: [entry]});
  }
  return result;
});
const threadPaths = computed(() => new Map(traceInfo.value?.threads.map(thread => [thread.id, thread.agentPath])));
const relatedSteps = computed(() => {
  const links = new Map();
  for (const {from, to} of model.value?.relations || []) {
    if (!links.has(from)) links.set(from, []);
    links.get(from).push(to);
    if (from !== to) {
      if (!links.has(to)) links.set(to, []);
      links.get(to).push(from);
    }
  }
  return links;
});

const empty = computed(() => {
  if (!model.value || !props.snapshot) return ['activity', 'Replay a session', 'Select or drop a Codex rollout to explore the conversation, tool calls, and raw records for each stage.'];
  if (entries.value.length || props.tab === 'trace') return null;
  if (props.tab === 'conversation') return ['message', 'No messages to display', durationReached.value
    ? 'Nothing matches in this source. Switch sources or open Events to see runtime notifications. The raw records contain all logged content.'
    : 'Continue playback or drag the timeline to see later records. You can also adjust the search or turn filter.'];
  if (props.tab === 'tools') return ['tools', 'No tool calls to display', 'As replay reaches a tool call, its arguments, status, and any result available at that point appear here.'];
  if (props.tab === 'events') return ['clock', 'No events to display', 'Continue playback or adjust the search and display options.'];
  return ['token', 'No token usage to display', tokens.value ? 'Replay has not reached any usage records yet, or none match the filters.'
    : 'This log has no token_count snapshots, so token usage for messages or tools cannot be estimated.'];
});

function isOpen(kind, id) {
  return expanded.has(`${props.active.id}:${kind}:${id}`);
}

function setOpen(kind, id, open) {
  const key = `${props.active.id}:${kind}:${id}`;
  if (open) expanded.add(key);
  else expanded.delete(key);
}

async function expandStep(id) {
  const sessionId = props.active?.id;
  await nextTick();
  if (props.active?.id !== sessionId) return;
  const step = model.value?.steps.find(item => item.id === id);
  if (!step) return;
  const kind = props.tab === 'events' || step.contextOnly || !messageKinds.has(step.kind) ? 'event' : step.kind;
  if (['event', 'tool', 'reasoning'].includes(kind)) setOpen(kind, id, true);
}

defineExpose({expandStep});

function seek(id, changeTab) {
  emit('seek', id, changeTab);
  expandStep(id);
}

const stepEvents = {
  toggle: setOpen,
  seek,
  select: id => emit('select', id),
  inspect: (spec, opener) => emit('inspect', spec, opener),
  copy: (text, opener) => emit('copy', text, opener),
  browse: (line, opener) => emit('browse', line, opener),
};

const signature = computed(() => entries.value.map(({step, phase, outputVisible}) => `${step.id}:${phase}:${outputVisible}`).join('|'));
watch(signature, async () => {
  const area = feed.value;
  if (props.tab === 'trace' || props.snapshot?.state.status !== 'playing' || !area || area.scrollHeight - area.scrollTop - area.clientHeight >= 100) return;
  await nextTick();
  if (area === feed.value) area.scrollTo({top: area.scrollHeight, behavior: 'instant'});
});
</script>

<template>
  <div id="feed" ref="feed" class="conversation-feed" aria-live="off">
    <div v-if="empty" class="empty-state">
      <div class="empty-icon"><Icon :name="empty[0]" /></div>
      <h2>{{ empty[1] }}</h2>
      <p>{{ empty[2] }}</p>
    </div>
    <TraceFeed v-else-if="tab === 'trace'" :key="active.id" :active="active" :query="query" :turn="turn"
      :status="traceStatus" :server-mode="serverMode"
      @inspect="stepEvents.inspect" @copy="stepEvents.copy" @choose-trace="emit('choose-trace', $event)" />
    <template v-else-if="tab === 'conversation'">
      <p class="projection-note">{{ sourceNames[source] }} · The two sources are shown separately and are not merged to fill gaps.</p>
      <template v-for="block in blocks" :key="`${active.id}:${block.first.id}`">
        <div v-if="block.kind === 'agent'" class="message-row agent-row">
          <div class="avatar agent-avatar"><Icon name="bot" /></div>
          <div class="agent-column">
            <div class="agent-heading">
              <strong>Agent · {{ modelName(active) }}</strong>
              <span v-if="block.first.threadId && active.traceInfo" class="trace-agent-badge">{{ threadPaths.get(block.first.threadId) || block.first.threadId }}</span>
              <FeedStep mode="source-label" :step="block.first" />
            </div>
            <div class="agent-content">
              <FeedStep v-for="{step, phase, outputVisible} in block.entries" :key="step.id" :mode="step.kind" :step="step"
                :phase="phase" :output-visible="outputVisible" :replay-ended="replayEnded"
                :selected="selectedStepId === step.id" :open="isOpen(step.kind, step.id)" v-on="stepEvents" />
            </div>
          </div>
        </div>
        <FeedStep v-else :mode="block.kind" :step="block.first"
          :selected="selectedStepId === block.first.id" :open="isOpen('event', block.first.id)" v-on="stepEvents" />
      </template>
    </template>
    <template v-else-if="tab === 'events'">
      <p class="panel-note">Runtime events are independent of the conversation source and preserve every logged notification. L indicates the original JSONL line number.</p>
      <div class="event-list">
        <FeedStep v-for="{step, outputVisible} in entries" :key="`${active.id}:${step.id}`" mode="event" :step="step"
          :related="relatedSteps.get(step.id)" :output-visible="outputVisible" :selected="selectedStepId === step.id"
          :open="isOpen('event', step.id)" v-on="stepEvents" />
      </div>
    </template>
    <template v-else-if="tab === 'tools'">
      <p class="panel-note">Tool call status changes with the replay position. Durations come from the log; MCP-reported durations appear separately in the details. Calls are marked as parallel only when their known intervals overlap.</p>
      <FeedStep v-for="{step, phase, outputVisible} in entries" :key="`${active.id}:${step.id}`" mode="tool" :step="step"
        :phase="phase" :output-visible="outputVisible" :replay-ended="replayEnded"
        :selected="selectedStepId === step.id" :open="isOpen('tool', step.id)" v-on="stepEvents" />
    </template>
    <template v-else>
      <div class="token-view-summary">
        <div><span>Total session tokens</span><br><strong>{{ number(tokens?.total_tokens) }}</strong></div>
        <span>Usage records reached: {{ entries.length }}</span>
      </div>
      <p class="panel-note">{{ usageNote }} Cached input and reasoning output are already included in input and output counts, respectively. Do not add them to the total again. These counts cannot be attributed precisely to individual messages.</p>
      <div class="table-scroll">
        <table class="token-table">
          <thead><tr><th>Record position</th><th>Input</th><th>Cached input</th><th>Output</th><th>Reasoning output</th><th>Interval total</th></tr></thead>
          <tbody>
            <tr v-for="{step} in entries" :key="step.id">
              <td><button type="button" class="event-meta-button" @click="seek(step.id, false)">L{{ step.line }} · {{ clock(step.atMs) }}</button></td>
              <td v-for="field in usageFields" :key="field">{{ number(step.usage?.[field]) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
