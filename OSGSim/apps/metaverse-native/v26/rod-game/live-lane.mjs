// SPDX-License-Identifier: MIT
// Nostr live motion lane. ROD stays the authority for identity, slots and
// checkpoints; this lane carries only high-rate motion samples between peers
// that already share a confirmed ROD roster.
//
// Trust model
//  - An event is accepted only if its pubkey equals the `nostr` key that a
//    CONFIRMED ROD join/rejoin of that actor declared (wallet-authorised).
//  - The sample must belong to that actor's current owner-proof run, pass the
//    same plausibility rules as ROD frames, and extend a per-run hash chain.
//  - Two different digests for one (actor, run, seq), or a fork of the chain,
//    prove the key holder equivocated; that actor's live lane is then ignored
//    until its next run. A confirmed ROD `checkpoint` that disagrees with the
//    digest seen on the lane has the same effect.
//  - Live frames never enter the OSG state or root. They are an overlay that
//    the DLL prefers over the committed frame when it is newer.
import {signEvent,verifyEvent,sha256,publicKey} from '../single-address/crypto.mjs';
import {canonical} from '../ownership.mjs';
import {assertFrame,frameImplausible,PLAUSIBILITY_V1} from './protocol.mjs';
export const LIVE_KIND=21328; // ephemeral range 20000-29999: relays forward, do not store
const ZERO='0'.repeat(64),ACTOR=/^peer(?:0|[1-9]\d{0,4})$/;
export const liveDigest=content=>sha256(canonical(content));
const tag=(event,name)=>event.tags.find(t=>t[0]===name)?.[1];

export class LiveLane{
 constructor({relay,secret,world,clock,resolve=()=>null,now=Date.now,minIntervalMs=250,maxPerSecond=8,windowMs=30000,
  staleMs=60000,okStaleMs=15000,maxInflight=3,limits=PLAUSIBILITY_V1,onStatus=()=>{}}={}){
  if(!relay?.publish||!relay?.subscribe||!secret||!/^[a-f0-9]{64}$/.test(world??''))throw Error('LIVE_LANE_CONFIG_INVALID');
  Object.assign(this,{relay,secret,world,clock,resolve,now,minIntervalMs,maxPerSecond,windowMs,staleMs,okStaleMs,maxInflight,limits,onStatus});
  this.pubkey=publicKey(secret);
  this.out={actor:null,runId:null,seq:0,digest:ZERO,simMjd:null,ring:new Map()};
  this.lastSentAt=0;this.lastOkAt=0;this.unackedSince=0;this.failures=0;this.inflight=0;this.subscription=null;
  this.peers=new Map();this.checked=new Set();
  this.counters={published:0,publishFailed:0,accepted:0,rejected:{}};
 }
 start({sinceSec=60}={}){
  if(this.subscription)return;
  this.subscription=this.relay.subscribe([{kinds:[LIVE_KIND],'#w':[this.world],since:Math.floor(this.now()/1000)-sinceSec}],event=>{
   const result=this.receive(event);
   if(result.rejected&&result.rejected!=='own_event')this.onStatus('LIVE_LANE_FRAME_REJECTED',{reason:result.rejected,actor:tag(event,'a')});
  },{prefilter:event=>event?.kind===LIVE_KIND&&event.pubkey!==this.pubkey&&this.resolve(event.pubkey)!==null&&Math.abs(event.created_at*1000-this.now())<=this.windowMs});
 }
 stop(){this.subscription?.close?.();this.subscription=null;}
 /** True when a live path to relays exists, so ROD frames may be sent rarely. */
 healthy(){
  // A single acknowledged publish is not enough: after the first frame the lane must keep getting acknowledgements,
  // otherwise ROD frames return to the normal cadence instead of the slow baseline.
  const stale=this.unackedSince>0&&this.now()-this.unackedSince>this.okStaleMs;
  return (this.relay.connectedCount??0)>0&&this.failures<3&&!stale;
 }
 /** Latest committed-to-lane position, used for a ROD checkpoint move. */
 checkpointCandidate(){
  const o=this.out;
  return o.seq>0&&o.actor?{actor:o.actor,runId:o.runId,seq:o.seq,digest:o.digest,simMjd:o.simMjd}:null;
 }
 // ---- sender -----------------------------------------------------------
 /** Non-blocking: signs, hands the event to the relay pool, returns the lane position. */
 publish({actor,eventId,runId,sample}){
  const t=this.now();
  if(t-this.lastSentAt<this.minIntervalMs||this.inflight>=this.maxInflight)return null;
  const o=this.out;
  if(o.runId!==runId||o.actor!==actor){Object.assign(o,{actor,runId,seq:0,digest:ZERO,ring:new Map()});}
  const content={v:1,w:this.world,a:actor,e:eventId,r:runId,n:o.seq+1,p:o.digest,s:sample};
  const digest=liveDigest(content);
  const event=signEvent({secret:this.secret,kind:LIVE_KIND,tags:[['w',this.world],['a',actor]],content:JSON.stringify(content),createdAt:Math.floor(t/1000)});
  o.seq=content.n;o.digest=digest;o.simMjd=sample.simMjd;o.ring.set(o.seq,digest);
  if(o.ring.size>256)o.ring.delete(o.ring.keys().next().value);
  this.lastSentAt=t;if(!this.unackedSince)this.unackedSince=t;this.inflight++;
  Promise.resolve().then(()=>this.relay.publish(event)).then(()=>{this.lastOkAt=this.now();this.unackedSince=0;this.failures=0;this.counters.published++;},
   e=>{this.failures++;this.counters.publishFailed++;this.onStatus('LIVE_LANE_PUBLISH_FAILED',{reason:String(e?.message??e).slice(0,160),failures:this.failures});})
   .finally(()=>{this.inflight--;});
  return{seq:o.seq,digest};
 }
 // ---- receiver ---------------------------------------------------------
 reject(reason){this.counters.rejected[reason]=(this.counters.rejected[reason]??0)+1;return{rejected:reason};}
 receive(event){
  if(!event||event.kind!==LIVE_KIND||!Array.isArray(event.tags)||tag(event,'w')!==this.world)return this.reject('not_live_frame');
  if(event.pubkey===this.pubkey)return{rejected:'own_event'};
  const actor=tag(event,'a');if(!ACTOR.test(actor??''))return this.reject('actor_tag_invalid');
  const t=this.now();
  if(Math.abs(event.created_at*1000-t)>this.windowMs)return this.reject('outside_time_window');
  const binding=this.resolve(event.pubkey);
  if(!binding||binding.actor!==actor)return this.reject('pubkey_not_bound_to_actor');
  if(!binding.runId)return this.reject('no_owner_proof_run');
  // Rate limit before the signature check (2-3 ms) so a flood cannot burn CPU.
  let st=this.peers.get(actor);
  if(st&&st.runId!==binding.runId){this.peers.delete(actor);st=null;}
  if(!st){st={runId:binding.runId,seq:0,digest:ZERO,frame:null,receivedAt:0,ring:new Map(),fraud:null,bucketAt:t,bucket:this.maxPerSecond};this.peers.set(actor,st);}
  st.bucket=Math.min(this.maxPerSecond,st.bucket+(t-st.bucketAt)/1000*this.maxPerSecond);st.bucketAt=t;
  if(st.bucket<1)return this.reject('rate_limited');st.bucket-=1;
  if(st.fraud)return this.reject('actor_equivocated');
  if(typeof event.content!=='string'||event.content.length>4096)return this.reject('content_too_large');
  if(!verifyEvent(event))return this.reject('signature_invalid');
  let c;try{c=JSON.parse(event.content);}catch{return this.reject('content_not_json');}
  const s=c?.s;
  if(c?.v!==1||c.w!==this.world||c.a!==actor||c.e!==binding.eventId||c.r!==binding.runId||!Number.isSafeInteger(c.n)||c.n<1||!/^[a-f0-9]{64}$/.test(c.p??'')||s?.entityName!==binding.nativeName||s?.runId!==binding.runId)return this.reject('content_not_owned');
  const frame={actor,owner:binding.owner,eventId:binding.eventId,sample:s};
  try{assertFrame(frame);}catch{return this.reject('sample_invalid');}
  const digest=liveDigest(c);
  const known=st.ring.get(c.n);
  if(known!==undefined){
   if(known!==digest){st.fraud={reason:'same_sequence_two_digests',seq:c.n};this.onStatus('LIVE_LANE_EQUIVOCATION',{actor,seq:c.n,reason:st.fraud.reason});return this.reject('equivocation');}
   return this.reject('duplicate');
  }
  if(c.n<st.seq)return this.reject('out_of_order');
  if(c.n===st.seq+1&&st.seq>0&&c.p!==st.digest){st.fraud={reason:'chain_fork',seq:c.n};this.onStatus('LIVE_LANE_EQUIVOCATION',{actor,seq:c.n,reason:st.fraud.reason});return this.reject('equivocation');}
  const previous=st.frame??binding.committed??null;
  if(previous?.sample?.runId===s.runId&&s.sequence<=previous.sample.sequence)return this.reject('stale_sample');
  const why=frameImplausible(frame,previous,{blockTimeSec:event.created_at,clock:this.clock,limits:this.limits});
  if(why)return this.reject('implausible_'+why);
  st.seq=c.n;st.digest=digest;st.frame=frame;st.receivedAt=t;st.ring.set(c.n,digest);
  if(st.ring.size>256)st.ring.delete(st.ring.keys().next().value);
  this.counters.accepted++;
  return{accepted:true,actor,seq:c.n};
 }
 /** Validate confirmed ROD checkpoints against what the lane showed, and forget departed actors. */
 observeProjection(projection){
  const active=new Set((projection?.order??[]).map(p=>projection.actors[p]?.ship?.actor));
  for(const actor of this.peers.keys())if(!active.has(actor))this.peers.delete(actor);
  for(const player of projection?.confirmed?.order??[]){
   const cp=projection.confirmed.actors[player]?.checkpoint,actor=projection.confirmed.actors[player]?.ship?.actor;
   if(!cp?.txid||this.checked.has(cp.txid))continue;this.checked.add(cp.txid);
   if(this.checked.size>1024)this.checked.delete(this.checked.values().next().value);
   const st=this.peers.get(actor),seen=st?.runId===cp.runId?st.ring.get(cp.seq):undefined;
   if(seen!==undefined&&seen!==cp.digest){st.fraud={reason:'checkpoint_digest_mismatch',seq:cp.seq};
    this.onStatus('LIVE_LANE_EQUIVOCATION',{actor,seq:cp.seq,reason:st.fraud.reason});}
  }
 }
 /** Current overlay for the DLL: actor -> {frame,seq,receivedAt}. */
 frames(){
  const t=this.now(),result={};
  for(const [actor,st] of this.peers)if(st.frame&&!st.fraud&&t-st.receivedAt<=this.staleMs)result[actor]={frame:st.frame,seq:st.seq,receivedAt:st.receivedAt};
  return result;
 }
 status(){return{pubkey:this.pubkey,healthy:this.healthy(),out:{seq:this.out.seq,runId:this.out.runId},peers:this.peers.size,lastOkAt:this.lastOkAt,counters:this.counters,
  fraud:[...this.peers].filter(([,s])=>s.fraud).map(([actor,s])=>({actor,...s.fraud}))};}
}
/** Resolve a Nostr pubkey to the single CONFIRMED roster actor that declared it (ambiguous keys resolve to nothing). */
export function bindingResolver(getProjection){
 let cached=null,index=new Map();
 return pubkey=>{
  const p=getProjection();if(!p?.confirmed?.actors||!p.actors)return null;
  if(p!==cached){
   cached=p;index=new Map();
   for(const player of p.confirmed.order){
    const c=p.confirmed.actors[player],live=p.actors[player];
    if(!c||c.retired||!c.nostr||!live||live.retired)continue;
    const entry={player,actor:c.ship.actor,eventId:c.ship.eventId,owner:c.ship.owner,nativeName:c.ship.nativeName,runId:live.ownerProof?.runId??null,committed:live.frame??null};
    index.set(c.nostr,index.has(c.nostr)?null:entry);
   }
  }
  return index.get(pubkey)??null;
 };
}
