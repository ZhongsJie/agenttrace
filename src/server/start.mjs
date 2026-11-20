import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPage} from './page.mjs';
import {createSessionLibrary} from './session-library.mjs';

export async function startServer({port = 8789, traceRoot, sessionRoot, settingsFile} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be an integer between 0 and 65535.');
  const initialSettings = {sessionRoot: sessionRoot || '', traceRoot: traceRoot ?? process.env.CODEX_ROLLOUT_TRACE_ROOT ?? '', additionalSessionRoots: []};
  const [library, html] = await Promise.all([
    createSessionLibrary({settingsFile, initialSettings}),
    createPage({server: {apiBase: '/api'}}),
  ]);
  const body = Buffer.from(html);
  const routes = new Set(['/', '/index.html']);
  const server = createServer(async (request, response) => {
    const json = (status, data) => { response.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}); response.end(JSON.stringify(data)); };
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/')) {
        const address = server.address();
        const allowedHosts = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`]);
        if (!allowedHosts.has(request.headers.host)) return json(403, {error: 'Request host is not allowed.'});
        if (!['GET', 'HEAD'].includes(request.method)) {
          if (request.headers.origin && ![`http://127.0.0.1:${address.port}`, `http://localhost:${address.port}`].includes(request.headers.origin)) return json(403, {error: 'Cross-site settings changes are not allowed.'});
        }
        if (request.method === 'GET' && url.pathname === '/api/settings') return json(200, library.settings());
        if (request.method === 'GET' && url.pathname === '/api/catalog') return json(200, library.catalog());
        if (request.method === 'GET' && url.pathname.startsWith('/api/sessions/')) return json(200, await library.loadSession(decodeURIComponent(url.pathname.slice('/api/sessions/'.length))));
        if (request.method === 'GET' && url.pathname === '/api/traces') return json(200, await library.loadTraces(url.searchParams.get('sessionId')));
        if (request.method === 'POST' && url.pathname === '/api/rescan') return json(200, await library.refresh());
        if (request.method === 'PUT' && url.pathname === '/api/settings') {
          if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) return json(415, {error: 'Settings requests must use JSON.'});
          let source = '';
          for await (const chunk of request) { source += chunk; if (Buffer.byteLength(source) > 65536) return json(413, {error: 'Settings request body is too large.'}); }
          let settings;
          try { settings = JSON.parse(source); } catch { return json(400, {error: 'Settings request body is not valid JSON.'}); }
          return json(200, await library.updateSettings(settings));
        }
        return json(404, {error: 'API endpoint not found.'});
      }
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405, {Allow: 'GET, HEAD'}); response.end(); return; }
      if (!routes.has(url.pathname)) { response.writeHead(404); response.end('Not found'); return; }
      response.writeHead(200, {'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch (error) { json(error.statusCode || 500, {error: error.message}); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return {server, library, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections?.(); })};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const index = args.indexOf('--port');
  try { const running = await startServer({port: index < 0 ? 8789 : Number(args[index + 1])}); console.log(`AgentTrace ${running.url}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
