const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const {parseRollout} = require('../parser.js');
const {buildReplay} = require('../replay.js');

function embeddedData(html) {
  const match = html.match(/<script id="embedded-rollout" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(match, 'report contains selected raw source');
  assert.ok(!match[1].includes('<'), 'raw log cannot terminate data script');
  return JSON.parse(match[1]);
}

function checkStandalonePage(html) {
  assert.doesNotMatch(html, /<iframe\b|\bsrcdoc\s*=|<script\b[^>]*\bsrc\s*=|<link\b[^>]*rel="stylesheet"/i);
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.ok(scripts.some(script => !script[1].includes('application/json')));
  for (const script of scripts) {
    if (!script[1].includes('application/json')) assert.doesNotThrow(() => new vm.Script(script[2]));
  }
  for (const label of ['Conversation', 'Events', 'Tools', 'Tokens', 'Overview', 'Metrics', 'Details']) {
    assert.ok(html.includes(label), `reference layout contains ${label}`);
  }
  assert.match(html, /<div id="app"><\/div>/);
  assert.match(html, /AgentFormat/);
}

test('standalone page embeds application assets and preserves log text as data', async () => {
  const {createPage} = await import('../page.mjs');
  const name = 'literal-$&.jsonl';
  const message = '</script><script>alert(1)</script> $& $` /*TURNS_DATA*/ " & <';
  const text = JSON.stringify({timestamp: '2026-11-05T11:38:50.000Z', type: 'response_item', payload: {type: 'message', role: 'user', content: [{text: message}]}});
  checkStandalonePage(await createPage());
  const report = await createPage({rollout: {name, text}});
  checkStandalonePage(report);
  const data = embeddedData(report);
  assert.deepEqual(data, {name, text});
  const model = buildReplay(parseRollout(data.text, data.name));
  assert.equal(model.metrics.messages, 1);
  assert.equal(model.steps[0].body, message);
  assert.equal(model.metrics.tokens, null);
});

test('product code has no external player source or template imports', async () => {
  const root = path.resolve(__dirname, '..');
  const files = ['index.html', 'style.css', 'frontend/src/App.vue', 'replay.js', 'formatter.js', 'trace-parser.js', 'page.mjs', 'trace-loader.mjs', 'start.mjs'];
  for (const file of files) {
    const source = await fs.readFile(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /claude-replay|vendor\/|playerAssets|renderReplay|srcdoc|REPLAY_ASSETS|TURNS_DATA/);
  }
  await assert.rejects(fs.access(path.join(root, 'vendor')));
});
