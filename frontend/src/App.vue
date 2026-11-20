<script setup>
import {computed, nextTick, onMounted, onUnmounted, ref, watch} from 'vue';
import Icon from './Icon.vue';
import SessionHeader from './SessionHeader.vue';
import PlaybackPanel from './PlaybackPanel.vue';
import ReplayFeed from './ReplayFeed.vue';
import SessionInspector from './SessionInspector.vue';
import InspectionDialog from './InspectionDialog.vue';
import SettingsDialog from './SettingsDialog.vue';
import {useWorkspace} from './useWorkspace.js';
import {complete, duration, modelName, number, sessionDate, sessionTitle} from './presentation.js';

const props = defineProps({bootData: {type: Object, required: true}, createReport: {type: Function, required: true}});
const {sessions, active, snapshot, player, selection, page, tab, source, query, turn, selectedStepId, preferences, error, toast, inspection,
  traceStatus, diagnostics, busy, settings, serverMode, header, notify, selectSession, importFiles, openSettings, refresh, setAutoRefresh,
  seekStep, openDocument, browse, chooseTrace, boot, dispose} = useWorkspace(props.bootData);

const sessionQuery = ref('');
const settingsOpen = ref(false);
const replayFeed = ref(null);
const theme = ref(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
watch(theme, value => { document.documentElement.dataset.theme = value; });

const visibleSessions = computed(() => {
  const term = sessionQuery.value.trim().toLowerCase();
  return sessions.filter(entry => `${entry.name} ${modelName(entry)}`.toLowerCase().includes(term));
});
const turns = computed(() => [...new Set((active.value?.model.steps || []).map(step => step.turnIndex).filter(value => value != null))]);
const tabs = {
  conversation: {title: 'Conversation', icon: 'message', search: '搜索对话内容…'},
  events: {title: 'Events', icon: 'clock', search: '搜索事件与原文…'},
  tools: {title: 'Tools', icon: 'tools', search: '搜索工具、参数或结果…'},
  tokens: {title: 'Tokens', icon: 'token', search: '搜索统计记录…'},
  trace: {title: 'Trace', icon: 'activity', search: '搜索 Trace ID、模型或线程…'},
};
const inspectorTab = ref('overview');

function navigate(view) {
  if (view === 'sessions') player.value?.pause();
  page.value = view;
}

function importInput(event) {
  const files = Array.from(event.target.files);
  event.target.value = '';
  importFiles(files);
}

function drop(event) { importFiles(event.dataTransfer.files); }
function preventDropDefault(event) { event.preventDefault(); }

function handleKeys(event) {
  const controller = player.value;
  if (!controller || page.value !== 'trace' || settingsOpen.value || inspection.value || event.altKey || event.ctrlKey || event.metaKey
    || event.target.closest?.('input,textarea,select,button,[contenteditable="true"]')) return;
  if (event.code === 'Space' || event.key.toLowerCase() === 'k') { event.preventDefault(); controller.toggle(); }
  else if (event.key === 'ArrowRight') { event.preventDefault(); controller.step(1); }
  else if (event.key === 'ArrowLeft') { event.preventDefault(); controller.step(-1); }
}

async function locate(id, changeTab) {
  if (!seekStep(id, changeTab)) return;
  replayFeed.value?.expandStep(id);
  await nextTick();
  document.getElementById(`step-${id}`)?.scrollIntoView({behavior: 'smooth', block: 'nearest'});
}

async function copy(text, opener) {
  let copied = false;
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); copied = true; }
  } catch {}
  if (!copied) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.cssText = 'position:fixed;left:-9999px;top:0';
    (opener?.closest('dialog[open]') || document.body).append(textarea);
    textarea.select();
    try { copied = document.execCommand('copy'); } catch {}
    textarea.remove();
    opener?.focus();
  }
  notify(copied ? '已复制。' : '浏览器不支持自动复制，请选中文本复制。');
}

function exportReport() {
  if (!active.value || selection.value.kind === 'loading') return;
  const {name, source: text, traces} = active.value;
  const html = props.createReport({name, text, traceBundles: traces.map(item => item.bundle)}, theme.value);
  const url = URL.createObjectURL(new Blob([html], {type: 'text/html;charset=utf-8'}));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name.split(/[\\/]/).pop().replace(/\.jsonl?$/i, '') + '-replay.html';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify('已导出当前会话的独立 HTML。');
}

onMounted(() => {
  window.addEventListener('keydown', handleKeys);
  window.addEventListener('dragover', preventDropDefault);
  window.addEventListener('drop', preventDropDefault);
  window.addEventListener('drop', drop);
  boot();
});
onUnmounted(() => {
  window.removeEventListener('keydown', handleKeys);
  window.removeEventListener('dragover', preventDropDefault);
  window.removeEventListener('drop', preventDropDefault);
  window.removeEventListener('drop', drop);
  dispose();
});
</script>

<template>
  <header class="topbar">
    <a id="brand-link" class="brand" href="#" aria-label="AgentTrace 轨迹视图" @click.prevent="navigate('trace')">
      <svg viewBox="0 0 28 28" aria-hidden="true"><path d="m14 2 11 6v12l-11 6-11-6V8Zm0 12L3 8m11 6 11-6M14 14v12M8 5l11 6"/></svg><span>AgentTrace</span>
    </a>
    <nav class="primary-nav" aria-label="主导航">
      <button id="trace-view" class="nav-item" :class="{active: page === 'trace'}" :aria-current="page === 'trace' ? 'page' : undefined" @click="navigate('trace')">Trace Viewer</button>
      <button id="sessions-view" class="nav-item" :class="{active: page === 'sessions'}" :aria-current="page === 'sessions' ? 'page' : undefined" @click="navigate('sessions')">Sessions</button>
    </nav>
    <div class="topbar-actions">
      <div class="theme-switch" aria-label="配色主题">
        <button v-for="choice in ['light', 'dark']" :id="`theme-${choice}`" :key="choice" class="icon-button" :class="{active: theme === choice}"
          :aria-pressed="theme === choice" :aria-label="choice === 'light' ? '浅色主题' : '深色主题'" :title="choice === 'light' ? '浅色主题' : '深色主题'" @click="theme = choice"><Icon :name="choice === 'light' ? 'sun' : 'moon'"/></button>
      </div>
      <button id="export" class="button secondary" :disabled="!active || selection.kind === 'loading'" @click="exportReport"><Icon name="export"/><span>Export</span></button>
      <label class="button primary import-label"><Icon name="file"/>上传会话文件<input id="files" type="file" accept=".jsonl,.json" multiple @change="importInput"></label>
    </div>
  </header>

  <div class="workspace">
    <aside class="session-sidebar panel">
      <div class="sidebar-heading">
        <h2>Session</h2>
        <div class="session-actions">
          <span id="session-count" class="count-pill">{{ sessions.length }}</span>
          <button id="session-refresh" class="icon-button" title="刷新会话列表" aria-label="刷新会话列表" :disabled="!serverMode || busy" @click="refresh()">↻</button>
          <label class="auto-refresh"><input id="session-auto-refresh" type="checkbox" :disabled="!serverMode" @change="setAutoRefresh($event.target.checked)">自动刷新</label>
        </div>
      </div>
      <label class="search-field session-search"><Icon name="search"/><input id="session-search" v-model="sessionQuery" type="search" placeholder="搜索会话…" aria-label="搜索已导入会话"></label>
      <div class="sidebar-divider"></div>
      <nav id="session-list" class="session-list" aria-label="会话列表">
        <button v-for="entry in visibleSessions" :key="entry.id" class="session-item" :class="{active: active === entry}" :data-session="entry.id" :title="entry.name" :aria-current="active === entry ? 'true' : undefined" @click="selectSession(entry)">
          <span class="session-dot" :class="complete(entry) ? 'complete' : 'incomplete'"></span>
          <span class="session-text"><strong>{{ sessionTitle(entry) }}</strong><span class="session-meta"><span class="model-short">{{ modelName(entry) }}</span><span>{{ sessionDate(entry) }}</span></span></span>
        </button>
        <p v-if="!visibleSessions.length" class="empty-inline">{{ sessions.length ? '没有匹配的会话。' : '尚未导入日志。选择或拖入 JSONL 文件开始。' }}</p>
      </nav>
      <button id="settings-open" class="button secondary sidebar-settings" @click="settingsOpen = true; openSettings()">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 3-.6 2.4-2 .9-2.2-.7-2 3.4 1.6 1.8v2.4L2.2 15l2 3.4 2.2-.7 2 .9L9 21h4l.6-2.4 2-.9 2.2.7 2-3.4-1.6-1.8v-2.4L19.8 9l-2-3.4-2.2.7-2-.9L13 3Z"/><circle cx="11" cy="12" r="3"/></svg><span>Settings</span>
      </button>
    </aside>

    <main class="center-column">
      <section id="trace-page" class="trace-page" :hidden="page !== 'trace'">
        <section id="session-header" class="session-header panel"><SessionHeader :header="header"/></section>
        <PlaybackPanel :active="active" :snapshot="snapshot" @toggle="player?.toggle()" @step="player?.step($event)" @seek="player?.seek($event)" @speed="player?.setSpeed($event)" @seek-step="locate"/>
        <section class="conversation-panel panel">
          <div class="conversation-toolbar">
            <div class="content-tabs" role="tablist" aria-label="轨迹内容">
              <button v-for="(item, key) in tabs" :key="key" class="content-tab" :class="{active: tab === key}" :data-tab="key" role="tab" :aria-selected="tab === key" @click="tab = key"><Icon :name="item.icon"/><span>{{ item.title }}</span></button>
            </div>
            <div class="conversation-filters">
              <select id="conversation-source" v-model="source" class="compact-select" aria-label="对话来源" :hidden="tab !== 'conversation'">
                <option value="modelItems">模型对话条目</option><option value="clientMessages">客户端消息事件</option><option id="snapshot-source-option" value="requestSnapshots" :hidden="!active?.model.projections.requestSnapshots.length">Trace 请求快照</option>
              </select>
              <select id="turn-filter" v-model="turn" class="compact-select" aria-label="筛选回合"><option value="all">全部回合</option><option v-for="index in turns" :key="index" :value="index">回合 {{ index }}</option></select>
              <label class="search-field conversation-search"><Icon name="search"/><input id="content-search" v-model="query" type="search" :placeholder="tabs[tab].search" aria-label="搜索轨迹内容"></label>
            </div>
          </div>
          <div v-if="!active && selection.kind === 'empty'" id="feed" class="conversation-feed"><div class="empty-state"><div class="empty-icon"><Icon name="folder"/></div><h2>会话目录为空</h2><p>打开 Settings 配置 Codex 会话目录，或额外导入本地文件。</p></div></div>
          <ReplayFeed v-else ref="replayFeed" :active="active" :snapshot="snapshot" :tab="tab" :source="source" :query="query" :turn="turn"
            :preferences="preferences" :selected-step-id="selectedStepId" :trace-status="traceStatus" :server-mode="serverMode"
            @seek="locate" @select="selectedStepId = $event" @copy="copy" @inspect="openDocument" @browse="browse" @choose-trace="chooseTrace"/>
        </section>
      </section>
      <section id="sessions-page" class="sessions-page panel" :hidden="page !== 'sessions'">
        <div class="sessions-page-heading"><div><p class="section-kicker">LOCAL WORKSPACE</p><h1>会话库</h1><p>支持从本机上传或拖入 JSONL 文件，直接在浏览器解析。文件仅保留在当前页面，不传至服务器。</p></div><label class="button primary import-label">上传会话文件<input id="sessions-files" type="file" accept=".jsonl,.json" multiple @change="importInput"></label></div>
        <div id="session-cards" class="session-cards">
          <button v-for="entry in visibleSessions" :key="entry.id" class="session-card" :class="{active: active === entry}" :data-session="entry.id" @click="selectSession(entry)">
            <h2>{{ sessionTitle(entry) }}</h2><span class="meta-chip"><Icon name="cube"/>{{ modelName(entry) }}</span><span class="meta-chip">{{ sessionDate(entry) }}</span>
            <div class="session-card-facts"><span>{{ entry.model ? duration(entry.model.metrics.recordedDurationMs) : '选择后加载' }}</span><span>{{ entry.model?.metrics.turns ?? '未知' }} 个回合</span><span>{{ entry.model?.metrics.toolCalls ?? '未知' }} 次工具调用</span><span>{{ number(entry.model?.metrics.tokens?.total_tokens) }} tokens</span></div>
          </button>
          <div v-if="!visibleSessions.length" class="empty-state"><div class="empty-icon"><Icon name="folder"/></div><h2>{{ sessions.length ? '没有匹配的会话' : '会话都在这里' }}</h2><p>选择本地文件后，可在这里切换查看。日志内容不会上传。</p></div>
        </div>
      </section>
    </main>
    <SessionInspector :active="active" :tab="inspectorTab" :selected-step-id="selectedStepId" :preferences="preferences" @change-tab="inspectorTab = $event"
      @preference="(key, value) => preferences[key] = value" @inspect="openDocument" @browse="browse" @copy="copy"/>
  </div>
  <SettingsDialog :open="settingsOpen" :settings="settings" :diagnostics="diagnostics" :server-mode="serverMode" :busy="busy" @close="settingsOpen = false" @save="refresh(true)"/>
  <InspectionDialog :inspection="inspection" :records="active?.rawRecords || []" :status="toast" @close="inspection = null" @copy="copy"/>
  <div id="error" class="error-banner" role="alert" :hidden="!error">{{ error }}</div><div id="toast" class="toast" role="status" :hidden="!toast">{{ toast }}</div>
</template>
