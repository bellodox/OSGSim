// SPDX-License-Identifier: MIT
// Synthetic input benchmark against the real separately built OSG/LanceDB checkout.
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {createWorldServer} from '../apps/world-service/server.mjs';
import {makeEnvelope} from '../packages/world-protocol/index.mjs';
const source=process.env.OSG_MULTI_SOURCE_DIR;
if(!source)throw Error('Set OSG_MULTI_SOURCE_DIR to the built experimental OSG checkout');
const batches=Number(process.argv[2]??200),samplesPerBatch=Number(process.argv[3]??13),vessels=Number(process.argv[4]??1);
if(!Number.isSafeInteger(batches)||batches<20||batches>2000)throw Error('Use 20..2000 batches');
if(!Number.isSafeInteger(samplesPerBatch)||samplesPerBatch<1||samplesPerBatch>128||!Number.isSafeInteger(vessels)||vessels<1||vessels>64)throw Error('Use 1..128 samples per batch and 1..64 vessels');
const directory=await mkdtemp(join(tmpdir(),'osgsim-world-bench-'));
const app=await createWorldServer({httpPort:0,bridgePort:0,dataDir:directory,osgMultiSourceDir:source,osgWorldMode:true,worldBatchMs:5000});
const latencies=[];let sequence=0;
const stats=a=>{const b=a.slice().sort((x,y)=>x-y);return {medianMs:b[Math.floor(b.length*.5)],p95Ms:b[Math.min(b.length-1,Math.floor(b.length*.95))],maxMs:b.at(-1)};};
try{
 const start=performance.now();
 for(let batch=0;batch<batches;batch++){
  const begin=performance.now();
  for(let i=0;i<samplesPerBatch;i++){
   sequence++;
   const step=Math.ceil(sequence/vessels);
   await app.handleSample(makeEnvelope('PHYSICS_SAMPLE',{runId:'synthetic-benchmark',epoch:0,step,sequence,simTime:step*.02,simDt:.02,entityId:'vessel-'+((sequence-1)%vessels),frameId:'metaverse-global-ecliptic',source:'native',position:[149e9+sequence*.01,0,0],velocity:[.5,0,0],orientation:[0,0,0,1],contact:false}));
  }
  await app.flushWorld();
  if(batch%20===0){const head=app.world.revision.head;await app.world.world.annotate('benchmark-agent',String(batch),{text:'Synthetic benchmark observation'},head);}
  latencies.push(performance.now()-begin);
 }
 const published=performance.now();await app.close();
 const reopenStart=performance.now();
 const cold=await createWorldServer({httpPort:0,bridgePort:0,dataDir:directory,osgMultiSourceDir:source,osgWorldMode:true});
 try{
  const state=await cold.world.snapshot();
  console.log(JSON.stringify({scope:'Synthetic inputs, real OSG/LanceDB and periodic client annotations; not Windows physics/GPU evidence',node:process.version,batches,samplesPerBatch,vessels,samples:sequence,wallMs:published-start,throughputSamplesPerSecond:sequence/(published-start)*1000,batchLatency:stats(latencies),first20:stats(latencies.slice(0,20)),last20:stats(latencies.slice(-20)),coldReopenAndQueryMs:performance.now()-reopenStart,lastReconstructedStep:state.frames[0]?.sample.step,rssBytes:process.memoryUsage().rss,worldRevision:cold.world.revision},null,2));
 }finally{await cold.close();}
}finally{await app.close().catch(()=>{});await rm(directory,{recursive:true,force:true});}
