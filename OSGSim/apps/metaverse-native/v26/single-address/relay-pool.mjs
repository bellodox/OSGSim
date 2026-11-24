// SPDX-License-Identifier: MIT
// NIP-01 multi-relay facade with outbound-only connectivity, failover, signed
// event-ID deduplication per logical subscription, all-relay history catch-up.
import {RelayClient} from './relay-client.mjs';
import {pinnedWebSocket} from './pinned-websocket.mjs';
import {verifyEvent,publicKey} from './crypto.mjs';
const validUrl=u=>{try{const x=new URL(u);return x.protocol==='wss:'||x.protocol==='ws:'&&['localhost','127.0.0.1','[::1]'].includes(x.hostname)}catch{return false}};
export class RelayPool{
 // pins: relay URL -> SHA-256 of the relay certificate's public key (from the ROD realm directory). A pinned relay is
 // trusted by that key alone, so a self-signed relay certificate works without a certificate authority.
 constructor({urls,secret,WebSocketImpl=globalThis.WebSocket,clock=Date.now,relayFactory=null,pins=null}={}){
  if(!Array.isArray(urls)||!urls.length||urls.length>10||urls.some(x=>!validUrl(x))||!secret)throw Error('invalid_relay_pool_configuration');
  this.pins=new Map([...(pins??[])].map(([u,p])=>[new URL(u).toString(),p]));this.pinned=new Map();this.secret=secret;this.pubkey=publicKey(secret);this.clock=clock;this.WebSocketImpl=WebSocketImpl;this.relayFactory=relayFactory;this.clients=new Map();this.subscriptions=new Set();this.closed=false;
  this.addRelays(urls,{connect:false});
 }
 get url(){return [...this.clients.keys()][0]}
 socketFor(url){const pin=this.pins.get(url);if(!pin)return this.WebSocketImpl;if(!this.pinned.has(pin))this.pinned.set(pin,pinnedWebSocket(pin));return this.pinned.get(pin);}
 addRelays(urls,{connect=true}={}){
  if(this.closed)throw Error('relay_pool_closed');
  if(!Array.isArray(urls)||urls.some(u=>!validUrl(u)))throw Error('invalid_signed_relay_hint');
  const unique=[...new Set(urls.map(x=>new URL(x).toString()))];
  if(this.clients.size+unique.filter(url=>!this.clients.has(url)).length>10)throw Error('relay_pool_maximum');
  const added=[];
  for(const url of unique){if(this.clients.has(url))continue;
   const client=this.relayFactory?this.relayFactory({url,secret:this.secret,clock:this.clock}):new RelayClient({url,secret:this.secret,WebSocketImpl:this.socketFor(url),clock:this.clock});
   this.clients.set(url,client);added.push(client);
   for(const logical of this.subscriptions)logical.add(client);
  }
  if(connect)for(const client of added)client.connect().catch(()=>{});
  return added.length;
 }
 async connect(timeoutMs=8000){if(this.closed)throw Error('relay_pool_closed');const results=await Promise.allSettled([...this.clients.values()].map(c=>c.connect(timeoutMs)));if(!results.some(x=>x.status==='fulfilled'))throw Error('all_nostr_relays_unavailable');}
 get connectedCount(){return [...this.clients.values()].filter(x=>x.opened).length;}
 // prefilter(event) runs BEFORE signature verification: a cheap predicate lets a
 // subscriber discard flood traffic without paying ~2 ms per forged event.
 subscribe(filters,onEvent,{id=null,prefilter=null}={}){
  if(this.closed)throw Error('relay_pool_closed');const seen=new Set(),handles=new Map(),logical={close(){for(const handle of handles.values())handle.close();handles.clear();},add(client){
   const handle=client.subscribe(filters,event=>{
    if(prefilter&&!prefilter(event))return;
    if(!verifyEvent(event)||seen.has(event.id))return;seen.add(event.id);if(seen.size>8192)seen.delete(seen.values().next().value);onEvent?.(event);
   },id?{id:id+'-'+handles.size}:{});handles.set(client,handle);
  }};
  this.subscriptions.add(logical);for(const client of this.clients.values())logical.add(client);
  return{async eose(timeoutMs=8000){const active=[...handles].filter(([client])=>client.opened).map(([,handle])=>handle);if(!active.length)return false;
   const outcomes=await Promise.all(active.map(h=>h.eose(timeoutMs).catch(()=>false)));return outcomes.some(Boolean);
  },close:()=>{this.subscriptions.delete(logical);logical.close();}};
 }
 async publish(event,options={}){
  if(this.closed)throw Error('relay_pool_closed');if(!verifyEvent(event))throw Error('invalid_nostr_publish_event');
  const live=[...this.clients.values()].filter(x=>x.opened);if(!live.length)throw Error('all_nostr_relays_disconnected');
  // Replicate unchanged signed ID to every relay; one positive ACK suffices for
  // availability, and failure on one cannot suppress a healthy alternate.
  // Return immediately after any relay acknowledges, without waiting for a
  // disconnected or slow secondary to exhaust its timeout. A background
  // Promise.allSettled consumes all remaining rejections safely.
  const deliveries=live.map(x=>x.publish(event,options));
  const settled=Promise.allSettled(deliveries);
  try{return await Promise.any(deliveries)}catch{await settled;throw Error('nostr_event_unacknowledged_on_all_relays')}
 }
 async close(){this.closed=true;for(const sub of this.subscriptions)sub.close();this.subscriptions.clear();await Promise.all([...this.clients.values()].map(c=>c.close()));this.clients.clear();}
}
