const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parseRollout} = require('../parser.js');
const {buildReplay, projectReplay, projectViews, reducePlayback, createPlayer, escapeHtml, json} = require('../replay.js');
const epoch = 1700000000000;
const row = (ms, type, payload) => ({timestamp: new Date(epoch + ms).toISOString(), type, payload});
const message = (role, text) => ({type: 'message', role, content: [{text}]});
const parse = rows => parseRollout(rows.map(value => JSON.stringify(value)).join('\n'));

function fixture() {
  return parse([
    row(0, 'response_item', message('user', '<environment_context>prologue</environment_context>')),
    row(10, 'event_msg', {type: 'task_started', turn_id: 'turn-1'}),
    row(20, 'response_item', message('user', 'Find a person')),
    row(100, 'response_item', {type: 'reasoning', summary: [{text: 'Search the directory'}]}),
    row(200, 'response_item', {type: 'function_call', call_id: 'call-1', name: 'oa_search', arguments: '{"keyword":"person"}'}),
    row(500, 'response_item', {type: 'function_call_output', call_id: 'call-1', output: 'Found a person'}),
    row(500, 'event_msg', {type: 'token_count', info: {total_token_usage: {input_tokens: 100, output_tokens: 20, total_tokens: 120}}}),
    row(800, 'response_item', message('assistant', 'Here is the result')),
    row(1000, 'event_msg', {type: 'task_complete', turn_id: 'turn-1', duration_ms: 990}),
  ]);
}

function fakeClock() {
  let time = 0;
  let sequence = 0;
  const callbacks = new Map();
  return {
    request(callback) { const id = sequence++; callbacks.set(id, callback); return id; },
    cancel(id) { callbacks.delete(id); },
    now() { return time; },
    advance(milliseconds) { time += milliseconds; },
    frame(milliseconds) {
      time += milliseconds;
      const pending = [...callbacks.values()];
      callbacks.clear();
      pending.forEach(callback => callback(time));
    },
    pending() { return callbacks.size; },
  };
}

test('native timeline retains actual facts and keeps prologue outside conversation', () => {
  const source = fixture();
  const model = buildReplay(source);
  assert.equal(model.timing, 'recorded');
  assert.equal(model.originTime, epoch);
  assert.equal(model.durationMs, 1000);
  assert.equal(model.metrics.recordedDurationMs, 1000);
  assert.equal(model.metrics.turns, 1);
  assert.equal(model.metrics.messages, 2);
  assert.equal(model.metrics.toolCalls, 1);
  assert.deepEqual(model.metrics.tokens, {input_tokens: 100, output_tokens: 20, total_tokens: 120});
  assert.deepEqual(model.metrics.toolTotals, [{name: 'oa_search', count: 1, totalDurationMs: 300, knownCount: 1, unknownCount: 0}]);
  assert.equal(model.steps.find(step => step.body.includes('prologue')).contextOnly, true);
  assert.equal(model.steps.find(step => step.body === 'Find a person').turnIndex, 1);
  assert.deepEqual(model.tracks.user.map(mark => mark.atMs), [20]);
  assert.deepEqual(model.tracks.tool.map(mark => [mark.atMs, mark.endMs]), [[200, 500]]);
  assert.equal(source.steps[0].atMs, undefined);
});

test('tool results reveal only at their own completion boundary and disappear on backward seek', () => {
  const model = buildReplay(fixture());
  const toolAt = time => projectReplay(model, time).find(entry => entry.step.kind === 'tool');
  assert.equal(toolAt(199), undefined);
  assert.equal(toolAt(200).phase, 'running');
  assert.equal(toolAt(499).outputVisible, false);
  assert.equal(toolAt(500).phase, 'completed');
  assert.equal(toolAt(500).outputVisible, true);
  assert.equal(toolAt(499).phase, 'running');
  assert.equal(toolAt(499).outputVisible, false);
  assert.deepEqual(model.timeline.filter(event => event.stepId === toolAt(500).step.id).map(event => [event.kind, event.atMs]), [['tool_start', 200], ['tool_result', 500]]);
});

test('overlapping tool completions remain independent and preserve measured parallel groups', () => {
  const session = parse([
    row(0, 'response_item', {type: 'function_call', name: 'a', call_id: 'a'}),
    row(10, 'response_item', {type: 'function_call', name: 'b', call_id: 'b'}),
    row(20, 'response_item', {type: 'function_call_output', call_id: 'b', output: 'b done'}),
    row(30, 'response_item', {type: 'function_call_output', call_id: 'a', output: 'a done'}),
  ]);
  const model = buildReplay(session);
  const at20 = projectReplay(model, 20);
  assert.equal(at20.find(entry => entry.step.callId === 'a').outputVisible, false);
  assert.equal(at20.find(entry => entry.step.callId === 'b').outputVisible, true);
  assert.deepEqual(model.tracks.tool.map(mark => mark.parallelGroup), [1, 1]);
  assert.deepEqual(model.metrics.toolTotals.map(total => total.totalDurationMs), [30, 10]);
});

test('presentation timing supports missing timestamps without inventing measured duration or tokens', () => {
  const session = parseRollout([
    {type: 'response_item', payload: message('user', 'Partial log')},
    {type: 'response_item', payload: {type: 'function_call', call_id: 'x', name: 'read', arguments: '{}'}},
    {type: 'response_item', payload: {type: 'function_call_output', call_id: 'x', output: 'result'}},
  ].map(value => JSON.stringify(value)).join('\n'));
  const model = buildReplay(session);
  assert.equal(model.timing, 'presentation');
  assert.equal(model.originTime, null);
  assert.equal(model.durationMs, 1400);
  assert.equal(model.metrics.recordedDurationMs, null);
  assert.equal(model.metrics.tokens, null);
  assert.equal(model.metrics.turns, 0);
  assert.deepEqual(model.metrics.toolTotals, [{name: 'read', count: 1, totalDurationMs: 0, knownCount: 0, unknownCount: 1}]);
  assert.equal(projectReplay(model, 700).find(entry => entry.step.kind === 'tool').outputVisible, false);
  assert.equal(projectReplay(model, 1400).find(entry => entry.step.kind === 'tool').outputVisible, true);
});

test('orphan output has no invented start and unfinished calls have no invented result', () => {
  const session = parse([
    row(0, 'response_item', {type: 'function_call_output', call_id: 'orphan', output: 'orphan result'}),
    row(10, 'response_item', {type: 'function_call', call_id: 'unfinished', name: 'read'}),
  ]);
  const model = buildReplay(session);
  assert.deepEqual(model.timeline.map(event => event.kind), ['tool_result', 'tool_start']);
  const visible = projectReplay(model, model.durationMs);
  assert.equal(visible[0].phase, 'missing_start');
  assert.equal(visible[0].outputVisible, true);
  assert.equal(visible[0].step.duration, null);
  assert.equal(visible[1].phase, 'running');
  assert.equal(visible[1].outputVisible, false);
  assert.equal(visible[1].step.endAtMs, null);
});

test('same-time records reveal together and stepping uses unique boundaries', () => {
  const model = buildReplay(parse([
    row(0, 'response_item', message('user', 'Start')),
    row(100, 'response_item', message('assistant', 'First')),
    row(100, 'response_item', message('assistant', 'Second')),
    row(200, 'response_item', message('assistant', 'Last')),
  ]));
  assert.deepEqual(model.boundaries, [0, 100, 200]);
  let state = {status: 'paused', positionMs: 0, speed: 1};
  state = reducePlayback(model, state, {type: 'STEP', direction: 1});
  assert.equal(state.positionMs, 100);
  assert.equal(projectReplay(model, state.positionMs).length, 3);
  state = reducePlayback(model, state, {type: 'STEP', direction: -1});
  assert.equal(state.positionMs, 0);
});

test('token graph uses cumulative deltas including counter resets rather than last snapshot', () => {
  const session = parse([100, 150, 20].map((total_tokens, index) => row(index * 100, 'event_msg', {type: 'token_count', info: {total_token_usage: {total_tokens}}})));
  const model = buildReplay(session);
  assert.deepEqual(model.metrics.usage.map(point => point.totalTokens), [100, 150, 170]);
  assert.equal(model.metrics.tokens.total_tokens, 170);
});

test('reducer clamps seeks and speed while ticks cannot move a paused cursor', () => {
  const model = buildReplay(fixture());
  const paused = {status: 'paused', positionMs: 100, speed: 1};
  assert.equal(reducePlayback(model, paused, {type: 'TICK', deltaMs: 500}), paused);
  assert.equal(reducePlayback(model, paused, {type: 'SET_SPEED', speed: 0}), paused);
  assert.equal(reducePlayback(model, paused, {type: 'SET_SPEED', speed: Infinity}), paused);
  assert.equal(reducePlayback(model, paused, {type: 'SET_SPEED', speed: 99}).speed, 16);
  assert.equal(reducePlayback(model, paused, {type: 'SEEK', positionMs: -200}).positionMs, 0);
  assert.deepEqual(reducePlayback(model, paused, {type: 'SEEK', positionMs: 9000}), {status: 'ended', positionMs: 1000, speed: 1});
  assert.equal(reducePlayback(model, paused, {type: 'SEEK', positionMs: NaN}), paused);
});

test('controller owns one scheduler and preserves elapsed time across pause, resume and speed changes', () => {
  const clock = fakeClock();
  const changes = [];
  const player = createPlayer(buildReplay(fixture()), snapshot => changes.push(snapshot), clock);
  assert.deepEqual(player.getState(), {status: 'ended', positionMs: 1000, speed: 1});
  assert.equal(clock.pending(), 0);
  assert.equal(changes.length, 0);
  player.play();
  player.play();
  assert.equal(clock.pending(), 1);
  assert.equal(player.getState().positionMs, 0);
  clock.frame(100);
  assert.equal(player.getState().positionMs, 100);
  clock.advance(50);
  player.setSpeed(2);
  assert.equal(player.getState().positionMs, 150);
  clock.frame(100);
  assert.equal(player.getState().positionMs, 350);
  clock.advance(25);
  player.pause();
  assert.equal(player.getState().positionMs, 400);
  assert.equal(clock.pending(), 0);
  clock.frame(900);
  assert.equal(player.getState().positionMs, 400);
  player.play();
  clock.frame(100);
  assert.equal(player.getState().positionMs, 600);
  player.destroy();
  assert.equal(clock.pending(), 0);
});

test('seeking pauses playback, hides completed output and ends exactly at the final boundary', () => {
  const clock = fakeClock();
  const changes = [];
  const model = buildReplay(fixture());
  const player = createPlayer(model, snapshot => changes.push(snapshot), clock);
  player.play();
  clock.frame(600);
  assert.equal(changes.at(-1).visible.find(entry => entry.step.kind === 'tool').outputVisible, true);
  player.seek(250);
  assert.equal(player.getState().status, 'paused');
  assert.equal(clock.pending(), 0);
  assert.equal(changes.at(-1).visible.find(entry => entry.step.kind === 'tool').outputVisible, false);
  player.step(1);
  assert.equal(player.getState().positionMs, 500);
  player.play();
  clock.frame(5000);
  assert.deepEqual(player.getState(), {status: 'ended', positionMs: 1000, speed: 1});
  assert.equal(clock.pending(), 0);
  player.play();
  assert.equal(player.getState().positionMs, 0);
  player.destroy();
});

test('destroy prevents queued work and all later controller commands from notifying', () => {
  const clock = fakeClock();
  let notifications = 0;
  const player = createPlayer(buildReplay(fixture()), () => notifications++, clock);
  player.play();
  player.destroy();
  const before = notifications;
  player.play(); player.seek(500); player.step(1); player.setSpeed(3); player.toggle();
  clock.frame(1000);
  assert.equal(notifications, before);
  assert.equal(clock.pending(), 0);
  assert.notEqual(player.getState().status, 'playing');
});

test('empty and zero-duration logs never schedule playback', () => {
  for (const session of [parseRollout(''), parse([row(0, 'response_item', message('assistant', 'One instant'))])]) {
    const clock = fakeClock();
    const model = buildReplay(session);
    const player = createPlayer(model, () => {}, clock);
    player.play();
    assert.equal(player.getState().status, 'paused');
    assert.equal(clock.pending(), 0);
    player.destroy();
  }
});

test('state snapshots cannot be used to change the player and log text is safely encodable', () => {
  const clock = fakeClock();
  const player = createPlayer(buildReplay(fixture()), () => {}, clock);
  const state = player.getState();
  state.positionMs = 99999;
  assert.equal(player.getState().positionMs, 1000);
  const text = '</script><script>alert(1)</script> $& $` $\' /*PLACEHOLDER*/\u2028\u2029';
  const encoded = json({text});
  assert.equal(JSON.parse(encoded).text, text);
  assert.ok(!encoded.includes('<'));
  assert.ok(!encoded.includes('\u2028'));
  assert.ok(!encoded.includes('\u2029'));
  assert.equal(escapeHtml('<img src="x" onerror=\'x\'>'), '&lt;img src=&quot;x&quot; onerror=&#39;x&#39;&gt;');
});


test('independent projections share clock while source switching leaves metrics fixed',()=>{
 const model=buildReplay(parse([
  row(0,'event_msg',{type:'task_started',turn_id:'turn'}),
  row(1,'response_item',message('user','model input')),
  row(2,'event_msg',{type:'user_message',message:'client input'}),
  row(3,'event_msg',{type:'agent_message',message:'client only output'}),
  row(4,'response_item',message('assistant','model output')),
  row(5,'event_msg',{type:'token_count',info:{total_token_usage:{total_tokens:10}}}),
 ]));
 const before=JSON.stringify(model.metrics);
 const atThree=projectViews(model,3);
 assert.deepEqual(atThree.modelItems.map(e=>e.step.body),['model input']);
 assert.deepEqual(atThree.clientMessages.map(e=>e.step.body),['client input','client only output']);
 assert.equal(atThree.runtimeEvents.length,3);
 assert.equal(projectViews(model,5).runtimeEvents.length,4);
 assert.equal(projectViews(model,1).clientMessages.length,0);
 assert.equal(model.metrics.messages,2);
 assert.equal(model.metrics.events,4);
 assert.equal(JSON.stringify(model.metrics),before);
 assert.equal(model.conversationSource,'modelItems');
});

test('event-only logs explicitly select client messages without manufacturing model entries',()=>{
 const model=buildReplay(parse([
  row(0,'event_msg',{type:'task_started',turn_id:'turn'}),
  row(1,'event_msg',{type:'user_message',message:'hello'}),
  row(2,'event_msg',{type:'agent_message',message:'hello'}),
 ]));
 assert.equal(model.conversationSource,'clientMessages');
 assert.equal(projectViews(model,2).modelItems.length,0);
 assert.equal(projectViews(model,2).clientMessages.length,2);
 assert.equal(projectViews(model,2).runtimeEvents.length,3);
 assert.equal(model.metrics.messages,2);
});

test('only initial prelude is a reminder and logs without task markers remain readable',()=>{
 const model=buildReplay(parse([
  row(0,'response_item',message('user','startup material')),
  row(10,'event_msg',{type:'task_started',turn_id:'one'}),
  row(20,'response_item',message('user','first request')),
  row(30,'event_msg',{type:'task_complete',turn_id:'one'}),
  row(40,'response_item',message('user','next request before next task marker')),
 ]));
 assert.equal(model.metrics.messages,2);
 assert.equal(model.tracks.user.length,2);
 assert.equal(model.steps.find(step=>step.body==='startup material').contextOnly,true);
 assert.equal(model.steps.find(step=>step.body==='next request before next task marker').contextOnly,false);
 const legacy=buildReplay(parse([row(0,'response_item',message('user','legacy user'))]));
 assert.equal(legacy.metrics.messages,1);
 assert.equal(legacy.tracks.user.length,1);
 assert.equal(legacy.steps[0].contextOnly,false);
});
