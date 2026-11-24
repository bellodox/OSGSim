// SPDX-License-Identifier: MIT
// Test-only actual TCP/WebSocket NIP-01 relay. No npm/server dependency.
// Supports REQ, EOSE, EVENT/OK, CLOSE, durable storage, ephemeral delivery.
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {verifyEvent} from '../../OSGSim/apps/metaverse-native/v26/single-address/crypto.mjs';
const MAGIC='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
function frame(value){
 const data=Buffer.from(JSON.stringify(value));let header;
 if(data.length<126)header=Buffer.from([0x81,data.length]);
 else if(data.length<65536){header=Buffer.alloc(4);header[0]=0x81;header[1]=126;header.writeUInt16BE(data.length,2);}
 else{header=Buffer.alloc(10);header[0]=0x81;header[1]=127;header.writeBigUInt64BE(BigInt(data.length),2)}
 return Buffer.concat([header,data]);
}
function matches(filter,event){
 for(const key of ['kinds','authors','ids']){
  if(!filter[key])continue;
  const value=key==='kinds'?event.kind:key==='authors'?event.pubkey:event.id;
  if(!filter[key].includes(value))return false;
 }
 for(const [key,values] of Object.entries(filter)){
  if(!key.startsWith('#'))continue;
  if(!event.tags.some(tag=>tag[0]===key.slice(1)&&values.includes(tag[1])))return false;
 }
 return (!Number.isSafeInteger(filter.since)||event.created_at>=filter.since)&&
        (!Number.isSafeInteger(filter.until)||event.created_at<=filter.until);
}
export async function startNip01LoopbackRelay({stored=[],onPublish=null}={}){
 const server=createServer((request,response)=>response.writeHead(404).end());
 const clients=new Set(),history=[...stored],received=[],acknowledgements=[];
 let online=true;
 server.on('upgrade',(request,socket)=>{
  if(!online){socket.destroy();return;}
  const key=request.headers['sec-websocket-key'];if(typeof key!=='string'){socket.destroy();return;}
  const accept=createHash('sha1').update(key+MAGIC).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const peer={socket,filters:new Map(),send(value){if(!socket.destroyed)socket.write(frame(value));}};
  clients.add(peer);socket.on('close',()=>clients.delete(peer));socket.on('error',()=>{});
  let buffer=Buffer.alloc(0);
  socket.on('data',data=>{
   buffer=Buffer.concat([buffer,data]);if(buffer.length>1024*1024){socket.destroy();return;}
   while(buffer.length>=6){
    const op=buffer[0]&15;
    let length=buffer[1]&127,offset=2;
    if(length===126){if(buffer.length<4)break;length=buffer.readUInt16BE(2);offset=4;}
    if(length===127){if(buffer.length<10)break;const n=buffer.readBigUInt64BE(2);if(n>1000000n){socket.destroy();return;}length=Number(n);offset=10;}
    if(!(buffer[1]&128)){socket.destroy();return;}
    if(buffer.length<offset+4+length)break;
    const mask=buffer.subarray(offset,offset+4),body=Buffer.from(buffer.subarray(offset+4,offset+4+length));
    buffer=buffer.subarray(offset+4+length);
    for(let i=0;i<length;i++)body[i]^=mask[i%4];
    if(op===8){socket.destroy();return;}
    if(op!==1)continue;
    let msg;try{msg=JSON.parse(body.toString('utf8'))}catch{continue}
    if(!Array.isArray(msg))continue;
    const [verb,id]=msg;
    if(verb==='REQ'&&typeof id==='string'){
     const filters=msg.slice(2);peer.filters.set(id,filters);
     const eligible=history.filter(ev=>filters.some(f=>matches(f,ev)));
     const limit=Math.max(0,Math.min(...filters.map(f=>f.limit??500),500));
     for(const ev of eligible.slice(-limit))peer.send(['EVENT',id,ev]);
     peer.send(['EOSE',id]);
    }else if(verb==='CLOSE')peer.filters.delete(id);
    else if(verb==='EVENT'){
     const ev=id;
     if(!verifyEvent(ev)){peer.send(['OK',ev?.id??'bad',false,'invalid: signature']);continue;}
     const isDuplicate=received.some(old=>old.id===ev.id);
     if(!isDuplicate){received.push(ev);if(!(ev.kind>=20000&&ev.kind<30000))history.push(ev);
      for(const other of clients)for(const [sub,filters]of other.filters){
       if(filters.some(f=>matches(f,ev)))other.send(['EVENT',sub,ev]);
      }
     }
     const acknowledged=onPublish?onPublish(ev)!==false:true;
     if(acknowledged){peer.send(['OK',ev.id,true,isDuplicate?'duplicate: already present':'']);acknowledgements.push(ev.id);}
    }
   }
  });
 });
 server.listen(0,'127.0.0.1');await once(server,'listening');
 return {url:`ws://127.0.0.1:${server.address().port}/`,history,received,acknowledgements,
  dropConnections(){for(const peer of clients)peer.socket.destroy();},
  async close(){online=false;for(const peer of clients)peer.socket.destroy();await new Promise(resolve=>server.close(resolve));}};
}
