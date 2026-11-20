const {test} = require('node:test');
const assert = require('node:assert/strict');
const Trace = require('../trace-parser.js');
const Replay = require('../replay.js');

function fixture() {
  const manifest = {schema_version: 1, trace_id: 'trace-one', rollout_id: 'rollout-one', root_thread_id: 'root', raw_event_log: 'trace.jsonl', payloads_dir: 'payloads'};
  const files = Object.create(null);
  files['manifest.json'] = JSON.stringify(manifest);
  const events = [];
  function payload(id, value) { files[`payloads/${id}.json`] = JSON.stringify(value); return {raw_payload_id: `raw:${id}`, path: `payloads/${id}.json`}; }
  function event(type, ms, values = {}, extra = {}) { events.push({schema_version: 1, seq: events.length + 1, wall_time_unix_ms: 1700000000000 + ms, rollout_id: 'rollout-one', thread_id: 'root', codex_turn_id: 'turn-one', payload: {type, ...values}, ...extra}); }
  event('rollout_started', 0, {}, {codex_turn_id: null});
  event('thread_started', 1, {thread_id: 'root', agent_path: '/root', metadata_payload: payload(1, {thread_id: 'root', agent_path: '/root', model: 'model-one', provider_name: 'provider-one', cwd: '/project', rollout_path: '/never/read/this'})}, {codex_turn_id: null});
  event('codex_turn_started', 10, {codex_turn_id: 'turn-one'});
  const input = [{type: 'message', role: 'developer', content: [{text: 'system context'}]}, {type: 'message', role: 'user', content: [{text: '# AGENTS.md context'}]}, {type: 'message', role: 'user', content: [{text: 'Run ls'}]}];
  event('inference_started', 20, {inference_call_id: 'i-one', model: 'model-one', provider_name: 'provider-one', request_payload: payload(2, {input})});
  const response = {token_usage: {input_tokens: 100, cached_input_tokens: 20, output_tokens: 10, reasoning_output_tokens: 3, total_tokens: 110}, output_items: [{type: 'reasoning', summary: [{text: 'Consider the request'}]}, {type: 'function_call', call_id: 'call-one', name: 'exec_command', arguments: '{"cmd":"ls"}'}]};
  event('inference_completed', 120, {inference_call_id: 'i-one', response_id: 'response-one', response_payload: payload(3, response)});
  event('tool_call_started', 130, {tool_call_id: 'call-one', kind: {type: 'exec_command'}, invocation_payload: payload(4, {tool_name: 'exec_command', payload: {type: 'function', arguments: '{"cmd":"ls"}'}})});
  event('tool_call_runtime_started', 140, {tool_call_id: 'call-one', runtime_payload: payload(5, {call_id: 'call-one'})});
  event('tool_call_runtime_ended', 142, {tool_call_id: 'call-one', runtime_payload: payload(6, {duration: {secs: 0, nanos: 184584}, stdout: 'hello'})});
  event('tool_call_ended', 150, {tool_call_id: 'call-one', status: 'completed', result_payload: payload(7, {type: 'direct_response', response_item: {type: 'function_call_output', call_id: 'call-one', output: 'hello'}})});
  event('inference_started', 160, {inference_call_id: 'i-two', request_payload: payload(8, {input: [...input, {type: 'function_call_output', call_id: 'call-one', output: 'hello'}]})});
  event('inference_completed', 250, {inference_call_id: 'i-two', response_payload: payload(9, {token_usage: {input_tokens: 120, cached_input_tokens: 100, output_tokens: 15, reasoning_output_tokens: 4, total_tokens: 135}, output_items: [{type: 'message', role: 'assistant', content: [{text: 'Done'}]}]})});
  event('codex_turn_ended', 300, {codex_turn_id: 'turn-one', status: 'completed'});
  event('protocol_event_observed', 301, {event_type: 'turn_complete', event_payload: payload(10, {type: 'task_complete', turn_id: 'turn-one', duration_ms: 290})});
  function bundle() { files['trace.jsonl'] = events.map(value => JSON.stringify(value)).join('\n'); return {name: 'sample-trace', files}; }
  return {manifest, files, events, payload, event, bundle};
}

test('relative bundle paths reject traversal, absolute paths and inherited path names remain plain files', () => {
  for (const path of ['../secret', 'payloads/../secret', '/tmp/secret', '\\server\\secret', 'C:\\secret', 'https://example.test/a', 'file:secret', 'a\0b', '']) assert.equal(Trace.safePath(path), null, path);
  assert.equal(Trace.safePath('./payloads\\1.json'), 'payloads/1.json');
  assert.equal(Trace.safePath('__proto__'), '__proto__');
});

test('bundle paths return only safe referenced payloads and preserve malformed-line diagnostics', () => {
  const f = fixture();
  const b = f.bundle();
  const source = b.files['trace.jsonl'] + '\nbad\n' + JSON.stringify({payload: {type: 'unknown', nested: {raw_payload_id: 'bad', path: '../outside'}}});
  const result = Trace.paths(b.files['manifest.json'], source);
  assert.equal(result.eventLog, 'trace.jsonl');
  assert.equal(result.payloads.length, 10);
  assert.ok(result.warnings.some(warning => warning.includes('bad') || warning.includes('第 14 行')));
  assert.ok(result.warnings.some(warning => warning.includes('../outside')));
  assert.throws(() => Trace.paths('{bad'));
  assert.throws(() => Trace.paths('{"raw_event_log":"../outside"}'));
});

test('directory collection supports parent roots and standalone bundles, without unrelated files', () => {
  const f = fixture(); const b = f.bundle();
  const entries = Object.entries(b.files).map(([path, text]) => ({path: `root/bundle-one/${path}`, text}));
  entries.push({path: 'root/bundle-one/payloads/unreferenced.json', text: '{"private":true}'});
  entries.push({path: '../escape.json', text: '{}'});
  const grouped = Trace.collectBundles(entries);
  assert.equal(grouped.bundles.length, 1);
  assert.equal(grouped.bundles[0].name, 'bundle-one');
  assert.equal(grouped.bundles[0].files['trace.jsonl'], b.files['trace.jsonl']);
  assert.equal(Object.hasOwn(grouped.bundles[0].files, 'payloads/unreferenced.json'), false);
  assert.ok(grouped.warnings.length);
  assert.equal(Trace.collectBundles(Object.entries(b.files).map(([path, text]) => ({path, text}))).bundles.length, 1);
});

test('trace independently projects one native conversation and separate measured inference/tool stages', () => {
  const f = fixture();const b = f.bundle();const {session, traceInfo} = Trace.parseBundle(b);
  assert.equal(session.format, 'codex-trace');
  assert.equal(session.traceInfo, traceInfo);
  assert.equal(traceInfo.inferences.length, 2);
  assert.deepEqual(traceInfo.inferences.map(span => span.durationMs), [100, 90]);
  assert.equal(session.turns.length, 1);
  assert.equal(session.turns[0].duration, 290);
  assert.equal(session.tools.length, 1);
  assert.equal(session.tools[0].body, '{"cmd":"ls"}');
  assert.equal(session.tools[0].duration, 20);
  assert.equal(session.tools[0].execution, 0.184584);
  assert.equal(traceInfo.tools[0].runtimeDurationMs, 2);
  assert.equal(session.tools[0].output, 'hello');
  assert.equal(session.total.total_tokens, 245);
  assert.equal(session.total.input_tokens, 220);
  assert.equal(session.total.output_tokens, 25);
  assert.equal(session.total.cached_input_tokens, 120);
  assert.equal(session.total.reasoning_output_tokens, 7);
  assert.deepEqual(session.projections.requestSnapshots.map(id => session.steps[id].body), ['Run ls', 'Run ls']);
  assert.equal(session.projections.modelItems.some(id => session.steps[id].kind === 'user'), false);
  assert.equal(Replay.buildReplay(session).metrics.messages, 1);
  assert.equal(session.steps.find(step => step.kind === 'user').origin, 'request_snapshot');
  assert.equal(session.steps.find(step => step.kind === 'reasoning').title, '深度思考');
  assert.deepEqual(session.steps.filter(step => step.kind === 'assistant').map(step => step.body), ['Done']);
  assert.equal(session.records[4].line, 5);
  assert.equal(traceInfo.payloads['payloads/2.json'].source, f.files['payloads/2.json']);
  assert.equal(traceInfo.diagnostics.length, 0);
  const model = Replay.buildReplay(session);
  assert.equal(model.metrics.messages, 1);
  assert.equal(model.metrics.tokens.total_tokens, 245);
  assert.equal(Replay.projectReplay(model, 149).find(entry => entry.step.kind === 'tool').outputVisible, false);
  assert.equal(Replay.projectReplay(model, 150).find(entry => entry.step.kind === 'tool').outputVisible, true);
});

test('duplicate completions and protocol token mirrors do not duplicate response tokens or messages', () => {
  const f = fixture();
  f.events.push({...f.events[4], seq: 100, wall_time_unix_ms: 1700000000290});
  f.event('protocol_event_observed', 302, {event_type: 'token_count', event_payload: f.payload(11, {type: 'token_count', info: {total_token_usage: {total_tokens: 245}}})});
  const {session, traceInfo} = Trace.parseBundle(f.bundle());
  assert.equal(traceInfo.inferences.length, 2);
  assert.equal(session.total.total_tokens, 245);
  assert.equal(session.steps.filter(step => step.kind === 'reasoning').length, 1);
  assert.equal(session.usage.length, 2);
});

test('missing payloads keep raw events, spans and diagnostics without invented usage or result text', () => {
  const f = fixture();const b = f.bundle();delete b.files['payloads/3.json'];delete b.files['payloads/7.json'];
  const {session, traceInfo} = Trace.parseBundle(b);
  assert.equal(session.records.length, f.events.length);
  assert.equal(traceInfo.inferences[0].durationMs, 100);
  assert.equal(traceInfo.inferences[0].tokenUsage, null);
  assert.equal(session.total.total_tokens, 135);
  assert.equal(Object.hasOwn(session.tools[0], 'output'), false);
  assert.ok(traceInfo.diagnostics.some(message => message.includes('payloads/3.json')));
  assert.equal(traceInfo.payloads['payloads/3.json'].error, '缺少 payload payloads/3.json');
  assert.equal(traceInfo.payloads['payloads/3.json'].source, null);
});

test('orphan tool results and incomplete starts preserve their missing endpoints', () => {
  const f = fixture();
  f.events.splice(5, 1);
  const parsed = Trace.parseBundle(f.bundle());
  assert.equal(parsed.session.tools[0].hasStart, false);
  assert.equal(parsed.session.tools[0].duration, null);
  assert.equal(parsed.session.tools[0].output, 'hello');
  const incomplete = fixture();incomplete.events.splice(8, 1);
  const tool = Trace.parseBundle(incomplete.bundle()).session.tools[0];
  assert.equal(tool.hasStart, true);
  assert.equal(tool.duration, null);
  assert.equal(Object.hasOwn(tool, 'output'), false);
});

test('out-of-order source records pair by timestamps while retaining actual physical lines', () => {
  const f = fixture();
  [f.events[3], f.events[4]] = [f.events[4], f.events[3]];
  const {session, traceInfo} = Trace.parseBundle(f.bundle());
  assert.equal(traceInfo.inferences[0].durationMs, 100);
  assert.equal(traceInfo.inferences[0].startLine, 5);
  assert.equal(traceInfo.inferences[0].endLine, 4);
  assert.equal(session.steps.find(step => step.kind === 'reasoning').line, 4);
});

test('identical call IDs in different threads remain independent and known tool overlap is marked', () => {
  const f = fixture();
  const rootEvents = [...f.events];
  for (const row of rootEvents) f.events.push({...row, seq: f.events.length + 1, thread_id: 'child', codex_turn_id: row.codex_turn_id ? 'child-turn' : null, payload: row.payload.type === 'thread_started' ? {...row.payload, thread_id: 'child', agent_path: '/root/child'} : row.payload});
  const {session, traceInfo} = Trace.parseBundle(f.bundle());
  assert.equal(traceInfo.inferences.length, 4);
  assert.equal(traceInfo.tools.length, 2);
  assert.equal(session.total.total_tokens, 490);
  assert.equal(session.tools[0].parallel, session.tools[1].parallel);
  assert.ok(session.tools[0].parallel);
  assert.equal(session.turns.length, 2);
});

test('malformed lines, unsupported schema and invalid times remain diagnosable', () => {
  const f = fixture();const b = f.bundle();b.files['manifest.json'] = JSON.stringify({...f.manifest, schema_version: 2});
  b.files['trace.jsonl'] = '\nnot-json\n' + JSON.stringify({schema_version: 2, wall_time_unix_ms: 1e30, payload: {type: 'unknown_event'}});
  const {session, traceInfo} = Trace.parseBundle(b);
  assert.equal(session.records[0].line, 3);
  assert.equal(traceInfo.events[0].type, 'unknown_event');
  assert.ok(session.warnings.some(warning => warning.includes('schema_version')));
  assert.ok(session.warnings.some(warning => warning.includes('第 2 行')));
  assert.ok(session.warnings.some(warning => warning.includes('时间戳')));
  assert.equal(Replay.buildReplay(session).timing, 'presentation');
});

test('unsafe references never resolve inherited or outside payload content', () => {
  const f = fixture();const b = f.bundle();
  const inherited = Object.create(b.files);inherited['manifest.json'] = b.files['manifest.json'];inherited['trace.jsonl'] = b.files['trace.jsonl'];
  const parsed = Trace.parseBundle({...b, files: inherited});
  assert.equal(parsed.session.total.total_tokens, undefined);
  assert.ok(parsed.traceInfo.diagnostics.some(warning => warning.includes('缺少 payload')));
  const index = f.events.findIndex(event => event.payload.type === 'inference_started');
  f.events[index].payload.request_payload.path = '../outside.json';
  const unsafe = Trace.parseBundle(f.bundle());
  assert.equal(unsafe.traceInfo.inferences[0].requestPath, null);
  assert.ok(unsafe.traceInfo.diagnostics.some(warning => warning.includes('拒绝 payload')));
});


test('malformed lifecycle events without turn identity never fabricate a turn or crash', () => {
  const bundle = {name: 'partial', files: {
    'manifest.json': JSON.stringify({schema_version: 1, root_thread_id: 'root'}),
    'trace.jsonl': [
      {wall_time_unix_ms: 1700000000000, payload: {type: 'codex_turn_started'}},
      {wall_time_unix_ms: 1e20, payload: {type: 'codex_turn_ended'}},
      {payload: {type: 'inference_started', inference_call_id: 'partial'}},
    ].map(value => JSON.stringify(value)).join('\n'),
  }};
  const {session, traceInfo} = Trace.parseBundle(bundle);
  assert.equal(session.turns.length, 0);
  assert.ok(session.warnings.some(warning => warning.includes('codex_turn_id')));
  assert.equal(session.records.length, 3);
  assert.equal(traceInfo.inferences[0].durationMs, null);
  assert.ok(traceInfo.diagnostics.some(warning => warning.includes('时间戳')));
  assert.equal(Replay.buildReplay(session).timing, 'presentation');
});

test('a present but empty payload remains distinct from an absent payload', () => {
  const f = fixture();const bundle = f.bundle();
  bundle.files['payloads/3.json'] = '';
  delete bundle.files['payloads/9.json'];
  const {traceInfo} = Trace.parseBundle(bundle);
  assert.equal(traceInfo.payloads['payloads/3.json'].source, '');
  assert.match(traceInfo.payloads['payloads/3.json'].error, /无法解析/);
  assert.equal(traceInfo.payloads['payloads/9.json'].source, null);
  assert.match(traceInfo.payloads['payloads/9.json'].error, /缺少/);
});


test('unknown similarly named events stay inspectable without inventing lifecycle spans', () => {
  const f = fixture();
  f.event('inference_future_notification', 302, {inference_call_id: 'not-a-call'});
  f.event('tool_call_future_notification', 303, {tool_call_id: 'not-a-tool'});
  const {session, traceInfo} = Trace.parseBundle(f.bundle());
  assert.equal(traceInfo.inferences.length, 2);
  assert.equal(traceInfo.tools.length, 1);
  assert.equal(session.records.length, 15);
  assert.equal(traceInfo.events[14].type, 'tool_call_future_notification');
});

function protocolCorrelationFixture(turns, protocol) {
  const files = Object.create(null);
  files['manifest.json'] = JSON.stringify({schema_version: 1, root_thread_id: 'root'});
  files['payloads/mirror.json'] = JSON.stringify(protocol);
  const rows = [];
  for (const [thread, turn, start, end] of turns) {
    rows.push({wall_time_unix_ms: 1700000000000 + start, thread_id: thread, codex_turn_id: turn, payload: {type: 'codex_turn_started'}});
    rows.push({wall_time_unix_ms: 1700000000000 + end, thread_id: thread, codex_turn_id: turn, payload: {type: 'codex_turn_ended'}});
  }
  rows.push({wall_time_unix_ms: 1700000000030, thread_id: null, codex_turn_id: null, payload: {type: 'protocol_event_observed', event_type: protocol.type, event_payload: {raw_payload_id: 'mirror', path: 'payloads/mirror.json'}}});
  files['trace.jsonl'] = rows.map(row => JSON.stringify(row)).join('\n');
  return {name: 'thread-correlation', files};
}

test('threadless protocol completion enriches its uniquely known child turn instead of inventing a root turn', () => {
  const {session, traceInfo} = Trace.parseBundle(protocolCorrelationFixture([
    ['root', 'root-turn', 0, 40], ['child', 'child-turn', 10, 20],
  ], {type: 'task_complete', turn_id: 'child-turn', duration_ms: 9}));
  assert.equal(session.turns.length, 2);
  assert.equal(session.turns.find(turn => turn.threadId === 'child').reportedDurationMs, 9);
  assert.equal(traceInfo.events.find(event => event.type === 'protocol_event_observed').threadId, 'child');
  assert.equal(traceInfo.threads.length, 2);
});

test('ambiguous or unmatched protocol mirrors preserve raw events without creating or enriching a guessed turn', () => {
  const ambiguous = Trace.parseBundle(protocolCorrelationFixture([
    ['root', 'same-turn', 0, 40], ['child', 'same-turn', 10, 20],
  ], {type: 'task_complete', turn_id: 'same-turn', duration_ms: 999}));
  assert.equal(ambiguous.session.turns.length, 2);
  assert.ok(ambiguous.session.turns.every(turn => turn.reportedDurationMs == null));
  assert.ok(ambiguous.traceInfo.diagnostics.some(message => message.includes('无法唯一关联')));
  assert.equal(ambiguous.traceInfo.events.length, 5);
  const unmatched = Trace.parseBundle(protocolCorrelationFixture([
    ['root', 'root-turn', 0, 40],
  ], {type: 'task_complete', turn_id: 'unobserved-turn', duration_ms: 999}));
  assert.equal(unmatched.session.turns.length, 1);
  assert.ok(unmatched.traceInfo.diagnostics.some(message => message.includes('无法关联')));
});

test('explicit nested protocol thread or session identity disambiguates reused turn IDs', () => {
  for (const field of ['thread_id', 'session_id']) {
    const {session, traceInfo} = Trace.parseBundle(protocolCorrelationFixture([
      ['root', 'same-turn', 0, 40], ['child', 'same-turn', 10, 20],
    ], {type: 'task_complete', turn_id: 'same-turn', [field]: 'child', duration_ms: 8}));
    assert.equal(session.turns.length, 2);
    assert.equal(session.turns.find(turn => turn.threadId === 'child').reportedDurationMs, 8);
    assert.equal(session.turns.find(turn => turn.threadId === 'root').reportedDurationMs, undefined);
    assert.equal(traceInfo.events.find(event => event.type === 'protocol_event_observed').threadId, 'child');
  }
});
