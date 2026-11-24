// SPDX-License-Identifier: MIT
// Append-only journal of one publisher's signed OSG delta batches (Nostr kind 8427). Nostr is delivery and
// evidence, never the OSG consensus authority. All state is kept incrementally: accepting a batch and
// reading the contiguous frontier cost time proportional to the new data, not to the whole session.
import {readFile,appendFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
import {signEvent,verifyEvent,publicKey} from './single-address/crypto.mjs';
import {eventGenesis,verifyWorldDelta} from './world.mjs';
const HASH=/^[a-f0-9]{64}$/;
export const KIND_DELTA=8427;
const MAX_BATCH=20,MAX_BATCH_BYTES=15000;

export class NostrMirror{
 constructor({worldId,file,secret=null,publisher=null,deltaBatchSize=20}={}){
  if(!HASH.test(worldId??'')||typeof file!=='string'||!file||!Number.isSafeInteger(deltaBatchSize)||deltaBatchSize<1||deltaBatchSize>MAX_BATCH)
   throw Error('invalid_nostr_mirror_configuration');
  if(secret&&publisher&&publicKey(secret)!==publisher)throw Error('nostr_identity_mismatch');
  this.worldId=worldId;this.file=file;this.secret=secret;this.publisher=publisher??(secret?publicKey(secret):null);
  if(!HASH.test(this.publisher??''))throw Error('invalid_nostr_mirror_publisher');
  this.deltaBatchSize=deltaBatchSize;this.seen=new Set();this.list=[];this.deltas=new Map();this.pendingDeltas=[];
  this.queue=Promise.resolve();this.front={sequence:0,eventHead:eventGenesis(worldId)};
 }
 async init(){
  await mkdir(dirname(this.file),{recursive:true});
  let raw='';try{raw=await readFile(this.file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
  for(const line of raw.split('\n')){if(!line)continue;let e;try{e=JSON.parse(line);}catch{continue;}
   try{this.accept(e,{persist:false});}catch{/* a damaged line cannot poison the journal */}}
  return this;
 }
 /** Verify and store one signed batch. Returns false for a duplicate, throws on forgery or conflicting history. */
 accept(event,{persist=true}={}){
  if(!verifyEvent(event)||event.pubkey!==this.publisher||event.kind!==KIND_DELTA)throw Error('untrusted_nostr_event');
  if(this.seen.has(event.id))return false;
  let x;try{x=JSON.parse(event.content);}catch{throw Error('invalid_nostr_delta_batch');}
  if(!x||x.schema!==1||x.worldId!==this.worldId||!Array.isArray(x.events)||x.events.length<1||x.events.length>MAX_BATCH)throw Error('invalid_nostr_delta_batch');
  let previous=x.events[0].previous,sequence=x.events[0].sequence;
  for(const e of x.events){previous=verifyWorldDelta(e,this.worldId,previous,sequence);sequence++;
   const old=this.deltas.get(e.sequence);if(old&&old.hash!==e.hash)throw Error('conflicting_nostr_event_history');}
  for(const e of x.events)this.deltas.set(e.sequence,structuredClone(e));
  this.seen.add(event.id);this.list.push(event);this.advance();
  if(persist)this.queue=this.queue.then(()=>appendFile(this.file,JSON.stringify(event)+'\n',{mode:0o600}));
  return true;
 }
 advance(){let {sequence,eventHead}=this.front;
  while(this.deltas.has(sequence+1)){eventHead=verifyWorldDelta(this.deltas.get(sequence+1),this.worldId,eventHead,sequence+1);sequence++;}
  this.front={sequence,eventHead};
 }
 queueDelta(event){if(!this.secret)throw Error('nostr_delta_signer_missing');this.pendingDeltas.push(structuredClone(event));if(this.pendingDeltas.length>=this.deltaBatchSize)this.flushDeltas();}
 /** Sign up to deltaBatchSize pending deltas (bounded by event size) into one batch event. */
 flushDeltas(){
  if(!this.pendingDeltas.length)return null;
  let count=0;
  for(let i=0;i<Math.min(this.deltaBatchSize,this.pendingDeltas.length);i++){
   if(Buffer.byteLength(JSON.stringify({schema:1,worldId:this.worldId,events:this.pendingDeltas.slice(0,i+1)}))>MAX_BATCH_BYTES)break;
   count=i+1;
  }
  if(!count)throw Error('nostr_single_delta_too_large');
  const events=this.pendingDeltas.slice(0,count);
  const event=signEvent({secret:this.secret,kind:KIND_DELTA,tags:[['w',this.worldId],['s',String(events[0].sequence)]],
   content:JSON.stringify({schema:1,worldId:this.worldId,events})});
  this.accept(event);this.pendingDeltas.splice(0,count);return event;
 }
 contiguous(){return{...this.front,missing:Math.max(0,this.deltas.size-this.front.sequence)};}
 /** Batches in acceptance order. Read-only; callers must not modify the returned events. */
 get events(){return this.list;}
 async close(){while(this.pendingDeltas.length)this.flushDeltas();await this.queue;}
}
