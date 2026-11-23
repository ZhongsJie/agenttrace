const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {parseRollout} = require('../src/core/parser.js');
const {buildReplay, createPlayer, projectReplay, projectViews} = require('../src/core/replay.js');

const timestamps = [0, 2, 4, null];
const threads = ['thread-a', 'thread-b'];
const epoch = Date.parse('2026-11-20T00:00:00Z');
const coveredViews = ['modelItems', 'clientMessages', 'tools'];

function histories(thread) {
  const histories = [[]];
  for (const time of timestamps) {
    const call = {thread, kind: 'call', time};
    histories.push([call], [{thread, kind: 'result', time}]);
    for (const end of timestamps) histories.push([call, {thread, kind: 'result', time: end}]);
  }
  return histories;
}

function* interleave(left, right) {
  if (left.length === 0 || right.length === 0) {
    yield [...left, ...right];
    return;
  }
  for (const tail of interleave(left.slice(1), right)) yield [left[0], ...tail];
  for (const tail of interleave(left, right.slice(1))) yield [right[0], ...tail];
}

const output = thread => `${thread} result`;
function rollout(rows) {
  return [{timestamp: new Date(epoch).toISOString(), type: 'session_meta', payload: {id: 'fixture'}}, ...rows.map(row => ({
    ...(row.time === null ? {} : {timestamp: new Date(epoch + row.time).toISOString()}),
    type: 'response_item',
    payload: {
      thread_id: row.thread,
      turn_id: 'turn',
      call_id: 'shared-call',
      ...(row.kind === 'call' ? {type: 'function_call', name: 'lookup', arguments: '{}'}
        : {type: 'function_call_output', output: output(row.thread)}),
    },
  }))].map(row => JSON.stringify(row)).join('\n');
}

function oracle(rows) {
  const inverted = threads.some(thread => {
    const own = rows.filter(row => row.thread === thread);
    return own.length === 2 && own.every(row => row.time !== null) && own[0].time > own[1].time;
  });
  const recorded = rows.length > 0 && !inverted && rows.every(row => row.time !== null);
  const times = rows.map((row, index) => recorded ? row.time : index * 700);
  const duration = Math.max(0, ...times);
  const calls = threads.flatMap(thread => {
    const callAt = rows.findIndex(row => row.thread === thread && row.kind === 'call');
    const resultAt = rows.findIndex(row => row.thread === thread && row.kind === 'result');
    if (callAt < 0 && resultAt < 0) return [];
    return [{thread, start: times[callAt < 0 ? resultAt : callAt], result: times[resultAt]}];
  });
  const positions = [...new Set([-1, 0, duration, duration + 1, ...times.flatMap(at => [at - 0.5, at, at + 0.5])])];
  return {duration, positions, calls};
}

function verify() {
  let fixtures = 0;
  let projections = 0;
  for (const left of histories(threads[0])) for (const right of histories(threads[1])) {
    for (const rows of interleave(left, right)) {
      const model = buildReplay(parseRollout(rollout(rows), 'verification.jsonl'));
      const {duration, positions, calls} = oracle(rows);
      const fail = (surface, cursor, expected, actual) => {
        process.stderr.write(`Counterexample: ${JSON.stringify({rows, surface, cursor, expected, actual})}\n`);
        process.exit(1);
      };
      const compare = (entries, surface, cursor) => {
        const at = Math.min(duration, Math.max(0, cursor));
        const expected = calls.filter(call => call.start <= at).map(call => [
          call.thread, call.result !== undefined && call.result <= at,
          call.result !== undefined && call.result <= at ? output(call.thread) : null,
        ]);
        const actual = entries.filter(entry => entry.step.kind === 'tool').map(entry => [
          entry.step.threadId, entry.outputVisible, entry.outputVisible ? entry.step.output : null,
        ]).sort(([a], [b]) => a.localeCompare(b));
        if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(surface, cursor, expected, actual);
        projections++;
      };
      if (model.durationMs !== duration) fail('buildReplay duration', null, duration, model.durationMs);
      for (const cursor of positions) {
        compare(projectReplay(model, cursor), 'projectReplay', cursor);
        const views = projectViews(model, cursor);
        for (const view of coveredViews) compare(views[view], `projectViews.${view}`, cursor);
      }
      const snapshots = [];
      const player = createPlayer(model, snapshot => snapshots.push(snapshot), {
        now: () => 0,
        request: () => { throw new Error('Seeking must not schedule playback'); },
        cancel() {},
      });
      for (const cursor of [duration, 0, duration]) {
        const before = player.getState().positionMs;
        snapshots.length = 0;
        player.seek(cursor);
        const actual = player.getState().positionMs;
        if (actual !== cursor || (cursor !== before && snapshots.length === 0)) {
          fail('player.seek', cursor, {cursor, notifyOnChange: cursor !== before}, {cursor: actual, notified: snapshots.length > 0});
        }
        for (const snapshot of snapshots) {
          if (snapshot.state.positionMs !== cursor) fail('player snapshot cursor', cursor, cursor, snapshot.state.positionMs);
          compare(snapshot.visible, 'player snapshot', cursor);
          for (const view of coveredViews) compare(snapshot.views[view], `player snapshot.${view}`, cursor);
        }
      }
      player.destroy();
      fixtures++;
    }
  }
  assert.equal(fixtures, 2481);
  process.stdout.write(`PASS: ${fixtures} rollout histories; ${projections} projection checks.\n`);
}

function verifyMutations() {
  const variants = [
    ['expose results early', 'replay.js', 'outputVisible: completed && step.output != null', 'outputVisible: step.output != null'],
    ['ignore thread in call identity', 'parser.js', "JSON.stringify([payload.thread_id || meta.id || meta.session_id || '',", 'JSON.stringify(['],
    ['reuse results from the previous cursor', 'replay.js', 'return {state: getState(), visible, views: projectViews(model, state.positionMs), activeStepId: active?.stepId ?? null};',
      'return {state: getState(), visible: projectReplay(model, model.durationMs), views: projectViews(model, model.durationMs), activeStepId: active?.stepId ?? null};'],
  ];
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttrace-replay-verification-'));
  try {
    const root = path.resolve(__dirname, '..');
    for (const [index, [name, file, original, replacement]] of variants.entries()) {
      const variant = path.join(temp, String(index));
      const verification = path.join(variant, 'verification');
      const core = path.join(variant, 'src/core');
      fs.mkdirSync(verification, {recursive: true});
      fs.mkdirSync(core, {recursive: true});
      const check = path.join(verification, path.basename(__filename));
      fs.copyFileSync(__filename, check);
      for (const entry of ['parser.js', 'replay.js']) {
        const source = fs.readFileSync(path.join(root, 'src/core', entry), 'utf8');
        if (entry === file) assert.equal(source.split(original).length, 2, `Update mutation anchor for ${file}`);
        fs.writeFileSync(path.join(core, entry), entry === file ? source.replace(original, replacement) : source);
      }
      const result = spawnSync(process.execPath, [check], {encoding: 'utf8'});
      if (result.error) throw result.error;
      assert.equal(result.status, 1, `${name}: ${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /^Counterexample: /m, `${name}: ${result.stderr}`);
      process.stdout.write(`CAUGHT: ${name}\n${result.stderr}`);
    }
  } finally {
    fs.rmSync(temp, {recursive: true, force: true});
  }
}

if (process.argv.length === 2) verify();
else if (process.argv.length === 3 && process.argv[2] === '--mutation-check') verifyMutations();
else throw new Error('Usage: node verification/verify-tool-result-boundary.cjs [--mutation-check]');
