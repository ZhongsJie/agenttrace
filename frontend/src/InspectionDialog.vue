<script setup>
import {computed, onBeforeUnmount, reactive, ref, watch} from 'vue';
import InspectorCodeLines from './InspectorCodeLines.vue';

const props = defineProps({
  inspection: Object,
  records: {type: Array, default: () => []},
  status: {type: String, default: ''},
});
const emit = defineEmits(['close', 'copy']);
const format = globalThis.AgentFormat;
const pageSize = 50;
const dialog = ref(null);
const codeView = ref(null);
const recordState = reactive({query: '', type: 'all', page: 1, line: null});
const display = reactive({language: 'auto', mode: 'formatted', wrap: true});
let opener;

const recordsMode = computed(() => props.inspection?.kind === 'records');
const documentMode = computed(() => props.inspection?.kind === 'document');
const page = computed(() => recordsMode.value ? format.recordPage(props.records, {...recordState, pageSize}) : null);
const selectedRecord = computed(() => page.value?.filtered.find(record => record.line === recordState.line) ?? page.value?.items[0]);
const selectedIndex = computed(() => page.value?.filtered.indexOf(selectedRecord.value) ?? -1);
const doc = computed(() => {
  if (documentMode.value) {
    const {source, ...options} = props.inspection.spec;
    return format.document(source, options);
  }
  const record = selectedRecord.value;
  if (record) return format.document(record.source, {title: `原始记录 · L${record.line}`, language: record.valid ? 'json' : 'text'});
  return null;
});
const view = computed(() => doc.value ? format.present(doc.value, {language: display.language, mode: display.mode}) : null);
const displayMode = computed(() => {
  if (display.mode === 'raw') return '原文';
  if (view.value?.warning) return '保留未解析内容';
  return ['json', 'jsonl'].includes(view.value?.language) ? '结构化格式化' : '保留原始缩进';
});

watch(() => props.inspection, next => {
  const index = next?.kind === 'records' ? Math.max(0, props.records.findIndex(record => record.line === next.line)) : 0;
  Object.assign(recordState, {query: '', type: 'all', page: Math.floor(index / pageSize) + 1, line: props.records[index]?.line ?? null});
  Object.assign(display, {language: 'auto', mode: 'formatted', wrap: true});
}, {immediate: true});

watch([dialog, () => props.inspection], ([element, next]) => {
  if (!element) return;
  if (next && !element.open) {
    opener = next.opener ?? document.activeElement;
    if (typeof element.showModal === 'function') element.showModal();
    else element.setAttribute('open', '');
  } else if (!next) {
    if (element.open && typeof element.close === 'function') element.close();
    else element.removeAttribute('open');
    restoreFocus();
  }
}, {flush: 'post'});

watch([view, () => display.wrap], resetScroll, {flush: 'post'});
onBeforeUnmount(restoreFocus);

function restoreFocus() {
  if (opener?.isConnected) opener.focus?.();
  opener = undefined;
}

function nativeClose() {
  if (dialog.value?.open) return;
  if (props.inspection) emit('close');
  restoreFocus();
}

function resetScroll() {
  if (codeView.value) codeView.value.scrollTop = 0;
}

function filterRecords(key, value) {
  recordState[key] = value;
  setPage(1);
}

function setPage(number) {
  recordState.page = number;
  recordState.line = null;
  resetScroll();
}

function chooseRecord(index) {
  const record = page.value?.filtered[index];
  if (!record) return;
  recordState.line = record.line;
  recordState.page = Math.floor(index / pageSize) + 1;
  display.language = 'auto';
  resetScroll();
}

function copy(displayed, event) {
  if (doc.value) emit('copy', displayed ? view.value.text : doc.value.source, event.currentTarget);
}
</script>

<template>
  <dialog id="inspection-dialog" ref="dialog" class="inspection-dialog" :class="{'document-only': documentMode}"
    aria-labelledby="inspection-title" @keydown.esc.prevent="emit('close')" @cancel.prevent="emit('close')" @close="nativeClose">
    <div class="inspection-shell">
      <header class="inspection-heading">
        <div>
          <h2 id="inspection-title">{{ recordsMode ? '原始记录浏览器' : doc?.title ?? '记录查看器' }}</h2>
          <p id="inspection-scope">{{ !inspection ? '全会话原始记录' : recordsMode || inspection.spec.scope === 'session' ? '全会话数据，不受回放进度限制' : '当前已到达的回放内容' }}</p>
        </div>
        <div class="inspection-heading-actions">
          <div id="inspection-record-navigation" :hidden="documentMode">
            <button id="record-prev" type="button" class="mini-button" :disabled="selectedIndex <= 0" @click="chooseRecord(selectedIndex - 1)">上一条</button>
            <button id="record-next" type="button" class="mini-button" :disabled="selectedIndex < 0 || selectedIndex >= (page?.total ?? 0) - 1" @click="chooseRecord(selectedIndex + 1)">下一条</button>
          </div>
          <button id="inspection-close" type="button" class="inspection-close" aria-label="关闭记录查看器" title="关闭 · Esc" autofocus @click="emit('close')">关闭 <span aria-hidden="true">×</span></button>
        </div>
      </header>
      <div class="inspection-layout">
        <aside id="inspection-records" class="inspection-records" :hidden="documentMode">
          <div class="record-filters">
            <label class="search-field"><input id="record-query" type="search" placeholder="搜索所有原始记录…" aria-label="搜索所有原始记录"
              :value="recordState.query" @input="filterRecords('query', $event.target.value)"></label>
            <select id="record-type" class="compact-select" aria-label="筛选原始事件类型" :value="recordState.type" @change="filterRecords('type', $event.target.value)">
              <option value="all">全部事件类型</option>
              <option v-for="type in page?.types" :key="type" :value="type">{{ type }}</option>
            </select>
            <span id="record-count" class="record-count">{{ page ? `${page.total} / ${records.length} 条` : '0 条记录' }}</span>
          </div>
          <nav id="inspection-record-list" class="inspection-record-list" aria-label="原始记录列表">
            <template v-if="page">
              <button v-for="(record, index) in page.items" :key="record.line" type="button" class="record-row" :class="{active: record === selectedRecord}"
                :data-record-line="record.line" :aria-pressed="record === selectedRecord" @click="chooseRecord((page.page - 1) * pageSize + index)">
                <span class="record-row-top"><b>L{{ record.line }}</b><span>{{ record.timestamp ? record.timestamp.slice(11, 23) : '无时间戳' }}</span><i v-if="!record.valid">无效 JSON</i></span>
                <strong>{{ record.subtype || record.type }}</strong>
                <small>{{ record.preview || record.source }}</small>
              </button>
              <div v-if="!page.total" class="record-empty">没有匹配记录。调整关键词或事件类型。</div>
            </template>
          </nav>
          <div class="record-pagination">
            <button id="record-page-prev" type="button" class="mini-button" :disabled="!page || page.page <= 1" @click="setPage(page.page - 1)">上一页</button>
            <span id="record-page-info">{{ page?.page ?? 1 }} / {{ page?.pageCount ?? 1 }}</span>
            <button id="record-page-next" type="button" class="mini-button" :disabled="!page || page.page >= page.pageCount" @click="setPage(page.page + 1)">下一页</button>
          </div>
        </aside>
        <section class="inspection-document">
          <div class="inspection-document-heading">
            <div>
              <h3 id="inspection-document-title">{{ doc?.title ?? (inspection ? '未选中记录' : '选择一条记录') }}</h3>
              <p id="inspection-document-meta"><template v-if="view">{{ view.language }} · {{ displayMode }} · {{ view.lineCount.toLocaleString() }} 行 · {{ doc.source.length.toLocaleString() }} 字符</template></p>
            </div>
          </div>
          <div class="inspection-toolbar">
            <label>语言<select id="inspection-language" v-model="display.language" class="compact-select" aria-label="查看语言" :disabled="!doc">
              <option v-for="language in format.languages" :key="language.id" :value="language.id">{{ language.label }}</option>
            </select></label>
            <label>视图<select id="inspection-mode" v-model="display.mode" class="compact-select" aria-label="格式化或原文视图" :disabled="!doc">
              <option value="formatted">格式化</option><option value="raw">原文</option>
            </select></label>
            <label class="inspection-wrap-option"><input id="inspection-wrap" v-model="display.wrap" type="checkbox" :disabled="!doc">自动换行</label>
            <div class="inspection-copy-actions">
              <button id="inspection-copy-original" type="button" class="mini-button" :disabled="!doc" @click="copy(false, $event)">复制原文</button>
              <button id="inspection-copy-displayed" type="button" class="mini-button" :disabled="!doc" @click="copy(true, $event)">复制当前视图</button>
            </div>
          </div>
          <div id="inspection-view" ref="codeView" class="inspection-view">
            <template v-if="view">
              <p v-if="view.warning" class="code-warning">{{ view.warning }}</p>
              <pre class="inspection-code" :class="{'code-wrap': display.wrap}"><InspectorCodeLines :lines="view.lines" /></pre>
            </template>
            <div v-else-if="inspection" class="record-empty">没有可展示的内容。</div>
          </div>
          <div id="inspection-status" class="inspection-status" role="status" aria-live="polite">{{ inspection ? status : '' }}</div>
        </section>
      </div>
    </div>
  </dialog>
</template>
