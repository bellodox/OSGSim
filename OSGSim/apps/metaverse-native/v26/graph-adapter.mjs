// SPDX-License-Identifier: MIT
// Single-writer OSG Multi graph. Crash recovery never steals a live writer lock.
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdir,open,unlink,readFile,stat} from 'node:fs/promises';
import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
const sameJSON=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const OSG_ELEMENT_ID=/^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*:.+$/;
export function assertOsgElementId(id){
 if(typeof id!=='string'||id.length>180||!OSG_ELEMENT_ID.test(id)||id!==id.normalize('NFC')||/[|@]/.test(id)||/%(?![0-9A-F]{2})/.test(id))
  throw Error('invalid_osg_element_id: '+String(id)+' (required namespace:type:name)');
 return id;
}
// OSG Multi hashes safe integers only. The simulator's physics state contains
// IEEE-754 values, so serialize JSON bytes as a canonical base64url field.
// This preserves fractional positions, velocities, null fields, and their exact
// JSON representation without weakening OSG Multi's validators or hashing.
// Base64url prevents the OSG string normalizer changing UTF-8 content.
const PROPS_ENCODING='osgsim-json-b64url-v1';
export function encodeOsgProps(value){
 const json=JSON.stringify(value,(_k,v)=>{
  if(typeof v==='number'&&!Number.isFinite(v))throw Error('invalid_osg_number');
  return v;
 });
 if(typeof json!=='string'||typeof value!=='object'||value===null||Array.isArray(value))throw Error('invalid_osg_props');
 return {encoding:PROPS_ENCODING,payload:Buffer.from(json,'utf8').toString('base64url')};
}
export function decodeOsgProps(raw){
 const value=typeof raw==='string'?JSON.parse(raw):raw;
 if(value&&typeof value==='object'&&!Array.isArray(value)&&
   Object.keys(value).length===2&&value.encoding===PROPS_ENCODING&&typeof value.payload==='string'){
  if(!/^[A-Za-z0-9_-]+$/.test(value.payload))throw Error('invalid_osg_payload');
  const bytes=Buffer.from(value.payload,'base64url');
  if(bytes.toString('base64url')!==value.payload)throw Error('invalid_osg_payload');
  const decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
  if(!decoded||typeof decoded!=='object'||Array.isArray(decoded))throw Error('invalid_osg_payload');
  return decoded;
 }
 return value; // Existing legacy stored objects remain readable.
}

const isLive=(pid)=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
export async function acquireGraphLock(dir) {
 const path=join(dir,'demo.lock'),owner={schema:1,host:hostname(),pid:process.pid,started:Date.now(),nonce:randomUUID()};
 for(let attempt=0;attempt<3;attempt++){
  try {const file=await open(path,'wx',0o600);
   try {await file.writeFile(JSON.stringify(owner)+'\n');await file.sync();return {file,path,owner};}
   catch(e){await file.close();await unlink(path).catch(()=>{});throw e;}
  }catch(e){if(e.code!=='EEXIST')throw e;
   // On a crash the exclusive-create file survives. Reap only a proven-dead
   // process on this host; never reset an unidentifiable or live lock.
   const before=await stat(path).catch(()=>null);if(!before){continue;}
   let old;try{old=JSON.parse(await readFile(path,'utf8'));}catch{throw Error('OSG writer lock is malformed; inspect it manually: '+path);}
   if(old.schema!==1||old.host!==hostname()||!Number.isSafeInteger(old.pid)||old.pid<1||typeof old.nonce!=='string')throw Error('OSG writer lock owner is unverified: '+path);
   if(isLive(old.pid))throw Error('OSG graph already has a live writer PID '+old.pid);
   // Grace avoids racing a writer that has only just created its lock record.
   if(Date.now()-before.mtimeMs<2000)throw Error('OSG dead writer lock is too recent; retry after 2 seconds');
   const after=await stat(path).catch(()=>null);
   if(!after||after.ino!==before.ino||after.size!==before.size||after.mtimeMs!==before.mtimeMs)continue;
   const current=await readFile(path,'utf8');if(JSON.stringify(JSON.parse(current))!==JSON.stringify(old))continue;
   await unlink(path).catch(e=>{if(e.code!=='ENOENT')throw e;});
  }
 }
 throw Error('Failed to obtain exclusive OSG graph writer lock: '+path);
}
export class OsgGraph{
 async open(source,dir){if(!source)throw Error('Set OSG_MULTI_SOURCE_DIR');await mkdir(dir,{recursive:true});
  const lock=await acquireGraphLock(dir);this.lock=lock.file;this.lockPath=lock.path;this.lockOwner=lock.owner;
  try{const root=resolve(source),core=await import(pathToFileURL(join(root,'dist/core/src/index.js'))),storage=await import(pathToFileURL(join(root,'dist/storage-lance/src/index.js')));
   this.core=core;this.store=await storage.openStore(join(dir,'graph'),true);const rows=await this.store.rows();core.verify(rows);this.view=await core.headView(this.store);return this;
  }catch(e){await this.close();throw e;}}
 get(id){const row=this.view.state.get(id);return row?decodeOsgProps(row.props):null;}
 async refresh(){this.view=await this.core.headView(this.store);return this.head;}
 get head(){return this.view.head;}
 async put(id,value){return this.putMany([{id,value}]);}
 putMany(entries){
  const op=(this.writeQueue??Promise.resolve()).then(()=>this._timedPut(entries));
  this.writeQueue=op.catch(()=>{});return op;
 }
 // A store write that never returns would block every later write, the ROD sync scan and the local
 // endpoint behind it. Give up on it after a limit, say so, and let the queue go on.
 async _timedPut(entries){
  const limit=this.writeTimeoutMs??30000,started=Date.now();let timer;
  const stalled=new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(Error('OSG_WRITE_STALLED'),{code:'OSG_WRITE_STALLED'})),limit);});
  const run=this._putMany(entries);run.catch(()=>{});
  try{return await Promise.race([run,stalled]);}
  catch(e){
   if(e.code==='OSG_WRITE_STALLED'){
    console.error('SPEXGSP_OSG_WRITE_STALLED '+JSON.stringify({ms:Date.now()-started,entries:entries.length,ids:entries.slice(0,4).map(x=>x.id)}));
    // Re-read the store head with its own limit; the stalled write may or may not have committed.
    let t2;try{await Promise.race([this.refresh(),new Promise((_,r)=>{t2=setTimeout(()=>r(Error('refresh timeout')),10000);t2.unref?.();})]);}catch{}finally{clearTimeout(t2);}
   }
   throw e;
  }finally{clearTimeout(timer);}
 }
 async _putMany(entries){
  if(!Array.isArray(entries)||entries.length<1||entries.length>1024)throw Error('invalid_osg_batch');
  const ids=new Set(),proposals=[],original=new Map();
  for(const {id,value} of entries){
   assertOsgElementId(id);if(ids.has(id))throw Error('invalid_osg_batch_id');ids.add(id);
   if(sameJSON(this.get(id),value))continue;
   original.set(id,value);
   proposals.push({element_id:id,kind:'demo_state',op:'assert',status:'hypothesis',props:encodeOsgProps(value),src:null,dst:null,predicate:null,extent:null,source_hash:null,valid_from:null,valid_to:null,observed_at:null});
  }
  if(!proposals.length)return this.head;
  try{await this.core.commit(this.store,proposals,'spexgsp-world','main',this.head,this.view);}
  catch(error){
   // The store may durably commit and then lose its acknowledgement (e.g.
   // LanceDB version-hint I/O). Re-read: only if every proposal is visible may
   // the ambiguous write be classified as successful.
   let recovered=null;
   try{recovered=await this.core.headView(this.store);}catch{} // Inconclusive recovery is an error.
   if(recovered){
    const complete=proposals.every(p=>{const row=recovered.state.get(p.element_id);
     return row&&sameJSON(decodeOsgProps(row.props),original.get(p.element_id));});
    if(complete){this.view=recovered;return this.head;}
   }
   throw error;
  }
  this.view=await this.core.headView(this.store);return this.head;
 }
 async close(){if(this.store){await this.store.close?.();this.store=null;}
  if(this.lock){await this.lock.close();this.lock=null;
   // Never delete a lock that has been replaced by a new process.
   try{const current=JSON.parse(await readFile(this.lockPath,'utf8'));
    if(current.nonce===this.lockOwner?.nonce&&current.pid===process.pid&&current.host===hostname())await unlink(this.lockPath);
   }catch(e){if(e.code!=='ENOENT')throw e;}
  }
 }
}
