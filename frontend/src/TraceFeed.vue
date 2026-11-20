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
const labels = {completed: '已完成', failed: '失败', error: '错误', cancelled: '已取消', canceled: '已取消', running: '未结束', incomplete: '不完整'};
const traceStatus = status => Object.hasOwn(labels, status) ? labels[status] : status || '未知状态';
const info = computed(() => props.active.traceInfo);
const missing = computed(() => {
  const {status, serverMode} = props;
  const title = '当前会话没有匹配的 Codex Trace';
  if (!serverMode) return {title, detail: '当前为离线报告，无法检查本机 Trace 目录配置。请通过 npm start 启动并在左下角 Settings 检查目录。'};
  if (!status) return {title, detail: '尚未取得 Trace 目录扫描状态。请打开左下角 Settings 重新扫描。'};
  if (!status.configured) return {title: '尚未配置 Trace 目录', detail: '请在左下角 Settings 设置 Trace 目录，或在首次启动查看器时设置 CODEX_ROLLOUT_TRACE_ROOT。'};
  if (status.warnings.length) return {title: 'Trace 目录扫描异常', detail: `已配置目录 ${status.directory}。${status.warnings.join('；')}。请在左下角 Settings 检查目录并重新扫描。`};
  return {title, detail: `已配置目录 ${status.directory}，扫描到 ${status.bundles} 份 Trace，但未找到与当前会话 ID 严格匹配的记录。请确认目录正确，以及该会话是否开启了 Trace 采集。`};
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
    {id: 'requests', title: '模型请求与响应', total: inferences.length, empty: '没有匹配的模型请求。', cards: inferences.filter(matches).map(span => ({
      span,
      title: span.model || '未知模型',
      facts: [
        ['请求到响应', duration(span.durationMs)],
        ['本次 Token', number(span.tokenUsage?.total_tokens)],
        ['输入 / 输出', `${number(span.tokenUsage?.input_tokens)} / ${number(span.tokenUsage?.output_tokens)}`],
      ],
      location: `来源 L${span.startLine ?? '?'} 至 L${span.endLine ?? '?'} · ${span.provider || '未知 provider'}`,
      payloads: [['请求 Payload', span.requestPath], ['响应 Payload', span.responsePath]],
    }))},
    {id: 'tools', title: '工具执行阶段', total: tools.length, empty: '没有匹配的工具调用。', cards: tools.filter(matches).map(span => ({
      span,
      title: span.name || '未知工具',
      facts: [
        ['调度至结果', duration(span.durationMs)],
        ['Runtime 事件区间', duration(span.runtimeDurationMs)],
        ['工具报告执行耗时', Number.isFinite(span.reportedExecutionMs) ? `${span.reportedExecutionMs.toFixed(6)} ms` : '未知'],
      ],
      payloads: [['调用参数', span.invocationPath], ...(span.runtimePaths || []).map((path, index) => [`Runtime ${index + 1}`, path]), ['调用结果', span.resultPath]],
    }))},
  ];
});
const manifest = computed(() => ({source: info.value.manifest, title: 'Trace Manifest', language: 'json', scope: 'session'}));
const inspect = (spec, opener) => emit('inspect', spec, opener);
const copy = (text, opener) => emit('copy', text, opener);

function openTrace(event) {
  inspect({source: info.value.source, title: '原始 trace.jsonl', language: 'jsonl', scope: 'session'}, event.currentTarget);
}

function openEvent(entry, event) {
  const {line, raw} = entry;
  inspect({source: lines.value[line - 1] || textOf(raw), title: `Trace 事件 · L${line}`, language: 'json', scope: 'session', line}, event.currentTarget);
}
</script>

<template>
  <div v-if="!info" class="empty-state">
    <div class="empty-icon"><Icon name="folder" /></div>
    <h2>{{ missing.title }}</h2>
    <p>{{ missing.detail }} 采集端启动 Codex 时需设置 CODEX_ROLLOUT_TRACE_ROOT；查看器无法从缺失记录判断当时是否启用。变量名是 ROLLOUT，而非 ROOLOUT。已有会话不会因现在配置目录而自动补采集。</p>
  </div>
  <section v-else class="trace-analysis">
    <header class="trace-analysis-heading">
      <div>
        <h2>Codex Trace</h2>
        <label v-if="active.traces?.length > 1" class="trace-selector-label">采集记录
          <select id="trace-selector" class="compact-select" aria-label="选择当前会话的 Trace" :value="active.traceIndex ?? 0"
            @change="emit('choose-trace', Number($event.target.value))">
            <option v-for="(item, index) in active.traces" :key="item.key ?? index" :value="index">{{ item.bundle.name || item.traceInfo.traceId || String(index + 1) }}</option>
          </select>
        </label>
        <p>全会话分析，不随回放位置截断。请求、响应与运行阶段保留各自的时间口径。</p>
      </div>
      <button type="button" class="mini-button trace-document-button" data-code-action="expand" @click="openTrace">查看 trace.jsonl</button>
    </header>
    <div class="trace-identities"><span>Trace {{ info.traceId || '未知' }}</span><span>Rollout {{ info.rolloutId || info.rootThreadId || '未知' }}</span></div>
    <div class="trace-summary">
      <div><span>模型请求</span><strong>{{ info.inferences.length }}</strong></div>
      <div><span>工具调用</span><strong>{{ info.tools.length }}</strong></div>
      <div><span>线程</span><strong>{{ info.threads.length }}</strong></div>
      <div><span>已记录响应 Token</span><strong>{{ number(traceUsage) }}</strong></div>
    </div>
    <p class="panel-note">Trace 响应用量按唯一模型调用累计，不与 rollout 用量再次相加。合计只包含有记录的响应，缺失用量不做估算。调度区间、Runtime 事件区间与工具报告耗时不可互相替代。请求快照不提供精确的用户提交时间。</p>
    <section v-for="section in sections" :key="section.id" class="trace-analysis-section">
      <h2>{{ section.title }} <small>{{ section.cards.length }} / {{ section.total }}</small></h2>
      <p v-if="!section.cards.length" class="diagnostic-note">{{ section.empty }}</p>
      <article v-for="(card, index) in section.cards" :key="`${card.span.id}:${card.span.threadId}:${card.span.turnId}:${index}`" class="trace-call-card">
        <header><div><h3>{{ card.title }}</h3><p class="trace-call-id">{{ card.span.id }}</p></div><span class="trace-status">{{ traceStatus(card.span.status) }}</span></header>
        <div class="trace-call-meta"><span class="trace-thread">{{ card.span.threadId || '未知线程' }}</span><span>{{ card.span.turnId || '未知回合' }}</span></div>
        <div class="trace-facts"><div v-for="[label, value] in card.facts" :key="label"><span>{{ label }}</span><strong>{{ value }}</strong></div></div>
        <p v-if="card.location" class="trace-source-location">{{ card.location }}</p>
        <div class="trace-payload-actions">
          <TracePayload v-for="[label, path] in card.payloads" :key="label" :path="path" :label="label" :payloads="info.payloads" @inspect="inspect" />
        </div>
      </article>
    </section>
    <section class="trace-analysis-section">
      <h2>线程 <small>{{ threads.length }} / {{ info.threads.length }}</small></h2>
      <div class="trace-thread-list">
        <article v-for="thread in threads" :key="thread.id">
          <div>
            <strong>{{ thread.agentPath || '未记录 Agent 路径' }}</strong><p>{{ thread.id }}</p>
            <small>{{ thread.model || '未知模型' }} · {{ thread.provider || '未知 provider' }}</small>
          </div>
          <TracePayload :path="thread.metadataPath" label="线程元数据" :payloads="info.payloads" @inspect="inspect" />
        </article>
        <p v-if="!threads.length" class="diagnostic-note">没有匹配的线程。</p>
      </div>
    </section>
    <details class="trace-inventory">
      <summary>原始事件 · {{ info.events.length }} 条</summary>
      <div class="trace-event-list">
        <div v-for="event in events" :key="event.line">
          <span>L{{ event.line }}</span><strong>{{ event.type }}</strong><small>{{ event.threadId || '' }}</small>
          <button type="button" class="mini-button trace-document-button" data-code-action="expand" @click="openEvent(event, $event)">查看记录</button>
        </div>
        <p v-if="!events.length" class="diagnostic-note">没有匹配的事件。</p>
      </div>
    </details>
    <details class="trace-inventory">
      <summary>关联数据文件 · {{ payloads.length }} 个</summary>
      <div class="trace-payload-inventory">
        <div v-for="payload in payloads" :key="payload.path">
          <code>{{ payload.path }}</code><span v-if="payload.error" class="trace-payload-missing">{{ payload.error }}</span>
          <TracePayload :path="payload.path" label="查看 Payload" :payloads="info.payloads" @inspect="inspect" />
        </div>
        <p v-if="!payloads.length" class="diagnostic-note">没有可用的关联数据。</p>
      </div>
    </details>
    <details class="trace-inventory">
      <summary>Manifest</summary><FeedCode :spec="manifest" @inspect="inspect" @copy="copy" />
    </details>
    <section v-if="info.diagnostics.length" class="trace-diagnostics">
      <h2>解析诊断</h2><ul><li v-for="message in info.diagnostics" :key="message">{{ message }}</li></ul>
    </section>
  </section>
</template>
