// SPDX-License-Identifier: MIT
// Synthetic TCP -> committed OSG -> Node WebSocket benchmark; not Windows/GPU acceptance.
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {fork} from 'node:child_process';import {performance} from 'node:perf_hooks';
import {createWorldServer} from '../apps/world-service/server.mjs';
const source=process.env.OSG_MULTI_SOURCE_DIR;if(!source)throw Error('Set OSG_MULTI_SOURCE_DIR to the matching built multi checkout');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=60000){const end=performance.now()+ms;while(performance.now()<end){if(await fn())return;await delay(20);}throw Error('Benchmark timed out');}
async function run(peers,vessels,polling=false){
 const dir=await mkdtemp(join(tmpdir(),'osg-live-load-')),webs=[];let app,producer,poller,pollBusy=false,polls=0,pollError=null;
 try{
  const clients=Object.fromEntries(Array.from({length:peers},(_,i)=>['peer'+i,'load_'+String(i).padStart(20,'0')]));
  app=await createWorldServer({httpPort:0,bridgePort:0,dataDir:dir,osgWorldMode:true,osgMultiSourceDir:source,worldBatchMs:250,worldClients:clients});
  const base=`http://127.0.0.1:${app.httpPort}`,seen=Array.from({length:3},()=>new Set()),latencies=[];let reconnectSnapshots=0;
  const open=async(index)=>{const socket=new WebSocket(`ws://127.0.0.1:${app.httpPort}/ws`);webs.push(socket);socket.addEventListener('message',event=>{const value=JSON.parse(event.data);if(index===3&&value.type==='OSG_WORLD_SNAPSHOT'&&value.runId)reconnectSnapshots++;for(const {sample}of value.frames??[]){if(index<3)seen[index].add(sample.sequence);if(index===0&&sample.type==='PHYSICS_SAMPLE')latencies.push(Date.now()-sample.capturedAtUnixMs);}});await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});return socket;};
  await Promise.all([0,1,2].map(open));
  if(polling)poller=setInterval(()=>{if(pollBusy)return;pollBusy=true;Promise.all(Array.from({length:3},async()=>{for(const path of ['/api/status','/api/world/state','/api/observer-evidence?observer=A&time=5']){const response=await fetch(base+path);assert.equal(response.status,200);await response.json();polls++;}})).catch(error=>{pollError=error.message;}).finally(()=>{pollBusy=false;});},1000);
  let sent=0;
  producer=fork(new URL('./benchmark-live-producer.mjs',import.meta.url),[String(app.bridgePort),String(vessels),'5000'],{stdio:['ignore','ignore','pipe','ipc']});
  let stderr='';producer.stderr.on('data',chunk=>{stderr+=chunk;});
  const finished=new Promise((resolve,reject)=>{producer.on('error',reject);producer.on('message',message=>{if(message.finished){sent=message.finished;resolve();}});producer.on('exit',code=>{if(code||!sent)reject(Error(`Producer exited ${code}: ${stderr}`));});});
  await until(()=>app.world.world.streams().streams[0]?.samples>0);
  const writes=Promise.all(Object.entries(clients).map(async([actor,token])=>{let version=null;for(const [i,action]of ['start','note','finish'].entries()){
   const response=await fetch(base+'/api/world/activities',{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify({sessionId:'load-session',requestId:'request-'+i,activityId:'study',action,text:'Concurrent peer '+actor,runId:'load-run',epoch:0,expectedVersion:version})});
   const result=await response.json();assert.equal(response.status,200,JSON.stringify(result));version=result.version;
  }}));
  const reconnect=open(3).then(async socket=>{await delay(750);socket.close();await open(3);});
  await Promise.all([finished,writes,reconnect]);await until(()=>app.state.samplesAccepted===sent);await app.flushWorld();await until(()=>seen.every(set=>set.size===sent)&&reconnectSnapshots>=2);
  clearInterval(poller);await until(()=>!pollBusy);assert.equal(pollError,null);
  assert.equal((await app.world.snapshot()).frames.length,vessels);assert.deepEqual(app.state.errors,[]);
  latencies.sort((a,b)=>a-b);const percentile=p=>latencies[Math.floor((latencies.length-1)*p)];
  return{peers,activityOperations:peers*3,vessels,targetStepsPerSecond:50,sent,accepted:app.state.samplesAccepted,observerCounts:seen.map(set=>set.size),latencyP50Ms:percentile(.5),latencyP95Ms:percentile(.95),maxLatencyMs:latencies.at(-1),httpPolls:polls,reconnected:true,reconnectSnapshots,errors:app.state.errors};
 }finally{clearInterval(poller);producer?.kill();for(const socket of webs)socket.close();await app?.close();await rm(dir,{recursive:true,force:true});}
}
for(const condition of (process.env.OSG_BENCH_MULTI_ONLY==='1'?[[32,4,true]]:[[0,1],[32,1],[32,4,true]]))console.log(JSON.stringify(await run(...condition)));
