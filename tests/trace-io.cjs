const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

const ref = (id, file, type) => ({raw_payload_id: `raw_payload:${id}`, kind: {type}, path: file});
async function fixture(parent, id = 'sample') {
  const root = path.join(parent, id);
  await fs.mkdir(path.join(root, 'payloads'), {recursive: true});
  const manifest = {schema_version: 1, trace_id: 'trace-' + id, rollout_id: id, root_thread_id: id, started_at_unix_ms: 1000, raw_event_log: 'trace.jsonl', payloads_dir: 'payloads'};
  const rows = [
    {type: 'thread_started', thread_id: id, agent_path: '/root', metadata_payload: ref(1, 'payloads/1.json', 'session_metadata')},
    {type: 'inference_started', inference_call_id: 'call', model: 'test-model', request_payload: ref(2, 'payloads/2.json', 'inference_request')},
    {type: 'inference_completed', inference_call_id: 'call', response_payload: ref(3, 'payloads/3.json', 'inference_response')},
  ].map((payload, index) => ({schema_version: 1, seq: index + 1, wall_time_unix_ms: 1000 + index * 100, rollout_id: id, thread_id: id, codex_turn_id: 'turn', payload}));
  const files = {
    'manifest.json': JSON.stringify(manifest),
    'trace.jsonl': rows.map(row => JSON.stringify(row)).join('\n'),
    'payloads/1.json': JSON.stringify({thread_id: id, agent_path: '/root', model: 'test-model', rollout_path: '/not/authorized/to/read.jsonl'}),
    'payloads/2.json': JSON.stringify({model: 'test-model', input: [{type: 'message', role: 'user', content: [{type: 'input_text', text: 'literal </script> $&'}]}]}),
    'payloads/3.json': JSON.stringify({response_id: 'response', token_usage: {input_tokens: 2, output_tokens: 1, total_tokens: 3}, output_items: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'done'}]}]}),
    'payloads/unused.json': 'UNREFERENCED_PRIVATE_MARKER',
  };
  for (const [file, text] of Object.entries(files)) await fs.writeFile(path.join(root, file), text);
  return {root, files, rows};
}

function request(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {method}, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', data => { body += data; });
      response.on('end', () => resolve({status: response.statusCode, body}));
    });
    req.on('error', reject); req.end();
  });
}

test('Node loader accepts bundle and parent roots while reading referenced payloads only', async () => {
  const {discoverTraceRoot, loadTraceBundle} = await import('../src/server/trace-loader.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agenttrace-loader-'));
  try {
    const a = await fixture(directory, 'a'); await fixture(directory, 'b');
    const parent = await discoverTraceRoot(directory);
    assert.deepEqual(parent.descriptors.map(descriptor => descriptor.name), ['a', 'b']);
    assert.deepEqual(parent.warnings, []);
    const bundle = await loadTraceBundle(parent.descriptors[0]);
    assert.equal(bundle.files['payloads/2.json'], a.files['payloads/2.json']);
    assert.ok(!Object.hasOwn(bundle.files, 'payloads/unused.json'));
    assert.equal((await discoverTraceRoot(a.root)).descriptors.length, 1);
    assert.ok(!JSON.stringify(bundle).includes('UNREFERENCED_PRIVATE_MARKER'));
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});

test('missing payload and malformed neighboring manifest remain visible as diagnostics', async () => {
  const {discoverTraceRoot, loadTraceBundle} = await import('../src/server/trace-loader.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agenttrace-partial-'));
  try {
    const a = await fixture(directory);
    await fs.unlink(path.join(a.root, 'payloads/3.json'));
    await fs.mkdir(path.join(directory, 'broken'));
    await fs.writeFile(path.join(directory, 'broken/manifest.json'), 'broken JSON');
    const {descriptors, warnings} = await discoverTraceRoot(directory);
    assert.equal(descriptors.length, 1);
    const bundle = await loadTraceBundle(descriptors[0]);
    assert.match(bundle.warnings.join('\n'), /payloads\/3.json/);
    assert.match(warnings.join('\n'), /broken/);
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});

test('trace file reads reject traversal and payload symlinks leaving the bundle', async () => {
  const {discoverTraceRoot, loadTraceBundle} = await import('../src/server/trace-loader.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agenttrace-path-'));
  try {
    const a = await fixture(directory);
    await fs.writeFile(path.join(directory, 'private.json'), 'DO_NOT_INCLUDE_OUTSIDE');
    await fs.unlink(path.join(a.root, 'payloads/3.json'));
    await fs.symlink(path.join(directory, 'private.json'), path.join(a.root, 'payloads/3.json'));
    a.rows.push({...a.rows[0], seq: 4, payload: {type: 'unknown', leaked: ref(4, '../private.json', 'unknown')}});
    await fs.writeFile(path.join(a.root, 'trace.jsonl'), a.rows.map(row => JSON.stringify(row)).join('\n'));
    const {descriptors} = await discoverTraceRoot(a.root);
    const bundle = await loadTraceBundle(descriptors[0]);
    assert.ok(!Object.hasOwn(bundle.files, 'payloads/3.json'));
    assert.ok(!Object.hasOwn(bundle.files, '../private.json'));
    assert.match(bundle.warnings.join('\n'), /Rejected unsafe payload path/);
    assert.match(bundle.warnings.join('\n'), /outside the trace directory/);
    assert.ok(!JSON.stringify(bundle).includes('DO_NOT_INCLUDE_OUTSIDE'));
  } finally { await fs.rm(directory, {recursive: true, force: true}); }
});

test('localhost provides referenced Trace payloads separately from the page', async () => {
  const {startServer} = await import('../src/server/start.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agenttrace-portable-'));
  let running;
  try {
    const a = await fixture(directory);
    running = await startServer({port: 0, traceRoot: a.root, settingsFile: path.join(directory, 'settings.json')});
    const page = await request(running.url);
    assert.equal(page.status, 200);
    assert.ok(!page.body.includes(a.files['payloads/2.json']));
    const result = await request(running.url + '/api/traces?sessionId=sample');
    assert.equal(result.status, 200);
    const {traceBundles, warnings} = JSON.parse(result.body);
    assert.equal(traceBundles.length, 1);
    assert.equal(traceBundles[0].files['payloads/2.json'], a.files['payloads/2.json']);
    assert.ok(!Object.hasOwn(traceBundles[0].files, 'payloads/unused.json'));
    assert.deepEqual(warnings, []);
  } finally { if (running) await running.close(); await fs.rm(directory, {recursive: true, force: true}); }
});

test('localhost startup exposes lazy catalog without arbitrary filesystem routes', async t => {
  const {startServer} = await import('../src/server/start.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agenttrace-server-'));
  let running;
  try {
    const a = await fixture(directory);
    try { running = await startServer({port: 0, traceRoot: a.root, settingsFile: path.join(directory, 'settings.json')}); }
    catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('The local sandbox does not allow listening on localhost'); return; } throw error; }
    assert.ok(running.url.startsWith('http://127.0.0.1:'));
    const page = await request(running.url);
    assert.equal(page.status, 200); assert.match(page.body, /id="server-config"/);
    const catalog = JSON.parse((await request(running.url + '/api/catalog')).body);
    assert.equal(catalog.unmatchedTraces.length, 1);
    assert.equal(catalog.sessions.length, 0);
    assert.equal((await request(running.url + '/index.html', 'HEAD')).body, '');
    assert.equal((await request(running.url + '/manifest.json')).status, 404);
    assert.equal((await request(running.url + '/report.html')).status, 404);
    assert.equal((await request(running.url + '/dist/index.html')).status, 404);
    assert.deepEqual((await fs.readdir(directory)).sort(), [path.basename(a.root)]);
    assert.equal((await request(running.url + '/%2e%2e/private.json')).status, 404);
    assert.equal((await request(running.url, 'POST')).status, 405);
  } finally { if (running) await running.close(); await fs.rm(directory, {recursive: true, force: true}); }
});
