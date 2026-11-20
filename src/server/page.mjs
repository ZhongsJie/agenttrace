import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build as viteBuild} from 'vite';
import replay from '../core/replay.js';

const root = new URL('../../', import.meta.url);
const read = name => readFile(new URL(name, root), 'utf8');
const dataScript = (id, data) => `<script id="${id}" type="application/json">${replay.json(data)}</script>`;
const script = source => `<script>${source.replace(/<\/script/gi, '<\\/script')}</script>`;

async function compilePage() {
  const core = ['parser.js', 'replay.js', 'formatter.js', 'trace-parser.js'];
  const [template, css, sources, frontend] = await Promise.all([
    read('src/client/index.html'), read('src/client/style.css'), Promise.all(core.map(name => read(`src/core/${name}`))),
    viteBuild({root: fileURLToPath(root), configFile: fileURLToPath(new URL('vite.config.mjs', root)), logLevel: 'silent'}),
  ]);
  const assets = (Array.isArray(frontend) ? frontend : [frontend]).flatMap(result => result.output);
  const [chunk] = assets;
  if (assets.length !== 1 || chunk.type !== 'chunk' || chunk.imports.length || chunk.dynamicImports.length) {
    throw new Error('The offline page requires a single self-contained Vue bundle.');
  }
  return template.replace('<link rel="stylesheet" href="style.css">', () => `<style>${css}</style>`)
    .replace('<!-- application-scripts -->', () => [...sources, chunk.code].map(script).join('\n'));
}

let compiled;
export async function createPage({server, rollout} = {}) {
  compiled ??= compilePage().catch(error => { compiled = undefined; throw error; });
  const data = Object.entries({'server-config': server, 'embedded-rollout': rollout})
    .filter(([, value]) => value != null).map(([id, value]) => dataScript(id, value));
  return (await compiled).replace('<!-- bootstrap-data -->', () => data.join('\n'));
}
