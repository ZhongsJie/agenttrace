import {readFile, realpath, stat, readdir, mkdir, writeFile, rename, unlink} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import trace from './trace-parser.js';
import {discoverTraceRoot, loadTraceBundle, firstNonemptyLine} from './trace-loader.mjs';

function failure(message, statusCode = 400) { return Object.assign(new Error(message), {statusCode}); }
function normalizeSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure('Settings 必须是对象。');
  const directory = (input, name) => {
    if (typeof input !== 'string' || input.includes('\0') || input.length > 16384) throw failure(`${name} 必须是目录路径。`);
    return input.trim() ? path.resolve(input.trim()) : '';
  };
  if (!Array.isArray(value.additionalSessionRoots) || value.additionalSessionRoots.length > 100) throw failure('额外会话目录必须是数组，最多 100 个。');
  return {sessionRoot: directory(value.sessionRoot, '会话目录'), traceRoot: directory(value.traceRoot, 'Trace 目录'), additionalSessionRoots: [...new Set(value.additionalSessionRoots.map(item => directory(item, '额外目录')).filter(Boolean))]};
}
async function validateDirectories(settings) {
  for (const root of [settings.sessionRoot, settings.traceRoot, ...settings.additionalSessionRoots].filter(Boolean)) {
    try { if (!(await stat(root)).isDirectory()) throw failure(`不是目录：${root}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
function metadataFromLine(line) {
  const record = JSON.parse(line);
  if (record.type !== 'session_meta' || !record.payload || typeof record.payload !== 'object') throw new Error('首条记录不是 session_meta。');
  return record.payload;
}
async function indexedModel(filename, meta) {
  if (typeof meta.model === 'string' && meta.model) return meta.model;
  const input = createReadStream(filename, {encoding: 'utf8'});
  const lines = createInterface({input, crlfDelay: Infinity});
  try {
    for await (const line of lines) {
      let record;
      try { record = JSON.parse(line.replace(/^\uFEFF/, '')); } catch { continue; }
      if (record.type === 'turn_context' && typeof record.payload?.model === 'string' && record.payload.model) return record.payload.model;
    }
  } finally { lines.close(); input.destroy(); }
  return null;
}
async function scan(settings, revision) {
  const sessions = [], warnings = [], registry = new Map(), ids = new Map(), seen = new Set();
  for (const configuredRoot of [...new Set([settings.sessionRoot, ...settings.additionalSessionRoots].filter(Boolean))]) {
    try {
      const root = await realpath(configuredRoot);
      if (!(await stat(root)).isDirectory()) throw new Error('不是目录');
      async function walk(directory) {
        for (const entry of await readdir(directory, {withFileTypes: true})) {
          const filename = path.join(directory, entry.name);
          if (entry.isDirectory()) { await walk(filename); continue; }
          if (!entry.isFile() || !/^rollout-.*\.jsonl$/.test(entry.name)) continue;
          const canonical = await realpath(filename);
          const relative = path.relative(root, canonical);
          if (relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || seen.has(canonical)) continue;
          seen.add(canonical);
          try {
            const info = await stat(canonical);
            let meta = {}, identity = {sessionId: null};
            try { meta = metadataFromLine(await firstNonemptyLine(canonical)); identity = trace.rolloutIdentity(meta); warnings.push(...identity.diagnostics.map(message => `${entry.name}：${message}`)); }
            catch (error) { warnings.push(`${entry.name}：${error.message}`); }
            const key = createHash('sha256').update(canonical).digest('hex');
            const descriptor = {key, sessionId: identity.sessionId, name: entry.name, relativePath: relative.split(path.sep).join('/'), sourceRoot: root, size: info.size, modifiedAt: info.mtime.toISOString(), startedAt: meta.timestamp || null, model: meta.model || null, traceCount: 0, association: 'none'};
            descriptor.model = await indexedModel(canonical, meta);
            sessions.push(descriptor); registry.set(key, {filename: canonical, descriptor});
            if (descriptor.sessionId) { if (!ids.has(descriptor.sessionId)) ids.set(descriptor.sessionId, []); ids.get(descriptor.sessionId).push(descriptor); }
          } catch (error) { warnings.push(`${filename}：${error.code || error.message}`); }
        }
      }
      await walk(root);
    } catch (error) { warnings.push(`会话目录 ${configuredRoot}：${error.code || error.message}`); }
  }
  let traces = [], traceWarnings = [];
  if (settings.traceRoot) {
    try { const found = await discoverTraceRoot(settings.traceRoot); traces = found.descriptors; traceWarnings.push(...found.warnings); }
    catch (error) { traceWarnings.push(`Trace 目录 ${settings.traceRoot}：${error.code || error.message}`); }
  }
  warnings.push(...traceWarnings);
  const traceIds = new Map(), unmatchedTraces = [];
  for (const descriptor of traces) {
    const {identity} = descriptor;
    if (identity.status !== 'verified') {
      warnings.push(...identity.diagnostics.map(message => `${descriptor.name}：${message}`));
      unmatchedTraces.push({name: descriptor.name, sessionId: null, reason: identity.diagnostics.join('；')});
      continue;
    }
    if (!traceIds.has(identity.sessionId)) traceIds.set(identity.sessionId, []);
    traceIds.get(identity.sessionId).push(descriptor);
    const matches = ids.get(identity.sessionId) || [];
    if (matches.length !== 1) unmatchedTraces.push({name: descriptor.name, sessionId: identity.sessionId, reason: matches.length ? '会话 ID 重复，关联有歧义。' : '未找到对应会话。'});
  }
  for (const [id, entries] of ids) {
    if (entries.length > 1) { warnings.push(`会话 ID ${id} 对应多个文件，Trace 不会自动关联。`); entries.forEach(entry => entry.association = 'ambiguous'); }
    else { entries[0].traceCount = (traceIds.get(id) || []).length; entries[0].association = entries[0].traceCount ? 'matched' : 'none'; }
  }
  sessions.sort((a, b) => (b.startedAt || b.modifiedAt).localeCompare(a.startedAt || a.modifiedAt) || a.name.localeCompare(b.name));
  return {settings, catalog: {revision, sessions, warnings, unmatchedTraces, traceStatus: {configured: !!settings.traceRoot, directory: settings.traceRoot, bundles: traces.length, warnings: traceWarnings}}, registry, ids, traceIds};
}

export async function createSessionLibrary({settingsFile = path.join(process.cwd(), '.agenttrace/settings.json'), initialSettings = {}} = {}) {
  let settings;
  try { settings = normalizeSettings(JSON.parse(await readFile(settingsFile, 'utf8'))); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    settings = normalizeSettings({sessionRoot: '', traceRoot: process.env.CODEX_ROLLOUT_TRACE_ROOT || '', additionalSessionRoots: [], ...initialSettings});
  }
  let snapshot = await scan(settings, 1), pending = Promise.resolve();
  const enqueue = work => { const result = pending.then(work); pending = result.catch(() => {}); return result; };
  const clone = value => structuredClone(value);
  async function loadTracesFor(current, sessionId) {
    const warnings = [], traceBundles = [];
    if (typeof sessionId !== 'string' || !sessionId) return {traceBundles, warnings};
    if ((current.ids.get(sessionId) || []).length > 1) return {traceBundles, warnings: ['会话 ID 重复，Trace 不会自动关联。']};
    for (const descriptor of current.traceIds.get(sessionId) || []) {
      try {
        const bundle = await loadTraceBundle(descriptor), identity = trace.traceIdentity(bundle);
        if (identity.status !== 'verified' || identity.sessionId !== sessionId) { warnings.push(`${descriptor.name}：Trace 身份已变化，请重新扫描。`); continue; }
        traceBundles.push(bundle);
      } catch (error) { warnings.push(`${descriptor.name}：${error.code || error.message}`); }
    }
    return {traceBundles, warnings};
  }
  return {
    settings: () => clone(snapshot.settings), catalog: () => clone(snapshot.catalog),
    refresh: () => enqueue(async () => { snapshot = await scan(snapshot.settings, snapshot.catalog.revision + 1); return clone(snapshot.catalog); }),
    updateSettings: value => enqueue(async () => {
      const nextSettings = normalizeSettings(value); await validateDirectories(nextSettings);
      const next = {...snapshot, settings: nextSettings};
      await mkdir(path.dirname(settingsFile), {recursive: true});
      const temporary = `${settingsFile}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify(nextSettings, null, 2) + '\n', {mode: 0o600}); await rename(temporary, settingsFile); }
      finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      snapshot = next; return {settings: clone(nextSettings), catalog: clone(next.catalog)};
    }),
    loadTraces: sessionId => loadTracesFor(snapshot, sessionId),
    loadSession: async key => {
      const current = snapshot, entry = current.registry.get(key);
      if (!entry) throw failure('会话不存在，请重新扫描。', 404);
      const canonical = await realpath(entry.filename);
      if (canonical !== entry.filename) throw failure('会话文件路径已变化，请重新扫描。', 409);
      const text = await readFile(canonical, 'utf8');
      let identity;
      try { identity = trace.rolloutIdentity(metadataFromLine(text.split(/\r?\n/).find(line => line.trim()) || '')); }
      catch { identity = {sessionId: null}; }
      if (identity.sessionId !== entry.descriptor.sessionId) throw failure('会话身份已变化，请重新扫描。', 409);
      const attached = await loadTracesFor(current, identity.sessionId);
      return {name: entry.descriptor.name, text, sessionId: identity.sessionId, ...attached};
    },
  };
}
