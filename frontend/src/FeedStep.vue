<script setup>
import {computed, h} from 'vue';
import Icon from './Icon.vue';
import FeedCode from './FeedCode.vue';
import {duration, textOf} from './presentation.js';

const props = defineProps({
  mode: {type: String, required: true},
  step: {type: Object, required: true},
  phase: String,
  outputVisible: Boolean,
  replayEnded: Boolean,
  traceInfo: Object,
  selected: Boolean,
  open: Boolean,
  related: Array,
});
const emit = defineEmits(['toggle', 'select', 'seek', 'copy', 'inspect', 'browse']);
const originLabels = {client_event: '客户端事件', request_snapshot: '请求快照', trace_payload: 'Trace payload'};
const titleLabels = {thread_settings_applied: '会话配置已应用', token_count: 'Token 用量更新', system: '系统提示', developer: '开发者提示', context: '上下文压缩'};
const sourceLabel = computed(() => {
  const {line, atMs, origin} = props.step;
  return `L${line} · +${duration(atMs)} · ${Object.hasOwn(originLabels, origin) ? originLabels[origin] : origin || '记录'}`;
});
const eventTitle = computed(() => {
  const {title, kind} = props.step;
  if (Object.hasOwn(titleLabels, title)) return titleLabels[title];
  if (Object.hasOwn(titleLabels, kind)) return titleLabels[kind];
  return title || kind;
});
const body = computed(() => textOf(props.step.body));
const noResult = computed(() => props.step.endAtMs == null);
const toolState = computed(() => {
  if (props.phase === 'missing_start') return {class: 'unknown', icon: 'info', label: '缺少起点'};
  if (props.phase === 'running') return {class: 'running', icon: 'clock', label: noResult.value && props.replayEnded ? '未记录结果' : '执行中'};
  return {class: '', icon: 'check', label: '已完成'};
});
const nonText = computed(() => {
  const {content} = props.step;
  if (Array.isArray(content)) return content.filter(item => item && typeof item.text !== 'string').map(item => item.type || '非文本内容');
  return ['images', 'local_images', 'file_ids', 'audio', 'local_audio'].flatMap(field => Array.isArray(content?.[field]) ? content[field].map(() => field) : []);
});
const sourcePayload = computed(() => {
  const {payloadPath} = props.step;
  const payload = payloadPath && props.traceInfo?.payloads[payloadPath];
  if (typeof payload?.source === 'string') return {source: payload.source, title: payloadPath, language: 'json', scope: 'session'};
  return null;
});
const card = computed(() => {
  const {mode, step} = props;
  if (mode === 'tool') return {class: 'tool-card', kind: 'tool', title: '调用参数', outputTitle: '执行结果'};
  if (mode === 'reasoning') return {class: 'reasoning-block', kind: 'reasoning'};
  if (mode === 'context') return {class: 'system-entry', kind: 'event', title: eventTitle.value};
  if (mode === 'event') return {class: 'event-item', kind: 'event', title: '事件内容', outputTitle: step.kind === 'tool' ? '工具结果' : null};
  return null;
});
const bodyCode = computed(() => ({source: props.step.body, title: card.value.title, scope: 'playback', stepId: props.step.id, field: 'body', line: props.step.line}));
const outputCode = computed(() => ({source: props.step.output, title: card.value.outputTitle, scope: 'playback', stepId: props.step.id, field: 'output', line: props.step.resultLine}));
const inspect = (spec, opener) => emit('inspect', spec, opener);
const copy = (text, opener) => emit('copy', text, opener);

function toggle(event) {
  const detail = event.currentTarget;
  if (detail.isConnected) emit('toggle', card.value.kind, props.step.id, detail.open);
}

function copyButton(extraClass = '') {
  return h('button', {
    type: 'button', class: ['icon-button', extraClass], 'data-copy': props.step.id, 'data-copy-field': 'body',
    'aria-label': '复制内容', title: '复制内容',
    onClick: event => { event.stopPropagation(); copy(body.value, event.currentTarget); },
  }, [h(Icon, {name: 'copy'})]);
}
const SummaryCopy = () => copyButton();

function sourceAction() {
  if (sourcePayload.value) return h('button', {
    type: 'button', class: 'mini-button trace-document-button', 'data-code-action': 'expand',
    onClick: event => inspect(sourcePayload.value, event.currentTarget),
  }, '原始 Payload');
  return h('button', {
    type: 'button', class: 'message-source-link', 'data-browse-records': props.step.line,
    onClick: event => emit('browse', props.step.line, event.currentTarget),
  }, `原始记录 L${props.step.line}`);
}
const SourceAction = () => sourceAction();
const Prose = () => h('div', {class: 'prose-wrap'}, [
  h('div', {class: 'message-text'}, body.value),
  nonText.value.length ? h('div', {class: 'content-parts'}, nonText.value.map((type, index) =>
    h('span', {class: 'content-part', key: index}, `${type} · 在原始记录中查看`))) : null,
  props.step.channel ? h('small', {class: 'message-phase'}, props.step.channel) : null,
  copyButton('prose-copy'),
  sourceAction(),
]);
</script>

<template>
  <span v-if="mode === 'source-label'" class="source-line">{{ sourceLabel }}</span>
  <details v-else-if="card" :id="`step-${step.id}`" :class="[card.class, {'active-step': selected && mode !== 'reasoning'}]"
    :data-expand="card.kind" :data-step="step.id" :open="open" @toggle="toggle"
    @click="emit('select', step.id)">
    <summary v-if="mode === 'tool'">
      <span class="tool-name"><Icon name="tools" />{{ step.title }}</span>
      <span class="tool-duration" title="调用发出到结果记录的区间">{{ duration(step.duration) }}</span>
      <span :class="['tool-state', toolState.class]"><Icon :name="toolState.icon" />{{ toolState.label }}</span>
      <span v-if="step.parallel" class="parallel-badge">并行组 {{ step.parallel }}</span>
      <code class="tool-preview">{{ body.replace(/\s+/g, ' ') }}</code>
      <SummaryCopy />
    </summary>
    <summary v-else-if="mode === 'reasoning'">深度思考 <Icon name="chevron" /></summary>
    <summary v-else-if="mode === 'context'"><strong>{{ eventTitle }}</strong><small>{{ sourceLabel }}</small></summary>
    <summary v-else>
      <span class="event-kind">{{ step.kind }}</span><span class="event-title">{{ eventTitle }}</span>
      <span class="event-meta"><button type="button" class="event-meta-button" :data-seek-step="step.id"
        @click.stop.prevent="emit('seek', step.id, false)">{{ sourceLabel }}</button></span>
    </summary>

    <div v-if="mode === 'tool'" class="tool-details">
      <FeedCode :spec="bodyCode" @inspect="inspect" @copy="copy" />
      <div class="tool-call-id">{{ step.callId || '没有 call_id' }} · {{ sourceLabel }}{{ Number.isFinite(step.execution) ? ` · 工具报告执行耗时 ${step.execution.toFixed(3)} ms` : '' }}</div>
      <FeedCode v-if="outputVisible && step.output != null" :spec="outputCode" @inspect="inspect" @copy="copy" />
      <template v-else>
        <h3>执行结果</h3>
        <p class="pending-result">{{ noResult ? '日志未包含调用结果。' : '结果尚未到达当前回放位置。' }}</p>
      </template>
    </div>
    <div v-else-if="mode === 'reasoning'" class="reasoning-text">{{ body }}<div class="reasoning-source">{{ sourceLabel }} <SourceAction /></div></div>
    <template v-else>
      <div v-if="mode === 'event'" class="event-source-refs">
        <button v-for="(ref, index) in step.sourceRefs" :key="index" type="button" class="mini-button" :data-browse-records="ref.line"
          @click="emit('browse', ref.line, $event.currentTarget)">{{ ref.type }} · {{ ref.payloadType || '' }} · L{{ ref.line }}</button>
        <button v-for="(id, index) in related" :key="index" type="button" class="mini-button" :data-related-step="id"
          @click.stop.prevent="emit('seek', id, true)">定位关联条目</button>
      </div>
      <FeedCode :spec="bodyCode" @inspect="inspect" @copy="copy" />
      <FeedCode v-if="card.outputTitle && outputVisible && step.output != null" :spec="outputCode" @inspect="inspect" @copy="copy" />
    </template>
  </details>

  <div v-else-if="mode === 'user'" :id="`step-${step.id}`" class="message-row user-row">
    <div class="user-content" :class="{'active-step': selected}">
      <div class="message-heading">
        <span class="avatar">U</span><strong>User</strong><span class="source-line">{{ sourceLabel }}</span>
        <span v-if="step.origin === 'request_snapshot'" class="snapshot-badge" title="来自模型请求快照，并非独立用户提交事件">请求快照</span>
      </div>
      <Prose />
    </div>
  </div>
  <div v-else-if="mode === 'agent'" :id="`step-${step.id}`" class="prose-wrap">
    <p class="panel-note">Agent 协作 · {{ step.title }}</p>
    <div class="message-text">{{ body }}</div>
  </div>
  <div v-else :id="`step-${step.id}`" :class="{'active-step': selected}"><Prose /></div>
</template>
