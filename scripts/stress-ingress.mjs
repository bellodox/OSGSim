// SPDX-License-Identifier: MIT
// Synthetic transport load only; never evidence of simulator physics or production capacity.
import net from 'node:net';import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {createWorldServer} from '../apps/world-service/server.mjs';
const dir=await mkdtemp(join(tmpdir(),'osg-load-'));const observers=[];let app,producer;
const count=1000;
async function until(f){const end=Date.now()+10000;while(Date.now()<end){if(f())return;await new Promise(r=>setTimeout(r,10));}throw Error('load validation timeout');}
try{
 app=await createWorldServer({httpPort:0,bridgePort:0,dataDir:dir,bridgeToken:null});
 for(let i=0;i<3;i++){
  const observer={received:0,ws:new WebSocket(`ws://127.0.0.1:${app.httpPort}/ws`)};
  observer.ws.addEventListener('message',e=>{if(JSON.parse(e.data).type==='PHYSICS_SAMPLE')observer.received++;});
  await once(observer.ws,'open');observers.push(observer);
 }
 producer=net.connect(app.bridgePort,'127.0.0.1');await once(producer,'connect');
 const frame=n=>({version:1,type:'PHYSICS_SAMPLE',runId:'synthetic-load',epoch:0,step:n,sequence:n,simTime:n*.01,simDt:.01,
  source:'native',entityId:'vessel-A',frameId:'metaverse-global-ecliptic',position:[n,0,0],velocity:[100,0,0],orientation:[0,0,0,1],contact:false});
 const start=performance.now();
 producer.write(Array.from({length:count},(_,i)=>JSON.stringify(frame(i+1))).join('\n')+'\n');
 await until(()=>app.state.samplesAccepted===count&&observers.every(o=>o.received===count));
 const elapsedMs=performance.now()-start;
 const entries=await app.journal.entries();
 if(entries.length!==21)throw Error('missing initial or periodic durable checkpoint');
 producer.write('invalid\n'+JSON.stringify(frame(count+1))+'\n');
 await until(()=>app.state.errors.length>0);
 if(app.state.samplesAccepted!==count)throw Error('failed producer continued to inject');
 console.log(JSON.stringify({status:'PASS',scope:'synthetic loopback TCP and three real Node WebSocket clients',samples:count,
  received:observers.map(o=>o.received),durableCheckpoints:entries.length,elapsedMs,invalidTailRejected:true,
  warning:'Single local measurement; not a Windows, OSG/LanceDB, GPU or production benchmark'},null,2));
}finally{producer?.destroy();for(const o of observers)o.ws.close();await app?.close();await rm(dir,{recursive:true,force:true});}
