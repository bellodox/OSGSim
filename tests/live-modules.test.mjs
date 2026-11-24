// SPDX-License-Identifier: MIT
// Live-module tests carried over from removed legacy test files (crypto, resolver, relay client/pool, NTP).
import test from 'node:test';
import assert from 'node:assert/strict';
import {schnorrSign,schnorrVerify,publicKey,signEvent,verifyEvent} from '../OSGSim/apps/metaverse-native/v26/single-address/crypto.mjs';
import {parseRelayAddress,seedRelays,getRodDirectory} from '../OSGSim/apps/metaverse-native/v26/single-address/resolver.mjs';
import {RelayClient} from '../OSGSim/apps/metaverse-native/v26/single-address/relay-client.mjs';
import {RelayPool} from '../OSGSim/apps/metaverse-native/v26/single-address/relay-pool.mjs';
import {assertRodMainnetInfo} from '../OSGSim/apps/metaverse-native/v26/single-address/network-policy.mjs';
import {disciplineBootstrapClock} from '../OSGSim/apps/metaverse-native/v26/single-address/bootstrap-clock.mjs';
import {WorldClock} from '../OSGSim/apps/metaverse-native/v26/world-time.mjs';
import {mainnetInfo,mainnetNetwork} from './mainnet-fixture.mjs';
const a='0'.repeat(63)+'3',b='0'.repeat(63)+'4',world='1'.repeat(64),genesis='2'.repeat(64),assets='3'.repeat(64);
const pubA=publicKey(a),pubB=publicKey(b);
const directory={schema:'spexgsp/realm/1',realmId:'moon/default',ownerAddress:'rOwnerA',publisher:pubA,worldId:world,assetRoot:assets,rodGenesis:genesis,era:1};
const secret='0'.repeat(63)+'3';

const clock={schema:1,simMjd0:51982.13,utcOriginMs:1700000000000,rate:1,era:1};
test('BIP340 independently matches official known valid and invalid signatures',()=>{
 const msg=Buffer.alloc(32),expected='e907831f80848d1069a5371b402410364bdf1c5f8307b0084c55f1ce2dca821525f66a4a85ea8b71e482a74f382d2ce5ebeee8fdb2172f477df4900d310536c0';
 assert.equal(schnorrSign(msg,a),expected);assert.ok(schnorrVerify(msg,pubA,expected));assert.ok(!schnorrVerify(Buffer.alloc(32,1),pubA,expected));
 assert.equal(schnorrSign(Buffer.alloc(32),b).length,128);
});

test('Nostr event signatures detect message, tag and sender spoofing',()=>{
 const e=signEvent({secret:a,kind:30326,content:'{}',tags:[['t','spexgsp-world']]});assert.ok(verifyEvent(e));assert.equal(verifyEvent({...e,content:'hacked'}),false);assert.equal(verifyEvent({...e,pubkey:pubB}),false);assert.equal(verifyEvent({...e,created_at:e.created_at+1}),false);
});

test('One-address locator accepts IP and .rod, rejects URL tricks and insecure fallbacks',()=>{
 assert.deepEqual(parseRelayAddress('203.0.113.42').urls,['wss://203.0.113.42/']);
 assert.deepEqual(parseRelayAddress('[2001:db8::12]').urls,['wss://[2001:db8::12]/']);
 assert.deepEqual(parseRelayAddress('example.rod'),{kind:'rod',name:'example'});
 for(const bad of ['http://127.0.0.1','user:pass@relay','relay.example.com','example.com','203.0.113.42/path','wss://user:pw@127.0.0.1','127.0.0.1:99999'])assert.throws(()=>parseRelayAddress(bad));
});

test('Application .rod resolution reads the ROD name/value DB, not ordinary DNS',async()=>{
 const rpc=async (method,args=[])=>{const [name]=args;if(method==='getnetworkinfo')return mainnetNetwork();
  if(method==='getblockchaininfo')return mainnetInfo(80);assert.equal(method,'name_show');assert.equal(name,'d/example');return{address:'rNameOwner',txid:'a'.repeat(64),height:44,value:JSON.stringify({svc:{nostr:['wss://203.0.113.42/']}})}};
 assert.deepEqual(await seedRelays('example.rod',rpc),['wss://203.0.113.42/']);
});

test('ROD directory requires confirmed name owner, matching chain and publisher',async()=>{
 const record={name:'spexgsp/universe/default',address:directory.ownerAddress,txid:'a'.repeat(64),height:42,ismine:false,value:JSON.stringify(directory)};
 const rpc=async method=>method==='name_show'?record:method==='getnetworkinfo'?mainnetNetwork():method==='getblockchaininfo'?mainnetInfo(44):genesis;
 assert.equal((await getRodDirectory(rpc)).directory.publisher,pubA);
 await assert.rejects(getRodDirectory(async method=>method==='name_show'?{...record,address:'rOther'}:method==='getnetworkinfo'?mainnetNetwork():method==='getblockchaininfo'?mainnetInfo(44):genesis),/owner/);
 await assert.rejects(getRodDirectory(async method=>method==='name_show'?record:method==='getnetworkinfo'?mainnetNetwork():method==='getblockchaininfo'?mainnetInfo(40):genesis),/not_confirmed/);
});

test('F04: each overlapping subscription gets a signed event once; a forged copy first cannot shadow it',async()=>{
 const delivered=[];
 const fake={opened:true,subscribe(filters,onEvent){delivered.push(onEvent);return{close(){},eose:async()=>true};},connect:async()=>{},close:async()=>{}};
 const pool=new RelayPool({urls:['wss://relay.example.test/'],secret,relayFactory:()=>fake});
 let a=0,b=0;const e=signEvent({secret,kind:30328,content:'{}'});
 pool.subscribe([{kinds:[30328]}],()=>a++);pool.subscribe([{kinds:[30328]}],()=>b++,{prefilter:()=>true});
 const forged={...e,sig:'0'.repeat(128)};
 for(const deliver of delivered){deliver(forged);deliver(e);deliver(e);}
 assert.deepEqual([a,b],[1,1]);
 const rejected=[];pool.subscribe([{kinds:[30328]}],()=>{},{prefilter:x=>{rejected.push(x.id);return false;}});
 delivered.at(-1)({...e,id:'f'.repeat(64)});assert.equal(rejected.length,1,'prefilter runs before signature verification');
 await pool.close();
});

test('F05: EOSE status is reset for a new physical WebSocket generation',async()=>{
 let sockets=0;class FakeSocket{
  constructor(){this.number=++sockets;this.readyState=0;this.listeners=new Map();queueMicrotask(()=>{this.readyState=1;this.emit('open',{})});}
  addEventListener(type,fn){const l=this.listeners.get(type)??[];l.push(fn);this.listeners.set(type,l)}
  emit(type,x){for(const cb of this.listeners.get(type)??[])cb(x)}
  send(json){const data=JSON.parse(json);if(data[0]==='REQ'&&this.number===1)this.emit('message',{data:JSON.stringify(['EOSE',data[1]])});}
  close(){this.readyState=3;this.emit('close',{})}
 }
 const client=new RelayClient({url:'wss://relay.example.test/',secret,WebSocketImpl:FakeSocket,reconnectMs:10,maxReconnectMs:30});
 await client.connect();const sub=client.subscribe([{kinds:[30326]}],()=>{});assert.equal(await sub.eose(50),true);
 client.ws.close();await new Promise(ok=>setTimeout(ok,65));assert.equal(client.opened,true);assert.ok(sockets>=2);
 assert.equal(await sub.eose(25),false);sub.close();await client.close();
});

test('F09: isolated/stale/behind ROD mainnet is rejected even if chain is main',()=>{
 assert.throws(()=>assertRodMainnetInfo({...mainnetInfo(100),headers:800000,verificationprogress:0.0001}),/HEADERS_NOT_CAUGHT_UP/);
 assert.throws(()=>assertRodMainnetInfo({...mainnetInfo(100),mediantime:1000}),/STALE/);
 assert.doesNotThrow(()=>assertRodMainnetInfo(mainnetInfo(500000)));
});

test('F08: two agreeing NTP sources remove local clock skew before announcement validation',async()=>{
 const now=Date.now(),cal=await disciplineBootstrapClock(['alpha','beta'],{now:()=>now-120000,query:async host=>({host,offsetMs:120000+(host==='alpha'?0:5),uncertaintyMs:3})});
 assert.ok(Math.abs(cal.clock()-now)<1000);assert.equal(cal.sources.length,2);
 await assert.rejects(disciplineBootstrapClock(['alpha','beta'],{query:async host=>({host,offsetMs:host==='alpha'?0:800000,uncertaintyMs:3})}),/sources_disagree/);
});

test('F10: signed multi-relay hints allow continuing when first relay is unreachable',async()=>{
 const signer='0'.repeat(63)+'4';
 class FakeSocket{
  constructor(url){this.url=url;this.readyState=0;this.listeners=new Map();if(url.includes('healthy'))queueMicrotask(()=>{this.readyState=1;this.emit('open',{})});}
  addEventListener(t,fn){const set=this.listeners.get(t)??[];set.push(fn);this.listeners.set(t,set)}
  emit(t,data){for(const cb of this.listeners.get(t)??[])cb(data)}
  send(json){const m=JSON.parse(json);if(m[0]==='REQ')queueMicrotask(()=>this.emit('message',{data:JSON.stringify(['EOSE',m[1]])}));
   if(m[0]==='EVENT')queueMicrotask(()=>this.emit('message',{data:JSON.stringify(['OK',m[1].id,true,''])}));}
  close(){this.readyState=3;this.emit('close',{})}
 }
 const pool=new RelayPool({urls:['wss://unreachable.test/','wss://healthy.test/'],secret,WebSocketImpl:FakeSocket});
 try{await pool.connect(70);assert.equal(pool.connectedCount,1);
  const s=pool.subscribe([{kinds:[30326]}],()=>{});assert.equal(await s.eose(80),true);
  const event=signEvent({secret:signer,kind:30326,content:'hello'});
  const reply=await pool.publish(event,{timeoutMs:90});assert.equal(reply.accepted,true);s.close();
 }finally{await pool.close()}
});



test('RelayPool rejects invalid multi-relay hint sets atomically',async()=>{
 const pool=new RelayPool({urls:['wss://relay-a.example.test/'],secret,clock:()=>Date.now(),WebSocketImpl:class{}});
 try{
  assert.throws(()=>pool.addRelays(['wss://relay-b.example.test/','ws://insecure.example.test/']),/invalid_signed_relay_hint/);
  assert.equal(pool.clients.size,1);
  assert.throws(()=>pool.addRelays(Array.from({length:11},(_,i)=>`wss://relay${i}.example.test/`)),/relay_pool_maximum/);
  assert.equal(pool.clients.size,1);
 }finally{await pool.close()}
});


test('RelayPool accepts publication on healthy relay without waiting for stalled secondary',async()=>{
 const clock=()=>Date.now();const good={opened:true,async publish(){return{accepted:true,id:'good'}},async close(){}};
 const bad={opened:true,async publish(){await new Promise(r=>setTimeout(r,140));throw Error('slow_second_relay_unavailable')},async close(){}};
 const pool=new RelayPool({urls:['wss://good.example.test/','wss://bad.example.test/'],secret,clock,relayFactory:({url})=>url.includes('good.')?good:bad});
 try{const start=Date.now();const event=signEvent({secret,kind:30326,content:'{ "hello": "world" }'});
  const result=await pool.publish(event,{timeoutMs:500});assert.equal(result.accepted,true);assert.ok(Date.now()-start<120);
 }finally{await pool.close()}
});

test('NTP calibration refuses two contradictory servers even if one is low-latency',async()=>{const c=new WorldClock(clock,{nowMono:()=>10,nowWall:()=>clock.utcOriginMs});await assert.rejects(c.calibrateFromPool(['a','b'],{query:async h=>({host:h,offsetMs:h==='a'?0:500,uncertaintyMs:2})}),/ntp_sources_disagree/);await c.calibrateFromPool(['a','b'],{query:async h=>({host:h,offsetMs:h==='a'?1:3,uncertaintyMs:2})});assert.ok(c.requireReady().ready);});
