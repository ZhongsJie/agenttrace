const {test} = require('node:test');
const assert = require('node:assert/strict');
const {traceIdentity, rolloutIdentity} = require('../src/core/trace-parser.js');
const bundle = (manifest, first) => ({files: {'manifest.json': JSON.stringify(manifest), 'trace.jsonl': typeof first === 'string' ? first : JSON.stringify(first)}});
test('association uses first record identity and rejects conflicting claims', () => {
  const first = {rollout_id: 'session', payload: {type:'rollout_started', root_thread_id:'session', trace_id:'trace'}};
  assert.equal(traceIdentity(bundle({rollout_id:'session',trace_id:'trace'},first)).sessionId,'session');
  assert.equal(traceIdentity(bundle({rollout_id:'other'},first)).status,'conflict');
  assert.equal(traceIdentity(bundle({trace_id:'session'},{payload:{type:'rollout_started',trace_id:'session'}})).sessionId,null);
  assert.equal(traceIdentity(bundle({rollout_id:'session'},'broken\n'+JSON.stringify(first))).status,'unresolved');
  assert.equal(traceIdentity(bundle({}, {payload:{root_thread_id:'session'}})).sessionId,'session');
  assert.equal(rolloutIdentity({id:'a',session_id:'b'}).status,'conflict');
  assert.equal(rolloutIdentity({session_id:'a'}).sessionId,'a');
});
