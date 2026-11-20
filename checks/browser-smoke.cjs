const {test} = require('node:test');
const assert = require('node:assert/strict');
const {mkdtemp, realpath, rm, writeFile, readFile} = require('node:fs/promises');
const {tmpdir} = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const {chromium} = require('playwright');

function rollout(id, model) {
  return [
    {type: 'session_meta', payload: {id, cli_version: '1.2.3', model_provider: 'fixture-provider'}},
    {type: 'turn_context', payload: {model}},
    {type: 'response_item', payload: {type: 'message', role: 'user', content: [{type: 'input_text', text: 'Fixture message'}]}},
  ].map((record, index) => JSON.stringify({...record, timestamp: `2026-11-20T00:00:0${index}.000Z`})).join('\n');
}

async function checkSession(page, id, model) {
  await page.getByRole('heading', {name: id, exact: true}).waitFor();
  assert.match(await page.locator('#session-chips').innerText(), new RegExp(model));
  assert.match(await page.locator('#session-chips').innerText(), /CLI 1\.2\.3/);
  assert.match(await page.locator('#session-summary').innerText(), /Messages\s*1/);
  assert.equal(await page.locator('#session-list button[aria-current=true] strong').textContent(), id);
}

test('standalone report reads embedded sessions, filters imports, and reopens its export', async () => {
  const {createPage} = await import('../src/server/page.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'agenttrace-browser-'));
  let browser;
  try {
    const report = path.join(directory, 'report.html');
    await writeFile(report, await createPage({rollout: {name: 'original.jsonl', text: rollout('embedded-session', 'embedded-model')}}));
    browser = await chromium.launch();
    const page = await browser.newPage({offline: true});
    page.setDefaultTimeout(5000);
    const errors = [];
    const networkRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url())) networkRequests.push(request.url()); });
    await page.goto(pathToFileURL(report).href);
    await checkSession(page, 'embedded-session', 'embedded-model');
    await page.locator('#seek').press('Home');
    assert.equal(await page.locator('#seek').inputValue(), '0');
    await checkSession(page, 'embedded-session', 'embedded-model');
    await page.locator('#files').setInputFiles({name: 'second fixture.jsonl', mimeType: 'application/jsonl', buffer: Buffer.from(rollout('second-session', 'imported-model'))});
    await checkSession(page, 'second-session', 'imported-model');
    await page.locator('#session-search').fill('ORIGINAL.JSONL');
    await page.locator('#session-list button').filter({hasText: 'embedded-session'}).click();
    await checkSession(page, 'embedded-session', 'embedded-model');
    assert.equal(await page.locator('#session-list button').count(), 1);
    await page.locator('#session-search').fill('no match');
    await page.locator('#session-list').getByText('No matching sessions.').waitFor();
    await page.locator('#session-search').fill('');
    const downloadReady = page.waitForEvent('download');
    await page.getByRole('button', {name: 'Export'}).click();
    const download = await downloadReady;
    const exported = path.join(directory, 'exported.html');
    await download.saveAs(exported);
    const html = await readFile(exported, 'utf8');
    assert.doesNotMatch(html, /<script\b[^>]*\bsrc\s*=|<link\b[^>]*rel=["']stylesheet|id="server-config"/i);
    await page.goto(pathToFileURL(exported).href);
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    await checkSession(page, 'embedded-session', 'embedded-model');
    assert.equal(await page.locator('#session-list button').count(), 1);
    await page.getByRole('button', {name: 'Settings'}).click();
    assert.equal(await page.locator('#settings-save').isDisabled(), true);
    assert.deepEqual(networkRequests, []);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('localhost page handles lazy selection and an empty catalog', async () => {
  const {startServer} = await import('../src/server/start.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'agenttrace-browser-server-'));
  let browser, running;
  try {
    const input = path.join(directory, 'rollout-server-session.jsonl');
    await writeFile(input, rollout('server-session', 'server-model'));
    running = await startServer({port: 0, sessionRoot: directory, settingsFile: path.join(directory, 'settings.json')});
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    await page.route('**/api/sessions/*', async route => { await gate; await route.continue(); });
    try {
      await page.goto(running.url);
      await page.getByRole('heading', {name: /^Loading/}).waitFor();
      assert.equal(await page.locator('#export').isDisabled(), true);
    } finally { release(); }
    await checkSession(page, 'server-session', 'server-model');
    await page.getByRole('button', {name: 'Settings'}).click();
    await page.waitForFunction(() => !document.getElementById('settings-save').disabled);
    assert.equal(await realpath(await page.locator('#settings-session-root').inputValue()), await realpath(directory));
    await page.locator('#settings-save').click();
    await page.getByText('Settings saved. Refresh the session list.').waitFor();
    await page.locator('#settings-close').click();
    await rm(input);
    await page.locator('#session-refresh').click();
    await page.getByRole('heading', {name: 'No sessions found'}).waitFor();
    assert.equal(await page.locator('#session-summary').innerText(), '');
    assert.equal(await page.locator('#export').isDisabled(), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await running?.close();
    await rm(directory, {recursive: true, force: true});
  }
});
