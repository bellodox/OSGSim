import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorldServer} from '../apps/world-service/server.mjs';
import {makeEnvelope} from '../packages/world-protocol/index.mjs';

const TOKEN='example_TransportOnly_1234567890';
const hello=(token=TOKEN)=>makeEnvelope('HELLO',{runId:'native-test-1',epoch:0,step:0,sequence:0,source:'native',bridgeToken:token});
const sample=makeEnvelope('PHYSICS_SAMPLE',{runId:'native-test-1',epoch:0,step:1,sequence:1,
  simTime:.1,simDt:.1,entityId:'vessel-1',frameId:'metaverse-global-ecliptic',source:'native',
  position:[1,2,3],velocity:[0,0,0],orientation:[0,0,0,1],contact:false});
async function write(port,frames) {
  const c=net.createConnection(port,'127.0.0.1');
  await new Promise((resolve,reject)=>{c.once('connect',resolve);c.once('error',reject);});
  c.write(frames.map(JSON.stringify).join('\n')+'\n');
  await new Promise(r=>setTimeout(r,100));
  c.destroy();
}
async function waitFor(predicate,timeout=1500){const stop=Date.now()+timeout;while(Date.now()<stop){if(predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('timeout');}

test('bridge configured with token rejects unauthenticated and invalid producers before accepting any telemetry',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'osg-auth-'));
  const app=await createWorldServer({httpPort:0,bridgePort:0,dataDir:dir,bridgeToken:TOKEN});
  try {
    await write(app.bridgePort,[sample]);
    await waitFor(()=>app.state.errors.some(e=>e.includes('HELLO required')));
    assert.equal(app.state.samplesAccepted,0);
    await write(app.bridgePort,[hello('wrong_SymmetricKey_123456'),sample]);
    await waitFor(()=>app.state.errors.some(e=>e.includes('authentication rejected')));
    assert.equal(app.state.samplesAccepted,0);
    await write(app.bridgePort,[hello(),sample]);
    await waitFor(()=>app.state.samplesAccepted===1);
    assert.equal(app.state.lastSample.entityId,'vessel-1');
    const status=await(await fetch(`http://127.0.0.1:${app.httpPort}/api/status`)).json();
    assert.equal(status.bridgeAuthRequired,true);
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});

test('cross-site WebSocket Origin is rejected; same-site browser Origin is accepted',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'osg-origin-'));
  const app=await createWorldServer({httpPort:0,bridgePort:0,dataDir:dir});
  async function tryUpgrade(origin){
    const c=net.createConnection(app.httpPort,'127.0.0.1');
    await new Promise((resolve,reject)=>{c.once('connect',resolve);c.once('error',reject);});
    const key=Buffer.alloc(16,7).toString('base64');
    c.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${app.httpPort}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    const answer=await new Promise(resolve=>{
      let response='';const stop=setTimeout(()=>{c.destroy();resolve(response)},250);
      c.on('data',d=>{response+=d.toString();clearTimeout(stop);resolve(response);c.destroy();});
      c.on('close',()=>{clearTimeout(stop);resolve(response);});
    });
    return answer;
  }
  try {
    assert.equal(await tryUpgrade('https://malicious.invalid'),'');
    assert.match(await tryUpgrade(`http://127.0.0.1:${app.httpPort}`),/101 Switching Protocols/);
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
