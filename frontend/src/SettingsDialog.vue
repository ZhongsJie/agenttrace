<script setup>
import {ref, watch} from 'vue';

const props = defineProps({open: Boolean, settings: Object, diagnostics: String, serverMode: Boolean, busy: Boolean});
const emit = defineEmits(['close', 'save']);
const dialog = ref(null);
watch(() => props.open, open => {
  if (open && !dialog.value.open) dialog.value.showModal();
  else if (!open && dialog.value.open) dialog.value.close();
});
</script>

<template>
  <dialog id="settings-dialog" ref="dialog" class="settings-dialog" aria-labelledby="settings-title" @close="!$event.currentTarget.open && emit('close')">
    <header><div><h2 id="settings-title">Settings</h2><p>保存本机目录配置，在 Session 列表刷新后生效。</p></div><button id="settings-close" type="button" class="mini-button" @click="emit('close')">关闭 ×</button></header>
    <div class="settings-fields">
      <label>Codex 会话目录<input id="settings-session-root" v-model="settings.sessionRoot" type="text" placeholder="/path/to/sessions" autocomplete="off" spellcheck="false"><small>递归扫描年份、月份等子目录中的 rollout-*.jsonl。</small></label>
      <label>Trace 目录<input id="settings-trace-root" v-model="settings.traceRoot" type="text" placeholder="/path/to/codex-traces" autocomplete="off" spellcheck="false"><small>从第一条 Trace 元数据匹配唯一会话，冲突或未匹配项不会绑定。</small></label>
      <label>额外会话目录<textarea id="settings-extra-roots" v-model="settings.additionalRoots" rows="3" placeholder="每行一个本机目录" spellcheck="false"></textarea><small>保存到本机配置，与主会话目录一起递归扫描。</small></label>
    </div>
    <div class="settings-actions"><button id="settings-save" type="button" class="button primary" :disabled="!serverMode || !settings.ready || busy" @click="emit('save')">保存配置</button></div>
    <p id="settings-status" class="settings-status" role="status" aria-live="polite">{{ settings.status }}</p>
    <details class="settings-diagnostics"><summary>目录与关联诊断</summary><pre id="settings-diagnostics">{{ diagnostics }}</pre></details>
  </dialog>
</template>
