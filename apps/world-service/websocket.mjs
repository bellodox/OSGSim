// SPDX-License-Identifier: MIT
import {createHash} from 'node:crypto';
const MAX_FRAME=64*1024,MAX_PEERS=64;
export function wsEncode(text,opcode=1){
 const bytes=Buffer.isBuffer(text)?text:Buffer.from(text),n=bytes.length;
 if(n>MAX_FRAME)throw Error('oversized websocket outbound message');
 let hdr;
 if(n<126)hdr=Buffer.from([0x80|opcode,n]);
 else if(n<65536){hdr=Buffer.alloc(4);hdr[0]=0x80|opcode;hdr[1]=126;hdr.writeUInt16BE(n,2);}
 else{hdr=Buffer.alloc(10);hdr[0]=0x80|opcode;hdr[1]=127;hdr.writeBigUInt64BE(BigInt(n),2);}
 return Buffer.concat([hdr,bytes]);
}
export function sendFrame(socket,payload,opcode=1){
 if(socket.destroyed)return false;
 // This is a live feed: disconnect slow readers; they reconnect to a fresh snapshot.
 if(socket.writableNeedDrain){socket.destroy();return false;}
 try{if(!socket.write(wsEncode(payload,opcode))){socket.destroy();return false;}return true;}
 catch{socket.destroy();return false;}
}
export function wsUpgrade(req,socket,peers,head=Buffer.alloc(0)){
 const reject=()=>{socket.destroy();return false;};
 if(peers.size>=MAX_PEERS||req.method!=='GET')return reject();
 if(req.headers.origin){try{
  const u=new URL(req.headers.origin);
  if(u.origin!==`http://${req.headers.host}`)return reject();
 }catch{return reject();}}
 const key=req.headers['sec-websocket-key'];
 if(req.headers.upgrade?.toLowerCase()!=='websocket'||req.headers['sec-websocket-version']!=='13'||
  !req.headers.connection?.toLowerCase().split(/\s*,\s*/).includes('upgrade')||
  typeof key!=='string'||!/^[A-Za-z0-9+/]{22}==$/.test(key)||Buffer.from(key,'base64').toString('base64')!==key)return reject();
 const accept=createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
 socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
 socket.setNoDelay(true);peers.add(socket);
 let buffered=Buffer.alloc(0);
 function consume(chunk){
  buffered=Buffer.concat([buffered,chunk]);
  if(buffered.length>MAX_FRAME){socket.destroy();return;}
  while(buffered.length>=2){
   const first=buffered[0],second=buffered[1],op=first&15,n=second&127;
   // Only masked, final, bounded control frames are accepted on this read-only channel.
   if((first&0x70)||!(first&0x80)||!(second&0x80)||![8,9,10].includes(op)||n>125||(op===8&&n===1)){socket.destroy();return;}
   if(buffered.length<6+n)return;
   const payload=Buffer.from(buffered.subarray(6,6+n));
   for(let i=0;i<n;i++)payload[i]^=buffered[2+i%4];
   buffered=buffered.subarray(6+n);
   if(op===9)sendFrame(socket,payload,10);
   if(op===8){socket.end(wsEncode(Buffer.alloc(0),8));return;}
  }
 }
 socket.on('data',consume);
 socket.on('close',()=>peers.delete(socket));socket.on('error',()=>{peers.delete(socket);socket.destroy();});
 if(head.length)consume(head);
 return !socket.destroyed;
}
