// SPDX-License-Identifier: MIT
// The local OSG world view: ship registry, frames and proofs, committed with an immutable causal event per change.
import {sha,canonical} from './ownership.mjs';
import {worldMjd,validateTimePolicy} from './world-time.mjs';
const ACTOR=/^peer(?:0|[1-9]\d{0,4})$/, ADDR=/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{25,64}$/;
const ID=/^[A-Za-z0-9_.:-]{1,128}$/, DIGEST=/^[a-f0-9]{64}$/;
const clone=x=>structuredClone(x);
// A pad belongs to its assigned vessel until an explicit, independently verified
// clearance event. Flight mode must never release a physically occupied pad.
const occupied=x=>x&&['RESERVED','ACTIVE','DEPARTED','LANDED'].includes(x.phase);
const eventKey=seq=>`metaverse:event:${String(seq).padStart(12,'0')}`;
export const eventGenesis=worldId=>sha({worldId,protocol:'osgsim-world-events-v3',genesis:true});
export const hashWorldDelta=e=>sha({worldId:e.worldId,sequence:e.sequence,previous:e.previous,type:e.type,payload:e.payload});
export function verifyWorldDelta(e,worldId,previous,sequence){
 if(!e||e.worldId!==worldId||e.sequence!==sequence||e.previous!==previous||e.hash!==hashWorldDelta(e))throw Error('invalid_world_event_chain');
 return e.hash;
}
export function worldRoot(s){return sha({v:263,world:s.worldId,clock:s.clock,ports:s.port,ships:s.ships,sequence:s.sequence,eventHead:s.eventHead,events:s.events,authorityRevision:s.authorityRevision??1,frontier:Object.fromEntries(Object.entries(s.frames).sort(([a],[b])=>a.localeCompare(b)).map(([id,f])=>[id,sha(f)])),proofs:s.proofs});}
export function validateWorld(s){
 if(!s||s.schema!==26||!DIGEST.test(s.worldId)||!s.port?.portId||!Array.isArray(s.port.slots)||!Array.isArray(s.port.allowedClasses)||!s.ships||!s.frames||!s.proofs||!Number.isSafeInteger(s.sequence)||s.sequence<0||!DIGEST.test(s.eventHead)||!Array.isArray(s.events)||s.events.length>32||!Number.isSafeInteger(s.nextActorId))throw Error('invalid_osg_world_record');
 validateTimePolicy(s.clock);const slots=new Set();
 for(const [actor,x] of Object.entries(s.ships)){
  if(!ACTOR.test(actor)||!ADDR.test(x.owner)||!ID.test(x.nativeName)||!DIGEST.test(x.eventId)||!DIGEST.test(x.worldId)||x.worldId!==s.worldId||!s.port.slots.some(q=>q.slot===x.slot)||!s.port.allowedClasses.includes(x.vesselClass)||!['RESERVED','ACTIVE','DEPARTED','LANDED'].includes(x.phase))throw Error('corrupt_osg_ship_registry');
  if(occupied(x)){if(slots.has(x.slot))throw Error('corrupt_osg_ship_registry');slots.add(x.slot);}
 }
 return true;
}
export class V26World{
 constructor({graph,rpc,worldId,clock,port,now=()=>Date.now(),onCommit=null}={}){
  if(!graph||!rpc||!DIGEST.test(worldId))throw Error('invalid_world_dependencies');
  this.graph=graph;this.rpc=rpc;this.worldId=worldId;this.now=now;this.clock=validateTimePolicy(clock);this.port=port;this.onCommit=onCommit;this.serial=Promise.resolve();this.state=null;
 }
 queue(fn){const r=this.serial.then(fn);this.serial=r.catch(()=>{});return r;}
 async init(){return this.queue(async()=>{
  const current=this.graph.get('metaverse:state:v26world');
  if(current){validateWorld(current);if(current.worldId!==this.worldId||canonical(current.clock)!==canonical(this.clock)||current.port.configSha256!==this.port.configSha256)throw Error('world_genesis_mismatch');this.state=current;}
  else{this.state={schema:26,worldId:this.worldId,clock:this.clock,port:this.port,ships:{},frames:{},proofs:{},events:[],sequence:0,eventHead:eventGenesis(this.worldId),authorityRevision:1,nextActorId:0};await this.graph.put('metaverse:state:v26world',this.state);}
  return this.snapshotUnsafe();
 });}
 snapshotUnsafe(){return clone({...this.state,root:worldRoot(this.state),osgHead:this.graph.head});}
 snapshot(){return this.queue(()=>this.snapshotUnsafe());}
 history(after=0,limit=200){return this.queue(()=>{
  if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>500)throw Error('invalid_history_window');
  const entries=[];for(let n=after+1;n<=Math.min(this.state.sequence,after+limit);n++){
   const entry=this.graph.get(eventKey(n));if(!entry||entry.sequence!==n||entry.hash!==hashWorldDelta(entry))throw Error('osg_event_history_missing');entries.push(entry);
  }
  return {worldId:this.worldId,events:entries,sequence:this.state.sequence,eventHead:this.state.eventHead,root:worldRoot(this.state),osgHead:this.graph.head};
 });}
 async commit(next,type,payload={}){
  if(!Number.isSafeInteger(next.sequence)||next.sequence!==this.state.sequence+1)throw Error('nonmonotonic_osg_commit');
  const event={worldId:this.worldId,sequence:next.sequence,previous:this.state.eventHead,type,payload};event.hash=hashWorldDelta(event);
  next.eventHead=event.hash;next.events=[...this.state.events.slice(-15),{sequence:event.sequence,type,hash:event.hash}];
  validateWorld(next);if(next.worldId!==this.worldId)throw Error('foreign_world');
  // The real OSG Multi adapter makes this ONE atomic commit; test doubles may lack putMany.
  try{
   if(typeof this.graph.putMany!=='function')throw Error('ATOMIC_OSG_WORLD_BATCH_REQUIRED');
   await this.graph.putMany([{id:eventKey(event.sequence),value:event},{id:'metaverse:state:v26world',value:next}]);
  }catch(err){
   // Some backends can commit and lose their acknowledgement. Confirm both
   // immutable event and updated world before treating it as success.
   await this.graph.refresh?.().catch(()=>{});
   if(canonical(this.graph.get('metaverse:state:v26world'))!==canonical(next)||
      canonical(this.graph.get(eventKey(event.sequence)))!==canonical(event))throw err;
  }
  this.state=next;const snapshot=this.snapshotUnsafe();
  if(this.onCommit){try{await this.onCommit(snapshot,event);}catch(e){console.error('SPEXGSP_V26_MIRROR_WRITE_FAILED '+e.message);}}
  return snapshot;
 }
 async nativeProof({observer,actor,eventId,kind,nativeName,runId,created,simMjd,verifiedPort,runNonce=null}={}){return this.queue(async()=>{
  const owned=this.state.ships[observer],target=this.state.ships[actor];
  if(!owned||!target||target.eventId!==eventId||target.nativeName!==nativeName||!['owner','remote'].includes(kind)||!ID.test(runId)||typeof created!=='boolean'||!Number.isFinite(simMjd)||typeof verifiedPort!=='boolean'||(created&&!verifiedPort))throw Error('invalid_native_spawn_proof');
  if((observer===actor)!==(kind==='owner'))throw Error('wrong_native_vessel_role');
  if(target.phase==='RESERVED'&&target.reservedUntilUtcMs<=this.now())throw Error('native_reservation_expired');
  if(kind==='remote'&&target.phase==='RESERVED')throw Error('remote_spawn_before_owner_ready');
  const key=observer+':'+actor,proof={observer,actor,eventId,kind,nativeName,runId,created,simMjd,verifiedPort,runNonce};
  if(canonical(this.state.proofs[key])===canonical(proof))return clone(proof);
  const next=clone(this.state);next.sequence++;
  if(kind==='owner'&&target.phase==='RESERVED'&&!created){delete next.ships[actor];delete next.proofs[key];await this.commit(next,'VESSEL_RESERVATION_FAILED',{actor,eventId,slot:target.slot,runId});return clone(proof);}
  if(kind==='owner'&&created&&target.phase==='RESERVED'){next.ships[actor].phase='ACTIVE';delete next.ships[actor].reservedUntilUtcMs;}
  next.proofs[key]=proof;await this.commit(next,'NATIVE_SPAWN_ACK',{key,proof,ship:next.ships[actor]});return clone(proof);
 });}
 async sceneProof({observer,target,runId,sceneSha256,cameraSha256,nativeNames,cameraTarget,simMjd,runNonce=null}={}){return this.queue(async()=>{
  if(!this.state.ships[observer]||!this.state.ships[target]||!ID.test(runId)||!DIGEST.test(sceneSha256)||!DIGEST.test(cameraSha256)||!Array.isArray(nativeNames)||!nativeNames.includes(this.state.ships[observer].nativeName)||!nativeNames.includes(this.state.ships[target].nativeName)||cameraTarget!==this.state.ships[target].nativeName||!Number.isFinite(simMjd))throw Error('invalid_native_scene_proof');
  const a=this.state.proofs[`${observer}:${observer}`],b=this.state.proofs[`${observer}:${target}`];if(!a?.created||!b?.created||a.runId!==runId||b.runId!==runId)throw Error('missing_native_vessel_acks');
  const key=`scene:${observer}:${target}`,proof={observer,target,runId,sceneSha256,cameraSha256,nativeNames,cameraTarget,simMjd,runNonce};
  if(this.state.proofs[key]&&canonical(this.state.proofs[key])===canonical(proof))return clone(proof);
  const next=clone(this.state);next.proofs[key]=proof;next.sequence++;await this.commit(next,'NATIVE_SCENE_PROOF',{key,proof});return clone(proof);
 });}
 /** Every check an own native sample must pass, without committing it. Returns the frame, or an idempotent result. */
 validateSample({actor,runId,sample,nowUtcMs=this.now()}={}){
  const ship=this.state.ships[actor];if(!ship||!ID.test(runId))throw Error('unknown_or_invalid_owner');
  const proof=this.state.proofs[`${actor}:${actor}`];if(!proof?.created||proof.runId!==runId||!['ACTIVE','DEPARTED','LANDED'].includes(ship.phase))throw Error('native_owner_not_ready');
  if(!sample||sample.type!=='PHYSICS_SAMPLE'||sample.source!=='native'||sample.entityName!==ship.nativeName||sample.runId!==runId||!Number.isSafeInteger(sample.sequence)||sample.sequence<1||!Number.isFinite(sample.simMjd)||sample.frameId!=='metaverse-moon-relative-v26'||!['LANDED','FREEFLIGHT'].includes(sample.mode)||!Array.isArray(sample.surface)||sample.surface.length!==4||!sample.surface.every(Number.isFinite))throw Error('invalid_native_physics');
  for(const [key,n] of [['position',3],['velocity',3],['orientation',4]]){
   if(!Array.isArray(sample[key])||sample[key].length!==n||sample[key].some(value=>typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>1e18))throw Error('invalid_native_physics_vectors');
  }
  if(sample.mode==='LANDED'&&(Math.abs(sample.surface[0])>Math.PI||Math.abs(sample.surface[1])>Math.PI/2||Math.abs(sample.surface[2])>2*Math.PI||Math.abs(sample.surface[3])>100000))throw Error('invalid_landed_reference');
  const qmag=Math.hypot(...sample.orientation);if(Math.abs(qmag-1)>0.005)throw Error('invalid_native_orientation');
  const mjd=worldMjd(this.clock,nowUtcMs);if(Math.abs(sample.simMjd-mjd)*86400000>1200)throw Error('simulator_world_clock_out_of_bounds');
  if(Number.isFinite(sample.capturedAtUnixMs)&&Math.abs(sample.capturedAtUnixMs-nowUtcMs)>2500)throw Error('native_sample_timestamp_out_of_bounds');
  const prev=this.state.frames[actor];
  if(prev&&prev.sample.runId===runId&&sample.sequence<=prev.sample.sequence){
   // Native TCP/HTTP and relay retries may redeliver an accepted sample.
   // Return exactly the already-committed frame only if bytes are identical.
   if(sample.sequence===prev.sample.sequence&&canonical(prev.sample)===canonical(sample))
    return{idempotent:true,frame:prev};
   throw Error('stale_native_physics');
  }
  return{frame:{actor,asset:ship.asset,owner:ship.owner,eventId:ship.eventId,sample,receivedUtcMs:nowUtcMs}};
 }
 async publish({actor,runId,sample,nowUtcMs=this.now()}={}){return this.queue(async()=>{
  const checked=this.validateSample({actor,runId,sample,nowUtcMs});
  if(checked.idempotent)return{frame:clone(checked.frame),root:worldRoot(this.state),osgHead:this.graph.head,idempotent:true};
  const frame=checked.frame,next=clone(this.state);next.frames[actor]=frame;
  if(sample.mode==='FREEFLIGHT'&&['ACTIVE','LANDED'].includes(next.ships[actor].phase))next.ships[actor].phase='DEPARTED';
  if(sample.mode==='LANDED'&&next.ships[actor].phase==='DEPARTED')next.ships[actor].phase='LANDED';
  next.sequence++;await this.commit(next,'PHYSICS_FRAME',{actor,frame,shipPhase:next.ships[actor].phase});
  return{frame,root:worldRoot(this.state),osgHead:this.graph.head};
 });}
}
