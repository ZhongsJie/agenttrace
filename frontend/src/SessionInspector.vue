<script setup>
import {computed} from 'vue';
import CodePreview from './CodePreview.vue';
import Icon from './Icon.vue';
import {clock, duration, modelName, number} from './presentation.js';

const props = defineProps({active: Object, tab: String, selectedStepId: Number, preferences: Object});
const emit = defineEmits(['change-tab', 'preference', 'inspect', 'browse', 'copy']);
const tabs = {overview: 'Overview', metrics: 'Metrics', details: 'Details'};
const options = [
  {id: 'show-content', key: 'content', label: '对话内容'},
  {id: 'show-reasoning', key: 'reasoning', label: '深度思考'},
  {id: 'show-context', key: 'contexts', label: '系统事件与上下文'},
];
const eventLabels = {
  thread_settings_applied: '会话配置已应用', token_count: 'Token 用量更新',
  system: '系统提示', developer: '开发者提示', context: '上下文压缩',
};
const eventOrigins = {client_event: '客户端事件', request_snapshot: '请求快照', trace_payload: 'Trace payload'};
const session = computed(() => props.active?.session);
const model = computed(() => props.active?.model);
const metrics = computed(() => model.value?.metrics);
const usage = computed(() => metrics.value?.tokens);
const records = computed(() => props.active?.rawRecords ?? []);
const invalidCount = computed(() => records.value.filter(record => !record.valid).length);
const selected = computed(() => model.value?.steps.find(step => step.id === props.selectedStepId));

const overview = computed(() => [
  ['clock', '记录跨度', duration(metrics.value?.recordedDurationMs)],
  ['layers', '实际回合', metrics.value?.turns],
  ['message', '对话消息', metrics.value?.messages],
  ['cube', '工具调用', metrics.value?.toolCalls],
]);
const executionFacts = computed(() => {
  const stats = metrics.value;
  return [
    ['记录跨度', duration(stats.recordedDurationMs)],
    ['实际回合', stats.turns],
    ...session.value.turns.map((turn, index) => [`回合 ${index + 1} 报告耗时`, duration(turn.duration)]),
    ['明文对话消息', stats.messages],
    ['工具调用', stats.toolCalls],
    ['重叠调用', session.value.tools.filter(tool => tool.parallel).length],
    ['回放时间模式', model.value.timing === 'recorded' ? '日志时间' : '等间距展示时间'],
  ];
});
const details = computed(() => {
  const {meta, context, records, warnings} = session.value;
  return [
    ['Session ID', meta.id || meta.session_id],
    ['模型', modelName(props.active)],
    ['Provider', meta.model_provider || meta.model_provider_id],
    ['CLI', meta.cli_version],
    ['工作目录', context.cwd || meta.cwd],
    ['原始记录', records.length],
    ['解析警告', warnings.length],
  ];
});
const selectedDocuments = computed(() => {
  const step = selected.value;
  const record = records.value.find(item => item.line === step.line);
  const location = {line: step.line, scope: 'session'};
  return [
    ...(record ? [{id: `selected-record-${step.id}`, spec: {source: record.source, title: '原始事件记录', language: record.valid ? 'json' : 'text', ...location}}] : []),
    {id: `selected-content-${step.id}`, spec: {source: step.body, title: '事件内容', ...location}},
  ];
});
const sessionDocuments = computed(() => [
  {id: 'session-meta', spec: {source: session.value.meta, title: '会话元数据', language: 'json', scope: 'session'}},
  {id: 'turn-context', spec: {source: session.value.context, title: '回合上下文', language: 'json', scope: 'session'}},
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
  const origin = Object.hasOwn(eventOrigins, step.origin) ? eventOrigins[step.origin] : step.origin || '记录';
  return `L${step.line} · +${duration(step.atMs)} · ${origin}`;
}

function copyOriginal(spec, event) {
  const {source} = globalThis.AgentFormat.document(spec.source);
  emit('copy', source, event.currentTarget);
}
</script>

<template>
  <aside class="inspector panel">
    <div class="inspector-tabs" role="tablist" aria-label="会话分析">
      <button v-for="(label, name) in tabs" :key="name" type="button" :data-inspector="name" :class="{active: tab === name}" role="tab"
        :aria-selected="tab === name" @click="emit('change-tab', name)">{{ label }}</button>
    </div>
    <div class="inspector-scroll">
      <div id="inspector-body" :key="active?.id">
        <section v-if="!active || tab === 'overview'" class="inspector-section">
          <h2>Session Overview</h2>
          <p class="section-caption">{{ session ? `全会话统计 · ${session.records.length} 条原始记录` : '导入日志后，这里显示全会话的执行统计与原始上下文。' }}</p>
          <div class="overview-grid">
            <div v-for="[name, label, value] in overview" :key="name" class="overview-card">
              <span class="metric-icon"><Icon :name="name" /></span>
              <div><span class="label">{{ label }}</span><strong>{{ value ?? '未知' }}</strong></div>
            </div>
          </div>
        </section>
        <template v-if="active && (tab === 'overview' || tab === 'metrics')">
          <section v-if="tab === 'metrics'" class="inspector-section">
            <h2>完整执行指标</h2>
            <p class="section-caption">以下为全会话统计，不受搜索和播放位置影响。</p>
            <dl class="facts-list">
              <div v-for="[label, value] in executionFacts" :key="label" class="fact"><dt>{{ label }}</dt><dd>{{ value ?? '未知' }}</dd></div>
            </dl>
          </section>
          <section class="inspector-section">
            <h2>Token Usage</h2>
            <div class="token-summary">
              <div class="token-total"><span>Total</span><strong>{{ number(usage?.total_tokens) }}</strong></div>
              <div class="token-breakdown">
                <div><span class="legend-label"><i class="legend-square"></i>输入 / 缓存</span><b>{{ number(usage?.input_tokens) }} / {{ number(usage?.cached_input_tokens) }}</b></div>
                <div><span class="legend-label"><i class="legend-square output"></i>输出 / 推理</span><b>{{ number(usage?.output_tokens) }} / {{ number(usage?.reasoning_output_tokens) }}</b></div>
              </div>
            </div>
            <template v-if="chart">
              <div class="token-chart">
                <svg viewBox="0 0 300 86" preserveAspectRatio="none" role="img" :aria-label="`累计 Token 用量，${chart.points.length} 个实际用量记录`">
                  <defs><linearGradient id="usage-gradient" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#7660f8" stop-opacity=".22"/><stop offset="1" stop-color="#7660f8" stop-opacity=".02"/></linearGradient></defs>
                  <path :d="chart.area" fill="url(#usage-gradient)"/>
                  <path d="M0 82H300" stroke="var(--border)" stroke-width="1"/>
                  <polyline :points="chart.line" fill="none" stroke="#7254ff" stroke-width="2" vector-effect="non-scaling-stroke"/>
                  <circle v-for="([x, y], index) in chart.points" :key="index" :cx="x" :cy="y" r="1.6" fill="#7254ff"/>
                </svg>
              </div>
              <div class="chart-caption"><span>+{{ clock(chart.first) }}</span><span>{{ chart.points.length }} 个用量记录</span><span>+{{ clock(chart.last) }}</span></div>
            </template>
            <p v-else class="diagnostic-note">没有可绘制的用量快照。</p>
          </section>
          <section class="inspector-section">
            <h2>工具调用耗时</h2>
            <div class="tool-time-list">
              <div v-for="tool in metrics.toolTotals" :key="tool.name" class="tool-time-item">
                <div class="tool-time-heading">
                  <Icon name="tools" /><strong :title="tool.name">{{ tool.name }}</strong><span>×{{ tool.count }}</span>
                  <b>{{ tool.knownCount ? duration(tool.totalDurationMs) : '未知' }}</b>
                </div>
                <div class="tool-time-rail"><i :style="{width: `${tool.knownCount ? tool.totalDurationMs / toolMax * 100 : 0}%`}"></i></div>
                <p v-if="tool.unknownCount" class="tool-time-footnote">{{ tool.unknownCount }} 次调用缺少完整区间，未计入耗时合计。</p>
              </div>
              <p v-if="!metrics.toolTotals.length" class="diagnostic-note">没有工具调用。</p>
            </div>
          </section>
          <p v-if="tab === 'metrics'" class="diagnostic-note">调用区间合计会在并行时重复覆盖墙钟时间，不能当作会话总耗时。</p>
        </template>
        <template v-else-if="active">
          <section class="inspector-section">
            <h2>Session Details</h2>
            <p class="section-caption">全会话原始信息，不随回放位置截断。</p>
            <dl class="facts-list">
              <div v-for="[label, value] in details" :key="label" class="fact"><dt>{{ label }}</dt><dd>{{ value ?? '未知' }}</dd></div>
            </dl>
          </section>
          <section v-if="selected" :key="selected.id" class="selected-event-view">
            <div class="selected-event-heading">
              <div><h3>{{ selectedTitle(selected) }}</h3><p>{{ selectedSource(selected) }}</p></div>
              <button type="button" class="mini-button" :data-browse-records="selected.line" @click="emit('browse', selected.line, $event.currentTarget)">在记录中查看</button>
            </div>
            <CodePreview v-for="{id, spec} in selectedDocuments" :key="id" :code-id="`${active.id}:${id}`" :source="spec.source" :title="spec.title" :language="spec.language"
              @inspect="emit('inspect', spec, $event.currentTarget)" @copy="copyOriginal(spec, $event)" />
          </section>
          <p v-else class="diagnostic-note">在 Events 或时间线上选择事件，可查看格式化内容与对应原始记录。</p>
          <p v-if="session.warnings.length" class="diagnostic-note warning">{{ session.warnings.join('\n') }}</p>
          <p v-else class="diagnostic-note">JSONL 解析未发现坏行。</p>
          <details v-for="{id, spec} in sessionDocuments" :key="id" class="detail-disclosure">
            <summary>{{ spec.title }}</summary>
            <CodePreview :code-id="`${active.id}:${id}`" :source="spec.source" :title="spec.title" :language="spec.language"
              @inspect="emit('inspect', spec, $event.currentTarget)" @copy="copyOriginal(spec, $event)" />
          </details>
          <section class="raw-records-launcher">
            <div><h3>全部原始记录</h3><p>{{ records.length }} 条非空记录 · {{ invalidCount }} 条无效 JSON</p></div>
            <button type="button" class="button secondary" data-browse-records="0" @click="emit('browse', 0, $event.currentTarget)">浏览原始记录</button>
            <p class="diagnostic-note">在大尺寸查看区按行浏览、搜索和筛选，保留原始行号与未解析的记录。</p>
          </section>
        </template>
      </div>
      <section class="display-options">
        <h2>显示选项</h2>
        <label v-for="option in options" :key="option.key"><input :id="option.id" type="checkbox" :checked="preferences?.[option.key]"
          @change="emit('preference', option.key, $event.target.checked)">{{ option.label }}</label>
        <div class="privacy-note"><span id="info-icon"><Icon name="info" /></span><p>时间为日志记录时间，不等于模型生成耗时。右侧统计覆盖全会话，不随播放进度变化。</p></div>
      </section>
    </div>
  </aside>
</template>
