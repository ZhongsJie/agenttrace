<script setup>
import {computed} from 'vue';
import Icon from './Icon.vue';
import {clock, duration} from './presentation.js';

const props = defineProps({
  active: {type: Object, default: null},
  snapshot: {type: Object, default: null},
});
const emit = defineEmits(['toggle', 'step', 'seek', 'speed', 'seek-step']);

const trackLabels = {user: 'User', agent: 'Agent', tool: 'Tool'};
const rates = [0.25, 0.5, 1, 2, 4, 8, 16];
const model = computed(() => props.active?.model);
const state = computed(() => model.value ? props.snapshot?.state : null);
const total = computed(() => model.value?.durationMs ?? 0);
const position = computed(() => Math.max(0, state.value?.positionMs ?? total.value));
const progress = computed(() => total.value ? Math.min(100, position.value / total.value * 100) : 0);
const canPlay = computed(() => total.value > 0 && model.value.timeline.length > 0);
const playing = computed(() => state.value?.status === 'playing');

const timingNote = computed(() => {
  if (!model.value) return '时间线按日志记录时间回放。消息记录时间不代表生成耗时。';
  if (model.value.timing === 'presentation') return '部分记录缺少时间戳，使用等间距展示时间。实测耗时仍以原始日志为准。';
  return '按日志记录时间回放。标记表示事件落盘，消息记录时间不等于生成耗时。';
});

const tracks = computed(() => {
  const replay = model.value;
  const span = replay?.durationMs || 1;
  const steps = new Map(replay?.steps.map(step => [step.id, step]));
  return Object.entries(trackLabels).map(([kind, label]) => {
    const laneEnds = [];
    const marks = (replay?.tracks[kind] || []).map(mark => {
      let lane = 0;
      const tool = kind === 'tool';
      if (tool) {
        while (lane < laneEnds.length && laneEnds[lane] > mark.atMs) lane++;
        laneEnds[lane] = mark.endMs ?? mark.atMs + 1;
      }
      const left = Math.min(99.2, Math.max(0, mark.atMs / span * 100));
      const width = tool && Number.isFinite(mark.endMs) ? Math.max(0.65, (mark.endMs - mark.atMs) / span * 100) : 0.65;
      const parallel = mark.parallelGroup;
      const title = `${mark.title || label} · +${duration(mark.atMs)}${tool ? ' · ' + duration(steps.get(mark.stepId)?.duration) : ''}${parallel ? ` · 并行组 ${parallel}` : ''}`;
      return {
        stepId: mark.stepId,
        parallel,
        title,
        style: {left: `${left}%`, width: `${Math.min(100 - left, width)}%`, top: `${lane * 15 - 1}px`},
      };
    });
    return {kind, label, marks, height: `${Math.max(1, laneEnds.length) * 15 - 4}px`};
  });
});
</script>

<template>
  <section class="playback-panel panel" aria-label="原生播放控制">
    <div class="transport">
      <div class="transport-buttons">
        <button id="previous" type="button" class="round-button" aria-label="上一个事件"
          title="上一个事件 · 左方向键" :disabled="!canPlay || position <= 0" @click="emit('step', -1)">
          <Icon name="previous" />
        </button>
        <button id="play" type="button" class="round-button play-button" :aria-label="playing ? '暂停' : '播放'"
          title="播放或暂停 · 空格键" :disabled="!canPlay" @click="emit('toggle')">
          <Icon :name="playing ? 'pause' : 'play'" />
        </button>
        <button id="next" type="button" class="round-button" aria-label="下一个事件"
          title="下一个事件 · 右方向键" :disabled="!canPlay || position >= total" @click="emit('step', 1)">
          <Icon name="next" />
        </button>
      </div>
      <span id="elapsed" class="time-label" :title="model ? duration(position) : null">{{ clock(position) }}</span>
      <input id="seek" class="seek" type="range" min="0" :max="Math.max(1, total)" :value="position" step="1"
        aria-label="回放进度" :disabled="!canPlay" :style="{'--progress': `${progress}%`}"
        :title="model ? `${duration(position)} / ${duration(total)}` : null" @input="emit('seek', Number($event.target.value))">
      <span id="time-total" class="time-label total-time">{{ clock(position) }} / {{ clock(total) }}</span>
      <select id="speed" class="compact-select speed-select" aria-label="播放速度"
        :value="state?.speed ?? 1" :disabled="!canPlay" @change="emit('speed', Number($event.target.value))">
        <option v-for="rate in rates" :key="rate" :value="rate">{{ rate }}×</option>
      </select>
    </div>
    <div id="tracks" class="activity-tracks">
      <div v-for="track in tracks" :key="track.kind" class="activity-track">
        <span>{{ track.label }}</span>
        <div class="track-rail" :style="{height: track.height}">
          <button v-for="mark in track.marks" :key="mark.stepId" type="button"
            :class="['track-mark', track.kind, {parallel: mark.parallel}]" :data-track-step="mark.stepId"
            :title="mark.title" :aria-label="`定位 ${mark.title}`" :style="mark.style" @click="emit('seek-step', mark.stepId, true)"></button>
          <span v-if="model" class="track-cursor" :style="{left: `${Math.min(99.9, progress)}%`}"></span>
        </div>
      </div>
    </div>
    <p id="timing-note" class="timing-note">{{ timingNote }}</p>
  </section>
</template>
