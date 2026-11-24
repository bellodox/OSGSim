// SPDX-License-Identifier: MIT
// Minimal WebSocket client (the subset RelayClient uses) that trusts one relay certificate key instead of a
// certificate authority. The expected key hash comes from the confirmed ROD realm directory. The connection is
// closed before any byte is sent unless the server's TLS certificate has exactly that public key.
import net from 'node:net';
import tls from 'node:tls';
import {createHash,randomBytes} from 'node:crypto';
import {spkiPin} from './relay-cert.mjs';

const GUID='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE=1024*1024,MAX_HEADER=16*1024;

export function pinnedWebSocket(pin,{connectTimeoutMs=10000}={}){
 if(!/^[a-f0-9]{64}$/.test(pin??''))throw Error('invalid_relay_pin');
 return class PinnedWebSocket{
  constructor(url){
   const u=new URL(url);if(u.protocol!=='wss:')throw Error('pinned_websocket_requires_wss');
   this.url=u.toString();this.readyState=0;this.listeners={open:[],message:[],error:[],close:[]};
   this.buffer=Buffer.alloc(0);this.fragments=[];this.fragmentBytes=0;this.upgraded=false;this.finished=false;
   const host=u.hostname.replace(/^\[|\]$/g,''),port=Number(u.port||443),key=randomBytes(16).toString('base64');
   const socket=this.socket=tls.connect({host,port,servername:net.isIP(host)?undefined:host,rejectUnauthorized:false,minVersion:'TLSv1.2'});
   socket.setNoDelay(true);
   this.timer=setTimeout(()=>this.fail('relay_connect_timeout'),connectTimeoutMs);this.timer.unref?.();
   socket.once('secureConnect',()=>{
    let ok=false;try{ok=spkiPin(socket.getPeerCertificate(true).raw)===pin;}catch{}
    if(!ok){this.fail('relay_certificate_pin_mismatch');return;}
    socket.write(`GET ${u.pathname||'/'} HTTP/1.1\r\nHost: ${u.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
   });
   socket.on('data',chunk=>{try{this.receive(chunk,key);}catch(e){this.fail(e.message);}});
   socket.on('error',e=>this.fail(e.message));
   socket.on('close',()=>this.finish());
  }
  addEventListener(type,fn){this.listeners[type]?.push(fn);}
  removeEventListener(type,fn){const l=this.listeners[type];if(l){const i=l.indexOf(fn);if(i>=0)l.splice(i,1);}}
  emit(type,event={}){for(const fn of [...(this.listeners[type]??[])])try{fn(event);}catch{}}
  fail(reason){if(this.finished)return;this.emit('error',{message:reason});this.socket.destroy();this.finish();}
  finish(){if(this.finished)return;this.finished=true;clearTimeout(this.timer);this.readyState=3;this.emit('close',{});}
  receive(chunk,key){
   this.buffer=Buffer.concat([this.buffer,chunk]);
   if(!this.upgraded){
    const end=this.buffer.indexOf('\r\n\r\n');
    if(end<0){if(this.buffer.length>MAX_HEADER)throw Error('relay_handshake_too_large');return;}
    const head=this.buffer.subarray(0,end).toString('latin1');this.buffer=this.buffer.subarray(end+4);
    const accept=/^sec-websocket-accept:\s*(.+)$/im.exec(head)?.[1]?.trim();
    if(!/^HTTP\/1\.1 101/.test(head)||accept!==createHash('sha1').update(key+GUID).digest('base64'))throw Error('relay_handshake_refused');
    this.upgraded=true;this.readyState=1;clearTimeout(this.timer);this.emit('open');
   }
   for(;;){
    const b=this.buffer;if(b.length<2)return;
    const fin=(b[0]&0x80)!==0,opcode=b[0]&0x0f,masked=(b[1]&0x80)!==0;let size=b[1]&0x7f,offset=2;
    if(size===126){if(b.length<4)return;size=b.readUInt16BE(2);offset=4;}
    else if(size===127){if(b.length<10)return;const big=b.readBigUInt64BE(2);if(big>BigInt(MAX_MESSAGE))throw Error('relay_frame_too_large');size=Number(big);offset=10;}
    if(size>MAX_MESSAGE)throw Error('relay_frame_too_large');
    if(b.length<offset+(masked?4:0)+size)return;
    let payload=Buffer.from(b.subarray(offset+(masked?4:0),offset+(masked?4:0)+size));
    if(masked){const mask=b.subarray(offset,offset+4);for(let i=0;i<payload.length;i++)payload[i]^=mask[i&3];}
    this.buffer=b.subarray(offset+(masked?4:0)+size);
    if(opcode===8){this.socket.end(this.frame(8,Buffer.alloc(0)));return;}
    if(opcode===9){this.socket.write(this.frame(10,payload));continue;}
    if(opcode===10)continue;
    if(opcode===1||opcode===0){
     this.fragments.push(payload);this.fragmentBytes+=payload.length;
     if(this.fragmentBytes>MAX_MESSAGE)throw Error('relay_message_too_large');
     if(fin){const data=Buffer.concat(this.fragments).toString('utf8');this.fragments=[];this.fragmentBytes=0;this.emit('message',{data});}
     continue;
    }
    if(opcode!==2)throw Error('relay_unsupported_opcode');
   }
  }
  frame(opcode,payload){
   const mask=randomBytes(4),n=payload.length;
   const head=n<126?Buffer.from([0x80|opcode,0x80|n]):n<65536?Buffer.from([0x80|opcode,0x80|126,n>>8,n&255]):(()=>{const h=Buffer.alloc(10);h[0]=0x80|opcode;h[1]=0x80|127;h.writeBigUInt64BE(BigInt(n),2);return h;})();
   const body=Buffer.from(payload);for(let i=0;i<body.length;i++)body[i]^=mask[i&3];
   return Buffer.concat([head,mask,body]);
  }
  send(data){
   if(this.readyState!==1)throw Error('relay_not_open');
   this.socket.write(this.frame(1,Buffer.from(String(data))));
  }
  close(){
   if(this.readyState>=2)return;
   this.readyState=2;try{this.socket.end(this.upgraded?this.frame(8,Buffer.alloc(0)):undefined);}catch{}
  }
 };
}

/** Try one pinned connection. Resolves {ok:true} when the relay answers the WebSocket handshake with the pinned key. */
export function probePinnedRelay(url,pin,timeoutMs=8000){
 return new Promise(resolve=>{
  let ws;const done=r=>{clearTimeout(timer);try{ws?.close();}catch{}resolve(r);};
  const timer=setTimeout(()=>done({ok:false,reason:'timeout'}),timeoutMs);
  try{ws=new (pinnedWebSocket(pin,{connectTimeoutMs:timeoutMs}))(url);}catch(e){done({ok:false,reason:e.message});return;}
  ws.addEventListener('open',()=>done({ok:true}));
  ws.addEventListener('error',e=>done({ok:false,reason:e.message}));
  ws.addEventListener('close',()=>done({ok:false,reason:'closed'}));
 });
}
