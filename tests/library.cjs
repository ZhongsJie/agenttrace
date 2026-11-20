const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const libraryModule = () => import('../src/server/session-library.mjs');
async function sandbox(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agenttrace-library-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  return root;
}
async function rollout(root, relative, id) {
  const filename = path.join(root, relative);
  await fs.mkdir(path.dirname(filename), {recursive: true});
  await fs.writeFile(filename, JSON.stringify({type: 'session_meta', payload: {id, timestamp: '2026-11-20T00:00:00Z'}}) + '\n');
  return filename;
}
async function bundle(root, name, id, options = {}) {
  const directory = path.join(root, name);
  await fs.mkdir(directory, {recursive: true});
  await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify({schema_version: 1, trace_id: name, rollout_id: id, root_thread_id: id, raw_event_log: 'trace.jsonl'}));
  await fs.writeFile(path.join(directory, 'trace.jsonl'), JSON.stringify({seq: 1, rollout_id: options.firstId || id, payload: {type: 'rollout_started', trace_id: name, root_thread_id: options.firstId || id}}) + '\n' + JSON.stringify({seq: 2, payload: {type: 'inference_started', request_payload: {raw_payload_id: 'raw_payload:1', kind: {type: 'inference_request'}, path: 'payloads/request.json'}}}));
  return directory;
}

test('recursive catalog associates multiple traces by header metadata and deduplicates overlapping roots', async t => {
  const root = await sandbox(t), sessions = path.join(root, 'sessions'), traces = path.join(root, 'traces');
  await rollout(sessions, '2026/11/20/rollout-misleading.jsonl', 'actual');
  await rollout(sessions, '2026/10/rollout-another.jsonl', 'other');
  await bundle(traces, 'trace-one', 'actual'); await bundle(traces, 'trace-two', 'actual');
  await bundle(traces, 'trace-unmatched', 'missing'); await bundle(traces, 'trace-conflict', 'actual', {firstId: 'other'});
  const {createSessionLibrary} = await libraryModule();
  const library = await createSessionLibrary({settingsFile: path.join(root, 'settings.json'), initialSettings: {sessionRoot: sessions, traceRoot: traces, additionalSessionRoots: [path.join(sessions, '2026')]}});
  const catalog = library.catalog();
  assert.equal(catalog.sessions.length, 2);
  const actual = catalog.sessions.find(item => item.sessionId === 'actual');
  assert.equal(actual.traceCount, 2); assert.equal(actual.association, 'matched');
  assert.equal(catalog.unmatchedTraces.length, 2);
  const loaded = await library.loadSession(actual.key);
  assert.equal(loaded.traceBundles.length, 2); assert.match(loaded.text, /actual/);
  assert.equal((await library.loadTraces('other')).traceBundles.length, 0);
  await assert.rejects(library.loadSession('../../secret'), {statusCode: 404});
});

test('duplicate session identities suppress attachment and stale source identity requires rescan', async t => {
  const root = await sandbox(t), sessions = path.join(root, 'sessions'), traces = path.join(root, 'traces');
  const first = await rollout(sessions, 'rollout-one.jsonl', 'same');
  await rollout(sessions, 'sub/rollout-two.jsonl', 'same'); await bundle(traces, 'trace', 'same');
  const {createSessionLibrary} = await libraryModule();
  const library = await createSessionLibrary({settingsFile: path.join(root, 'settings.json'), initialSettings: {sessionRoot: sessions, traceRoot: traces}});
  assert(library.catalog().sessions.every(item => item.association === 'ambiguous' && item.traceCount === 0));
  assert.equal((await library.loadTraces('same')).traceBundles.length, 0);
  const key = library.catalog().sessions.find(item => item.name === 'rollout-one.jsonl').key;
  await fs.writeFile(first, JSON.stringify({type: 'session_meta', payload: {id: 'changed'}}));
  await assert.rejects(library.loadSession(key), {statusCode: 409});
});

test('settings persist, add directories, publish immutable revisions, and reject invalid changes', async t => {
  const root = await sandbox(t), first = path.join(root, 'first'), extra = path.join(root, 'extra'), settingsFile = path.join(root, 'config/settings.json');
  await rollout(first, 'rollout-one.jsonl', 'one'); await rollout(extra, '2025/rollout-two.jsonl', 'two');
  const {createSessionLibrary} = await libraryModule();
  const library = await createSessionLibrary({settingsFile, initialSettings: {sessionRoot: first}});
  const old = library.catalog(); old.sessions.length = 0;
  assert.equal(library.catalog().sessions.length, 1);
  const saved = await library.updateSettings({sessionRoot: first, traceRoot: '', additionalSessionRoots: [extra]});
  assert.equal(saved.catalog.sessions.length, 1); assert.equal(saved.catalog.revision, 1);
  const refreshed = await library.refresh();
  assert.equal(refreshed.sessions.length, 2); assert.equal(refreshed.revision, 2);
  const restarted = await createSessionLibrary({settingsFile, initialSettings: {sessionRoot: '/ignored'}});
  assert.equal(restarted.catalog().sessions.length, 2);
  await assert.rejects(library.updateSettings({sessionRoot: 123, traceRoot: '', additionalSessionRoots: []}));
  assert.equal(library.catalog().revision, 2);
  const filename = await rollout(root, 'rollout-file.jsonl', 'file');
  await assert.rejects(library.updateSettings({sessionRoot: filename, traceRoot: '', additionalSessionRoots: []}), /Not a directory/);
  assert.equal((await library.refresh()).revision, 3);
});

test('trace payload loading is lazy and revalidates identity after scan', async t => {
  const root = await sandbox(t), sessions = path.join(root, 'sessions'), traces = path.join(root, 'traces');
  await rollout(sessions, 'rollout-one.jsonl', 'one');
  const directory = await bundle(traces, 'trace', 'one');
  const {createSessionLibrary} = await libraryModule();
  const library = await createSessionLibrary({settingsFile: path.join(root, 'settings.json'), initialSettings: {sessionRoot: sessions, traceRoot: traces}});
  assert.equal(library.catalog().sessions[0].traceCount, 1);
  await fs.mkdir(path.join(directory, 'payloads'));
  await fs.writeFile(path.join(directory, 'payloads/request.json'), '{"loaded":"after-scan"}');
  const loaded = await library.loadSession(library.catalog().sessions[0].key);
  assert.match(loaded.traceBundles[0].files['payloads/request.json'], /after-scan/);
  await fs.writeFile(path.join(directory, 'trace.jsonl'), JSON.stringify({rollout_id: 'impostor', payload: {type: 'rollout_started'}}));
  const stale = await library.loadTraces('one');
  assert.equal(stale.traceBundles.length, 0); assert.match(stale.warnings.join(' '), /trace identity has changed/);
});

test('replaced trace directory symlinks cannot escape the indexed bundle', async t => {
  const root = await sandbox(t), sessions = path.join(root, 'sessions'), traces = path.join(root, 'traces');
  await rollout(sessions, 'rollout-one.jsonl', 'one');
  const directory = await bundle(traces, 'trace', 'one');
  const outside = await bundle(path.join(root, 'outside'), 'trace', 'one');
  const {createSessionLibrary} = await libraryModule();
  const library = await createSessionLibrary({settingsFile: path.join(root, 'settings.json'), initialSettings: {sessionRoot: sessions, traceRoot: traces}});
  await fs.rm(directory, {recursive: true}); await fs.symlink(outside, directory, 'dir');
  const result = await library.loadTraces('one');
  assert.equal(result.traceBundles.length, 0); assert.match(result.warnings.join(' '), /outside the trace directory/);
});

test('catalog shows turn context model before loading a session', async t => {
  const root = await sandbox(t);
  const filename = await rollout(root, '2026/11/rollout-model.jsonl', 'model-session');
  await fs.appendFile(filename, JSON.stringify({type:'response_item',payload:{type:'message',role:'user'}})+'\n'+JSON.stringify({type:'turn_context',payload:{model:'qwen3.8-flash'}})+'\n');
  const {createSessionLibrary} = await libraryModule();
  const library = await createSessionLibrary({settingsFile:path.join(root,'settings.json'),initialSettings:{sessionRoot:root,traceRoot:'',additionalSessionRoots:[]}});
  assert.equal(library.catalog().sessions[0].model,'qwen3.8-flash');
});
