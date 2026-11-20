const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
test('local API settings persist, recursively scan and reject cross-origin mutations', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'agenttrace-api-'));
  const {startServer} = await import('../start.mjs');
  let running;
  try {
    const root = path.join(directory,'sessions');
    await fs.mkdir(path.join(root,'2026/11/20'),{recursive:true});
    await fs.writeFile(path.join(root,'2026/11/20/rollout-example.jsonl'),JSON.stringify({type:'session_meta',payload:{id:'session',timestamp:'2026-11-20T00:00:00Z'}}));
    const options = {port:0,settingsFile:path.join(directory,'settings.json')};
    try { running = await startServer(options); } catch(error) {if(['EPERM','EACCES'].includes(error.code)){t.skip('沙箱禁止监听');return;}throw error;}
    const settings = {sessionRoot:root,traceRoot:'',additionalSessionRoots:[]};
    const put = origin => fetch(running.url+'/api/settings',{method:'PUT',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(settings)});
    assert.equal((await put('https://foreign.example')).status,403);
    const saved = await put(running.url); assert.equal(saved.status,200);
    assert.equal((await saved.json()).catalog.sessions.length,0);
    const catalog = await (await fetch(running.url+'/api/rescan',{method:'POST'})).json();assert.equal(catalog.sessions.length,1);
    const loaded = await fetch(running.url+'/api/sessions/'+catalog.sessions[0].key);assert.equal((await loaded.json()).sessionId,'session');
    assert.equal((await fetch(running.url+'/api/sessions/arbitrary-path')).status,404);
    assert.equal((await fetch(running.url+'/api/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:'broken'})).status,400);
    await running.close();running=await startServer(options);
    assert.equal((await (await fetch(running.url+'/api/settings')).json()).sessionRoot,root);
    assert.equal((await (await fetch(running.url+'/api/catalog')).json()).sessions.length,1);
  } finally {if(running)await running.close();await fs.rm(directory,{recursive:true,force:true});}
});
