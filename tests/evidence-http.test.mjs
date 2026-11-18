import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import net from 'node:net';
import {createWorldServer} from '../apps/world-service/server.mjs';
import {makeEnvelope} from '../packages/world-protocol/index.mjs';
import {decodeSample} from '../packages/osg-physical/journal.mjs';
const base={runId:'causality-transport-test',epoch:0,simDt:.1,source:'native',
  entityId:'lander',frameId:'metaverse-global-ecliptic',position:[1_700_000,0,0],
  velocity:[0,0,0],orientation:[0,0,0,1]};
const envelope=(sequence,contact)=>makeEnvelope('PHYSICS_SAMPLE',{...base,step:sequence,sequence,simTime:sequence*.1,contact});
const waitFor=async pred=>{for(let i=0;i<100;i++){if(pred())return;await new Promise(r=>setTimeout(r,10));}throw Error('timeout');};

test('contact contains recoverable physical asset and three observers have distinct causal arrival times',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'osg-causal-'));let app=await createWorldServer({httpPort:0,bridgePort:0,dataDir:dir});
 let socket;
 try{
   socket=net.createConnection(app.bridgePort,'127.0.0.1');await new Promise(r=>socket.once('connect',r));
   socket.write([envelope(1,false),envelope(2,true)].map(JSON.stringify).join('\n')+'\n');
   await waitFor(()=>app.state.contacts.length===1);
   const contact=app.state.contacts[0];
   assert.deepEqual(decodeSample(await app.assets.get(contact.assetHash)).position,base.position);
   const url=`http://127.0.0.1:${app.httpPort}/api/observer-evidence`;
   const get=async(observer,time)=>await(await fetch(`${url}?observer=${observer}&time=${time}`)).json();
   const A=await get('A',.2),B=await get('B',.2),C=await get('C',.2);
   assert.equal(A.events[0].status,'RECEIVED');
   assert.equal(B.events[0].status,'NOT_YET_CAUSAL');
   assert.equal(C.events[0].status,'NOT_YET_CAUSAL');
   assert.equal((await get('C',1.6)).events[0].status,'RECEIVED');
   socket.destroy();await app.close();
   app=await createWorldServer({httpPort:0,bridgePort:0,dataDir:dir});
   const recovered=await (await fetch(`http://127.0.0.1:${app.httpPort}/api/observer-evidence?observer=C&time=1.6`)).json();
   assert.equal(recovered.status,'NO_NATIVE_ANCHOR');assert.deepEqual(recovered.events,[]);
   assert.equal((await app.journal.entries()).filter(e=>e.type==='CONTACT_BEGIN').length,1);
 }finally{socket?.destroy();await app.close();await rm(dir,{recursive:true,force:true});}
});
