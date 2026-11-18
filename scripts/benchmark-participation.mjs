// SPDX-License-Identifier: MIT
// Synthetic Node peers and native-shaped inputs against real external OSG; not Windows/GPU acceptance.
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createWorldServer} from '../apps/world-service/server.mjs';
import {makeEnvelope} from '../packages/world-protocol/index.mjs';
if(!process.env.OSG_MULTI_SOURCE_DIR)throw Error('Set OSG_MULTI_SOURCE_DIR');
const directory=await mkdtemp(join(tmpdir(),'osg-peers-'));
const count=32,worldClients=Object.fromEntries(Array.from({length:count},(_,i)=>['peer'+i,`benchmark_token_${String(i).padStart(16,'0')}`]));
let app;
try{
 app=await createWorldServer({httpPort:0,bridgePort:0,dataDir:directory,osgWorldMode:true,osgMultiSourceDir:process.env.OSG_MULTI_SOURCE_DIR,worldBatchMs:5000,worldClients});
 const sample=sequence=>makeEnvelope('PHYSICS_SAMPLE',{runId:'peer-benchmark',epoch:0,step:sequence,sequence,simTime:sequence*.02,simDt:.02,frameId:'global',entityId:'vessel',source:'native',position:[100,0,0],velocity:[0,0,0],contact:false});
 await app.handleSample(sample(1));await app.flushWorld();
 const url=`http://127.0.0.1:${app.httpPort}/api/world/activities`,latencies=[],versions=new Map();
 const begin=performance.now();
 for(const [round,action]of ['start','note','finish'].entries()){
  const requests=Object.entries(worldClients).map(async([actor,token])=>{
   const start=performance.now();const response=await fetch(url,{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify({sessionId:'benchmark',requestId:`round-${round}`,runId:'peer-benchmark',epoch:0,activityId:'study',action,text:'Synthetic shared observation',expectedVersion:versions.get(actor)??null})});
   const result=await response.json();if(!response.ok)throw Error(JSON.stringify(result));versions.set(actor,result.version);latencies.push(performance.now()-start);
  });
  await app.handleSample(sample(round+2));await app.flushWorld();await Promise.all(requests);
 }
 const durationMs=performance.now()-begin;
 const entries=await app.world.activities.list();
 if(entries.items.filter(i=>i.actor!=='osg-host'&&i.state==='finished').length!==count)throw Error('Missing peer outcomes');
 if(app.world.world.streams().streams[0].samples!==4)throw Error('Lost physical samples');
 latencies.sort((a,b)=>a-b);
 console.log(JSON.stringify({kind:'synthetic peers, real OSG/LanceDB',peers:count,operations:latencies.length,durationMs,
  operationsPerSecond:latencies.length/(durationMs/1000),latencyP50Ms:latencies[Math.floor(latencies.length*.5)],latencyP95Ms:latencies[Math.floor(latencies.length*.95)],
  finishedPeerActivities:count,committedSamples:4,qualification:'One bounded local workload, not capacity or Windows/GPU acceptance'},null,2));
}finally{await app?.close();await rm(directory,{recursive:true,force:true});}
