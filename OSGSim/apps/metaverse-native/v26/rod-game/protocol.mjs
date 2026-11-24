// SPDX-License-Identifier: MIT
// Canonical ROD game moves. Neither ZMQ nor a claimed txid establishes authority.
import {sha,canonical} from '../ownership.mjs';
const H=/^[a-f0-9]{64}$/;
const P=/^p\/[a-zA-Z0-9_.-]{1,48}$/;
const ID=/^[a-zA-Z0-9_.:-]{1,96}$/;
const ADDR=/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{25,64}$/;
export const hashMove=move=>sha({schema:1,world:move.world,game:move.game,player:move.player,seq:move.seq,previous:move.previous,kind:move.kind,payload:move.payload});
export const moveDigest=move=>hashMove(move);
export function buildMove({world,game,player,seq,previous,kind,payload}) {
 const move={v:1,world,game,player,seq,previous,kind,payload};move.digest=hashMove(move);return validateMove(move,{world,game});
}
export function assertFrame(f){
 const s=f?.sample;
 if(!f||!s||s.type!=='PHYSICS_SAMPLE'||s.source!=='native'||s.frameId!=='metaverse-moon-relative-v26'||!ID.test(s.runId??'')||!Number.isSafeInteger(s.sequence)||s.sequence<1||!Number.isFinite(s.simMjd)||!['LANDED','FREEFLIGHT'].includes(s.mode))throw Error('ROD_GAME_FRAME_INVALID');
 for(const [key,n] of [['position',3],['velocity',3],['orientation',4],['surface',4]])if(!Array.isArray(s[key])||s[key].length!==n||!s[key].every(x=>Number.isFinite(x)&&Math.abs(x)<1e18))throw Error('ROD_GAME_FRAME_INVALID');
 if(!H.test(f.eventId??'')||!ADDR.test(f.owner??'')||!ID.test(s.entityName??'')||!Number.isSafeInteger(s.capturedAtUnixMs)||s.capturedAtUnixMs<0||Math.abs(Math.hypot(...s.orientation)-1)>0.005)throw Error('ROD_GAME_FRAME_INVALID');
 if(s.mode==='LANDED'&&(Math.abs(s.surface[0])>Math.PI||Math.abs(s.surface[1])>Math.PI/2||Math.abs(s.surface[2])>2*Math.PI||Math.abs(s.surface[3])>100000))throw Error('ROD_GAME_FRAME_INVALID');
}
export function validateMove(m,{world,game}={}){
 if(!m||m.v!==1||!H.test(m.world??'')||!ID.test(m.game??'')||!P.test(m.player??'')||!Number.isSafeInteger(m.seq)||m.seq<1||m.seq>1e9||!['join','rejoin','owner-proof','frame','scene-proof','leave','checkpoint'].includes(m.kind)||!m.payload||typeof m.payload!=='object'||Array.isArray(m.payload)||!H.test(m.digest??'')||m.digest!==hashMove(m)||!H.test(m.previous??'')||(m.seq===1&&m.previous!=='0'.repeat(64)))throw Error('ROD_GAME_MOVE_INVALID');
 if(world&&m.world!==world||game&&m.game!==game)throw Error('ROD_GAME_MOVE_FOREIGN');
 const p=m.payload;
 if(m.kind==='join'||m.kind==='rejoin'){
  if((m.kind==='join'&&m.seq!==1)||(m.kind==='rejoin'&&m.seq<2)||!ADDR.test(p.owner??'')||p.asset!==m.world||!Number.isSafeInteger(p.clockEra)||p.clockEra<1||(p.nostr!==undefined&&!H.test(p.nostr)))throw Error('ROD_GAME_JOIN_INVALID');
 }else if(m.kind==='owner-proof'){
  if(!p.proof||!p.proof.created||p.proof.kind!=='owner'||!ID.test(p.proof.runId??'')||!H.test(p.proof.eventId??'')||!p.proof.verifiedPort)throw Error('ROD_GAME_OWNER_PROOF_INVALID');
 }else if(m.kind==='frame'){
  assertFrame(p.frame);
 }else if(m.kind==='checkpoint'){
  // Commitment to the head of the player's live-lane hash chain at one lane sequence.
  if(!/^peer(?:0|[1-9]\d{0,4})$/.test(p.actor??'')||!ID.test(p.runId??'')||!Number.isSafeInteger(p.seq)||p.seq<1||!H.test(p.digest??'')||!Number.isFinite(p.simMjd))throw Error('ROD_GAME_CHECKPOINT_INVALID');
 }else if(m.kind==='scene-proof'){
  if(!p.proof||!H.test(p.proof.sceneSha256??'')||!H.test(p.proof.cameraSha256??'')||!ID.test(p.proof.observer??'')||!ID.test(p.proof.target??'')||!ID.test(p.proof.runId??'')||!ID.test(p.proof.cameraTarget??'')||!Array.isArray(p.proof.nativeNames)||p.proof.nativeNames.length<2||p.proof.nativeNames.length>128||!p.proof.nativeNames.every(x=>ID.test(x)))throw Error('ROD_GAME_SCENE_PROOF_INVALID');
 }
 if(Buffer.byteLength(JSON.stringify({g:{[m.game]:m}}))>2048)throw Error('ROD_GAME_MOVE_TOO_LARGE');
 return m;
}
// v3: inactivity retirement and ignored (not rejected) moves of retired actors. A consensus change.
export const GAME_PROTOCOL='osgsim-rod-primary-v3';
export function gameGenesis({world,assetRoot,port,clock,rodGenesis}){
 if(!H.test(world??'')||!H.test(assetRoot??'')||!H.test(rodGenesis??'')||!H.test(port?.configSha256??''))throw Error('ROD_GAME_GENESIS_INVALID');
 return{schema:1,protocol:GAME_PROTOCOL,worldId:world,assetRoot,rodGenesis,portHash:port.configSha256,clock};
}
export function verifyGameGenesis(value,expected){
 let parsed;try{parsed=typeof value==='string'?JSON.parse(value):value}catch{throw Error('ROD_GAME_GENESIS_NOT_JSON')}
 if(canonical(parsed)!==canonical(expected))throw Error('ROD_GAME_GENESIS_MISMATCH');return parsed;
}
export const gameName=game=>`g/${game}`;
export function parseRodTx(tx,{world,game}={}){
 if(!H.test(tx?.txid??'')||!Array.isArray(tx?.vout))return [];
 const matches=[];
 for(const out of tx.vout){const op=out.scriptPubKey?.nameOp;
  if(!op||!['name_update','name_register'].includes(op.op)||!P.test(op.name??''))continue;
  let value;try{value=typeof op.value==='string'?JSON.parse(op.value):op.value;}catch{continue}
  const move=value?.g?.[game];if(!move)continue;
  const address=out.scriptPubKey?.address??out.scriptPubKey?.addresses?.[0];
  if(!ADDR.test(address??'')||move.player!==op.name)continue;
  try{validateMove(move,{world,game});if(move.kind==='join'&&move.payload.owner!==address)continue;
   matches.push({txid:tx.txid,player:op.name,address,move,vout:out.n,inputs:tx.vin??[]});}catch{}
 }
 return matches;
}
// Confirmed block order is authoritative. Mempool order is provisional and
// deterministic only for the same observed tx set. Any gap is excluded.
// A player name may return with a new, never-reused actor after a confirmed
// leave. Existing history and spent actor IDs remain part of the root.
// Consensus-level plausibility rules for self-reported native samples. They do
// not prove physics; they bound what a wallet can claim. Changing any value is
// a consensus change and requires a new protocol version.
export const PLAUSIBILITY_V1=Object.freeze({version:1,maxPositionM:1e9,maxSpeedMs:5e4,maxAccelMs2:60,
 posSlackM:50,velSlackMs:5,maxMjdSkewS:10800,maxGapS:86400});
const norm=a=>Math.hypot(...a);
/** @returns {string|null} reason a frame is implausible, or null. */
export function frameImplausible(frame,prev,{blockTimeSec=null,clock,limits=PLAUSIBILITY_V1}={}){
 if(!limits)return null;
 const s=frame.sample;
 if(norm(s.position)>limits.maxPositionM)return 'position_bound';
 if(norm(s.velocity)>limits.maxSpeedMs)return 'speed_bound';
 if(Number.isFinite(blockTimeSec)&&clock){
  const mjd=clock.simMjd0+(blockTimeSec*1000-clock.utcOriginMs)/86400000;
  if(Math.abs(s.simMjd-mjd)*86400>limits.maxMjdSkewS)return 'time_vs_block';
 }
 const p=prev?.sample;
 if(p&&p.runId===s.runId){
  const dt=(s.simMjd-p.simMjd)*86400;
  if(dt<-0.05)return 'time_reversal';
  if(dt<=limits.maxGapS){
   const t=Math.max(0,dt),dv=norm(s.velocity.map((v,i)=>v-p.velocity[i]));
   if(dv>limits.maxAccelMs2*t+limits.velSlackMs)return 'acceleration_bound';
   const dp=norm(s.position.map((v,i)=>v-(p.position[i]+p.velocity[i]*t)));
   if(dp>0.5*limits.maxAccelMs2*t*t+limits.posSlackM)return 'displacement_bound';
  }
 }
 return null;
}
// A ship whose player has had no confirmed move for this many blocks (~2 h at ROD's 30 s blocks) is retired and
// its pad freed. An active peer moves at least every 5 minutes (checkpoint), so only absent players expire; a
// retired player returns with a rejoin move.
export const INACTIVITY_RETIRE_BLOCKS=240;
export function assembleProjection({world,game,confirmed=[],pending=[],port,clock,limits=PLAUSIBILITY_V1,tipHeight=null}){
 if(!port?.portId||!Array.isArray(port.slots)||!port.slots.length||!Number.isSafeInteger(clock?.era))throw Error('ROD_PROJECTION_GENESIS_INVALID');
 const zero='0'.repeat(64),heads=new Map(),actors=new Map(),order=[],retired=[],accepted=[],rejected=[],ignored=[];
 let nextActor=0;const lastActive=new Map();
 const reject=(row,why)=>{rejected.push({txid:row.txid,why,player:row.player});};
 const retire=(player,how)=>{const a=actors.get(player);
  a.retired=true;a.ship.phase='RETIRED';order.splice(order.indexOf(player),1);
  retired.push({player,actor:a.ship.actor,slot:a.ship.slot,eventId:a.ship.eventId,...how});};
 const expireBefore=height=>{for(const player of [...order]){const last=lastActive.get(player);
  if(Number.isSafeInteger(last)&&last<=height-INACTIVITY_RETIRE_BLOCKS)retire(player,{expiredAtHeight:height});}};
 const reserve=(row,final)=>{
  const m=row.move,old=actors.get(m.player),previous=heads.get(m.player);
  if(!final){reject(row,'unconfirmed_join_waits_for_block');return false;}
  if(m.payload.clockEra!==clock.era||m.payload.owner!==row.address||
     (m.kind==='join'&&previous)||(m.kind==='rejoin'&&(!previous||!old?.retired))){reject(row,'join_conflict');return false;}
  const used=new Set(order.map(player=>actors.get(player).ship.slot));
  const slot=port.slots.find(p=>!used.has(p.slot));
  if(!slot||nextActor>=10000){reject(row,'port_full');return false;}
  const id=`peer${nextActor++}`;
  const eventId=sha({worldId:world,actor:id,address:m.payload.owner,portId:port.portId,slot:slot.slot,kind:'ROD_JOIN',player:m.player});
  const ship={worldId:world,actor:id,asset:`ship:${id}`,owner:m.payload.owner,nativeName:`Glider-Peer${id.slice(4)}`,vesselClass:'ShuttlePB',referenceBody:'Moon',portId:port.portId,slot:slot.slot,eventId,phase:'RESERVED',spawnUtcMs:0,reservedUntilUtcMs:Number.MAX_SAFE_INTEGER,epoch:clock.era};
  actors.set(m.player,{ship,frame:null,ownerProof:null,sceneProof:null,confirmed:final,retired:false,nostr:m.payload.nostr??null,checkpoint:null,joinHeight:Number.isSafeInteger(row.height)?row.height:null});order.push(m.player);
  return true;
 };
 const accept=(row,final)=>{
  const m=row.move,prev=heads.get(m.player),expected=(prev?.seq??0)+1,head=prev?.digest??zero;
  if(m.seq!==expected||m.previous!==head){reject(row,'noncontiguous');return;}
  if(m.kind==='join'||m.kind==='rejoin'){
   if(!reserve(row,final))return;
  }else if(!prev||!actors.has(m.player)){reject(row,'missing_join');return;}
  else if(row.address!==actors.get(m.player).ship.owner){reject(row,'player_name_transferred_requires_new_authorization');return;}
  else {
   const a=actors.get(m.player);
   // Owner-scoped moves that are not applicable (foreign actor, stale run or
   // sequence, implausible sample) are IGNORED, not rejected: the move is valid
   // on the player's hash chain, so it advances it, and one bad move can never
   // stall every later move of that player.
   const why=(()=>{
   // Valid on the player's chain but not applicable: the player must rejoin first. Ignored, so the chain advances.
   if(a.retired)return 'retired_actor_requires_rejoin';
   if(m.kind==='owner-proof'){
    const pr=m.payload.proof;if(pr.eventId!==a.ship.eventId||pr.actor!==a.ship.actor||pr.observer!==a.ship.actor){return 'owner_proof_foreign';}
    a.ownerProof=pr;a.ship.phase='ACTIVE';
   }else if(m.kind==='frame'){
    if(!a.ownerProof||m.payload.frame.actor!==a.ship.actor||m.payload.frame.owner!==a.ship.owner||m.payload.frame.eventId!==a.ship.eventId||m.payload.frame.sample.entityName!==a.ship.nativeName||m.payload.frame.sample.runId!==a.ownerProof.runId||(a.frame?.sample?.runId===m.payload.frame.sample.runId&&(a.frame?.sample?.sequence??0)>=m.payload.frame.sample.sequence)){return 'frame_not_owned_or_stale';}
    // An implausible sample is *ignored* (Xaya semantics: an invalid move
    // cannot be undone), but it still advances the player's hash chain so one
    // bad frame can never stall every later move of that player.
    const why=frameImplausible(m.payload.frame,a.frame,{blockTimeSec:final?row.blockTime:null,clock,limits});
    if(why)return 'frame_implausible_'+why;
    a.frame=m.payload.frame;a.ship.phase=m.payload.frame.sample.mode==='LANDED'?'LANDED':'DEPARTED';
   }else if(m.kind==='checkpoint'){
    const c=m.payload,last=a.checkpoint?.runId===c.runId?a.checkpoint.seq:0;
    if(!a.ownerProof||c.actor!==a.ship.actor||c.runId!==a.ownerProof.runId||c.seq<=last){return 'checkpoint_not_owned_or_stale';}
    a.checkpoint={runId:c.runId,seq:c.seq,digest:c.digest,simMjd:c.simMjd,txid:row.txid,height:Number.isSafeInteger(row.height)?row.height:null};
   }else if(m.kind==='scene-proof'){
    const proof=m.payload.proof;
    const remote=order.map(player=>actors.get(player)).find(x=>x?.ship?.actor===proof.target);
    if(!a.ownerProof||!remote?.ownerProof||proof.observer!==a.ship.actor||proof.target===a.ship.actor||proof.cameraTarget!==remote.ship.nativeName||!proof.nativeNames.includes(a.ship.nativeName)||!proof.nativeNames.includes(remote.ship.nativeName)){return 'scene_proof_not_from_owner_or_unknown_target';}
    a.sceneProof=proof;
   }else if(m.kind==='leave'){
    // Release the reservation but retain its physical evidence in historical
    // OSG events. Actor IDs are never recycled, even when ports are.
    retire(m.player,{leaveDigest:m.digest});
   }
    return null;
   })();
   if(why)ignored.push({txid:row.txid,why,player:m.player});
  }
  heads.set(m.player,{seq:m.seq,digest:m.digest,txid:row.txid,confirmed:final});accepted.push({txid:row.txid,move:m,confirmed:final});
  if(final&&Number.isSafeInteger(row.height))lastActive.set(m.player,row.height);
 };
 const root=()=>{
  const value={schema:1,world,game,clockEra:clock.era,
   frontier:order.map(player=>({player,digest:heads.get(player).digest,ship:actors.get(player).ship,frame:actors.get(player).frame,proof:actors.get(player).ownerProof,sceneProof:actors.get(player).sceneProof}))};
  if(retired.length)value.retired=retired.map(x=>({...x,digest:heads.get(x.player)?.digest}));
  return sha(value);
 };
 for(const row of confirmed){if(Number.isSafeInteger(row.height))expireBefore(row.height);accept(row,true);}
 if(Number.isSafeInteger(tipHeight))expireBefore(tipHeight);
 const canonicalRoot=root(),confirmedState={root:canonicalRoot,frontier:Object.fromEntries(heads),actors:Object.fromEntries([...actors].map(([n,v])=>[n,structuredClone(v)])),order:[...order],retired:structuredClone(retired)};
 // Only the final confirmed chain assigns lasting actor IDs. Pending moves
 // are a *provisional* local view and cannot silently alter the shared root.
 for(const row of pending)accept(row,false);
 return {schema:1,world,game,confirmedRoot:canonicalRoot,liveRoot:root(),confirmed:confirmedState,frontier:Object.fromEntries(heads),actors:Object.fromEntries(actors),order,retired,accepted,rejected,ignored};
}
