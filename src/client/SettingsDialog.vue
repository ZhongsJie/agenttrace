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
    <header><div><h2 id="settings-title">Settings</h2><p>Save your local directory settings, then refresh the session list to apply them.</p></div><button id="settings-close" type="button" class="mini-button" @click="emit('close')">Close ×</button></header>
    <div class="settings-fields">
      <label>Codex session directory<input id="settings-session-root" v-model="settings.sessionRoot" type="text" placeholder="/path/to/sessions" autocomplete="off" spellcheck="false"><small>Scans year, month, and other subdirectories for rollout-*.jsonl files.</small></label>
      <label>Trace directory<input id="settings-trace-root" v-model="settings.traceRoot" type="text" placeholder="/path/to/codex-traces" autocomplete="off" spellcheck="false"><small>Uses metadata from the first trace record to match a single session. Ambiguous or unmatched traces are not linked.</small></label>
      <label>Additional session directories<textarea id="settings-extra-roots" v-model="settings.additionalRoots" rows="3" placeholder="One local directory per line" spellcheck="false"></textarea><small>Saved in local settings and scanned recursively along with the main session directory.</small></label>
    </div>
    <div class="settings-actions"><button id="settings-save" type="button" class="button primary" :disabled="!serverMode || !settings.ready || busy" @click="emit('save')">Save settings</button></div>
    <p id="settings-status" class="settings-status" role="status" aria-live="polite">{{ settings.status }}</p>
    <details class="settings-diagnostics"><summary>Directory and trace matching diagnostics</summary><pre id="settings-diagnostics">{{ diagnostics }}</pre></details>
  </dialog>
</template>
