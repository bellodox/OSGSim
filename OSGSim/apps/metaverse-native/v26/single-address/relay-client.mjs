// SPDX-License-Identifier: MIT
// NIP-01 subscriptions, publication acknowledgements, NIP-42 AUTH, reconnect.
// Event delivery deduplication is per SUBSCRIPTION and per CONNECTION generation.
import {EventEmitter} from 'node:events';
import {randomBytes} from 'node:crypto';
import {signEvent,verifyEvent,publicKey} from './crypto.mjs';
const safe=x=>typeof x==='string'&&Buffer.byteLength(x)<=(256*1024);
const HEX64=/^[a-f0-9]{64}$/,HEX128=/^[a-f0-9]{128}$/;
const eventShape=e=>!!e&&typeof e==='object'&&HEX64.test(e.id??'')&&HEX64.test(e.pubkey??'')&&HEX128.test(e.sig??'')&&
 Number.isSafeInteger(e.kind)&&Number.isSafeInteger(e.created_at)&&Array.isArray(e.tags)&&typeof e.content==='string';
export class RelayClient extends EventEmitter{
 constructor({url,secret,WebSocketImpl=globalThis.WebSocket,reconnectMs=200,maxReconnectMs=8000,clock=()=>Date.now(),maxMessageBytes=256*1024}={}){
  super();if(!WebSocketImpl||!/^wss?:\/\//.test(url??''))throw Error('invalid_relay_url');
  this.url=new URL(url).toString();this.secret=secret;this.pubkey=publicKey(secret);this.WS=WebSocketImpl;this.reconnectMs=reconnectMs;this.maxReconnectMs=maxReconnectMs;this.clock=clock;this.maxMessageBytes=maxMessageBytes;
  this.ws=null;this.opened=false;this.closing=false;this.pending=new Map();this.subscriptions=new Map();this.reconnectTimer=null;this.retries=0;this.authChallenge=null;this.authEvents=new Set();this.generation=0;
 }
 async connect(timeoutMs=8000){if(this.closing)throw Error('relay_closed');if(this.opened)return;return new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>{cleanup();reject(Error('relay_connect_timeout'));},timeoutMs);
  const cleanup=()=>{clearTimeout(timer);this.off('open',good);this.off('fatal',bad)};
  const good=()=>{cleanup();resolve()};const bad=e=>{cleanup();reject(e)};this.once('open',good);this.once('fatal',bad);this._open();
 });}
 _resetSubscription(state){state.eose=false;state.error=null;for(const fn of state.waiters)fn(false);state.waiters.clear();}
 _open(){if(this.ws||this.closing)return;let ws;try{ws=new this.WS(this.url);}catch(e){this.emit('error-message',e.message);this._scheduleReconnect();return;}
  this.ws=ws;
  ws.addEventListener('open',()=>{
   if(this.ws!==ws||this.closing)return;this.opened=true;this.generation++;this.authChallenge=null;this.authEvents.clear();this.retries=0;
   for(const s of this.subscriptions.values()){this._resetSubscription(s);this._send(['REQ',s.id,...s.filters]);}
   for(const p of this.pending.values())this._send(['EVENT',p.event]);this.emit('open');
  });
  ws.addEventListener('message',m=>{if(this.ws!==ws)return;try{
   const raw=typeof m.data==='string'?m.data:String(m.data);if(!safe(raw)||Buffer.byteLength(raw)>this.maxMessageBytes)return;this._incoming(JSON.parse(raw));
  }catch(e){this.emit('error-message','relay_message_invalid_'+e.message)}});
  ws.addEventListener('error',()=>{});
  ws.addEventListener('close',()=>{if(this.ws!==ws)return;this.opened=false;this.ws=null;for(const s of this.subscriptions.values())this._resetSubscription(s);this.authChallenge=null;this.authEvents.clear();this.emit('disconnect');this._scheduleReconnect();});
 }
 _scheduleReconnect(){if(this.closing||this.reconnectTimer)return;const ms=Math.min(this.maxReconnectMs,this.reconnectMs*2**Math.min(this.retries++,8));this.reconnectTimer=setTimeout(()=>{this.reconnectTimer=null;this._open();},ms);this.reconnectTimer.unref?.();}
 _send(a){if(this.opened&&this.ws?.readyState===1){try{this.ws.send(JSON.stringify(a));return true;}catch{}}return false;}
 _settle(state,result){for(const fn of state.waiters)fn(result);state.waiters.clear();}
 _incoming(msg){if(!Array.isArray(msg)||msg.length<2||typeof msg[0]!=='string')return;const [type,id,value,...more]=msg;
  if(type==='EVENT'&&typeof id==='string'&&eventShape(value)){
   // Only a cheap shape check here. RelayPool runs the subscriber's prefilter, then verifies the signature and
   // de-duplicates by id, so a forged copy can neither cost a verification nor shadow the genuine event.
   if(Math.abs(value.created_at-Math.floor(this.clock()/1000))>86400*7)return;
   const s=this.subscriptions.get(id);if(!s)return;
   if(s.onEvent)try{s.onEvent(value);}catch(e){this.emit('error-message','subscriber_exception_'+e.message)}
  }else if(type==='EOSE'&&typeof id==='string'){
   const s=this.subscriptions.get(id);if(s){s.eose=true;this._settle(s,true);this.emit('eose',id)}
  }else if(type==='OK'&&typeof id==='string'){
   if(this.authEvents.has(id)){
    this.authEvents.delete(id);
    if(value===true){for(const s of this.subscriptions.values()){this._resetSubscription(s);this._send(['REQ',s.id,...s.filters]);}for(const p of this.pending.values())this._send(['EVENT',p.event]);}
    else this.emit('error-message','relay_auth_rejected_'+String(more[0]??'').slice(0,120));
    return;
   }
   const p=this.pending.get(id);
   if(p){const reason=String(more[0]??'');if(value===true||reason.startsWith('duplicate:')){this.pending.delete(id);clearTimeout(p.timer);p.resolve({id,accepted:true});}
    else if(reason.startsWith('auth-required:')&&this.authChallenge)this._auth(this.authChallenge);
    else{this.pending.delete(id);clearTimeout(p.timer);p.reject(Error('relay_rejected_'+reason.slice(0,150)));}
   }
  }else if(type==='CLOSED'&&typeof id==='string'){
   const sub=this.subscriptions.get(id);if(sub){const reason=String(value??'');this._resetSubscription(sub);
    if(reason.startsWith('auth-required:')&&this.authChallenge)this._auth(this.authChallenge);
    else{sub.error=reason;this.emit('error-message','relay_subscription_closed_'+id+':'+reason.slice(0,80));}
   }
  }else if(type==='AUTH'&&typeof id==='string'){
   this.authChallenge=id;this._auth(id);
  }else if(type==='NOTICE')this.emit('notice',String(id).slice(0,300));
 }
 _auth(challenge){if(!this.opened)return;const event=signEvent({secret:this.secret,kind:22242,content:'',tags:[['relay',this.url],['challenge',challenge]],createdAt:Math.floor(this.clock()/1000)});
  this.authEvents.add(event.id);this._send(['AUTH',event]);
 }
 subscribe(filters,onEvent,{id=randomBytes(10).toString('hex')}={}){
  if(!Array.isArray(filters)||!filters.length||filters.length>8||filters.some(x=>!x||typeof x!=='object'))throw Error('invalid_relay_filters');
  if(this.subscriptions.has(id))throw Error('duplicate_relay_subscription');
  const state={id,filters,onEvent,eose:false,error:null,waiters:new Set()};this.subscriptions.set(id,state);this._send(['REQ',id,...filters]);
  return{id,async eose(timeout=8000){if(state.eose)return true;if(state.error)return false;
   return await new Promise(resolve=>{let timer;const done=v=>{clearTimeout(timer);state.waiters.delete(done);resolve(v)};state.waiters.add(done);timer=setTimeout(()=>done(false),timeout)});
  },close:()=>{this.subscriptions.delete(id);this._send(['CLOSE',id]);this._settle(state,false)}};
 }
 async publish(event,{timeoutMs=8000}={}){
  if(!verifyEvent(event))throw Error('invalid_nostr_publish_event');if(this.closing)throw Error('relay_closed');
  if(this.pending.has(event.id))return this.pending.get(event.id).promise;
  let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});const timer=setTimeout(()=>{const p=this.pending.get(event.id);if(!p)return;this.pending.delete(event.id);reject(Error('relay_publish_timeout'));},timeoutMs);
  this.pending.set(event.id,{event,resolve,reject,timer,promise});this._send(['EVENT',event]);return promise;
 }
 async close(){if(this.closing)return;this.closing=true;this.opened=false;clearTimeout(this.reconnectTimer);for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('relay_closed'))}this.pending.clear();for(const s of this.subscriptions.values())this._settle(s,false);this.subscriptions.clear();const socket=this.ws;this.ws=null;try{socket?.close()}catch{}this.removeAllListeners();}
}
