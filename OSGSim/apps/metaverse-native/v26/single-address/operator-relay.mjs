// SPDX-License-Identifier: MIT
// Built-in Nostr relay (NIP-01 subset) that ships with SpeXGSP. Peers that run the simulation also run
// this relay, so the simulation depends on no third-party relay. It accepts only the kinds the simulation
// uses, verifies every signature, rate limits writers and keeps ephemeral frames out of storage.
import http from 'node:http';
import https from 'node:https';
import {createHash} from 'node:crypto';
import {mkdir,readFile,appendFile} from 'node:fs/promises';
import {atomicWriteFile} from '../fs-util.mjs';
import {dirname} from 'node:path';
import {verifyEvent} from './crypto.mjs';

// The only event kinds SpeXGSP publishes: OSG delta history, the live motion lane and peer advertisements.
export const RELAY_KINDS=Object.freeze([8427,21328,30328]);
const GUID='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const isEphemeral=k=>k>=20000&&k<30000;
const isParameterized=k=>k>=30000&&k<40000;

function frame(opcode,payload){
 const body=Buffer.isBuffer(payload)?payload:Buffer.from(payload);
 let header;
 if(body.length<126)header=Buffer.from([0x80|opcode,body.length]);
 else if(body.length<65536){header=Buffer.alloc(4);header[0]=0x80|opcode;header[1]=126;header.writeUInt16BE(body.length,2);}
 else{header=Buffer.alloc(10);header[0]=0x80|opcode;header[1]=127;header.writeBigUInt64BE(BigInt(body.length),2);}
 return Buffer.concat([header,body]);
}

export function matchesFilter(event,f){
 if(!f||typeof f!=='object')return false;
 if(f.ids&&!f.ids.includes(event.id))return false;
 if(f.authors&&!f.authors.includes(event.pubkey))return false;
 if(f.kinds&&!f.kinds.includes(event.kind))return false;
 if(Number.isSafeInteger(f.since)&&event.created_at<f.since)return false;
 if(Number.isSafeInteger(f.until)&&event.created_at>f.until)return false;
 for(const key of Object.keys(f)){
  if(key.length===2&&key[0]==='#'){
   const wanted=f[key];if(!Array.isArray(wanted))return false;
   if(!event.tags.some(t=>t[0]===key[1]&&wanted.includes(t[1])))return false;
  }
 }
 return true;
}
function validFilter(f){
 if(!f||typeof f!=='object'||Array.isArray(f))return false;
 for(const [k,v] of Object.entries(f)){
  if(['ids','authors'].includes(k)){if(!Array.isArray(v)||v.length>100||v.some(x=>typeof x!=='string'||x.length>64))return false;}
  else if(k==='kinds'){if(!Array.isArray(v)||v.length>20||v.some(x=>!Number.isSafeInteger(x)))return false;}
  else if(['since','until','limit'].includes(k)){if(!Number.isSafeInteger(v)||v<0)return false;}
  else if(k.length===2&&k[0]==='#'){if(!Array.isArray(v)||v.length>100||v.some(x=>typeof x!=='string'||x.length>256))return false;}
  else return false;
 }
 return true;
}

export class OperatorRelay{
 constructor({host='127.0.0.1',port=0,file=null,tls=null,now=Date.now,allowedKinds=RELAY_KINDS,maxEvents=50000,maxMessageBytes=524288,
  maxConnections=64,maxSubscriptions=20,eventsPerSecond=20,burst=60,maxPerAddress=8,maxBufferedBytes=4*1024*1024,pingMs=30000,onStatus=()=>{}}={}){
  Object.assign(this,{host,port,file,tls,now,maxEvents,maxMessageBytes,maxConnections,maxSubscriptions,eventsPerSecond,burst,maxPerAddress,maxBufferedBytes,pingMs,onStatus});
  this.allowed=new Set(allowedKinds);this.events=new Map();this.slots=new Map();this.clients=new Set();this.server=null;this.closed=false;this.counters={stored:0,rejected:0,broadcast:0};
 }
 get url(){const a=this.server?.address();return a?`${this.tls?'wss':'ws'}://${this.host.includes(':')?'['+this.host+']':this.host}:${a.port}/`:null;}
 /** URL for this machine's own peer. With TLS the certificate names the public host, not 127.0.0.1, so a second,
  * plain listener on loopback serves the local peer. */
 get localUrl(){if(this.loopbackServer)return`ws://127.0.0.1:${this.loopbackServer.address().port}/`;
  const u=this.url;return u&&!this.tls?u.replace('://0.0.0.0:','://127.0.0.1:').replace('://[::]:','://127.0.0.1:'):null;}
 async start(){
  if(this.file){
   await mkdir(dirname(this.file),{recursive:true});
   let raw='';try{raw=await readFile(this.file,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
   const lines=raw.split('\n').filter(Boolean);
   for(const line of lines){try{const e=JSON.parse(line);if(this.allowed.has(e.kind)&&!isEphemeral(e.kind)&&verifyEvent(e))this.insert(e);}catch{}}
   // The file only ever grows by appending; rewrite it with what is still held once at least half of it is stale.
   if(lines.length>1000&&lines.length>this.events.size*2){
    await atomicWriteFile(this.file,[...this.events.values()].map(e=>JSON.stringify(e)).join('\n')+(this.events.size?'\n':''));
    this.onStatus('OPERATOR_RELAY_COMPACTED',{before:lines.length,after:this.events.size});
   }
  }
  const handler=(req,res)=>{res.writeHead(426,{'content-type':'text/plain'});res.end('SpeXGSP relay: WebSocket only\n');};
  this.server=this.tls?https.createServer({cert:this.tls.cert,key:this.tls.key,minVersion:'TLSv1.2'},handler):http.createServer(handler);
  this.server.maxConnections=this.maxConnections*4;
  this.server.on('upgrade',(req,socket)=>this.upgrade(req,socket));
  await new Promise((ok,fail)=>{this.server.once('error',fail);this.server.listen(this.port,this.host,ok);});
  if(this.tls){
   this.loopbackServer=http.createServer(handler);this.loopbackServer.maxConnections=this.maxConnections*4;this.loopbackServer.on('upgrade',(req,socket)=>this.upgrade(req,socket));
   await new Promise((ok,fail)=>{this.loopbackServer.once('error',fail);this.loopbackServer.listen(0,'127.0.0.1',ok);});
  }
  // Dead connections (a closed laptop, a dropped NAT mapping) are found by ping: a client that answered nothing since the
  // previous round is dropped, so they do not use up the connection slots.
  if(this.pingMs>0){this.pinger=setInterval(()=>{for(const c of this.clients){if(!c.alive){c.socket.destroy();continue;}c.alive=false;if(!c.socket.destroyed)c.socket.write(frame(9,Buffer.alloc(0)));}},this.pingMs);this.pinger.unref?.();}
  this.onStatus('OPERATOR_RELAY_LISTENING',{url:this.url,stored:this.events.size});
  return this;
 }
 async close(){
  this.closed=true;clearInterval(this.pinger);for(const c of this.clients)c.socket.destroy();this.clients.clear();
  if(this.server)await new Promise(ok=>this.server.close(ok));
  if(this.loopbackServer)await new Promise(ok=>this.loopbackServer.close(ok));
 }
 upgrade(req,socket){
  const key=req.headers['sec-websocket-key'];
  const address=socket.remoteAddress??'';const loopback=address==='127.0.0.1'||address==='::1'||address==='::ffff:127.0.0.1';
  if(!loopback&&[...this.clients].filter(c=>c.address===address).length>=this.maxPerAddress){socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');return;}
  if(this.closed||this.clients.size>=this.maxConnections||req.headers.upgrade?.toLowerCase()!=='websocket'||typeof key!=='string'||req.headers['sec-websocket-version']!=='13'){
   socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');return;}
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+
   createHash('sha1').update(key+GUID).digest('base64')+'\r\n\r\n');
  socket.setNoDelay(true);
  const client={socket,address,alive:true,subs:new Map(),buffer:Buffer.alloc(0),fragments:[],fragmentBytes:0,bucket:this.burst,bucketAt:this.now()};
  this.clients.add(client);
  socket.on('data',chunk=>{client.alive=true;try{this.read(client,chunk);}catch{socket.destroy();}});
  socket.on('close',()=>this.clients.delete(client));socket.on('error',()=>socket.destroy());
 }
 read(client,chunk){
  client.buffer=Buffer.concat([client.buffer,chunk]);
  if(client.buffer.length>this.maxMessageBytes*2)throw Error('buffer_overflow');
  for(;;){
   const b=client.buffer;if(b.length<2)return;
   const fin=(b[0]&0x80)!==0,opcode=b[0]&0x0f,masked=(b[1]&0x80)!==0;let len=b[1]&0x7f,offset=2;
   if(!masked)throw Error('unmasked_client_frame');
   if(len===126){if(b.length<4)return;len=b.readUInt16BE(2);offset=4;}
   else if(len===127){if(b.length<10)return;const big=b.readBigUInt64BE(2);if(big>BigInt(this.maxMessageBytes))throw Error('frame_too_large');len=Number(big);offset=10;}
   if(len>this.maxMessageBytes)throw Error('frame_too_large');
   if(b.length<offset+4+len)return;
   const mask=b.subarray(offset,offset+4),payload=Buffer.from(b.subarray(offset+4,offset+4+len));
   for(let i=0;i<payload.length;i++)payload[i]^=mask[i&3];
   client.buffer=b.subarray(offset+4+len);
   if(opcode===8){client.socket.end(frame(8,Buffer.alloc(0)));return;}
   if(opcode===9){client.socket.write(frame(10,payload));continue;}
   if(opcode===10)continue;
   if(opcode===1||opcode===0){
    client.fragments.push(payload);client.fragmentBytes+=payload.length;
    if(client.fragmentBytes>this.maxMessageBytes)throw Error('message_too_large');
    if(fin){const text=Buffer.concat(client.fragments).toString('utf8');client.fragments=[];client.fragmentBytes=0;this.message(client,text);}
    continue;
   }
   throw Error('unsupported_opcode');
  }
 }
 send(client,value){
  if(client.socket.destroyed)return;
  // A reader that does not drain its socket must not make the relay buffer without limit.
  if(client.socket.writableLength>this.maxBufferedBytes){client.socket.destroy();return;}
  client.socket.write(frame(1,JSON.stringify(value)));
 }
 message(client,text){
  let m;try{m=JSON.parse(text);}catch{this.send(client,['NOTICE','invalid: not JSON']);return;}
  if(!Array.isArray(m)||typeof m[0]!=='string'){this.send(client,['NOTICE','invalid: message shape']);return;}
  if(m[0]==='EVENT')this.onEvent(client,m[1]);
  else if(m[0]==='REQ')this.onReq(client,m[1],m.slice(2));
  else if(m[0]==='CLOSE'&&typeof m[1]==='string')client.subs.delete(m[1]);
  else this.send(client,['NOTICE','unsupported: '+m[0].slice(0,20)]);
 }
 allow(client){
  const t=this.now();client.bucket=Math.min(this.burst,client.bucket+(t-client.bucketAt)/1000*this.eventsPerSecond);client.bucketAt=t;
  if(client.bucket<1)return false;client.bucket-=1;return true;
 }
 onEvent(client,event){
  const id=typeof event?.id==='string'?event.id:'';
  const no=reason=>{this.counters.rejected++;this.send(client,['OK',id,false,reason]);};
  if(!this.allow(client))return no('rate-limited: slow down');
  if(!event||typeof event!=='object'||!Array.isArray(event.tags)||typeof event.content!=='string')return no('invalid: malformed event');
  if(!this.allowed.has(event.kind))return no('blocked: kind not used by this simulation');
  if(event.content.length>this.maxMessageBytes)return no('invalid: content too large');
  // Stored history (e.g. kind 8427 batches) is legitimately old when republished; only ephemeral frames must be fresh.
  if(isEphemeral(event.kind)&&Math.abs(event.created_at*1000-this.now())>300e3)return no('invalid: ephemeral created_at out of range');
  if(event.created_at*1000>this.now()+600e3)return no('invalid: created_at in the future');
  if(!verifyEvent(event))return no('invalid: bad id or signature');
  if(this.events.has(event.id)){this.send(client,['OK',event.id,true,'duplicate: already have this event']);return;}
  if(!isEphemeral(event.kind)){
   const old=this.slots.get(this.slotKey(event));
   if(old&&(old.created_at>event.created_at||old.created_at===event.created_at&&old.id<event.id)){this.send(client,['OK',event.id,true,'duplicate: newer version stored']);return;}
   this.insert(event);this.counters.stored++;
   if(this.file)appendFile(this.file,JSON.stringify(event)+'\n',{mode:0o600}).catch(e=>this.onStatus('OPERATOR_RELAY_STORE_FAILED',{reason:e.message}));
  }
  this.send(client,['OK',event.id,true,'']);
  this.broadcast(event);
 }
 slotKey(e){
  if(isParameterized(e.kind))return e.pubkey+':'+e.kind+':'+(e.tags.find(t=>t[0]==='d')?.[1]??'');
  return null;
 }
 insert(event){
  const slot=this.slotKey(event);
  if(slot){const old=this.slots.get(slot);if(old)this.events.delete(old.id);this.slots.set(slot,event);}
  this.events.set(event.id,event);
  while(this.events.size>this.maxEvents){const first=this.events.keys().next().value;const e=this.events.get(first);this.events.delete(first);const k=this.slotKey(e);if(k&&this.slots.get(k)===e)this.slots.delete(k);}
 }
 onReq(client,id,filters){
  if(typeof id!=='string'||!id||id.length>64||!filters.length||filters.length>8||!filters.every(validFilter)){this.send(client,['CLOSED',typeof id==='string'?id:'','invalid: bad REQ']);return;}
  if(!client.subs.has(id)&&client.subs.size>=this.maxSubscriptions){this.send(client,['CLOSED',id,'rate-limited: too many subscriptions']);return;}
  client.subs.set(id,filters);
  const cap=1000;
  for(const f of filters){
   const limit=Math.min(f.limit??cap,cap);
   const matches=[...this.events.values()].filter(e=>matchesFilter(e,f)).sort((a,b)=>b.created_at-a.created_at||(a.id<b.id?-1:1)).slice(0,limit).reverse();
   for(const e of matches)this.send(client,['EVENT',id,e]);
  }
  this.send(client,['EOSE',id]);
 }
 broadcast(event){
  for(const c of this.clients)for(const [id,filters] of c.subs)if(filters.some(f=>matchesFilter(event,f))){this.send(c,['EVENT',id,event]);this.counters.broadcast++;}
 }
}

export {loadRelayTls} from './relay-cert.mjs';
