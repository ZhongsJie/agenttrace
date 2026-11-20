(function (root) {
  'use strict';

  const isFiniteNumber = Number.isFinite;
  const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));
  const json = value => (JSON.stringify(value) ?? 'null').replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');

  function buildReplay(session) {
    const turnIds = new Map(session.turns.map((turn, index) => [turn.id, index + 1]));
    const sourceSteps = session.steps.map(step => ({
      ...step,
      contextOnly: ['system', 'developer', 'context'].includes(step.kind) || step.prelude === true,
      turnIndex: turnIds.get(step.turn) ?? null,
    }));
    const eventSources = [];
    for (const step of sourceSteps) {
      const hasResult = step.kind === 'tool' && (step.end != null || Object.prototype.hasOwnProperty.call(step, 'output'));
      if (step.kind !== 'tool' || step.hasStart !== false) {
        eventSources.push({id: `${step.id}:start`, stepId: step.id, kind: step.kind === 'tool' ? 'tool_start' : step.kind, sourceTime: step.time, line: step.line});
      }
      if (hasResult) {
        eventSources.push({id: `${step.id}:result`, stepId: step.id, kind: 'tool_result', sourceTime: step.end, line: step.resultLine ?? step.line});
      }
    }
    const recordTimes = session.records.map(record => record.time).filter(isFiniteNumber);
    const minimumTime = recordTimes.reduce((minimum, time) => Math.min(minimum, time), Infinity);
    const maximumTime = recordTimes.reduce((maximum, time) => Math.max(maximum, time), -Infinity);
    const recordedDurationMs = recordTimes.length ? maximumTime - minimumTime : null;
    const validOrder = sourceSteps.every(step => step.kind !== 'tool' || !isFiniteNumber(step.end) || !isFiniteNumber(step.time) || step.end >= step.time);
    const recorded = eventSources.length > 0 && eventSources.every(event => isFiniteNumber(event.sourceTime)) && validOrder;
    const originTime = recorded ? (recordTimes.length ? minimumTime : eventSources.reduce((minimum, event) => Math.min(minimum, event.sourceTime), Infinity)) : null;
    const resultOrder = event => event.kind === 'tool_result' ? 1 : 0;
    const timeline = eventSources.sort(recorded
      ? (a, b) => a.sourceTime - b.sourceTime || a.line - b.line || resultOrder(a) - resultOrder(b)
      : (a, b) => a.line - b.line || resultOrder(a) - resultOrder(b));
    timeline.forEach((event, index) => { event.atMs = recorded ? Math.max(0, event.sourceTime - originTime) : index * 700; });
    const starts = new Map(timeline.filter(event => event.kind !== 'tool_result').map(event => [event.stepId, event.atMs]));
    const ends = new Map(timeline.filter(event => event.kind === 'tool_result').map(event => [event.stepId, event.atMs]));
    const steps = sourceSteps.map(step => ({...step, atMs: starts.get(step.id) ?? ends.get(step.id) ?? 0, endAtMs: ends.get(step.id) ?? null}));
    steps.sort((a, b) => a.atMs - b.atMs || a.line - b.line);
    const lastEventTime = timeline.length ? timeline[timeline.length - 1].atMs : 0;
    const durationMs = recorded ? Math.max(lastEventTime, recordedDurationMs ?? 0) : lastEventTime;
    const boundaries = [...new Set([0, ...timeline.map(event => event.atMs), durationMs])].sort((a, b) => a - b);
    const projections = Object.fromEntries(Object.entries(session.projections).map(([key, ids]) => [key, [...ids]]));
    const byId = new Map(steps.map(step => [step.id, step]));
    const hasModelMessages = projections.modelItems.some(id => ['user', 'assistant', 'reasoning'].includes(byId.get(id)?.kind) && !byId.get(id).contextOnly);
    const conversationSource = hasModelMessages ? 'modelItems' : 'clientMessages';
    const canonicalIds = new Set([...projections[conversationSource], ...projections.tools]);
    const tracks = {user: [], agent: [], tool: []};
    for (const step of steps.filter(step => canonicalIds.has(step.id))) {
      if (step.contextOnly) continue;
      const track = step.kind === 'user' ? tracks.user : step.kind === 'tool' ? tracks.tool : ['assistant', 'reasoning', 'agent'].includes(step.kind) ? tracks.agent : null;
      if (track) track.push({stepId: step.id, atMs: step.atMs, endMs: step.kind === 'tool' ? step.endAtMs : null, title: step.title, parallelGroup: step.parallel ?? null});
    }
    const usageSteps = new Map(steps.filter(step => step.kind === 'usage').map(step => [step.line, step]));
    let tokenTotal = 0;
    const usage = session.usage.filter(point => isFiniteNumber(point.delta?.total_tokens)).map(point => ({
      atMs: usageSteps.get(point.line)?.atMs ?? 0,
      delta: {...point.delta},
    })).sort((a, b) => a.atMs - b.atMs).map(point => ({...point, totalTokens: tokenTotal += point.delta.total_tokens}));
    const totals = new Map();
    for (const tool of session.tools) {
      const aggregate = totals.get(tool.title) ?? {name: tool.title, count: 0, totalDurationMs: 0, knownCount: 0, unknownCount: 0};
      aggregate.count += 1;
      if (isFiniteNumber(tool.duration) && tool.duration >= 0) { aggregate.knownCount += 1; aggregate.totalDurationMs += tool.duration; }
      else aggregate.unknownCount += 1;
      totals.set(tool.title, aggregate);
    }
    const hasTokens = Object.values(session.total).some(isFiniteNumber);
    return {
      name: session.name,
      timing: recorded ? 'recorded' : 'presentation',
      originTime,
      durationMs,
      steps,
      projections,
      relations: session.relations,
      conversationSource,
      timeline,
      boundaries,
      tracks,
      metrics: {
        recordedDurationMs,
        turns: session.turns.length,
        messages: steps.filter(step => canonicalIds.has(step.id) && !step.contextOnly && ['user', 'assistant'].includes(step.kind)).length,
        events: projections.runtimeEvents.length,
        conversationSource,
        toolCalls: session.tools.length,
        tokens: hasTokens ? {...session.total} : null,
        usage,
        toolTotals: [...totals.values()].sort((a, b) => b.totalDurationMs - a.totalDurationMs || a.name.localeCompare(b.name)),
      },
    };
  }

  function projectReplay(model, positionMs) {
    const position = clamp(isFiniteNumber(positionMs) ? positionMs : 0, 0, model.durationMs);
    return model.steps.filter(step => step.atMs <= position).map(step => {
      if (step.kind !== 'tool') return {step, phase: 'visible', outputVisible: false};
      const completed = step.endAtMs !== null && step.endAtMs <= position;
      return {step, phase: step.hasStart === false ? 'missing_start' : completed ? 'completed' : 'running', outputVisible: completed && step.output != null};
    });
  }

  function projectViews(model, positionMs) {
    const visible = projectReplay(model, positionMs);
    const byId = new Map(visible.map(entry => [entry.step.id, entry]));
    const select = ids => ids.map(id => byId.get(id)).filter(Boolean).sort((a, b) => a.step.atMs - b.step.atMs || a.step.line - b.step.line);
    return {
      modelItems: select([...model.projections.modelItems, ...model.projections.tools, ...model.projections.contexts]),
      clientMessages: select([...model.projections.clientMessages, ...model.projections.tools, ...model.projections.contexts]),
      runtimeEvents: select(model.projections.runtimeEvents),
      tools: select(model.projections.tools),
      usage: select(model.projections.usage),
      requestSnapshots: select(model.projections.requestSnapshots),
    };
  }

  function reducePlayback(model, state, action) {
    const stationaryStatus = position => model.durationMs > 0 && position >= model.durationMs ? 'ended' : 'paused';
    switch (action.type) {
      case 'PLAY':
        if (!model.timeline.length || model.durationMs <= 0) return {...state, status: 'paused'};
        if (state.status === 'playing') return state;
        return {...state, status: 'playing', positionMs: state.positionMs >= model.durationMs ? 0 : state.positionMs};
      case 'PAUSE':
        return {...state, status: stationaryStatus(state.positionMs)};
      case 'SEEK': {
        if (!isFiniteNumber(action.positionMs)) return state;
        const positionMs = clamp(action.positionMs, 0, model.durationMs);
        return {...state, positionMs, status: stationaryStatus(positionMs)};
      }
      case 'STEP': {
        if (![1, -1].includes(action.direction)) return state;
        const positionMs = action.direction === 1
          ? model.boundaries.find(boundary => boundary > state.positionMs) ?? model.durationMs
          : [...model.boundaries].reverse().find(boundary => boundary < state.positionMs) ?? 0;
        return {...state, positionMs, status: stationaryStatus(positionMs)};
      }
      case 'SET_SPEED':
        return isFiniteNumber(action.speed) && action.speed > 0 ? {...state, speed: clamp(action.speed, 0.25, 16)} : state;
      case 'TICK': {
        if (state.status !== 'playing' || !isFiniteNumber(action.deltaMs) || action.deltaMs <= 0) return state;
        const positionMs = Math.min(model.durationMs, state.positionMs + action.deltaMs * state.speed);
        return {...state, positionMs, status: positionMs >= model.durationMs ? 'ended' : 'playing'};
      }
      default:
        return state;
    }
  }

  function createPlayer(model, onChange, scheduler) {
    const clock = scheduler ?? {
      request: callback => root.requestAnimationFrame(callback),
      cancel: handle => root.cancelAnimationFrame(handle),
      now: () => root.performance.now(),
    };
    let state = {status: model.timeline.length && model.durationMs > 0 ? 'ended' : 'paused', positionMs: model.durationMs, speed: 1};
    let handle = null;
    let previousTime = null;
    let destroyed = false;
    const getState = () => ({...state});
    const snapshot = () => {
      const visible = projectReplay(model, state.positionMs);
      const active = [...model.timeline].reverse().find(event => event.atMs <= state.positionMs);
      return {state: getState(), visible, views: projectViews(model, state.positionMs), activeStepId: active?.stepId ?? null};
    };
    const elapsed = now => {
      if (state.status === 'playing' && previousTime !== null) state = reducePlayback(model, state, {type: 'TICK', deltaMs: Math.max(0, now - previousTime)});
      previousTime = now;
    };
    const cancel = () => {
      if (handle !== null) clock.cancel(handle);
      handle = null;
    };
    function schedule() {
      if (!destroyed && state.status === 'playing' && handle === null) handle = clock.request(frame);
    }
    function frame() {
      handle = null;
      if (destroyed || state.status !== 'playing') return;
      const oldState = state;
      elapsed(clock.now());
      if (state.status !== 'playing') previousTime = null;
      schedule();
      if (state !== oldState) onChange(snapshot());
    }
    function dispatch(action) {
      if (destroyed) return;
      const oldState = state;
      const now = clock.now();
      elapsed(now);
      state = reducePlayback(model, state, action);
      if (state.status === 'playing') previousTime = now;
      else { previousTime = null; cancel(); }
      schedule();
      if (state !== oldState) onChange(snapshot());
    }
    return {
      play: () => dispatch({type: 'PLAY'}),
      pause: () => dispatch({type: 'PAUSE'}),
      toggle: () => dispatch({type: state.status === 'playing' ? 'PAUSE' : 'PLAY'}),
      seek: positionMs => dispatch({type: 'SEEK', positionMs}),
      step: direction => dispatch({type: 'STEP', direction}),
      setSpeed: speed => dispatch({type: 'SET_SPEED', speed}),
      getState,
      destroy: () => { if (!destroyed) { cancel(); destroyed = true; previousTime = null; state = reducePlayback(model, state, {type: 'PAUSE'}); } },
    };
  }

  const api = {buildReplay, projectReplay, projectViews, reducePlayback, createPlayer, escapeHtml, json};
  if (typeof module !== 'undefined') module.exports = api;
  else root.AgentReplay = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
