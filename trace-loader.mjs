import {readFile, realpath, stat, lstat, readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createInterface} from 'node:readline';
import path from 'node:path';
import trace from './trace-parser.js';

export async function scopedFilename(directory, relativePath) {
  const relative = trace.safePath(relativePath);
  if (!relative) throw new Error(`不支持的 trace 相对路径 ${String(relativePath)}`);
  const filename = await realpath(path.join(directory, ...relative.split('/')));
  const within = path.relative(directory, filename);
  if (within.startsWith('..' + path.sep) || within === '..' || path.isAbsolute(within)) throw new Error(`引用超出 trace 目录 ${relative}`);
  if (!(await stat(filename)).isFile()) throw new Error(`引用不是文件 ${relative}`);
  return filename;
}

async function readScoped(directory, relativePath) {
  return readFile(await scopedFilename(directory, relativePath), 'utf8');
}

export async function firstNonemptyLine(filename) {
  const input = createReadStream(filename, {encoding: 'utf8'});
  const lines = createInterface({input, crlfDelay: Infinity});
  try { for await (const line of lines) if (line.trim()) return line.replace(/^\uFEFF/, ''); }
  finally { lines.close(); input.destroy(); }
  return '';
}

async function hasManifest(directory) {
  try { await lstat(path.join(directory, 'manifest.json')); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

export async function discoverTraceRoot(configuredRoot) {
  if (typeof configuredRoot !== 'string' || !configuredRoot.trim()) throw new Error('CODEX_ROLLOUT_TRACE_ROOT 必须是 trace 目录路径。');
  const root = await realpath(path.resolve(configuredRoot));
  if (!(await stat(root)).isDirectory()) throw new Error('CODEX_ROLLOUT_TRACE_ROOT 指向的不是目录。');
  const candidates = [];
  if (await hasManifest(root)) candidates.push(root);
  else {
    for (const entry of (await readdir(root, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory() && await hasManifest(path.join(root, entry.name))) candidates.push(path.join(root, entry.name));
    }
  }
  const descriptors = [], warnings = [];
  for (const directory of candidates) {
    const name = path.basename(directory);
    try {
      const manifest = await readScoped(directory, 'manifest.json');
      const references = trace.paths(manifest);
      const first = await firstNonemptyLine(await scopedFilename(directory, references.eventLog));
      const bundle = {name, files: {'manifest.json': manifest, [references.eventLog]: first}};
      descriptors.push({directory, name, identity: trace.traceIdentity(bundle), bundle});
    } catch (error) { warnings.push(`${name}：${error.code || error.message}`); }
  }
  if (!candidates.length) warnings.push('目录中没有找到 manifest.json，请选择 trace bundle 或包含 trace bundle 的父目录。');
  return {descriptors, warnings};
}

export async function loadTraceBundle(descriptor) {
  const {directory, name} = descriptor;
  const files = Object.create(null);
  files['manifest.json'] = await readScoped(directory, 'manifest.json');
  const first = trace.paths(files['manifest.json']);
  files[first.eventLog] = await readScoped(directory, first.eventLog);
  const references = trace.paths(files['manifest.json'], files[first.eventLog]);
  const diagnostics = [...first.warnings, ...references.warnings];
  for (const relative of references.payloads) {
    try { files[relative] = await readScoped(directory, relative); }
    catch (error) { diagnostics.push(`无法读取 ${relative}：${error.code || error.message}`); }
  }
  return {name, files, warnings: [...new Set(diagnostics)]};
}

export async function loadTraceRoot(configuredRoot) {
  const {descriptors, warnings} = await discoverTraceRoot(configuredRoot);
  const bundles = [];
  for (const descriptor of descriptors) {
    try { bundles.push(await loadTraceBundle(descriptor)); }
    catch (error) { warnings.push(`${descriptor.name}：${error.code || error.message}`); }
  }
  return {bundles, warnings};
}
