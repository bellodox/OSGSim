import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {OperatorRelay,RELAY_KINDS} from '../OSGSim/apps/metaverse-native/v26/single-address/operator-relay.mjs';
import {RelayPool} from '../OSGSim/apps/metaverse-native/v26/single-address/relay-pool.mjs';
import {generateSecret,signEvent} from '../OSGSim/apps/metaverse-native/v26/single-address/crypto.mjs';
import {bootstrapRelays} from '../OSGSim/apps/metaverse-native/v26/single-address/universe-catalog.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,ms=3000)=>{const t=Date.now();while(Date.now()-t<ms){if(fn())return true;await sleep(20);}return false;};
async function setup(options={}){
 const dir=await mkdtemp(join(tmpdir(),'spex-relay-'));
 const relay=await new OperatorRelay({file:join(dir,'events.jsonl'),...options}).start();
 return{dir,relay};
}
const pool=(relay,secret=generateSecret())=>new RelayPool({urls:[relay.url],secret});

test('a RelayPool publishes to and reads from the built-in relay',async()=>{
 const {relay}=await setup();const a=pool(relay),b=pool(relay);
 try{
  await a.connect();await b.connect();
  const got=[];b.subscribe([{kinds:[8427],'#w':['w1']}],e=>got.push(e));await sleep(100);
  const event=signEvent({secret:generateSecret(),kind:8427,tags:[['w','w1']],content:'hello'});
  await a.publish(event);
  assert.equal(await until(()=>got.length===1),true);assert.equal(got[0].id,event.id);
  // late subscriber receives stored history, then EOSE
  const late=[];const sub=b.subscribe([{kinds:[8427]}],e=>late.push(e));assert.equal(await sub.eose(2000),true);assert.equal(late.length,1);
 }finally{await a.close();await b.close();await relay.close();}
});

test('large events (extended frame length) round-trip',async()=>{
 const {relay}=await setup();const a=pool(relay),b=pool(relay);
 try{
  await a.connect();await b.connect();const got=[];b.subscribe([{kinds:[8427]}],e=>got.push(e));await sleep(100);
  const event=signEvent({secret:generateSecret(),kind:8427,content:'x'.repeat(100000)});await a.publish(event);
  assert.equal(await until(()=>got.length===1),true);assert.equal(got[0].content.length,100000);
 }finally{await a.close();await b.close();await relay.close();}
});

test('ephemeral frames are forwarded but never stored',async()=>{
 const {relay}=await setup();const a=pool(relay),b=pool(relay);
 try{
  await a.connect();await b.connect();const got=[];b.subscribe([{kinds:[21328]}],e=>got.push(e));await sleep(100);
  await a.publish(signEvent({secret:generateSecret(),kind:21328,tags:[['w','x']],content:'{}'}));
  assert.equal(await until(()=>got.length===1),true);
  const late=[];const sub=b.subscribe([{kinds:[21328]}],e=>late.push(e));await sub.eose(2000);assert.equal(late.length,0);
 }finally{await a.close();await b.close();await relay.close();}
});

test('kinds the simulation does not use, forged events and floods are rejected',async()=>{
 const {relay}=await setup({burst:5,eventsPerSecond:1});
 const ws=new WebSocket(relay.url);const replies=[];
 ws.onmessage=m=>replies.push(JSON.parse(m.data));await new Promise((ok,fail)=>{ws.onopen=ok;ws.onerror=fail;});
 try{
  const secret=generateSecret(),send=e=>ws.send(JSON.stringify(['EVENT',e]));
  const note=signEvent({secret,kind:1,content:'note'});send(note);
  const good=signEvent({secret,kind:8427,content:'{}'});send({...good,content:'tampered'});
  for(let i=0;i<12;i++)send(signEvent({secret,kind:8427,content:String(i)}));
  assert.equal(await until(()=>replies.length>=14),true);
  const ok=replies.filter(r=>r[0]==='OK');
  assert.match(ok.find(r=>r[1]===note.id)[3],/^blocked/);
  assert.match(ok.find(r=>r[1]===good.id)[3],/^invalid/);
  assert.ok(ok.some(r=>r[2]===false&&/^rate-limited/.test(r[3])),'writer rate limit applies');
  assert.equal(RELAY_KINDS.includes(1),false);
 }finally{ws.close();await relay.close();}
});

test('parameterized replaceable events keep only the newest per d tag, and storage survives a restart',async()=>{
 const {dir,relay}=await setup();const a=pool(relay);const secret=generateSecret();
 try{
  await a.connect();const base=Math.floor(Date.now()/1000);
  await a.publish(signEvent({secret,kind:30328,tags:[['d','peer']],content:'old',createdAt:base-10}));
  await a.publish(signEvent({secret,kind:30328,tags:[['d','peer']],content:'new',createdAt:base}));
  await a.publish(signEvent({secret,kind:30328,tags:[['d','peer']],content:'older',createdAt:base-20}));
  const seen=[];const sub=a.subscribe([{kinds:[30328]}],e=>seen.push(e.content));await sub.eose(2000);assert.deepEqual(seen,['new']);
 }finally{await a.close();await relay.close();}
 const again=await new OperatorRelay({file:join(dir,'events.jsonl')}).start();const b=pool(again);
 try{await b.connect();const seen=[];const sub=b.subscribe([{kinds:[30328]}],e=>seen.push(e.content));await sub.eose(2000);assert.deepEqual(seen,['new']);}
 finally{await b.close();await again.close();}
 assert.ok((await readFile(join(dir,'events.jsonl'),'utf8')).includes('"new"'));
});

test('old stored history (kind 8427) is accepted when republished',async()=>{
 const {relay}=await setup();const a=pool(relay);
 try{await a.connect();await a.publish(signEvent({secret:generateSecret(),kind:8427,content:'old',createdAt:Math.floor(Date.now()/1000)-86400*30}));}
 finally{await a.close();await relay.close();}
});

test('bootstrapRelays uses only the built-in relay and operator relays; no public relay is bundled',async()=>{
 const root=await mkdtemp(join(tmpdir(),'spex-boot-'));
 const bundled=JSON.parse(await readFile(new URL('../OSGSim/bootstrap-relays.json',import.meta.url),'utf8'));
 assert.deepEqual(bundled.relays,[]);
 const read=async()=>JSON.stringify({schema:1,relays:[]});
 assert.deepEqual(await bootstrapRelays({root,readConfig:read,localRelays:['ws://127.0.0.1:7447/']}),['ws://127.0.0.1:7447/']);
 await assert.rejects(bootstrapRelays({root,readConfig:read}),/NO_OPERATOR_RELAY_CONFIGURED/);
 const op=async()=>JSON.stringify({schema:1,relays:['wss://relay.operator.example/']});
 assert.deepEqual(await bootstrapRelays({root,readConfig:op,localRelays:['ws://127.0.0.1:7447/']}),['ws://127.0.0.1:7447/','wss://relay.operator.example/']);
 await assert.rejects(bootstrapRelays({root,readConfig:read,localRelays:['ws://example.com:7447/']}),/invalid_local_relay_url/);
});

// ---- peers find each other through the relays the universe owner lists on ROD ----
const GENESIS='1'.repeat(64),OWNER='rFJtzkbeQ3dxWQg9G82LHMsPvrhSLMarJU';
const rodStub=(relays,{record=true}={})=>async method=>{
 if(method==='getblockchaininfo')return{chain:'main',blocks:100,headers:100,verificationprogress:1,mediantime:Math.floor(Date.now()/1000),initialblockdownload:false};
 if(method==='getblockhash')return GENESIS;
 if(method==='name_show'){
  if(!record)throw Error('name not found');
  return{address:OWNER,txid:'2'.repeat(64),height:50,value:JSON.stringify({schema:'spexgsp/realm/1',realmId:'spexgsp:default',ownerAddress:OWNER,
   publisher:'3'.repeat(64),worldId:'4'.repeat(64),assetRoot:'5'.repeat(64),rodGenesis:GENESIS,era:1,...(relays?{relays}:{})})};
 }
 throw Error('unexpected '+method);
};

test('two peers with only their own relay find each other through the owner-listed relay on ROD',async()=>{
 const shared=await setup(),peerA=await setup(),peerB=await setup();
 const root=await mkdtemp(join(tmpdir(),'spex-find-'));const empty=async()=>JSON.stringify({schema:1,relays:[]});
 const rpc=rodStub([shared.relay.url]);
 const urlsA=await bootstrapRelays({root,readConfig:empty,rpc,localRelays:[peerA.relay.url],realmName:'spexgsp/universe/default',allowLocalWs:true});
 const urlsB=await bootstrapRelays({root,readConfig:empty,rpc,localRelays:[peerB.relay.url],realmName:'spexgsp/universe/default',allowLocalWs:true});
 assert.deepEqual(urlsA,[peerA.relay.url,shared.relay.url]);assert.deepEqual(urlsB,[peerB.relay.url,shared.relay.url]);
 const a=new RelayPool({urls:urlsA,secret:generateSecret()}),b=new RelayPool({urls:urlsB,secret:generateSecret()});
 try{
  await a.connect();await b.connect();const got=[];b.subscribe([{kinds:[30328]}],e=>got.push(e));await sleep(150);
  const advert=signEvent({secret:generateSecret(),kind:30328,tags:[['d','peerA']],content:'{"peer":"A"}'});
  await a.publish(advert);
  assert.equal(await until(()=>got.some(e=>e.id===advert.id)),true,'peer B sees peer A advertisement');
  // control: without the ROD-listed relay the peers are isolated
  const alone=new RelayPool({urls:[peerB.relay.url],secret:generateSecret()});await alone.connect();const none=[];alone.subscribe([{kinds:[30328]}],e=>none.push(e));await sleep(150);
  await a.publish(signEvent({secret:generateSecret(),kind:30328,tags:[['d','peerA2']],content:'{}'}));await sleep(300);
  assert.equal(none.length,0,'own relay only: no discovery');await alone.close();
 }finally{await a.close();await b.close();for(const x of [shared,peerA,peerB])await x.relay.close();}
});

test('ROD directory relay list: absent, unregistered and malformed records are handled safely',async()=>{
 const root=await mkdtemp(join(tmpdir(),'spex-find2-'));const empty=async()=>JSON.stringify({schema:1,relays:[]});
 const local=['ws://127.0.0.1:7447/'];
 assert.deepEqual(await bootstrapRelays({root,readConfig:empty,rpc:rodStub(null),localRelays:local,realmName:'spexgsp/universe/default'}),local,'record without relays');
 assert.deepEqual(await bootstrapRelays({root,readConfig:empty,rpc:rodStub(null,{record:false}),localRelays:local,realmName:'spexgsp/universe/default'}),local,'realm not registered');
 await assert.rejects(bootstrapRelays({root,readConfig:empty,rpc:rodStub(['ws://evil.example/']),localRelays:local,realmName:'spexgsp/universe/default'}),/insecure_nostr_relay_disallowed/,'plain ws from ROD is refused');
 await assert.rejects(bootstrapRelays({root,readConfig:empty,rpc:rodStub(Array.from({length:7},(_,i)=>`wss://r${i}.example/`)),localRelays:local,realmName:'spexgsp/universe/default'}),/invalid_ROD_directory_relays/);
 const listed=await bootstrapRelays({root,readConfig:empty,rpc:rodStub(['wss://relay.operator.example/']),localRelays:local,realmName:'spexgsp/universe/default'});
 assert.deepEqual(listed,[...local,'wss://relay.operator.example/']);
});

test('relays listed on ROD take precedence over a long operator file when the pool is capped at 8',async()=>{
 const root=await mkdtemp(join(tmpdir(),'spex-order-'));
 const many=async()=>JSON.stringify({schema:1,relays:Array.from({length:8},(_,i)=>`wss://file${i}.example/`)});
 const urls=await bootstrapRelays({root,readConfig:many,rpc:rodStub(['wss://onchain.example/']),localRelays:['ws://127.0.0.1:7447/'],realmName:'spexgsp/universe/default'});
 assert.equal(urls.length,8);assert.equal(urls[0],'ws://127.0.0.1:7447/');assert.equal(urls[1],'wss://onchain.example/');
});
