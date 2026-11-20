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
  selected: Boolean,
  open: Boolean,
  related: Array,
});
const emit = defineEmits(['toggle', 'select', 'seek', 'copy', 'inspect', 'browse']);
const originLabels = {client_event: 'Client event'};
const titleLabels = {thread_settings_applied: 'Session settings applied', token_count: 'Token usage updated', system: 'System prompt', developer: 'Developer prompt', context: 'Context compaction'};
const sourceLabel = computed(() => {
  const {line, atMs, origin} = props.step;
  return `L${line} · +${duration(atMs)} · ${Object.hasOwn(originLabels, origin) ? originLabels[origin] : origin || 'Record'}`;
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
  if (props.phase === 'missing_start') return {class: 'unknown', icon: 'info', label: 'Missing start'};
  if (props.phase === 'running') return {class: 'running', icon: 'clock', label: noResult.value && props.replayEnded ? 'No result recorded' : 'Running'};
  return {class: '', icon: 'check', label: 'Completed'};
});
const nonText = computed(() => {
  const {content} = props.step;
  if (Array.isArray(content)) return content.filter(item => item && typeof item.text !== 'string').map(item => item.type || 'Non-text content');
  return ['images', 'local_images', 'file_ids', 'audio', 'local_audio'].flatMap(field => Array.isArray(content?.[field]) ? content[field].map(() => field) : []);
});
const card = computed(() => {
  const {mode, step} = props;
  if (mode === 'tool') return {class: 'tool-card', kind: 'tool', title: 'Tool arguments', outputTitle: 'Tool result'};
  if (mode === 'reasoning') return {class: 'reasoning-block', kind: 'reasoning'};
  if (mode === 'context') return {class: 'system-entry', kind: 'event', title: eventTitle.value};
  if (mode === 'event') return {class: 'event-item', kind: 'event', title: 'Event content', outputTitle: step.kind === 'tool' ? 'Tool result' : null};
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
    type: 'button', class: ['icon-button', extraClass],
    'aria-label': 'Copy content', title: 'Copy content',
    onClick: event => { event.stopPropagation(); copy(body.value, event.currentTarget); },
  }, [h(Icon, {name: 'copy'})]);
}
const SummaryCopy = () => copyButton();

function sourceAction() {
  return h('button', {
    type: 'button', class: 'message-source-link',
    onClick: event => emit('browse', props.step.line, event.currentTarget),
  }, `Raw record L${props.step.line}`);
}
const SourceAction = () => sourceAction();
const Prose = () => h('div', {class: 'prose-wrap'}, [
  h('div', {class: 'message-text'}, body.value),
  nonText.value.length ? h('div', {class: 'content-parts'}, nonText.value.map((type, index) =>
    h('span', {class: 'content-part', key: index}, `${type} · View in raw records`))) : null,
  props.step.channel ? h('small', {class: 'message-phase'}, props.step.channel) : null,
  copyButton('prose-copy'),
  sourceAction(),
]);
</script>

<template>
  <span v-if="mode === 'source-label'" class="source-line">{{ sourceLabel }}</span>
  <details v-else-if="card" :id="`step-${step.id}`" :class="[card.class, {'active-step': selected && mode !== 'reasoning'}]"
    :open="open" @toggle="toggle"
    @click="emit('select', step.id)">
    <summary v-if="mode === 'tool'">
      <span class="tool-name"><Icon name="tools" />{{ step.title }}</span>
      <span class="tool-duration" title="Time from dispatch to the recorded result">{{ duration(step.duration) }}</span>
      <span :class="['tool-state', toolState.class]"><Icon :name="toolState.icon" />{{ toolState.label }}</span>
      <span v-if="step.parallel" class="parallel-badge">Parallel group {{ step.parallel }}</span>
      <code class="tool-preview">{{ body.replace(/\s+/g, ' ') }}</code>
      <SummaryCopy />
    </summary>
    <summary v-else-if="mode === 'reasoning'">Reasoning <Icon name="chevron" /></summary>
    <summary v-else-if="mode === 'context'"><strong>{{ eventTitle }}</strong><small>{{ sourceLabel }}</small></summary>
    <summary v-else>
      <span class="event-kind">{{ step.kind }}</span><span class="event-title">{{ eventTitle }}</span>
      <span class="event-meta"><button type="button" class="event-meta-button"
        @click.stop.prevent="emit('seek', step.id, false)">{{ sourceLabel }}</button></span>
    </summary>

    <div v-if="mode === 'tool'" class="tool-details">
      <FeedCode :spec="bodyCode" @inspect="inspect" @copy="copy" />
      <div class="tool-call-id">{{ step.callId || 'No call ID' }} · {{ sourceLabel }}{{ Number.isFinite(step.execution) ? ` · Tool-reported duration: ${step.execution.toFixed(3)} ms` : '' }}</div>
      <FeedCode v-if="outputVisible && step.output != null" :spec="outputCode" @inspect="inspect" @copy="copy" />
      <template v-else>
        <h3>Tool result</h3>
        <p class="pending-result">{{ noResult ? 'The log does not contain a tool result.' : 'The result is not available at this replay position.' }}</p>
      </template>
    </div>
    <div v-else-if="mode === 'reasoning'" class="reasoning-text">{{ body }}<div class="reasoning-source">{{ sourceLabel }} <SourceAction /></div></div>
    <template v-else>
      <div v-if="mode === 'event'" class="event-source-refs">
        <button v-for="(ref, index) in step.sourceRefs" :key="index" type="button" class="mini-button"
          @click="emit('browse', ref.line, $event.currentTarget)">{{ ref.type }} · {{ ref.payloadType || '' }} · L{{ ref.line }}</button>
        <button v-for="(id, index) in related" :key="index" type="button" class="mini-button"
          @click.stop.prevent="emit('seek', id, true)">Jump to related entry</button>
      </div>
      <FeedCode :spec="bodyCode" @inspect="inspect" @copy="copy" />
      <FeedCode v-if="card.outputTitle && outputVisible && step.output != null" :spec="outputCode" @inspect="inspect" @copy="copy" />
    </template>
  </details>

  <div v-else-if="mode === 'user'" :id="`step-${step.id}`" class="message-row user-row">
    <div class="user-content" :class="{'active-step': selected}">
      <div class="message-heading">
        <span class="avatar">U</span><strong>User</strong><span class="source-line">{{ sourceLabel }}</span>
      </div>
      <Prose />
    </div>
  </div>
  <div v-else-if="mode === 'agent'" :id="`step-${step.id}`" class="prose-wrap">
    <p class="panel-note">Agent collaboration · {{ step.title }}</p>
    <div class="message-text">{{ body }}</div>
  </div>
  <div v-else :id="`step-${step.id}`" :class="{'active-step': selected}"><Prose /></div>
</template>
