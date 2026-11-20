(function (root) {
  'use strict';

  function parseRollout(text, name = 'rollout.jsonl') {
    const records = [], warnings = [];
    text.replace(/^\uFEFF/, '').split(/\r?\n/).forEach((line, index) => {
      if (!line.trim()) return;
      try {
        const record = JSON.parse(line);
        if (!record || typeof record !== 'object' || Array.isArray(record)) throw Error('记录必须是对象');
        if (typeof record.type !== 'string') throw Error('缺少记录类型');
        if (record.payload != null && (typeof record.payload !== 'object' || Array.isArray(record.payload))) throw Error('payload 必须是对象');
        if (record.payload?.type != null && typeof record.payload.type !== 'string') throw Error('payload.type 必须是字符串');
        records.push({...record, line: index + 1, time: Date.parse(record.timestamp)});
      } catch (error) { warnings.push(`第 ${index + 1} 行：${error.message}`); }
    });
    const meta = records.find(record => record.type === 'session_meta')?.payload || {};
    const steps = [], calls = new Map(), usage = [], turns = [], relations = [];
    const projections = {modelItems: [], clientMessages: [], runtimeEvents: [], tools: [], usage: [], contexts: [], requestSnapshots: []};
    const firstTaskLine = records.find(record => record.type === 'event_msg' && ['task_started', 'turn_started'].includes(record.payload?.type))?.line;
    let turn = null, context = {}, previous = {}, total = {}, firstUsage = true;
    const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.map(item => typeof item?.text === 'string' ? item.text : '').filter(Boolean).join('\n') : '';
    const sourceRef = record => ({file: name, line: record.line, type: record.type, payloadType: record.payload?.type});
    const add = (record, kind, title, body, projection, extra = {}) => {
      const payload = record.payload || {};
      const step = {id: steps.length, line: record.line, time: record.time, kind, title, body, prelude: firstTaskLine != null && record.line < firstTaskLine, turn: payload.turn_id || payload.internal_chat_message_metadata_passthrough?.turn_id || turn?.id, threadId: payload.thread_id || meta.id || meta.session_id, itemId: payload.item_id || (record.type === 'response_item' ? payload.id : undefined), origin: record.type, sourceRefs: [sourceRef(record)], ...extra};
      steps.push(step);
      if (projection) projections[projection].push(step.id);
      return step;
    };
    const callKey = payload => JSON.stringify([payload.thread_id || meta.id || meta.session_id || '', payload.turn_id || payload.internal_chat_message_metadata_passthrough?.turn_id || turn?.id || '', payload.call_id || payload.id || '']);
    for (const record of records) {
      const payload = record.payload || {}, type = payload.type;
      if (record.type === 'turn_context') { context = payload; continue; }
      if (record.type === 'event_msg' && ['task_started', 'turn_started'].includes(type)) {
        turn = {id: payload.turn_id || `turn-${turns.length + 1}`, start: record.time};
        turns.push(turn);
      }
      if (record.type === 'event_msg') add(record, 'event', type || 'event_msg', JSON.stringify(payload, null, 2), 'runtimeEvents', {eventType: type, content: payload});
      if (record.type === 'event_msg' && ['task_started', 'turn_started'].includes(type)) continue;
      if (record.type === 'event_msg' && ['task_complete', 'turn_complete', 'turn_aborted'].includes(type)) {
        if (turn) { turn.end = record.time; turn.duration = payload.duration_ms ?? record.time - turn.start; }
        turn = null;
        continue;
      }
      if (record.type === 'event_msg' && type === 'token_count' && payload.info?.total_token_usage) {
        const now = payload.info.total_token_usage, delta = {};
        let changed = false;
        for (const [key, value] of Object.entries(now)) {
          if (typeof value !== 'number') continue;
          delta[key] = value >= (previous[key] || 0) ? value - (previous[key] || 0) : value;
          if (delta[key]) changed = true;
          total[key] = (total[key] || 0) + delta[key];
        }
        if (changed) {
          usage.push({time: record.time, line: record.line, delta, total: {...now}, last: payload.info.last_token_usage, baseline: firstUsage});
          add(record, 'usage', 'Token 统计区间', JSON.stringify(delta, null, 2), 'usage', {usage: delta});
        }
        previous = {...now}; firstUsage = false;
        continue;
      }
      if (record.type === 'response_item' && ['function_call', 'custom_tool_call', 'local_shell_call'].includes(type)) {
        const step = add(record, 'tool', payload.name || type, payload.arguments || payload.input || JSON.stringify(payload.action), 'tools', {callId: payload.call_id || payload.id, status: '未完成', hasStart: true, model: context.model, content: payload});
        calls.set(callKey(payload), step);
        continue;
      }
      if ((record.type === 'response_item' && ['function_call_output', 'custom_tool_call_output'].includes(type)) || (record.type === 'event_msg' && /(?:mcp_tool_call|exec_command|patch_apply)_(?:begin|end)$/.test(type))) {
        const key = callKey(payload);
        let step = calls.get(key);
        if (!step && type.endsWith('_begin')) {
          step = add(record, 'tool', payload.invocation?.tool || type, JSON.stringify(payload.invocation || payload, null, 2), 'tools', {callId: payload.call_id, status: '未完成', hasStart: true, content: payload});
          calls.set(key, step);
        }
        if (!step) {
          step = add(record, 'tool', payload.invocation?.tool || '孤立工具结果', '', 'tools', {callId: payload.call_id, status: '缺少调用起点', hasStart: false});
          calls.set(key, step);
        }
        if (!step.sourceRefs.some(ref => ref.line === record.line)) step.sourceRefs.push(sourceRef(record));
        if (type.endsWith('_end') || type.endsWith('_output')) {
          const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? payload.result ?? payload, null, 2);
          if (record.type === 'response_item' || step.resultOrigin !== 'response_item') {
            step.end = record.time;
            step.duration = Number.isFinite(step.time) && step.hasStart ? record.time - step.time : null;
            step.status = step.hasStart ? '已完成' : '缺少调用起点';
            step.output = output; step.resultLine = record.line; step.resultOrigin = record.type; step.resultContent = payload;
          }
          if (record.type === 'event_msg') { step.runtimeEnd = record.time; step.runtimeOutput = payload; }
          if (payload.duration != null) step.execution = typeof payload.duration === 'number' ? payload.duration : (payload.duration.secs || 0) * 1000 + (payload.duration.nanos || 0) / 1e6;
        } else step.runtimeStart = record.time;
        continue;
      }
      if (record.type === 'response_item' && type === 'message') {
        const body = textOf(payload.content), classification = firstTaskLine != null && record.line < firstTaskLine ? {contextKind: 'session_prelude', title: '用户提示'} : null;
        add(record, classification ? 'context' : payload.role || 'message', classification?.title || (payload.role === 'assistant' ? 'Assistant' : payload.role === 'user' ? '用户' : payload.role), body, classification ? 'contexts' : 'modelItems', {channel: payload.phase || payload.channel, role: payload.role, content: payload.content, ...(classification || {})});
        continue;
      }
      if (record.type === 'response_item' && type === 'reasoning') {
        const prelude = firstTaskLine != null && record.line < firstTaskLine;
        add(record, prelude ? 'context' : 'reasoning', prelude ? '用户提示' : '深度思考', textOf(payload.summary || payload.content) || '仅有加密内容，无法回放明文', prelude ? 'contexts' : 'modelItems', {content: payload.summary || payload.content, encrypted: !textOf(payload.summary || payload.content), ...(prelude ? {contextKind: 'session_prelude'} : {})});
        continue;
      }
      if (record.type === 'event_msg' && ['user_message', 'agent_message', 'agent_reasoning', 'agent_reasoning_raw_content'].includes(type)) {
        const kind = {user_message: 'user', agent_message: 'assistant', agent_reasoning: 'reasoning', agent_reasoning_raw_content: 'reasoning'}[type];
        const prelude = firstTaskLine != null && record.line < firstTaskLine;
        add(record, prelude ? 'context' : kind, prelude ? '用户提示' : kind === 'reasoning' ? '深度思考' : kind, typeof payload.message === 'string' ? payload.message : typeof payload.text === 'string' ? payload.text : '', prelude ? 'contexts' : 'clientMessages', {channel: payload.phase, role: kind === 'reasoning' ? undefined : kind, content: payload, origin: 'client_event', ...(prelude ? {contextKind: 'session_prelude'} : {})});
        continue;
      }
      if (record.type === 'compacted') add(record, 'context', '上下文压缩', payload.message || JSON.stringify(payload), 'contexts', {content: payload});
      else if (!['session_meta', 'turn_context', 'event_msg'].includes(record.type)) add(record, 'context', type || record.type, JSON.stringify(payload, null, 2), 'contexts', {content: payload});
    }
    const modelIdentity = new Map();
    for (const id of projections.modelItems) {
      const step = steps[id];
      if (step.itemId) modelIdentity.set(JSON.stringify([step.threadId || '', step.turn || '', step.itemId]), step.id);
    }
    for (const id of projections.runtimeEvents) {
      const step = steps[id];
      if (!step.itemId) continue;
      const modelId = modelIdentity.get(JSON.stringify([step.threadId || '', step.turn || '', step.itemId]));
      if (modelId != null) relations.push({kind: 'item_identity', from: modelId, to: id, evidence: {threadId: step.threadId, turnId: step.turn, itemId: step.itemId}});
    }
    const tools = projections.tools.map(id => steps[id]);
    let group = 0, component = [], componentEnd = -Infinity;
    const finish = () => { if (component.length > 1) { group++; component.forEach(step => step.parallel = group); } };
    for (const step of tools.filter(step => step.hasStart && Number.isFinite(step.time) && Number.isFinite(step.end) && step.end > step.time).sort((a, b) => a.time - b.time)) {
      if (step.time >= componentEnd) { finish(); component = [step]; componentEnd = step.end; }
      else { component.push(step); componentEnd = Math.max(componentEnd, step.end); }
    }
    finish();
    const times = records.map(record => record.time).filter(Number.isFinite);
    return {name, meta, context, records, steps, projections, relations, usage, turns, total, warnings, start: times.length ? times.reduce((value, time) => Math.min(value, time), Infinity) : 0, end: times.length ? times.reduce((value, time) => Math.max(value, time), -Infinity) : 0, tools};
  }
  if (typeof module !== 'undefined') module.exports = {parseRollout};
  else root.parseRollout = parseRollout;
})(typeof globalThis !== 'undefined' ? globalThis : this);
