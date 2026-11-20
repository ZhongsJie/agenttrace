const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtemp, rm, writeFile} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require('playwright');

const epoch = Date.parse('2026-11-20T00:00:00Z');
const rolloutId = 'viewer-session';
const originalMessage = 'Model conversation \u4f60\u597d';
const row = (ms, type, payload) => JSON.stringify({timestamp: new Date(epoch + ms).toISOString(), type, payload});
function fixture() {
  const text = [
    row(0, 'session_meta', {id: rolloutId}),
    row(100, 'event_msg', {type: 'task_started', turn_id: 'turn-one'}),
    row(200, 'response_item', {type: 'message', role: 'user', content: [{text: originalMessage}]}),
    row(300, 'event_msg', {type: 'agent_message', message: 'Client conversation'}),
    row(400, 'response_item', {type: 'function_call', name: 'read_file', call_id: 'call-one', arguments: '{"path":"fixture"}'}),
    row(700, 'response_item', {type: 'function_call_output', call_id: 'call-one', output: 'TOOL_RESULT_ONLY'}),
    row(800, 'event_msg', {type: 'token_count', info: {total_token_usage: {input_tokens: 100, output_tokens: 20, total_tokens: 120}}}),
    row(900, 'event_msg', {type: 'task_complete', turn_id: 'turn-one'}),
  ].join('\n');
  const traceEvent = (seq, type, fields) => JSON.stringify({schema_version: 1, seq, wall_time_unix_ms: epoch + seq, rollout_id: rolloutId, thread_id: rolloutId, codex_turn_id: 'turn-one', payload: {type, ...fields}});
  const trace = {
    name: 'trace-fixture',
    files: {
      'manifest.json': JSON.stringify({schema_version: 1, trace_id: 'trace-fixture', rollout_id: rolloutId, root_thread_id: rolloutId, raw_event_log: 'trace.jsonl'}),
      'trace.jsonl': [traceEvent(1, 'inference_started', {inference_call_id: 'request-one', model: 'trace-model', request_payload: {raw_payload_id: 'request', path: 'payloads/request.json'}}),
        traceEvent(2, 'inference_completed', {inference_call_id: 'request-one', response_payload: {raw_payload_id: 'response', path: 'payloads/response.json'}})].join('\n'),
      'payloads/request.json': JSON.stringify({input: [{type: 'message', role: 'user', content: [{text: 'TRACE_REQUEST_ONLY'}]}]}),
      'payloads/response.json': JSON.stringify({token_usage: {input_tokens: 30, output_tokens: 10, total_tokens: 40}}),
    },
  };
  return {name: 'viewer-session.jsonl', text, traceBundles: [trace]};
}

test('Vue viewer preserves projections, tool boundaries, records, and attached Trace across export', async () => {
  const {createPage} = await import('../src/server/page.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'agenttrace-viewer-browser-'));
  let browser;
  try {
    const file = path.join(directory, 'viewer.html');
    await writeFile(file, await createPage({rollout: fixture()}));
    browser = await chromium.launch();
    const page = await browser.newPage({offline: true});
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(file).href);
    const feed = page.locator('#feed');
    const tab = name => page.getByRole('tab', {name, exact: true});
    await feed.getByText(originalMessage, {exact: true}).waitFor();
    await page.locator('#conversation-source').selectOption('clientMessages');
    await feed.getByText('Client conversation').waitFor();
    assert.equal(await feed.getByText(originalMessage, {exact: true}).count(), 0);
    await tab('Events').click();
    assert.ok(await feed.locator('.event-item').count());
    await tab('Tokens').click();
    assert.match(await feed.innerText(), /120/);
    await tab('Tools').click();
    const tool = feed.locator('.tool-card');
    await tool.locator('summary').click();
    await tool.getByText('TOOL_RESULT_ONLY', {exact: true}).waitFor();
    for (let step = 0; step < 4 && Number(await page.locator('#seek').inputValue()) > 400; step++) await page.locator('#previous').click();
    assert.equal(await page.locator('#seek').inputValue(), '400');
    await tool.getByText(/The result is not available/).waitFor();
    assert.equal(await tool.getByText('TOOL_RESULT_ONLY', {exact: true}).count(), 0);
    await page.locator('#seek').press('End');
    await tool.getByText('TOOL_RESULT_ONLY', {exact: true}).waitFor();
    await tool.locator('.code-view').filter({hasText: 'Tool result'}).getByRole('button', {name: 'Expand'}).click();
    const dialog = page.locator('#inspection-dialog');
    await dialog.getByText('TOOL_RESULT_ONLY', {exact: true}).waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({state: 'hidden'});
    await tab('Details').click();
    await page.getByRole('button', {name: 'Browse raw records'}).click();
    await dialog.locator('#record-query').fill('TOOL_RESULT_ONLY');
    assert.equal(await dialog.locator('.record-row').count(), 1);
    assert.match(await dialog.locator('#inspection-view').innerText(), /TOOL_RESULT_ONLY/);
    await page.keyboard.press('Escape');
    await dialog.waitFor({state: 'hidden'});
    await tab('Trace').click();
    await feed.getByText('Trace trace-fixture', {exact: true}).waitFor();
    assert.match(await feed.locator('.trace-summary').innerText(), /40/);
    await feed.getByRole('button', {name: 'Request payload'}).click();
    assert.match(await dialog.locator('#inspection-view').innerText(), /TRACE_REQUEST_ONLY/);
    await page.keyboard.press('Escape');
    await dialog.waitFor({state: 'hidden'});
    const pending = page.waitForEvent('download');
    await page.getByRole('button', {name: 'Export'}).click();
    const exported = path.join(directory, 'export.html');
    await (await pending).saveAs(exported);
    await page.goto(pathToFileURL(exported).href);
    await feed.getByText(originalMessage, {exact: true}).waitFor();
    await tab('Trace').click();
    await feed.getByText('Trace trace-fixture', {exact: true}).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await rm(directory, {recursive: true, force: true});
  }
});
