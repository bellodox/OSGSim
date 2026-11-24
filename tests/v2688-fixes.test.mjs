// SPDX-License-Identifier: MIT
// v26.8.8: regression tests for the audit fixes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {WorldClock} from '../OSGSim/apps/metaverse-native/v26/world-time.mjs';
import {ensureRodPlayerName,playerNameForWorld} from '../OSGSim/apps/metaverse-native/v26/rod-game/player-identity.mjs';
import {RodGamePublisher} from '../OSGSim/apps/metaverse-native/v26/rod-game/publisher.mjs';
import {RodGameSync} from '../OSGSim/apps/metaverse-native/v26/rod-game/sync.mjs';
import {LiveLane} from '../OSGSim/apps/metaverse-native/v26/rod-game/live-lane.mjs';
import {generateSecret} from '../OSGSim/apps/metaverse-native/v26/single-address/crypto.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const W='a'.repeat(64),KEY='b'.repeat(64),ADDRESS='rFJtzkbeQ3dxWQg9G82LHMsPvrhSLMarJU',TX='d'.repeat(64);
const policy={schema:1,utcOriginMs:1700000000000,simMjd0:51982.13,rate:1,era:1};

test('finding 1: peer WorldClock stays ready past maxAgeMs when auto-calibration runs, and fails closed without it',async()=>{
 const query=async host=>({host,offsetMs:5,delayMs:4,uncertaintyMs:3,sampleUtcMs:Date.now()});
 const fresh=new WorldClock(policy,{maxAgeMs:3000});
 await fresh.calibrateFromPool(['a.example','b.example'],{query});
 fresh.startAutoCalibration(['a.example','b.example'],{intervalMs:1000,query});
 const stale=new WorldClock(policy,{maxAgeMs:3000});await stale.calibrateFromPool(['a.example','b.example'],{query});
 await sleep(3600);
 assert.equal(fresh.status().ready,true,'auto-calibrated clock is ready after maxAgeMs');
 assert.equal(stale.status().ready,false,'a clock that is never recalibrated expires');
 assert.throws(()=>stale.requireReady(),/world_clock_uncertain/);
 fresh.stopAutoCalibration();
 assert.throws(()=>fresh.startAutoCalibration(['a','b'],{intervalMs:5000,query}),/invalid_auto_calibration_interval/);
});

test('finding 1: auto-calibration reports failures, retries sooner, and does not overlap',async()=>{
 let inflight=0,peak=0,fail=true;const errors=[];
 const query=async host=>{inflight++;peak=Math.max(peak,inflight);try{await sleep(400);if(fail)throw Error('offline');return{host,offsetMs:0,delayMs:2,uncertaintyMs:2,sampleUtcMs:Date.now()};}finally{inflight--;}};
 const clock=new WorldClock(policy,{maxAgeMs:20000});
 clock.startAutoCalibration(['a.example','b.example'],{intervalMs:1000,retryMs:1000,query,onError:e=>errors.push(e.message)});
  await sleep(2000);assert.ok(errors.length>=1&&/ntp_quorum_unavailable/.test(errors[0]));
 fail=false;await sleep(2400);assert.equal(clock.status().ready,true);clock.stopAutoCalibration();
 assert.ok(peak<=2,'one round (two hosts) at a time, never overlapping rounds: '+peak);
});

test('finding 2: a refused name_register (locked or empty wallet) is retried, not frozen as ambiguous',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spex-refuse-'));
 try{
  const name=playerNameForWorld(W,KEY),value=JSON.stringify({schema:'spexgsp/player/1',worldId:W,nostrPubkey:KEY});
  let registers=0,chain=null,pending=[];const statuses=[];
  const rpc=async method=>{switch(method){
   case 'getnewaddress':return ADDRESS;case 'getaddressinfo':return{ismine:true};
   case 'name_show':if(!chain)throw Error('name not found');return chain;
   case 'name_pending':return pending;
   case 'name_register':registers++;
    if(registers===1)throw Object.assign(new Error('ROD name_register: Please enter the wallet passphrase'),{code:-13});
    chain={name,address:ADDRESS,value,height:5,txid:TX};return TX;
   default:throw Error('unexpected '+method);}};
  const journalFile=join(dir,'player.json');
  const result=await ensureRodPlayerName({rpc,worldId:W,nostrPubkey:KEY,journalFile,salted:false,allowRegistration:true,timeoutMs:20000,pollMs:10,onStatus:(k,v)=>statuses.push([k,v])});
  assert.equal(registers,2,'refusal then success');
  assert.ok(statuses.some(([k,v])=>k==='ROD_PLAYER_NAME_REGISTER_REFUSED'&&v.code===-13));
  assert.equal(result.name,name);
  assert.equal(JSON.parse(await readFile(journalFile,'utf8')).status,'CONFIRMED');
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('finding 2: an unknown outcome (timeout, no code) still stops automatic re-registration',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spex-ambig-'));
 try{
  let registers=0;
  const rpc=async method=>{switch(method){
   case 'getnewaddress':return ADDRESS;case 'getaddressinfo':return{ismine:true};
   case 'name_show':throw Error('name not found');case 'name_pending':return[];
   case 'name_register':registers++;throw Error('timeout');
   default:throw Error('unexpected '+method);}};
  await assert.rejects(ensureRodPlayerName({rpc,worldId:W,nostrPubkey:KEY,journalFile:join(dir,'p.json'),salted:false,allowRegistration:true,timeoutMs:5000,pollMs:10}),/OUTCOME_AMBIGUOUS/);
  assert.equal(registers,1,'never rebroadcast an unknown outcome');
 }finally{await rm(dir,{recursive:true,force:true});}
});

const publisher=async(over={})=>{
 const dir=await mkdtemp(join(tmpdir(),'spex-pub-'));
 const p=new RodGamePublisher({rpc:async()=>[],world:W,game:'osgsimtest',player:'p/alice',ownerAddress:ADDRESS,clockEra:1,source:{projection:null,status:()=>({ready:false})},
  filename:join(dir,'outbox.json'),resumeAfterMs:50,discardAfterMs:200,...over});
 return{p,dir};
};

test('finding 5: an ambiguous RPC pause resolves itself — adopted when the move is found',async()=>{
 const {p,dir}=await publisher();
 try{
  p.state.paused=true;p.state.pending={move:{digest:'e'.repeat(64),seq:1},createdAt:Date.now(),txid:null};
  let recovered=0;p.recover=async()=>{recovered++;p.state.pending=null;};
  await p.tryResume();assert.equal(p.state.paused,true,'first call only stamps pausedAt');assert.ok(Number.isSafeInteger(p.state.pausedAt));
  await p.tryResume();assert.equal(p.state.paused,true,'still inside the cooldown');
  await sleep(70);await p.tryResume();
  assert.equal(recovered,1);assert.equal(p.state.paused,false);assert.equal(p.state.pausedAt,null);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('finding 5: an intent absent from chain and mempool is discarded only after discardAfterMs',async()=>{
 const {p,dir}=await publisher();const statuses=[];p.onStatus=(k)=>statuses.push(k);
 try{
  p.state.paused=true;p.state.pending={move:{digest:'e'.repeat(64),seq:1},createdAt:Date.now(),txid:null};
  p.recover=async()=>{throw Error('ROD_PLAYER_PUBLISH_UNRESOLVED_INTENT_INSPECT_BEFORE_RETRY');};
  await p.tryResume();await sleep(70);await p.tryResume();
  assert.equal(p.state.paused,true,'unresolved but not yet past discardAfterMs: stay paused');assert.ok(p.state.pending);
  await sleep(220);await p.tryResume();
  assert.equal(p.state.paused,false);assert.equal(p.state.pending,null);
  assert.ok(statuses.includes('ROD_PLAYER_AMBIGUOUS_INTENT_DISCARDED_AFTER_VERIFICATION'));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('finding 6: a dead ZMQ subscriber is restarted with the game re-tracked',async()=>{
 const calls=[];let tracked=[];
 const rpc=async(method,args=[])=>{calls.push([method,...args]);
  if(method==='trackedgames'){if(args[0]==='add'){tracked.push(args[1]);return null;}return tracked;}
  throw Error('unexpected '+method);};
 const sync=new RodGameSync({rpc,world:W,game:'osgsimtest',port:{portId:'p'},clock:policy,assetRoot:W,graph:{putMany:async()=>{}}});
 sync.requireZmq=true;let starts=0;
 sync.startZmq=async()=>{starts++;if(starts===1)throw Error('ROD_NATIVE_ZMQ_NOT_READY');sync.zmqReady=true;};
 sync.reconcile=async()=>{};
 const statuses=[];sync.onStatus=(k)=>statuses.push(k);
 sync.scheduleZmqRestart();sync.scheduleZmqRestart(); // second call is a no-op while one is scheduled
 await sleep(3800);
 assert.equal(starts,2,'first restart failed, second succeeded');
 assert.ok(statuses.includes('ROD_ZMQ_RESTART_FAILED')&&statuses.includes('ROD_ZMQ_RESTARTED'));
 assert.ok(calls.some(c=>c[0]==='trackedgames'&&c[1]==='add'&&c[2]==='osgsimtest'),'game tracking restored after node restart');
 await sync.close();
 sync.requireZmq=true;sync.closed=true;sync.scheduleZmqRestart();assert.equal(sync.zmqRestartTimer,null,'no restart after close');
});

test('finding 9: live lane is unhealthy when acknowledgements stop, healthy again after one arrives',async()=>{
 let t=1700000000000;const now=()=>t;let settle=null;
 const relay={connectedCount:1,subscribe(){return{close(){}}},publish:()=>new Promise((ok,fail)=>{settle={ok,fail};})};
 const lane=new LiveLane({relay,secret:generateSecret(),world:W,clock:policy,now,minIntervalMs:10,okStaleMs:15000,resolve:()=>null});
 assert.equal(lane.healthy(),true,'connected, nothing sent yet');
 const sample={entityName:'Glider1',runId:'native-1',sequence:1,simMjd:51982.2};
 lane.publish({actor:'peer1',eventId:'f'.repeat(64),runId:'native-1',sample});await sleep(5);
 assert.equal(lane.healthy(),true,'inside the acknowledgement window');
 t+=16000;assert.equal(lane.healthy(),false,'relay connected but silent: ROD frames must not stay on the slow baseline');
 settle.ok();await sleep(10);
 assert.equal(lane.healthy(),true,'acknowledged again');
});

