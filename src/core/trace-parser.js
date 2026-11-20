(function (root) {
  'use strict';

  const own = (object, key) => object != null && Object.hasOwn(object, key);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const finite = Number.isFinite;
  const validTime = value => finite(value) && Math.abs(value) <= 8.64e15;
  const identity = value => typeof value === 'string' && value.length ? value : null;
  const encode = value => typeof value === 'string' ? value : JSON.stringify(value ?? '', null, 2);
  const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(item => typeof item?.text === 'string' ? item.text : '').filter(Boolean).join('\n') : '';
  const duration = (start, end) => finite(start) && finite(end) && end >= start ? end - start : null;
  const parseJson = source => JSON.parse(source.replace(/^\uFEFF/, ''));

  function safePath(value) {
    if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) return null;
    const source = value.replace(/\\/g, '/');
    if (source.startsWith('/') || /^[A-Za-z][A-Za-z\d+.-]*:/.test(source)) return null;
    const parts = source.split('/');
    if (parts.includes('..')) return null;
    const normalized = parts.filter(part => part && part !== '.').join('/');
    return normalized || null;
  }

  function manifestFrom(source) {
    const manifest = parseJson(source);
    if (!object(manifest)) throw new Error('manifest.json must contain a JSON object');
    const eventLog = safePath(manifest.raw_event_log ?? 'trace.jsonl');
    if (!eventLog) throw new Error('manifest.raw_event_log is not a safe relative path');
    return {manifest, eventLog};
  }

  function traceRows(source, warnings) {
    const rows = [];
    source.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((line, index) => {
      if (!line.trim()) return;
      try {
        const value = JSON.parse(line);
        if (!object(value) || !object(value.payload) || typeof value.payload.type !== 'string') throw new Error('Trace record is missing payload.type');
        rows.push({value, line: index + 1});
      } catch (error) { warnings.push(`Trace line ${index + 1}: ${error.message}`); }
    });
    return rows;
  }

  function referencePaths(value, result, warnings, line) {
    if (!value || typeof value !== 'object') return;
    if (object(value) && own(value, 'raw_payload_id') && own(value, 'path')) {
      const path = safePath(value.path);
      if (path) result.add(path);
      else warnings.push(`Trace line ${line}: Rejected unsafe payload path ${String(value.path)}`);
    }
    for (const child of Object.values(value)) referencePaths(child, result, warnings, line);
  }

  function paths(manifestText, traceText = '') {
    const {manifest, eventLog} = manifestFrom(manifestText);
    const warnings = [];
    if (manifest.schema_version !== 1) warnings.push(`Unsupported trace schema_version ${String(manifest.schema_version)}. Attempting to parse known fields.`);
    const payloads = new Set();
    for (const row of traceRows(traceText, warnings)) referencePaths(row.value.payload, payloads, warnings, row.line);
    return {eventLog, payloads: [...payloads].sort(), warnings};
  }

  function parseBundle(bundle) {
    const diagnostics = [...(Array.isArray(bundle.warnings) ? bundle.warnings : [])];
    const files = object(bundle.files) ? bundle.files : {};
    if (!own(files, 'manifest.json') || typeof files['manifest.json'] !== 'string') throw new Error('Trace bundle is missing manifest.json');
    const {manifest, eventLog} = manifestFrom(files['manifest.json']);
    if (!own(files, eventLog) || typeof files[eventLog] !== 'string') throw new Error(`Trace bundle is missing ${eventLog}`);
    const source = files[eventLog];
    const references = paths(files['manifest.json'], source);
    diagnostics.push(...references.warnings);
    const payloads = Object.create(null);
    for (const path of references.payloads) {
      const payloadSource = own(files, path) && typeof files[path] === 'string' ? files[path] : null;
      let value = null;
      let error = null;
      if (payloadSource == null) error = `Missing payload ${path}`;
      else { try { value = parseJson(payloadSource); } catch (failure) { error = `Could not parse payload ${path}: ${failure.message}`; } }
      if (error) diagnostics.push(error);
      payloads[path] = {path, source: payloadSource, value, error};
    }
    const resolvedPath = reference => {
      if (!object(reference)) return null;
      return safePath(reference.path);
    };
    const resolved = reference => {
      const path = resolvedPath(reference);
      return path && own(payloads, path) ? payloads[path].value : null;
    };
    const rows = traceRows(source, []);
    const rawByLine = new Map(rows.map(row => [row.line, row.value]));
    const records = rows.map(({value, line}) => {
      if (!validTime(value.wall_time_unix_ms)) diagnostics.push(`Trace line ${line}: Missing a valid timestamp in milliseconds.`);
      return {...value, line, time: validTime(value.wall_time_unix_ms) ? value.wall_time_unix_ms : NaN, timestamp: validTime(value.wall_time_unix_ms) ? new Date(value.wall_time_unix_ms).toISOString() : undefined};
    });
    const events = records.map(record => {
      const p = record.payload;
      const protocol = p.type === 'protocol_event_observed' ? resolved(p.event_payload) : null;
      const threadId = identity(record.thread_id) || identity(p.thread_id) || identity(protocol?.thread_id) || identity(protocol?.session_id) || (p.type === 'protocol_event_observed' ? null : identity(manifest.root_thread_id));
      return {line: record.line, seq: record.seq, time: record.time, type: p.type, threadId, turnId: identity(record.codex_turn_id) || identity(p.codex_turn_id) || identity(protocol?.turn_id), payload: p, raw: rawByLine.get(record.line)};
    });
    const ordered = [...events].sort((a, b) => finite(a.time) && finite(b.time) ? a.time - b.time || a.line - b.line : a.line - b.line);
    const threadMap = new Map();
    const inferenceMap = new Map();
    const toolMap = new Map();
    const turnMap = new Map();
    const activeTurns = new Map();
    const turnKey = (thread, turn) => JSON.stringify([thread, turn]);
    const callKey = (event, id) => JSON.stringify([event.threadId, id]);
    const ensureThread = id => {
      if (!id) return {id: null, agentPath: null, model: null, provider: null, metadataPath: null};
      if (!threadMap.has(id)) threadMap.set(id, {id, agentPath: null, model: null, provider: null, metadataPath: null});
      return threadMap.get(id);
    };
    const ensureTurn = event => {
      if (!event.turnId) return null;
      const key = turnKey(event.threadId, event.turnId);
      if (!turnMap.has(key)) turnMap.set(key, {id: event.turnId, threadId: event.threadId});
      return turnMap.get(key);
    };
    const authoritativeThreads = new Map();
    for (const event of events) {
      if (event.type === 'protocol_event_observed' || !event.turnId) continue;
      ensureTurn(event);
      if (!event.threadId) continue;
      if (!authoritativeThreads.has(event.turnId)) authoritativeThreads.set(event.turnId, new Set());
      authoritativeThreads.get(event.turnId).add(event.threadId);
    }
    for (const event of events) {
      if (event.type !== 'protocol_event_observed' || !event.turnId) continue;
      const candidates = authoritativeThreads.get(event.turnId) || new Set();
      if (!event.threadId && candidates.size === 1) event.threadId = [...candidates][0];
      event.turnResolved = event.threadId !== null && turnMap.has(turnKey(event.threadId, event.turnId));
      if (!event.turnResolved) diagnostics.push(`Trace line ${event.line}: Could not ${!event.threadId && candidates.size > 1 ? 'uniquely match' : 'match'} a mirrored protocol event to turn ${event.turnId}. The original event was kept.`);
    }
    const first = (target, key, value) => { if (target[key] == null && value != null) target[key] = value; };
    for (const event of ordered) {
      const p = event.payload;
      const thread = ensureThread(event.threadId);
      if (p.type === 'thread_started') {
        const metadata = resolved(p.metadata_payload);
        thread.metadataPath = resolvedPath(p.metadata_payload);
        thread.agentPath = p.agent_path ?? metadata?.agent_path ?? thread.agentPath;
        thread.model = metadata?.model ?? thread.model;
        thread.provider = metadata?.provider_name ?? thread.provider;
      }
      if (p.type === 'codex_turn_started' && event.turnId) activeTurns.set(event.threadId, event.turnId);
      if (p.type !== 'protocol_event_observed' && !event.turnId && activeTurns.has(event.threadId)) event.turnId = activeTurns.get(event.threadId);
      const turn = p.type === 'protocol_event_observed' ? event.turnResolved ? turnMap.get(turnKey(event.threadId, event.turnId)) : null : ensureTurn(event);
      if (['codex_turn_started', 'codex_turn_ended'].includes(p.type) && !turn) diagnostics.push(`Trace line ${event.line}: Missing codex_turn_id. The event was kept without creating a turn.`);
      if (p.type === 'codex_turn_started' && turn) {
        first(turn, 'start', finite(event.time) ? event.time : null);
        first(turn, 'startLine', event.line);
      } else if (p.type === 'codex_turn_ended' && turn) {
        first(turn, 'end', finite(event.time) ? event.time : null);
        first(turn, 'endLine', event.line);
        if (turn) turn.status = p.status || 'completed';
        activeTurns.delete(event.threadId);
      }
      if (p.type === 'protocol_event_observed') {
        const protocol = resolved(p.event_payload);
        if (protocol && ['turn_started', 'task_started'].includes(protocol.type) && turn) {
          first(turn, 'protocolStart', event.time);
        }
        if (protocol && ['turn_complete', 'task_complete', 'turn_aborted'].includes(protocol.type) && turn) {
          if (finite(protocol.duration_ms)) turn.reportedDurationMs = protocol.duration_ms;
          if (finite(protocol.time_to_first_token_ms)) turn.timeToFirstTokenMs = protocol.time_to_first_token_ms;
          first(turn, 'protocolEnd', event.time);
        }
      }
      if (['inference_started', 'inference_completed', 'inference_failed', 'inference_cancelled'].includes(p.type)) {
        const id = typeof p.inference_call_id === 'string' ? p.inference_call_id : `missing-inference-id-L${event.line}`;
        const key = callKey(event, id);
        if (!inferenceMap.has(key)) inferenceMap.set(key, {id, threadId: event.threadId, turnId: event.turnId, startMs: null, endMs: null, durationMs: null, startLine: null, endLine: null, model: null, provider: null, requestPath: null, responsePath: null, tokenUsage: null, status: 'incomplete', responseId: null, upstreamRequestId: null});
        const span = inferenceMap.get(key);
        if (p.type === 'inference_started') {
          first(span, 'startMs', finite(event.time) ? event.time : null); first(span, 'startLine', event.line);
          first(span, 'requestPath', resolvedPath(p.request_payload));
          first(span, 'model', p.model); first(span, 'provider', p.provider_name);
          thread.model = p.model ?? thread.model; thread.provider = p.provider_name ?? thread.provider;
        } else if (['inference_completed', 'inference_failed', 'inference_cancelled'].includes(p.type)) {
          first(span, 'endMs', finite(event.time) ? event.time : null); first(span, 'endLine', event.line);
          first(span, 'responsePath', resolvedPath(p.response_payload));
          first(span, 'responseId', p.response_id); first(span, 'upstreamRequestId', p.upstream_request_id);
          span.status = p.status || (p.type === 'inference_completed' ? 'completed' : p.type.replace('inference_', ''));
        }
      }
      if (['tool_call_started', 'tool_call_ended', 'tool_call_runtime_started', 'tool_call_runtime_ended'].includes(p.type)) {
        const id = typeof p.tool_call_id === 'string' ? p.tool_call_id : `missing-tool-id-L${event.line}`;
        const key = callKey(event, id);
        if (!toolMap.has(key)) toolMap.set(key, {id, name: null, threadId: event.threadId, turnId: event.turnId, startMs: null, endMs: null, durationMs: null, startLine: null, endLine: null, runtimeStartMs: null, runtimeEndMs: null, runtimeDurationMs: null, reportedExecutionMs: null, invocationPath: null, resultPath: null, runtimePaths: [], status: 'incomplete'});
        const span = toolMap.get(key);
        if (p.type === 'tool_call_started') {
          first(span, 'startMs', finite(event.time) ? event.time : null); first(span, 'startLine', event.line);
          first(span, 'invocationPath', resolvedPath(p.invocation_payload));
          first(span, 'name', p.summary?.label || p.kind?.type);
        } else if (p.type === 'tool_call_ended') {
          first(span, 'endMs', finite(event.time) ? event.time : null); first(span, 'endLine', event.line);
          first(span, 'resultPath', resolvedPath(p.result_payload)); span.status = p.status || 'completed';
        } else if (['tool_call_runtime_started', 'tool_call_runtime_ended'].includes(p.type)) {
          const path = resolvedPath(p.runtime_payload);
          if (path && !span.runtimePaths.includes(path)) span.runtimePaths.push(path);
          const isStart = p.type === 'tool_call_runtime_started';
          first(span, isStart ? 'runtimeStartMs' : 'runtimeEndMs', finite(event.time) ? event.time : null);
          const runtime = resolved(p.runtime_payload);
          const d = runtime?.duration;
          if (finite(d) && d >= 0) first(span, 'reportedExecutionMs', d);
          else if (object(d) && finite(d.secs) && finite(d.nanos) && d.secs >= 0 && d.nanos >= 0) first(span, 'reportedExecutionMs', d.secs * 1000 + d.nanos / 1e6);
        }
      }
    }
    const inferences = [...inferenceMap.values()];
    const tools = [...toolMap.values()];
    for (const span of inferences) span.durationMs = duration(span.startMs, span.endMs);
    for (const span of tools) {
      span.durationMs = duration(span.startMs, span.endMs);
      span.runtimeDurationMs = duration(span.runtimeStartMs, span.runtimeEndMs);
      const invocation = span.invocationPath && payloads[span.invocationPath]?.value;
      span.name = invocation?.tool_name || span.name || 'unknown_tool';
    }
    const steps = [];
    const projections = {modelItems: [], clientMessages: [], runtimeEvents: [], tools: [], usage: [], contexts: [], requestSnapshots: []};
    const usage = [];
    const total = {};
    const eventByLine = new Map(events.map(event => [event.line, event]));
    const add = (line, kind, title, body, extra = {}) => {
      const event = eventByLine.get(line);
      if (!event) return null;
      const step = {id: steps.length, line, time: event.time, kind, title, body, turn: event.type === 'protocol_event_observed' && !event.turnResolved ? undefined : event.turnId ?? undefined, threadId: event.threadId, origin: 'trace_payload', sourceRefs: [{file: bundle.name || 'codex-trace', line, type: 'trace_event', payloadType: event.type, path: extra.payloadPath || null}], ...extra};
      steps.push(step);
      const projection = extra.origin === 'request_snapshot' ? 'requestSnapshots' : extra.origin === 'client_event' ? 'clientMessages' : kind === 'event' ? 'runtimeEvents' : kind === 'tool' ? 'tools' : kind === 'usage' ? 'usage' : ['user', 'assistant', 'reasoning'].includes(kind) ? 'modelItems' : 'contexts';
      projections[projection].push(step.id);
      return step;
    };
    for (const event of events) {
      add(event.line, 'event', event.type, JSON.stringify(event.raw, null, 2), {origin: 'trace_event', content: event.raw});
      if (event.type !== 'protocol_event_observed') continue;
      const protocol = resolved(event.payload.event_payload);
      const kind = {user_message: 'user', agent_message: 'assistant', agent_reasoning: 'reasoning', agent_reasoning_raw_content: 'reasoning'}[protocol?.type];
      if (kind) add(event.line, kind, kind === 'reasoning' ? 'Reasoning' : kind, typeof protocol.message === 'string' ? protocol.message : protocol.text || '', {origin: 'client_event', content: protocol, payloadPath: resolvedPath(event.payload.event_payload), itemId: protocol.item_id, channel: protocol.phase});
    }
    for (const span of [...inferences].sort((a, b) => (a.startMs ?? Infinity) - (b.startMs ?? Infinity) || (a.startLine ?? Infinity) - (b.startLine ?? Infinity))) {
      const request = span.requestPath && payloads[span.requestPath]?.value;
      first(span, 'model', typeof request?.model === 'string' ? request.model : null);
      const messages = Array.isArray(request?.input) ? request.input.filter(item => item?.type === 'message' && item.role === 'user') : [];
      const latest = messages[messages.length - 1];
      const userText = textOf(latest?.content);
      if (latest && span.startLine != null) {
        add(span.startLine, 'user', 'User', userText, {origin: 'request_snapshot', sourceOrigin: 'request_snapshot', inferenceCallId: span.id, payloadPath: span.requestPath, content: latest.content, itemId: latest.id});
      }
    }
    for (const span of [...inferences].sort((a, b) => (a.endMs ?? Infinity) - (b.endMs ?? Infinity) || (a.endLine ?? Infinity) - (b.endLine ?? Infinity))) {
      if (span.endLine == null || !span.responsePath) continue;
      const response = payloads[span.responsePath]?.value;
      first(span, 'responseId', typeof response?.response_id === 'string' ? response.response_id : null);
      first(span, 'upstreamRequestId', typeof response?.upstream_request_id === 'string' ? response.upstream_request_id : null);
      for (const item of Array.isArray(response?.output_items) ? response.output_items : []) {
        if (item?.type === 'reasoning') add(span.endLine, 'reasoning', 'Reasoning', textOf(item.summary) || textOf(item.content) || 'No plaintext reasoning was recorded.', {inferenceCallId: span.id, payloadPath: span.responsePath, content: item.summary || item.content, itemId: item.id, channel: item.phase || item.channel});
        else if (item?.type === 'message' && item.role === 'assistant') add(span.endLine, 'assistant', 'Assistant', textOf(item.content), {inferenceCallId: span.id, payloadPath: span.responsePath, content: item.summary || item.content, itemId: item.id, channel: item.phase || item.channel});
      }
      if (object(response?.token_usage)) {
        const delta = Object.fromEntries(Object.entries(response.token_usage).filter(([, value]) => finite(value) && value >= 0));
        if (Object.keys(delta).length) {
          span.tokenUsage = delta;
          for (const [key, value] of Object.entries(delta)) total[key] = (total[key] || 0) + value;
          usage.push({time: eventByLine.get(span.endLine).time, line: span.endLine, delta, total: {...total}, last: {...delta}, baseline: false});
          add(span.endLine, 'usage', 'Model request token usage', JSON.stringify(delta, null, 2), {usage: delta, inferenceCallId: span.id, payloadPath: span.responsePath});
        }
      }
    }
    const canonicalTools = [];
    for (const span of tools) {
      const invocation = span.invocationPath && payloads[span.invocationPath]?.value;
      const result = span.resultPath && payloads[span.resultPath]?.value;
      const hasStart = span.startLine != null;
      const hasEnd = span.endLine != null;
      const line = span.startLine ?? span.endLine;
      if (line == null) continue;
      const argumentsValue = invocation?.payload?.arguments ?? invocation?.arguments ?? invocation?.payload?.input ?? invocation?.payload ?? '';
      const step = add(line, 'tool', span.name, encode(argumentsValue), {callId: span.id, traceToolId: span.id, hasStart, status: hasStart ? hasEnd ? span.status === 'completed' ? 'Completed' : span.status : 'Incomplete' : 'Missing call start', duration: span.durationMs, execution: span.reportedExecutionMs, payloadPath: span.invocationPath});
      if (hasEnd) {
        step.end = span.endMs ?? NaN;
        step.resultLine = span.endLine;
        step.resultPayloadPath = span.resultPath;
        step.sourceRefs.push({file: bundle.name || 'codex-trace', line: span.endLine, type: 'trace_event', payloadType: eventByLine.get(span.endLine)?.type, path: span.resultPath});
        if (object(result) && own(result, 'response_item') && object(result.response_item) && own(result.response_item, 'output')) step.output = encode(result.response_item.output);
        else if (object(result) && own(result, 'output')) step.output = encode(result.output);
      }
      canonicalTools.push(step);
    }
    const intervals = canonicalTools.filter(tool => tool.hasStart && finite(tool.time) && finite(tool.end) && tool.end > tool.time).sort((a, b) => a.time - b.time);
    let component = [], componentEnd = -Infinity, group = 0;
    const flush = () => { if (component.length > 1) { group++; for (const tool of component) tool.parallel = group; } };
    for (const tool of intervals) { if (tool.time >= componentEnd) { flush(); component = [tool]; componentEnd = tool.end; } else { component.push(tool); componentEnd = Math.max(componentEnd, tool.end); } }
    flush();
    const turns = [...turnMap.values()];
    for (const turn of turns) {
      turn.duration = turn.reportedDurationMs ?? duration(turn.start, turn.end);
      if (turn.startLine != null) add(turn.startLine, 'turn', 'Turn started', turn.id, {turn: turn.id});
      if (turn.endLine != null) add(turn.endLine, 'turn', 'Turn completed', turn.id, {turn: turn.id, duration: turn.duration});
    }
    const rootThread = threadMap.get(manifest.root_thread_id) || [...threadMap.values()][0];
    const metadata = rootThread?.metadataPath && payloads[rootThread.metadataPath]?.value;
    const times = records.map(record => record.time).filter(finite);
    const start = times.reduce((minimum, time) => Math.min(minimum, time), Infinity);
    const end = times.reduce((maximum, time) => Math.max(maximum, time), -Infinity);
    const traceInfo = {manifest, traceId: manifest.trace_id ?? null, rolloutId: manifest.rollout_id ?? null, rootThreadId: manifest.root_thread_id ?? null, source, events, payloads, threads: [...threadMap.values()], inferences, tools, diagnostics: [...new Set(diagnostics)]};
    const session = {
      name: bundle.name || 'codex-trace', format: 'codex-trace',
      meta: {...(object(metadata) ? metadata : {}), id: manifest.rollout_id || manifest.root_thread_id || manifest.trace_id, session_id: manifest.rollout_id || manifest.root_thread_id || manifest.trace_id, model: rootThread?.model || metadata?.model, model_provider: metadata?.provider_name || rootThread?.provider, trace_id: manifest.trace_id},
      context: {model: rootThread?.model || metadata?.model, cwd: metadata?.cwd},
      records, steps, projections, relations: [], tools: canonicalTools, usage, turns, total, warnings: traceInfo.diagnostics,
      start: finite(start) ? start : 0, end: finite(end) ? end : 0, traceInfo,
    };
    return {session, traceInfo};
  }

  function rolloutIdentity(meta) {
    const claims = [meta?.id, meta?.session_id].map(identity).filter(Boolean);
    const conflict = new Set(claims).size > 1;
    return {sessionId: conflict ? null : claims[0] || null, status: conflict ? 'conflict' : claims.length ? 'verified' : 'unresolved', diagnostics: conflict ? ['The id and session_id fields in the session metadata conflict.'] : claims.length ? [] : ['Session metadata is missing an ID.']};
  }

  function traceIdentity(bundle) {
    try {
      const {manifest, eventLog} = manifestFrom(bundle?.files?.['manifest.json'] || '');
      const firstLine = (bundle.files[eventLog] || '').replace(/^\uFEFF/, '').split(/\r?\n/).find(line => line.trim());
      const first = JSON.parse(firstLine || 'null');
      if (!object(first) || !object(first.payload)) throw new Error('The first trace record does not contain valid metadata');
      const firstClaims = [first.rollout_id, first.payload.root_thread_id].map(identity).filter(Boolean);
      if (!firstClaims.length) throw new Error('The first trace record has neither rollout_id nor root_thread_id');
      const claims = [...firstClaims, ...[manifest.rollout_id, manifest.root_thread_id].map(identity).filter(Boolean)];
      if (new Set(claims).size > 1 || (identity(first.payload.trace_id) && identity(manifest.trace_id) && first.payload.trace_id !== manifest.trace_id)) {
        return {sessionId: null, status: 'conflict', diagnostics: ['The trace identity in the first record conflicts with the manifest.']};
      }
      return {sessionId: claims[0], status: 'verified', diagnostics: []};
    } catch (error) { return {sessionId: null, status: 'unresolved', diagnostics: [error.message]}; }
  }

  const api = {safePath, paths, parseBundle, rolloutIdentity, traceIdentity};
  if (typeof module !== 'undefined') module.exports = api;
  else root.AgentTrace = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
