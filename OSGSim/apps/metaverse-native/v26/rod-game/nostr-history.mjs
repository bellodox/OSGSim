// SPDX-License-Identifier: MIT
// Nostr is mandatory discovery and complementary *slow/full* OSG evidence
// availability. Per-device event streams are independent. Verified ROD names
// and game moves -- never a relay -- determine native world authority.
import {mkdir,readFile,appendFile,open} from 'node:fs/promises';
import {join} from 'node:path';
import {NostrMirror} from '../nostr-mirror.mjs';
import {verifyEvent,publicKey} from '../single-address/crypto.mjs';
import {verifyRodPeerAdvertisement,DISTRIBUTED_NOSTR_KIND} from './nostr-peer.mjs';
import {verifyWorldDelta,eventGenesis} from '../world.mjs';
const H=/^[a-f0-9]{64}$/;
const KIND_DELTA=8427;
const clone=x=>structuredClone(x);
const id=(pubkey,seq)=>`metaverse:nostr:delta_${pubkey}_${String(seq).padStart(12,'0')}`;
export class RodNostrHistory {
 constructor({world,graph,relay,rpc,secret,worldId,port,assetRoot,rodGenesis,dir,onStatus=()=>{},maxImport=3000,pageSize=300,flushMs=15000,deltaBatchSize=20}={}){
  if(!world||!graph?.putMany||!relay?.subscribe||!relay?.publish||typeof rpc!=='function'||
     !H.test(worldId??'')||!H.test(assetRoot??'')||!H.test(rodGenesis??'')||!dir||!secret)
   throw Error('ROD_NOSTR_HISTORY_CONFIGURATION_INVALID');
  if(!Number.isSafeInteger(maxImport)||maxImport<1||maxImport>100000||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>500)throw Error('ROD_NOSTR_HISTORY_PAGE_LIMIT_INVALID');
  Object.assign(this,{world,graph,relay,rpc,secret,worldId,port,assetRoot,rodGenesis,dir,onStatus,maxImport,pageSize});
  this.pubkey=publicKey(secret);this.remote=new Map();this.acked=new Set();this.unpersisted=[];this.closed=false;
  this.queuedThrough=0;this.flushMs=flushMs;this.deltaBatchSize=deltaBatchSize;this.lastFlushAt=Date.now();
  this.legacyAckFile=join(dir,'relay-acknowledged.json');this.ackFile=join(dir,'relay-acknowledged.log');
  // Incremental state: unpublished batches in order, and the contiguous frontier of acknowledged deltas.
  this.outbox=[];this.localSeen=0;this.ackedDeltas=new Map();this.ackFront=null;
 }
 async init(){
  await mkdir(this.dir,{recursive:true});
  // Acknowledgements are an append-only log (one id per line). The former
  // single JSON file was rewritten in full on every publish; it is still read
  // once so an upgraded installation does not republish its history.
  try{const value=JSON.parse(await readFile(this.legacyAckFile,'utf8'));
   if(value.schema===1&&value.worldId===this.worldId&&Array.isArray(value.ids))
    for(const id of value.ids)if(H.test(id)){this.acked.add(id);this.unpersisted.push(id);}}
  catch(e){if(e.code!=='ENOENT')throw e;}
  try{for(const line of (await readFile(this.ackFile,'utf8')).split('\n'))if(H.test(line))this.acked.add(line);}
  catch(e){if(e.code!=='ENOENT')throw e;}
  this.local=await new NostrMirror({worldId:this.worldId,file:join(this.dir,'local-deltas.jsonl'),
   secret:this.secret,publisher:this.pubkey,deltaBatchSize:this.deltaBatchSize}).init();
  this.queuedThrough=this.local.contiguous().sequence;
  this.ackFront={sequence:0,eventHead:eventGenesis(this.worldId)};
  await this.captureMissing();this.flushAll();this.syncOutbox();return this;
 }
 async persistAck(){
  if(!this.unpersisted.length)return;
  const ids=this.unpersisted.splice(0);
  try{await appendFile(this.ackFile,ids.join('\n')+'\n',{mode:0o600});}
  catch(e){this.unpersisted.unshift(...ids);throw e;}
 }
 flushAll(){let n=0;while(this.local.pendingDeltas.length){this.local.flushDeltas();n++;}this.lastFlushAt=Date.now();return n;}
 async capture(event){
  if(this.closed)throw Error('ROD_NOSTR_HISTORY_CLOSED');
  if(event?.worldId!==this.worldId||!Number.isSafeInteger(event.sequence))throw Error('ROD_NOSTR_LOCAL_EVENT_INVALID');
  if(event.sequence<=this.queuedThrough)return;
  if(event.sequence!==this.queuedThrough+1){await this.captureMissing();if(event.sequence<=this.queuedThrough)return;}
  // Commits are batched (up to deltaBatchSize per signed Nostr event) instead
  // of one relay event per OSG commit; publishPending flushes on a timer.
  this.local.queueDelta(event);this.queuedThrough=event.sequence;await this.local.queue;
 }
 async captureMissing(){
  let current=Math.max(this.local.contiguous().sequence,this.queuedThrough);
  while(current<this.world.state.sequence){
   const history=await this.world.history(current,200);
   if(!history.events.length)throw Error('ROD_NOSTR_OSG_HISTORY_GAP');
   for(const event of history.events){if(event.sequence<=this.queuedThrough)continue;this.local.queueDelta(event);this.queuedThrough=event.sequence;}
   await this.local.queue;current=Math.max(this.local.contiguous().sequence,this.queuedThrough);
  }
  return current;
 }
 /** Move batches the local journal created since the last call into the outbox, or the acknowledged frontier. */
 syncOutbox(){
  const list=this.local.events;
  for(;this.localSeen<list.length;this.localSeen++){const event=list[this.localSeen];
   if(event.kind!==KIND_DELTA)continue;
   if(this.acked.has(event.id))this.noteAcked(event);else this.outbox.push(event);
  }
 }
 noteAcked(event){
  for(const delta of JSON.parse(event.content).events)this.ackedDeltas.set(delta.sequence,delta);
  let {sequence,eventHead}=this.ackFront;
  while(this.ackedDeltas.has(sequence+1)){eventHead=verifyWorldDelta(this.ackedDeltas.get(sequence+1),this.worldId,eventHead,sequence+1);sequence++;}
  this.ackFront={sequence,eventHead};
 }
 async publishPending({max=20,force=false}={}){
  await this.captureMissing();
  if(this.local.pendingDeltas.length&&(force||Date.now()-this.lastFlushAt>=this.flushMs))this.flushAll();
  this.syncOutbox();
  let count=0;
  while(this.outbox.length&&count<max){const event=this.outbox[0];
   try{await this.relay.publish(event);}
   catch(e){this.onStatus('NOSTR_SLOW_HISTORY_OUTBOX_PENDING',{eventId:event.id,error:e.message});break;}
   this.outbox.shift();this.acked.add(event.id);this.unpersisted.push(event.id);this.noteAcked(event);count++;
  }
  if(count)await this.persistAck();return {acknowledged:count,pending:this.outbox.length};
 }
 // Only NIP-01 OK-acknowledged event batches are advertised as recoverable.
 // The local OSG/event journal can be further ahead during a relay outage.
 availableFrontier(){return this.ackFront?{...this.ackFront}:{sequence:0,eventHead:eventGenesis(this.worldId)};}
 async collect(filters,timeoutMs=5000){
  const events=[];
  const sub=this.relay.subscribe(filters,event=>{if(events.length<this.maxImport*4)events.push(event);});
  try{if(!await sub.eose(timeoutMs))throw Error('ROD_NOSTR_HISTORY_EOSE_UNAVAILABLE');}
  finally{sub.close();}
  return events;
 }
 async trustedAuthors(){
  const ads=await this.collect([{kinds:[DISTRIBUTED_NOSTR_KIND],'#w':[this.worldId],limit:500}]);
  const trusted=new Map();
  for(const ad of ads){
   const found=await verifyRodPeerAdvertisement(ad,{rpc:this.rpc,port:this.port,
    assetRoot:this.assetRoot,rodGenesis:this.rodGenesis});
   if(found?.claim.worldId!==this.worldId)continue;
   const previous=trusted.get(ad.pubkey);
   if(previous&&previous.player!==found.claim.player)throw Error('ROD_NOSTR_ARCHIVE_AUTHOR_CHANGED_OWNER');
   if(!previous||ad.created_at>previous.issuedAt)
    trusted.set(ad.pubkey,{player:found.claim.player,issuedAt:ad.created_at,
     expectedSequence:found.claim.osgSequence??null,expectedHead:found.claim.osgEventHead??null});
  }
  return trusted;
 }
 async pull({timeoutMs=5000}={}){
  if(this.closed)throw Error('ROD_NOSTR_HISTORY_CLOSED');
  const authors=await this.trustedAuthors();authors.delete(this.pubkey);
  if(!authors.size)return {imported:0,authors:0,complete:true,frontiers:{}};
  const additions=[],imported=new Set(),frontiers={};let complete=true;
  for(const [author,info] of authors){
   if(!info||typeof info.player!=='string')throw Error('ROD_NOSTR_ARCHIVE_AUTHOR_UNVERIFIED');
   let mirror=this.remote.get(author);
   if(!mirror){mirror=await new NostrMirror({worldId:this.worldId,
     file:join(this.dir,`peer-${author}.jsonl`),publisher:author}).init();this.remote.set(author,mirror);}
   // Nostr is slower historical availability, not multiplayer authority.
   // Keep a durable descending-time cursor across bounded catch-up cycles;
   // a separate newest page per cycle captures additions after that cursor.
   const cursorKey=`metaverse:nostr:page_cursor_${author}`;
   const previousCursor=this.graph.get?.(cursorKey);
   let cursor=Number.isSafeInteger(previousCursor?.before)?previousCursor.before:null;
   let budget=this.maxImport,first=true,exhausted=false;
   const observedIds=new Set(),stagedDeltas=new Map();
   const acceptSigned=(signed)=>{
    if(observedIds.has(signed.id))return false;
    observedIds.add(signed.id);
    if(!verifyEvent(signed)||signed.kind!==KIND_DELTA||signed.pubkey!==author)return false;
    let data;try{data=JSON.parse(signed.content);}catch{return false;}
    if(data?.schema!==1||data.worldId!==this.worldId||!Array.isArray(data.events)||
       !data.events.length||data.events.length>20)return false;
    // The signed sequence index must match the batch. It permits reliable
    // gap queries even when many commits have identical Nostr timestamps.
    const starts=signed.tags?.filter(t=>t[0]==='s').map(t=>t[1]);
    if(starts?.length!==1||starts[0]!==String(data.events[0].sequence))return false;
    try{mirror.accept(signed);}catch(e){this.onStatus('NOSTR_SLOW_HISTORY_CONFLICT',{pubkey:author,error:e.message});return false;}
    imported.add(signed.id);
    for(const delta of data.events){const key=id(author,delta.sequence),value={schema:1,worldId:this.worldId,
     author,player:info.player,eventId:signed.id,delta:clone(delta),canonicalAuthority:'rod-game'};
     const existing=stagedDeltas.get(key)??this.graph.get?.(key);
     if(existing){
      if(existing.delta?.hash!==delta.hash||existing.player!==info.player)
       throw Error('ROD_NOSTR_ARCHIVE_CONFLICTING_EVENT');
      continue; // Re-signed identical evidence must not duplicate an OSG row.
     }
     stagedDeltas.set(key,value);
     additions.push({id:key,value});
    }
    return true;
   };
   while(budget>0){
    const limit=Math.min(this.pageSize,budget),filters={kinds:[KIND_DELTA],authors:[author],
     '#w':[this.worldId],limit};
    if(!first&&cursor!==null)filters.until=cursor;
    const page=await this.collect([filters],timeoutMs);
    const filtered=page.filter(e=>e.kind===KIND_DELTA&&e.pubkey===author&&Number.isSafeInteger(e.created_at))
     .sort((a,b)=>b.created_at-a.created_at||b.id.localeCompare(a.id));
    for(const signed of filtered)acceptSigned(signed);
    // Always include fresh announcements at the top of each cycle, then
    // resume historical catch-up from the persistent cursor.
    if(first){first=false;
     if(cursor!==null){continue;}
    }
    budget-=Math.min(this.pageSize,page.length);
    if(page.length<limit){exhausted=true;cursor=null;break;}
    const oldest=filtered.at(-1)?.created_at;
    if(!Number.isSafeInteger(oldest)){complete=false;break;}
    if(cursor!==null&&oldest>=cursor){complete=false;break;}
    cursor=oldest-1;
    if(cursor<0){exhausted=true;cursor=null;break;}
   }
   // Timestamp-based NIP-01 pagination cannot distinguish two events with
   // the same created_at. Recover the next missing commit by its signed
   // starting sequence (#s), never skipping it due to a time cursor.
   // A batch contains at most 20 consecutive WorldDelta records.
   if(Number.isSafeInteger(info.expectedSequence)){
    const maxQueries=Math.min(4,Math.max(1,Math.ceil(this.maxImport/this.pageSize)));
    for(let tries=0;tries<maxQueries;tries++){
     const before=mirror.contiguous().sequence,missing=before+1;
     if(missing>info.expectedSequence)break;
     const starts=Array.from({length:Math.min(20,missing)},(_,i)=>String(missing-i));
     const page=await this.collect([{kinds:[KIND_DELTA],authors:[author],
      '#w':[this.worldId],'#s':starts,limit:Math.max(20,this.pageSize)}],timeoutMs);
     for(const signed of page)acceptSigned(signed);
     if(mirror.contiguous().sequence===before)break;
    }
   }
   // Persist the Nostr file before advancing the OSG catch-up cursor.
   await mirror.queue;
   if(cursor!==null){additions.push({id:cursorKey,value:{schema:1,before:cursor,worldId:this.worldId}});}
   else if(exhausted){additions.push({id:cursorKey,value:{schema:1,before:null,worldId:this.worldId}});}
   const frontier=mirror.contiguous();frontiers[author]={...frontier,expectedSequence:info.expectedSequence,
    expectedHead:info.expectedHead,historyExhausted:exhausted};
   if(info.expectedSequence===null||info.expectedHead===null||frontier.sequence<info.expectedSequence||
      (frontier.sequence===info.expectedSequence&&frontier.eventHead!==info.expectedHead))complete=false;
  }
  for(let i=0;i<additions.length;i+=250)await this.graph.putMany(additions.slice(i,i+250));
  this.onStatus('NOSTR_SLOW_HISTORY_IMPORT',{imported:imported.size,authors:authors.size,complete});
  return {imported:imported.size,authors:authors.size,complete,frontiers};
 }
 status(){return {local:this.local?.contiguous()??null,relayAckCount:this.acked.size,
  remote:Object.fromEntries([...this.remote].map(([k,m])=>[k,m.contiguous()]))};}
 async close(){this.closed=true;await this.local?.close();for(const m of this.remote.values())await m.close();}
}

/** Highest delta sequence in a delta journal written by another process. Each call reads only the bytes appended
 * since the previous call, so the cost does not grow with the length of the session. */
export function journalFrontierReader(file){
 let offset=0,tail='',max=0;
 return async()=>{
  if(!file)return{sequence:null,eventHead:null,source:'parent-nostr-archive-not-configured'};
  let handle;try{handle=await open(file,'r');}catch(e){return{sequence:null,eventHead:null,source:'parent-nostr-archive-unavailable',error:e.message}}
  try{const {size}=await handle.stat();
   if(size<offset){offset=0;tail='';max=0;}
   if(size>offset){const buffer=Buffer.alloc(size-offset);await handle.read(buffer,0,buffer.length,offset);offset=size;
    const lines=(tail+buffer.toString('utf8')).split('\n');tail=lines.pop();
    for(const line of lines){if(!line.trim())continue;
     try{const event=JSON.parse(line);if(event.kind!==KIND_DELTA)continue;
      for(const delta of JSON.parse(event.content).events??[])if(Number.isSafeInteger(delta.sequence)&&delta.sequence>max)max=delta.sequence;
     }catch{}}
   }
  }finally{await handle.close();}
  return{sequence:max,eventHead:null,source:'parent-signed-nostr-archive'};
 };
}
