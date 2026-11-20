const {test} = require('node:test');
const assert = require('node:assert/strict');
const format = require('../src/core/formatter.js');

function decoded(html) {
  return html.replace(/<\/?span(?: class="tok-[a-z]+")?>/g, '')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function assertSafeAndExact(view) {
  assert.equal(decoded(view.html), view.text);
  assert.equal(view.lines.join('\n'), view.html);
  assert.equal(view.lineCount, view.text.split('\n').length);
  assert.doesNotMatch(view.html.replace(/<\/?span(?: class="tok-[a-z]+")?>/g, ''), /[<>]/);
  for (const line of view.lines) {
    assert.equal((line.match(/<span /g) || []).length, (line.match(/<\/span>/g) || []).length);
  }
}

test('JSON presentation pretty prints without changing the original source', () => {
  const source = '  {"name":"Renée","number":-2.5e3,"yes":true,"none":null,"list":[1,2]}\r\n';
  const document = format.document(source, {id: 'record-1', title: 'Event for Renée', origin: {sourceLine: 4}});
  const view = format.present(document);
  assert.equal(document.source, source);
  assert.equal(document.id, 'record-1');
  assert.equal(document.title, 'Event for Renée');
  assert.equal(document.origin.sourceLine, 4);
  assert.equal(view.source, source);
  assert.equal(view.language, 'json');
  assert.equal(view.text, JSON.stringify(JSON.parse(source), null, 2));
  assert.equal(view.warning, null);
  assert.match(view.html, /class="tok-key"/);
  assert.match(view.html, /class="tok-string"/);
  assert.match(view.html, /class="tok-number"/);
  assert.match(view.html, /class="tok-boolean"/);
  assert.match(view.html, /class="tok-null"/);
  assert.match(view.html, /class="tok-punctuation"/);
  assertSafeAndExact(view);
  const raw = format.present(document, {mode: 'raw'});
  assert.equal(raw.text, source);
  assertSafeAndExact(raw);
});

test('JSON formatting preserves encoded body strings instead of silently decoding them', () => {
  const body = '{"cmd":"echo <hello>","nested":"line\\nnext"}';
  const source = JSON.stringify({body});
  const view = format.present(format.document(source));
  assert.equal(JSON.parse(view.text).body, body);
  assertSafeAndExact(view);
});

test('malformed JSON stays intact with a visible parsing warning', () => {
  const source = '{"message": "unterminated\n<unsafe attr="x">';
  const view = format.present(format.document(source, {language: 'json'}));
  assert.equal(view.language, 'json');
  assert.equal(view.text, source);
  assert.match(view.warning, /Could not parse JSON.*original text was kept/);
  assertSafeAndExact(view);
});

test('JSONL retains malformed physical lines and reports their original line numbers', () => {
  const source = '{"one":1}\r\n\r\nnot-json <tag>\r\n {"two":true} \r\n';
  const document = format.document(source, {language: 'jsonl'});
  const view = format.present(document);
  assert.equal(view.source, source);
  assert.match(view.text, /not-json <tag>/);
  assert.match(view.warning, /Could not parse line 3/);
  assert.match(view.text, /"one": 1/);
  assert.match(view.text, /"two": true/);
  assertSafeAndExact(view);
  const raw = format.present(document, {mode: 'raw'});
  assert.equal(raw.text, source);
  assertSafeAndExact(raw);
  const multipleInvalid = format.present(format.document(source + 'incomplete', {language: 'jsonl'}));
  assert.match(multipleInvalid.warning, /Could not parse lines 3, 5/);
});

test('automatic detection recognizes JSONL and respects explicit language overrides', () => {
  const document = format.document('{"a":1}\n{"b":2}');
  assert.equal(document.suggestedLanguage, 'jsonl');
  assert.equal(format.present(document).language, 'jsonl');
  const text = format.present(document, {language: 'text'});
  assert.equal(text.text, document.source);
  assert.doesNotMatch(text.html, /class="tok-/);
  const unknown = format.present(document, {language: '"><img onerror=alert(1)>'});
  assert.equal(unknown.language, 'text');
  assertSafeAndExact(unknown);
  for (const language of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const fallback = format.present(document, {language});
    assert.equal(fallback.language, 'text');
    assertSafeAndExact(fallback);
    assert.equal(format.document('original', {language}).suggestedLanguage, 'text');
  }
});

test('hostile log markup never becomes executable markup or dynamic token classes', () => {
  const source = '</script><script>alert("X")</script><img src=x onerror="bad()"> &quot; & < > \' "';
  for (const language of format.languages.filter(language => language.id !== 'auto')) {
    const view = format.present(format.document(source, {language: language.id}), {mode: 'raw'});
    assertSafeAndExact(view);
    assert.doesNotMatch(view.html, /<script|<img|onerror="bad/);
  }
});

test('non-JSON language views highlight lexically and retain every source character', () => {
  const examples = {
    javascript: 'const x = "hello";\n/* multi\nline */\nif (x !== null) console.log(x);\n',
    typescript: 'interface User { name: string }\nconst item: User = {name: "Renée"};\n',
    python: 'def greet(name):\n    """multi\n    doc"""\n    return True # comment\n',
    bash: '#!/bin/bash\nexport NAME=world\nprintf "%s\\n" "$NAME" | cat --number\n',
    yaml: 'name: person\nready: true\n  list: [1, 2] # comment\n',
    xml: '<root name="unsafe & text">\n  <!-- multi\n  comment -->\n</root>\n',
    markdown: '# Heading\nText **bold** and [link](https://example.test).\n```js\nlet x = 1;\n```\n',
  };
  for (const [language, source] of Object.entries(examples)) {
    const view = format.present(format.document(source, {language}));
    assert.equal(view.language, language);
    assert.equal(view.text, source);
    assert.match(view.html, /class="tok-/);
    assertSafeAndExact(view);
  }
});

test('language hints guide code content while JSON values retain JSON formatting', () => {
  const shell = format.document('custom-tool --file /tmp/result', {hint: 'exec_command'});
  assert.equal(shell.suggestedLanguage, 'bash');
  const args = format.document('{"cmd":"ls -la"}', {hint: 'exec_command'});
  assert.equal(args.suggestedLanguage, 'json');
  assert.equal(format.document('def work():\n    return None').suggestedLanguage, 'python');
  assert.equal(format.document('<root id="1"/>').suggestedLanguage, 'xml');
  assert.equal(format.document('const value: number = 1;').suggestedLanguage, 'typescript');
  assert.equal(format.document('# Heading\n\nText').suggestedLanguage, 'markdown');
  assert.equal(format.document('arbitrary output Renée').suggestedLanguage, 'text');
});

test('record index preserves source line numbers, malformed entries and decoded previews', () => {
  const first = '\uFEFF' + JSON.stringify({timestamp: '2026-11-05T11:38:50Z', type: 'response_item', payload: {type: 'message', content: [{text: 'Renée'}]}});
  const source = first + '\r\n\r\n invalid <tag> \r\n {"type":"event_msg","payload":{"type":"token_count"}}\r\n42\n';
  const records = format.records(source);
  assert.equal(records.length, 4);
  assert.deepEqual(records.map(record => record.line), [1, 3, 4, 5]);
  assert.equal(records[0].source, first);
  assert.equal(records[0].category, 'response_item/message');
  assert.equal(records[0].timestamp, '2026-11-05T11:38:50Z');
  assert.equal(records[0].preview, 'Renée');
  assert.equal(records[1].valid, false);
  assert.equal(records[1].source, ' invalid <tag> ');
  assert.equal(records[1].category, 'unknown');
  assert.equal(records[2].category, 'event_msg/token_count');
  assert.equal(records[3].valid, true);
  assert.equal(records[3].type, 'unknown');
});

test('record search and type filtering cover the entire index rather than one rendered page', () => {
  const source = Array.from({length: 112}, (_, index) => JSON.stringify({type: index % 2 ? 'event_msg' : 'response_item', payload: {type: index % 2 ? 'token_count' : 'message', message: `person ${index} ${index === 105 ? 'Renée' : ''}`}})).join('\n');
  const records = format.records(source);
  const page = format.recordPage(records, {page: 3});
  assert.equal(page.page, 3);
  assert.equal(page.pageCount, 3);
  assert.equal(page.items.length, 12);
  assert.equal(page.items[0].line, 101);
  assert.equal(page.total, 112);
  const search = format.recordPage(records, {query: 'Renée'});
  assert.equal(search.total, 1);
  assert.equal(search.items[0].line, 106);
  const typed = format.recordPage(records, {type: 'event_msg/token_count', pageSize: 10, page: 2});
  assert.equal(typed.total, 56);
  assert.equal(typed.items.length, 10);
  assert.equal(typed.items[0].line, 22);
  const outer = format.recordPage(records, {type: 'event_msg'});
  assert.equal(outer.total, 56);
  assert.deepEqual(outer.types, ['event_msg/token_count', 'response_item/message']);
  assert.equal(records.length, 112);
  assert.equal(records[0].line, 1);
});

test('empty filtered pages expose no unrelated record and page bounds remain usable', () => {
  const records = format.records('{"type":"a"}\n{"type":"b"}');
  const empty = format.recordPage(records, {query: 'not present', page: 100});
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.filtered, []);
  assert.equal(empty.total, 0);
  assert.equal(empty.page, 1);
  assert.equal(empty.pageCount, 1);
  assert.equal(format.recordPage(records, {page: -1, pageSize: 1}).items[0].line, 1);
  assert.equal(format.recordPage(records, {page: 100, pageSize: 1}).items[0].line, 2);
  assert.equal(format.recordPage(records, {query: ' A ', type: 'a'}).total, 1);
});

test('generated object documents and empty content have stable native presentations', () => {
  const value = {name: 'Renée', nested: [true, null]};
  const doc = format.document(value, {language: 'json'});
  assert.deepEqual(JSON.parse(doc.source), value);
  assert.deepEqual(value, {name: 'Renée', nested: [true, null]});
  const empty = format.present(format.document(''));
  assert.equal(empty.source, '');
  assert.equal(empty.language, 'text');
  assert.deepEqual(empty.lines, ['']);
  assert.equal(empty.lineCount, 1);
  assert.equal(format.records('\n \n').length, 0);
});

test('trace raw records expose their event type and wall-clock timestamp without changing source', () => {
  const source = JSON.stringify({schema_version: 1, seq: 1, wall_time_unix_ms: 1795141214707, payload: {type: 'inference_started'}});
  const row = format.records(source)[0];
  assert.equal(row.type, 'codex_trace');
  assert.equal(row.category, 'codex_trace/inference_started');
  assert.equal(row.timestamp, '2026-11-20T02:20:14.707Z');
  assert.equal(row.source, source);
  assert.equal(format.records(JSON.stringify({wall_time_unix_ms: 1e20, payload: {type: 'unknown'}}))[0].timestamp, null);
});
