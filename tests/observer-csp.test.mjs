import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorldServer} from '../apps/world-service/server.mjs';

// Only generated blob workers are needed; do not widen scripts or other resource policies.
test('observer CSP permits blob sorting workers without weakening other directives',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'osg-worker-csp-'));
  let app;
  try{
    app=await createWorldServer({httpPort:0,bridgePort:0,dataDir:directory});
    for(const path of ['/', '/apps/observer/app.mjs', '/apps/observer/playcanvas-bridge.mjs']){
      const response=await fetch(`http://127.0.0.1:${app.httpPort}${path}`);
      assert.equal(response.status,200);
      const policy=response.headers.get('content-security-policy');
      const directives=policy.split(';').map(value=>value.trim()).filter(Boolean).map(value=>value.split(/\s+/));
      assert.equal(new Set(directives.map(([name])=>name)).size,directives.length);
      assert.deepEqual(Object.fromEntries(directives.map(([name,...sources])=>[name,sources])),{
        'default-src':["'self'",'https://cdn.jsdelivr.net'],
        'script-src':["'self'",'https://cdn.jsdelivr.net'],
        'worker-src':['blob:'],
        'style-src':["'self'","'unsafe-inline'"],
        'connect-src':["'self'",'ws://127.0.0.1:*','https://cdn.jsdelivr.net'],
        'img-src':["'self'",'data:']
      });
      assert.ok(!policy.includes("'unsafe-eval'"));
      await response.arrayBuffer();
    }
  }finally{
    await app?.close();
    await rm(directory,{recursive:true,force:true});
  }
});
