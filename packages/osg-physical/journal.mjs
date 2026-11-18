// SPDX-License-Identifier: MIT
import { open, mkdir, readFile, truncate, link, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assert, sha256, validateEnvelope,finite,vec3,quat } from '../world-protocol/index.mjs';

async function syncDirectory(path){
  // Node does not expose a portable Windows directory FlushFileBuffers handle.
  if(process.platform==='win32')return;
  const dir=await open(path,'r');try{await dir.sync();}finally{await dir.close();}
}

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}
export class DurableJournal {
  #writeHandle; #lockHandle; #opened=false; #events=[]; #lastHash='0'.repeat(64); #sequence=0; #seen=new Map(); #pending=Promise.resolve(); #faulted=false;
  constructor(file,{readOnly=false}={}) {this.file=file;this.readOnly=readOnly;}
  async open() {
    assert(!this.#opened,'journal already open');
    this.#opened=true;this.#lastHash='0'.repeat(64);this.#sequence=0;this.#seen.clear();this.#events=[];this.#faulted=false;
    try {
    if(!this.readOnly)await mkdir(dirname(this.file),{recursive:true});
    if(!this.readOnly){
      try{this.#lockHandle=await open(this.file+'.lock','wx');}
      catch(e){if(e.code==='EEXIST')throw new Error('journal writer lock exists; stop its owner before stale-lock recovery');throw e;}
      await this.#lockHandle.writeFile(JSON.stringify({pid:process.pid})+'\n');
      await this.#lockHandle.sync();
    }
    let raw=''; try {raw=await readFile(this.file,'utf8');}catch(e){if(this.readOnly||e.code!=='ENOENT')throw e;}
    if(raw&&!raw.endsWith('\n')) {
      assert(!this.readOnly,'incomplete journal tail; read-only verification will not repair it');
      const ix=raw.lastIndexOf('\n');
      raw=ix>=0?raw.slice(0,ix+1):'';
      await truncate(this.file,Buffer.byteLength(raw));
    }
    for(const line of raw.split('\n').filter(Boolean)) {
      const record=JSON.parse(line);
      assert(record.schema===1,'journal schema mismatch');
      assert(record.previous===this.#lastHash,'journal chain mismatch');
      assert(record.sequence===this.#sequence+1,'journal sequence mismatch');
      assert(record.digest===sha256(canonical({schema:record.schema,sequence:record.sequence,previous:record.previous,envelope:record.envelope})), 'journal checksum mismatch');
      validateEnvelope(record.envelope);
      const e=record.envelope;
      const eid=this.#identity(e);
      assert(!this.#seen.has(eid),`duplicate journal event ${eid}`);
      this.#seen.set(eid,sha256(canonical(e)));
      this.#lastHash=record.digest;this.#sequence=record.sequence;
      this.#events.push(e);
    }
    if(!this.readOnly){this.#writeHandle=await open(this.file,'a');await this.#writeHandle.sync();await syncDirectory(dirname(this.file));}
    return this;
    }catch(error){await this.close();throw error;}
  }
  #identity(e){return JSON.stringify([e.runId,e.epoch,e.eventId??`${e.type}/${e.step}/${e.entityId??''}`]);}
  append(event) {
    let snapshot;try{snapshot=JSON.parse(JSON.stringify(validateEnvelope(event)));}catch(e){return Promise.reject(e);}
    const operation=this.#pending.then(()=>this.#appendSerialized(snapshot));
    this.#pending=operation.catch(()=>{});
    return operation;
  }
  async #appendSerialized(event) {
    validateEnvelope(event);
    if(this.#faulted)throw new Error('journal writer faulted; reopen for validated recovery');
    if(!this.#writeHandle)throw new Error('journal is closed');
    const id=this.#identity(event);
    const payloadDigest=sha256(canonical(event));
    if(this.#seen.has(id)){
      assert(this.#seen.get(id)===payloadDigest,'duplicate event ID has different payload');
      return {duplicate:true,sequence:this.#sequence,hash:this.#lastHash};
    }
    const record={schema:1,sequence:this.#sequence+1,previous:this.#lastHash,envelope:event};
    record.digest=sha256(canonical(record));
    // A single serialized caller owns this writer. Partial writes are never acknowledged.
    const line=canonical(record)+'\n';
    try {
      await this.#writeHandle.writeFile(line,'utf8');
      await this.#writeHandle.sync();
    }catch(error){this.#faulted=true;throw error;}
    this.#sequence++;
    this.#lastHash=record.digest;this.#seen.set(id,payloadDigest);
    this.#events.push(event);
    return {duplicate:false,sequence:this.#sequence,hash:record.digest};
  }
  async entries(){
    await this.#pending;
    return structuredClone(this.#events);
  }
  get head(){return {sequence:this.#sequence,hash:this.#lastHash};}
  async close(){await this.#pending;
    try{if(this.#writeHandle){await this.#writeHandle.close();this.#writeHandle=null;}}
    finally{if(this.#lockHandle){await this.#lockHandle.close();this.#lockHandle=null;await unlink(this.file+'.lock');}this.#opened=false;}
  }
}
export class AssetStore {
  constructor(root){this.root=root;}
  async put(data) {
    const buffer=Buffer.from(data);
    const hash=sha256(buffer),base=join(this.root,hash.slice(0,2));
    await mkdir(base,{recursive:true});
    const destination=join(base,hash),temporary=join(base,`.${hash}.${randomUUID()}.tmp`);
    let existing;
    try{existing=await readFile(destination);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(existing){assert(sha256(existing)===hash,'preexisting asset hash mismatch');return hash;}
    const writer=await open(temporary,'wx');
    try {
      await writer.writeFile(buffer);
      await writer.sync();
    }finally{await writer.close();}
    try {
      // Hardlink atomically publishes a fully fsynced immutable blob without replacing a winner.
      try{await link(temporary,destination);}
      catch(e){if(e.code!=='EEXIST')throw e;}
      const published=await readFile(destination);
      assert(sha256(published)===hash,'asset publication collision/corruption');
      await syncDirectory(base);await syncDirectory(this.root);await syncDirectory(dirname(this.root));
    }finally{await unlink(temporary).catch(e=>{if(e.code!=='ENOENT')throw e;});}
    return hash;
  }
  async get(hash){
    assert(/^[0-9a-f]{64}$/.test(hash),'invalid hash');
    const data=await readFile(join(this.root,hash.slice(0,2),hash));
    assert(sha256(data)===hash,'asset hash mismatch'); return data;
  }
}
/** Immutable binary physical-state encoding. Floats stay outside OSG's canonical JSON. */
export function encodeSample(sample){
  finite(sample.simTime,'sample time');finite(sample.simDt,'sample dt');assert(sample.simDt>=0,'negative sample dt');
  vec3(sample.position,'sample position');vec3(sample.velocity,'sample velocity');
  if(sample.orientation!=null)quat(sample.orientation,'sample orientation');
  if(sample.angularVelocity!=null)vec3(sample.angularVelocity,'sample angular velocity');
  if(sample.contact!=null)assert(typeof sample.contact==='boolean','invalid sample contact');
  const buf=Buffer.alloc(136);buf.write('OSGSIM2\0',0,'ascii');
  buf[8]=(sample.contact!=null?1:0)|(sample.contact===true?2:0)|(sample.orientation!=null?4:0)|(sample.angularVelocity!=null?8:0);
  const scalars=[sample.simTime,sample.simDt,...sample.position,...sample.velocity,...(sample.orientation??[0,0,0,0]),...(sample.angularVelocity??[0,0,0])];
  scalars.forEach((x,i)=>buf.writeDoubleLE(x,16+i*8));
  return buf;
}
export function decodeSample(buf){
  const legacy=buf.length===96;
  assert(legacy||(buf.length===136&&buf.subarray(0,8).toString('ascii')==='OSGSIM2\0'),'invalid binary sample');
  const flags=legacy?4:buf[8];
  assert(legacy||((flags&~15)===0&&buf.subarray(9,16).every(x=>x===0)&&(!(flags&2)||(flags&1))),'invalid sample flags');
  const a=Array.from({length:legacy?12:15},(_,i)=>finite(buf.readDoubleLE((legacy?0:16)+i*8),'binary sample'));
  assert(a[1]>=0,'negative binary sample dt');
  const orientation=flags&4?a.slice(8,12):null;if(orientation)quat(orientation,'binary orientation');
  return {formatVersion:legacy?1:2,simTime:a[0],simDt:a[1],position:a.slice(2,5),velocity:a.slice(5,8),orientation,
    angularVelocity:flags&8?a.slice(12,15):null,contact:flags&1?!!(flags&2):null};
}
