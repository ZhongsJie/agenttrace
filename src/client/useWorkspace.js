import {computed, reactive, ref, shallowReactive, shallowRef} from 'vue';
import {duration, modelName, sessionTitle} from './presentation.js';

export function useWorkspace({server, rollout, bootError}) {
  const {AgentReplay: replay, AgentTrace: trace, AgentFormat: format, parseRollout} = globalThis;
  const sessions = shallowReactive([]);
  const active = shallowRef(null);
  const snapshot = shallowRef(null);
  const player = shallowRef(null);
  const selection = ref({kind: 'initial'});
  const page = ref('trace');
  const tab = ref('conversation');
  const source = ref('modelItems');
  const query = ref('');
  const turn = ref('all');
  const selectedStepId = ref(null);
  const preferences = reactive({content: true, reasoning: true, contexts: false});
  const error = ref(bootError || '');
  const toast = ref('');
  const inspection = shallowRef(null);
  const traceStatus = shallowRef(null);
  const diagnostics = ref('');
  const busy = ref(false);
  const settings = reactive({sessionRoot: '', traceRoot: '', additionalRoots: '', status: '', ready: false});
  const serverMode = !!server?.apiBase;
  let requestId = 0;
  let nextSessionId = 1;
  let toastTimer;
  let refreshTimer;

  const header = computed(() => {
    const entry = active.value;
    const state = selection.value;
    const title = state.kind === 'loading' ? `Loading ${state.title}…` : entry ? sessionTitle(entry)
      : {initial: 'Select a session log', empty: 'No sessions found', failed: 'Could not load session'}[state.kind] || 'Select a session log';
    if (!entry) return {title, hint: state.kind === 'initial' ? 'Import a local log to start replaying' : null};
    const {recordedDurationMs, turns, messages, toolCalls} = entry.model.metrics;
    return {
      title, filename: entry.name,
      session: {
        source: entry.traceInfo ? 'Rollout + Trace' : 'Rollout',
        chips: {model: modelName(entry), cli: `CLI ${entry.session.meta.cli_version || 'Unknown'}`, provider: entry.session.meta.model_provider || entry.session.meta.model_provider_id || 'Unknown provider'},
        metrics: {'Recorded span': duration(recordedDurationMs), 'Turns': turns, 'Messages': messages, 'Tools': toolCalls},
      },
    };
  });

  function notify(message) {
    clearTimeout(toastTimer);
    toast.value = message;
    toastTimer = setTimeout(() => { toast.value = ''; }, 2800);
  }

  function showError(cause) { error.value = cause.message || String(cause); }

  async function api(route, options) {
    const response = await fetch(server.apiBase + route, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status})`);
    return data;
  }

  function fields(text, name) {
    let first;
    try { first = JSON.parse(text.split(/\r?\n/).find(line => line.trim()) || '{}'); } catch {}
    if (first && ((!first.type && Number.isFinite(first.wall_time_unix_ms)) || (first.raw_event_log && first.trace_id))) {
      throw new Error('This file is a Codex trace. Configure the trace directory in Settings and select the corresponding rollout session.');
    }
    const session = parseRollout(text, name);
    return {name, source: text, session, model: replay.buildReplay(session), rawRecords: format.records(text)};
  }

  const identityOf = entry => entry.session ? trace.rolloutIdentity(entry.session.meta).sessionId : entry.descriptor.sessionId;
  function match(identity) {
    if (!identity) return null;
    const entries = sessions.filter(entry => identityOf(entry) === identity);
    return entries.length === 1 ? entries[0] : null;
  }

  function selectTrace(entry, index) {
    entry.traceIndex = Math.max(0, Math.min(index, entry.traces.length - 1));
    entry.traceInfo = entry.traces[entry.traceIndex]?.traceInfo || null;
  }

  function attach(entry, bundles) {
    for (const bundle of bundles) {
      const identity = trace.traceIdentity(bundle);
      if (identity.status !== 'verified' || match(identity.sessionId) !== entry || identityOf(entry) !== identity.sessionId) {
        notify('The trace identity did not match this session, so the trace was not linked.');
        continue;
      }
      const {traceInfo} = trace.parseBundle(bundle);
      const key = traceInfo.traceId || JSON.stringify(bundle);
      const attachment = {key, bundle, traceInfo};
      const index = entry.traces.findIndex(item => item.key === key);
      entry.traces = index === -1 ? [...entry.traces, attachment] : entry.traces.map((item, i) => i === index ? attachment : item);
    }
    selectTrace(entry, entry.traceIndex || 0);
  }

  function reconcile() {
    const counts = new Map();
    for (const entry of sessions) {
      const identity = identityOf(entry);
      if (identity) counts.set(identity, (counts.get(identity) || 0) + 1);
    }
    for (const entry of sessions) {
      if (counts.get(identityOf(entry)) > 1) {
        entry.traces = [];
        selectTrace(entry, 0);
      }
    }
  }

  function resetSelection() {
    inspection.value = null;
    player.value?.destroy();
    player.value = null;
    active.value = null;
    snapshot.value = null;
  }

  function outputVisible(spec, current = snapshot.value) {
    return spec.field !== 'output' || spec.scope === 'session'
      || !!current?.visible.some(item => item.step.id === spec.stepId && item.outputVisible);
  }

  function updatePlayback(next) {
    snapshot.value = next;
    if (inspection.value?.kind === 'document' && !outputVisible(inspection.value.spec, next)) inspection.value = null;
  }

  async function selectSession(entry) {
    const request = ++requestId;
    if (!entry.session) {
      player.value?.pause();
      selection.value = {kind: 'loading', title: sessionTitle(entry)};
      try {
        const data = await api(`/sessions/${encodeURIComponent(entry.descriptor.key)}`);
        if (request !== requestId || !sessions.includes(entry)) return;
        Object.assign(entry, fields(data.text, data.name));
        attach(entry, data.traceBundles || []);
      } catch (cause) {
        if (request === requestId) {
          selection.value = {kind: active.value ? 'ready' : 'failed'};
          showError(cause);
        }
        return;
      }
    }
    resetSelection();
    active.value = entry;
    source.value = entry.model.conversationSource;
    selectedStepId.value = null;
    query.value = '';
    turn.value = 'all';
    error.value = '';
    page.value = 'trace';
    selection.value = {kind: 'ready'};
    player.value = replay.createPlayer(entry.model, updatePlayback);
    const state = player.value.getState();
    updatePlayback({state, views: replay.projectViews(entry.model, state.positionMs), visible: replay.projectReplay(entry.model, state.positionMs)});
  }

  function addSession(parsed, bundles = []) {
    let entry = sessions.find(item => item.source === parsed.source);
    if (entry) Object.assign(entry, parsed);
    else {
      entry = shallowReactive({id: nextSessionId++, traces: [], ...parsed});
      sessions.push(entry);
    }
    const identity = identityOf(entry);
    if (identity && !match(identity)) {
      reconcile();
      notify('Multiple rollouts have the same session ID, so trace matching was paused.');
    }
    attach(entry, bundles);
    selectSession(entry);
    if (entry.session.warnings.length) notify(`Import complete. See Details for parse warnings (${entry.session.warnings.length}).`);
    return entry;
  }

  async function importFiles(files) {
    const orderedFiles = Array.from(files);
    for (const file of orderedFiles) {
      try {
        const parsed = fields(await file.text(), file.name);
        const identity = identityOf(parsed);
        const indexed = match(identity);
        if (indexed?.server && !indexed.session) {
          try {
            const data = await api(`/sessions/${encodeURIComponent(indexed.descriptor.key)}`);
            if (sessions.includes(indexed)) {
              Object.assign(indexed, fields(data.text, data.name));
              attach(indexed, data.traceBundles || []);
            }
          } catch { /* Catalog availability does not block imports. */ }
        }
        const entry = addSession(parsed);
        if (serverMode && identity) {
          try {
            const data = await api(`/traces?sessionId=${encodeURIComponent(identity)}`);
            if (sessions.includes(entry)) attach(entry, data.traceBundles || []);
            if (data.warnings?.length) notify(data.warnings.join('; '));
          } catch { notify('The session was imported in the browser, but server traces are temporarily unavailable.'); }
        }
      } catch (cause) { showError(cause); }
    }
  }

  async function applyCatalog(catalog) {
    const previousKey = active.value?.server ? active.value.descriptor.key : null;
    ++requestId;
    if (previousKey) resetSelection();
    traceStatus.value = catalog.traceStatus || null;
    diagnostics.value = [
      ...(catalog.warnings || []),
      ...(catalog.unmatchedTraces || []).map(item => typeof item === 'string' ? item : `${item.name || item.traceId || 'Trace'}: ${item.reason || item.message || item.diagnostics?.join('; ') || 'No matching session'}`),
    ].join('\n') || 'Scan completed without warnings. Traces are linked only to rollouts with matching session IDs.';
    const imported = sessions.filter(entry => !entry.server);
    const indexed = (catalog.sessions || []).map(descriptor => shallowReactive({id: nextSessionId++, server: true, descriptor, name: descriptor.relativePath || descriptor.name, traces: []}));
    sessions.splice(0, sessions.length, ...imported, ...indexed);
    reconcile();
    inspection.value = null;
    const selected = indexed.find(entry => entry.descriptor.key === previousKey) || (!active.value && sessions[0]);
    if (selected) await selectSession(selected);
    else selection.value = {kind: active.value ? 'ready' : 'empty'};
  }

  function acceptSettings(value) {
    settings.sessionRoot = value.sessionRoot || '';
    settings.traceRoot = value.traceRoot || '';
    settings.additionalRoots = (value.additionalSessionRoots || []).join('\n');
    settings.ready = true;
  }

  async function openSettings() {
    player.value?.pause();
    settings.ready = false;
    settings.status = serverMode ? 'Loading settings…' : 'Run npm start to configure directory paths. You can still select log files.';
    if (!serverMode) return;
    try { acceptSettings(await api('/settings')); settings.status = ''; }
    catch (cause) { settings.status = cause.message; }
  }

  async function refresh(save = false) {
    if (!serverMode || busy.value) return;
    busy.value = true;
    try {
      if (save) {
        const body = {sessionRoot: settings.sessionRoot.trim(), traceRoot: settings.traceRoot.trim(), additionalSessionRoots: settings.additionalRoots.split(/\r?\n/).map(value => value.trim()).filter(Boolean)};
        const data = await api('/settings', {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
        acceptSettings(data.settings);
        settings.status = 'Settings saved. Refresh the session list.';
      } else await applyCatalog(await api('/rescan', {method: 'POST'}));
    } catch (cause) { if (save) settings.status = cause.message; else showError(cause); }
    finally { busy.value = false; }
  }

  function setAutoRefresh(enabled) {
    clearInterval(refreshTimer);
    if (enabled && serverMode) refreshTimer = setInterval(() => { if (!document.hidden) refresh(); }, 10000);
  }

  function seekStep(id, changeTab) {
    const model = active.value?.model;
    const step = model?.steps.find(item => item.id === id);
    if (!step) return false;
    selectedStepId.value = id;
    if (changeTab) {
      query.value = '';
      turn.value = 'all';
      if (model.projections.clientMessages.includes(id)) source.value = 'clientMessages';
      else if (model.projections.modelItems.includes(id)) source.value = 'modelItems';
      tab.value = model.projections.runtimeEvents.includes(id) ? 'events' : step.kind === 'tool' ? 'tools' : 'conversation';
    }
    player.value.seek(step.atMs);
    return true;
  }

  function openDocument(spec, opener) {
    if (!active.value || !outputVisible(spec)) return;
    player.value?.pause();
    inspection.value = {kind: 'document', spec, opener};
  }

  function browse(line, opener) {
    if (!active.value) return;
    player.value?.pause();
    inspection.value = {kind: 'records', line, opener};
  }

  function chooseTrace(index) {
    const entry = active.value;
    if (!entry || !entry.traces[index]) return;
    inspection.value = null;
    selectTrace(entry, index);
  }

  function boot() {
    if (rollout) {
      try { addSession(fields(rollout.text, rollout.name), rollout.traceBundles || []); }
      catch (cause) { error.value = [error.value, cause.message].filter(Boolean).join('\n'); }
    }
    if (serverMode) api('/catalog').then(applyCatalog).catch(showError);
  }

  function dispose() { player.value?.destroy(); clearInterval(refreshTimer); clearTimeout(toastTimer); }

  return {sessions, active, snapshot, player, selection, page, tab, source, query, turn, selectedStepId, preferences, error, toast, inspection,
    traceStatus, diagnostics, busy, settings, serverMode, header, notify, selectSession, importFiles, openSettings, refresh, setAutoRefresh,
    seekStep, openDocument, browse, chooseTrace, boot, dispose};
}
