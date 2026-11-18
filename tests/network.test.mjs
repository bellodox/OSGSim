import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorldServer} from '../apps/world-service/server.mjs';
import {makeEnvelope} from '../packages/world-protocol/index.mjs';

const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(predicate, timeout=3000) {
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await predicate())return;await delay(20);}
  throw Error('condition not reached');
}
function sample(seq,entityId='vessel-A',contact=false) {
  return makeEnvelope('PHYSICS_SAMPLE', {
    runId:'transport-synthetic-fixture',epoch:0,step:seq,sequence:seq,simTime:seq*.25,simDt:.25,
    entityId,frameId:'metaverse-global-ecliptic',source:'native',position:[1000,seq*2,0],velocity:[0,2,0],
    orientation:[0,0,0,1],contact
  });
}
async function connectWs(port) {
  const received=[];
  const ws=new WebSocket(`ws://127.0.0.1:${port}/ws`);
  ws.addEventListener('message',e=>{received.push(JSON.parse(e.data));});
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  return {ws,received};
}
async function nativeSocket(port) {
  const client=net.createConnection(port,'127.0.0.1');
  await new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject);});
  return client;
}

test('real local network: 3 WebSocket observers receive native transport samples and contact; late joiner resyncs all entities',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'osg-ws-'));
  const app=await createWorldServer({httpPort:0,bridgePort:0,dataDir:dir});
  const browsers=[],sockets=[];
  try {
    for(let i=0;i<3;i++)browsers.push(await connectWs(app.httpPort));
    const ingress=await nativeSocket(app.bridgePort);sockets.push(ingress);
    ingress.write([sample(1,'vessel-A',false),sample(2,'vessel-B',false),sample(3,'vessel-A',true)].map(JSON.stringify).join('\n')+'\n');
    await waitFor(()=>app.state.samplesAccepted===3);
    await waitFor(()=>browsers.every(b=>b.received.some(x=>x.type==='CONTACT_BEGIN')));
    for(const browser of browsers){
      assert.equal(browser.received.filter(x=>x.type==='PHYSICS_SAMPLE').length,3);
      assert.equal(browser.received.filter(x=>x.type==='CONTACT_BEGIN').length,1);
    }
    const late=await connectWs(app.httpPort);browsers.push(late);
    await waitFor(()=>late.received.filter(x=>x.type==='WORLD_INIT').length>=2);
    assert.deepEqual(new Set(late.received.filter(x=>x.type==='WORLD_INIT').map(x=>x.entityId)),new Set(['vessel-A','vessel-B']));
    const st=await(await fetch(`http://127.0.0.1:${app.httpPort}/api/status`)).json();
    assert.equal(st.nativeConnected,true);
    const ents=await(await fetch(`http://127.0.0.1:${app.httpPort}/api/entities`)).json();
    assert.equal(ents.entities.length,2);
  }finally{
    for(const b of browsers)b.ws.close();for(const s of sockets)s.destroy();
    await app.close();await rm(dir,{recursive:true,force:true});
  }
});

test('journal events survive restart without being misrepresented as current live telemetry',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'osg-resync-'));
  let app=await createWorldServer({httpPort:0,bridgePort:0,dataDir:dir});
  let ingress;
  try{
    ingress=await nativeSocket(app.bridgePort);
    ingress.write([sample(1,'vessel-A',false),sample(2,'vessel-A',true)].map(JSON.stringify).join('\n')+'\n');
    await waitFor(()=>app.state.contacts.length===1);
    ingress.destroy();await app.close();
    app=await createWorldServer({httpPort:0,bridgePort:0,dataDir:dir});
    const b=await connectWs(app.httpPort);
    try{
      await delay(100);
      assert.equal(b.received.some(x=>x.type==='CONTACT_BEGIN'),false);
      assert.equal(b.received.some(x=>x.type==='WORLD_INIT'),false);
      assert.equal((await app.journal.entries()).filter(x=>x.type==='CONTACT_BEGIN').length,1);
      assert.equal(app.state.contacts.length,1);
    }finally{b.ws.close();}
  }finally{
    ingress?.destroy();await app.close();await rm(dir,{recursive:true,force:true});
  }
});

test('new run isolates live vessel cache and event replay from previous run while preserving journal history',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'osg-run-split-'));
 const app=await createWorldServer({httpPort:0,bridgePort:0,dataDir:dir});
 let ingress;
 try{
   ingress=await nativeSocket(app.bridgePort);
   ingress.write([sample(1,'old-vessel',false),sample(2,'old-vessel',true)].map(JSON.stringify).join('\n')+'\n');
   await waitFor(()=>app.state.contacts.length===1);
   const next={...sample(1,'new-vessel',false),runId:'new-run-id'};
   ingress.write(JSON.stringify(next)+'\n');
   await waitFor(()=>app.state.activeRunKey==='new-run-id/0');
   assert.equal(app.state.lastByEntity.size,1);
   const browser=await connectWs(app.httpPort);
   try{
     await waitFor(()=>browser.received.some(x=>x.type==='WORLD_INIT'));
     assert.deepEqual(browser.received.filter(x=>x.type==='WORLD_INIT').map(x=>x.entityId),['new-vessel']);
     assert.equal(browser.received.some(x=>x.type==='CONTACT_BEGIN'),false);
     const journal=await app.journal.entries();assert.equal(journal.filter(x=>x.type==='CONTACT_BEGIN').length,1);
   }finally{browser.ws.close();}
 }finally{ingress?.destroy();await app.close();await rm(dir,{recursive:true,force:true});}
});
