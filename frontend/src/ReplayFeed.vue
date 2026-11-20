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
const sourceNames = {modelItems: '模型对话条目', requestSnapshots: 'Trace 请求快照', clientMessages: '客户端消息事件'};
const usageFields = ['input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_output_tokens', 'total_tokens'];
const query = computed(() => props.query.trim().toLowerCase());
const model = computed(() => props.active?.model);
const traceInfo = computed(() => props.active?.session?.traceInfo || props.active?.traceInfo);
const durationReached = computed(() => props.snapshot?.state.positionMs >= model.value?.durationMs);
const replayEnded = computed(() => durationReached.value && props.snapshot?.state.status !== 'playing');
const tokens = computed(() => model.value?.metrics.tokens);
const usageNote = '按累计快照的增量统计，重复通知不重复计数。首个快照可能包含更早用量。';

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
  if (!model.value || !props.snapshot) return ['activity', '把执行过程放到眼前', '选择或拖入一份 Codex rollout，查看对话、工具调用和每个阶段的原始记录。'];
  if (entries.value.length || props.tab === 'trace') return null;
  if (props.tab === 'conversation') return ['message', '这里还没有对话', durationReached.value
    ? '当前来源没有匹配内容。可切换对话来源，或到 Events 查看运行通知，原始记录保留全部内容。'
    : '继续播放或拖动进度查看后续记录。也可调整搜索与回合筛选。'];
  if (props.tab === 'tools') return ['tools', '当前没有工具调用', '播放到调用位置后，这里会显示参数、状态与已到达的结果。'];
  if (props.tab === 'events') return ['clock', '当前没有事件', '继续播放，或调整搜索与显示选项。'];
  return ['token', '当前没有 Token 统计', tokens.value ? '统计记录尚未到达当前播放位置，或不符合筛选条件。'
    : '这份日志没有 token_count 用量快照，不能估算消息或工具的 Token 消耗。'];
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
      <p class="projection-note">{{ sourceNames[source] }} · 两类来源独立展示，不自动混合补齐。{{ source === 'requestSnapshots' ? '每次模型请求分别展示，不代表用户再次提交，不计入消息数。' : '' }}</p>
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
                :phase="phase" :output-visible="outputVisible" :replay-ended="replayEnded" :trace-info="traceInfo"
                :selected="selectedStepId === step.id" :open="isOpen(step.kind, step.id)" v-on="stepEvents" />
            </div>
          </div>
        </div>
        <FeedStep v-else :mode="block.kind" :step="block.first" :trace-info="traceInfo"
          :selected="selectedStepId === block.first.id" :open="isOpen('event', block.first.id)" v-on="stepEvents" />
      </template>
    </template>
    <template v-else-if="tab === 'events'">
      <p class="panel-note">运行事件独立于对话来源，保留日志中的每条通知。L 表示原始 JSONL 行号。</p>
      <div class="event-list">
        <FeedStep v-for="{step, outputVisible} in entries" :key="`${active.id}:${step.id}`" mode="event" :step="step"
          :related="relatedSteps.get(step.id)" :output-visible="outputVisible" :selected="selectedStepId === step.id"
          :open="isOpen('event', step.id)" v-on="stepEvents" />
      </div>
    </template>
    <template v-else-if="tab === 'tools'">
      <p class="panel-note">调用状态随回放位置变化。耗时为日志实测区间，MCP 报告耗时另列于详情。并行只根据已知区间重叠标记。</p>
      <FeedStep v-for="{step, phase, outputVisible} in entries" :key="`${active.id}:${step.id}`" mode="tool" :step="step"
        :phase="phase" :output-visible="outputVisible" :replay-ended="replayEnded"
        :selected="selectedStepId === step.id" :open="isOpen('tool', step.id)" v-on="stepEvents" />
    </template>
    <template v-else>
      <div class="token-view-summary">
        <div><span>全会话累计 Token</span><br><strong>{{ number(tokens?.total_tokens) }}</strong></div>
        <span>{{ entries.length }} 个已到达的用量记录</span>
      </div>
      <p class="panel-note">{{ usageNote }}缓存输入与推理输出分别是输入、输出的子集，不能再次加到总数，也不能精确分摊到单条消息。</p>
      <div class="table-scroll">
        <table class="token-table">
          <thead><tr><th>记录位置</th><th>输入</th><th>缓存输入</th><th>输出</th><th>推理输出</th><th>区间总数</th></tr></thead>
          <tbody>
            <tr v-for="{step} in entries" :key="step.id">
              <td><button type="button" class="event-meta-button" :data-seek-step="step.id" @click="seek(step.id, false)">L{{ step.line }} · {{ clock(step.atMs) }}</button></td>
              <td v-for="field in usageFields" :key="field">{{ number(step.usage?.[field]) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>
