import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {X509Certificate,createPublicKey} from 'node:crypto';
import {OperatorRelay} from '../OSGSim/apps/metaverse-native/v26/single-address/operator-relay.mjs';
import {RelayPool} from '../OSGSim/apps/metaverse-native/v26/single-address/relay-pool.mjs';
import {generateSecret,signEvent} from '../OSGSim/apps/metaverse-native/v26/single-address/crypto.mjs';
import {generateRelayCertificate,ensureRelayCertificate,loadRelayTls,readRelayCertificate,relayUrl,spkiPin,validRelayHost}
 from '../OSGSim/apps/metaverse-native/v26/single-address/relay-cert.mjs';
import {pinnedWebSocket,probePinnedRelay} from '../OSGSim/apps/metaverse-native/v26/single-address/pinned-websocket.mjs';
import {directoryRelayInfo} from '../OSGSim/apps/metaverse-native/v26/single-address/resolver.mjs';
import {bootstrapRelays} from '../OSGSim/apps/metaverse-native/v26/single-address/universe-catalog.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const until=async(fn,ms=3000)=>{const t=Date.now();while(Date.now()-t<ms){if(fn())return true;await sleep(20);}return false;};
const hasOpenssl=(()=>{try{execFileSync('openssl',['version']);return true;}catch{return false;}})();

test('generated certificate is a valid self-signed X.509 for an IPv4 and an IPv6 address; host names are refused',async()=>{
 for(const host of ['203.0.113.7','2001:db8::1']){
  const made=generateRelayCertificate({host});
  const x=new X509Certificate(made.cert);
  assert.equal(x.verify(x.publicKey),true,'self-signature verifies: '+host);
  assert.equal(x.ca,false);
  assert.match(x.subjectAltName,/localhost/);
  assert.equal(x.checkIP(host)!==undefined,true,'SAN holds '+host);
  assert.ok(Date.parse(x.validFrom)<Date.now()&&Date.parse(x.validTo)>Date.now()+3000*86400000);
  assert.equal(made.pin,spkiPin(made.cert));assert.match(made.pin,/^[a-f0-9]{64}$/);
  assert.doesNotThrow(()=>createPublicKey(made.key));
 }
 for(const bad of ['bad host/','relay.example.org','localhost','https://x',''])assert.throws(()=>generateRelayCertificate({host:bad}),/invalid_relay_host/,bad);
 assert.equal(validRelayHost('https://x'),false);assert.equal(relayUrl('2001:db8::1',7447),'wss://[2001:db8::1]:7447/');
});

test('OpenSSL accepts the generated certificate and agrees on the key hash',{skip:!hasOpenssl},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spex-cert-'));
 try{
  const made=generateRelayCertificate({host:'198.51.100.9'});
  await writeFile(join(dir,'c.pem'),made.cert);await writeFile(join(dir,'k.pem'),made.key);
  const text=execFileSync('openssl',['x509','-in',join(dir,'c.pem'),'-noout','-text'],{encoding:'utf8'});
  assert.match(text,/ecdsa-with-SHA256/);assert.match(text,/IP Address:198\.51\.100\.9/);assert.match(text,/CA:FALSE/);assert.match(text,/TLS Web Server Authentication/);
  const spki=execFileSync('openssl',['x509','-in',join(dir,'c.pem'),'-pubkey','-noout']);
  const hash=execFileSync('openssl',['dgst','-sha256','-hex'],{input:execFileSync('openssl',['pkey','-pubin','-outform','DER'],{input:spki})},).toString().trim().split(' ').pop();
  assert.equal(hash,made.pin);
  execFileSync('openssl',['verify','-CAfile',join(dir,'c.pem'),'-purpose','sslserver','-ignore_critical',join(dir,'c.pem')],{stdio:'pipe'});
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('ensureRelayCertificate keeps key and pin across restarts and renews when the host changes or the certificate is about to expire',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spex-cert-'));
 try{
  const first=await ensureRelayCertificate({dir,host:'203.0.113.7'});assert.equal(first.created,true);
  const second=await ensureRelayCertificate({dir,host:'203.0.113.7'});assert.equal(second.created,false);assert.equal(second.pin,first.pin);
  assert.equal((await readRelayCertificate(dir)).pin,first.pin);
  const other=await ensureRelayCertificate({dir,host:'203.0.113.8'});assert.equal(other.created,true);assert.notEqual(other.pin,first.pin);
  const late=await ensureRelayCertificate({dir,host:'203.0.113.8',now:Date.now()+3600*86400000});assert.equal(late.created,true,'less than 90 days left');
  await writeFile(join(dir,'relay-key.pem'),'garbage');assert.equal(await readRelayCertificate(dir),null,'a damaged set counts as absent');
  const key=await ensureRelayCertificate({dir,host:'203.0.113.8'});assert.equal(key.created,true);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('loadRelayTls: environment files first, then the generated certificate, else none',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spex-cert-'));
 try{
  assert.equal(await loadRelayTls({}, {dir}),null);
  assert.equal(await loadRelayTls({}),null);
  const made=await ensureRelayCertificate({dir,host:'203.0.113.7'});
  const generated=await loadRelayTls({}, {dir});assert.equal(generated.source,'generated');assert.equal(generated.host,'203.0.113.7');assert.equal(generated.pin,made.pin);
  const other=generateRelayCertificate({host:'198.51.100.20'});
  await writeFile(join(dir,'e.crt'),other.cert);await writeFile(join(dir,'e.key'),other.key);
  const env=await loadRelayTls({OSGSIM_RELAY_TLS_CERT:join(dir,'e.crt'),OSGSIM_RELAY_TLS_KEY:join(dir,'e.key')},{dir});
  assert.equal(env.source,'environment');assert.equal(env.pin,other.pin);
  await assert.rejects(loadRelayTls({OSGSIM_RELAY_TLS_CERT:join(dir,'e.crt')},{dir}),/NEEDS_BOTH/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

async function tlsRelay(options={}){
 const dir=await mkdtemp(join(tmpdir(),'spex-tlsrelay-'));
 const cert=await ensureRelayCertificate({dir:join(dir,'tls'),host:'127.0.0.1'});
 const relay=await new OperatorRelay({host:'127.0.0.1',tls:{cert:cert.cert,key:cert.key},file:join(dir,'events.jsonl'),...options}).start();
 return{dir,cert,relay,url:relay.url};
}

test('a pinned self-signed relay works end to end; without the pin, or with a wrong pin, it is refused',async()=>{
 const {dir,cert,relay,url}=await tlsRelay();
 const pins=new Map([[url,cert.pin]]);
 const a=new RelayPool({urls:[url],secret:generateSecret(),pins}),b=new RelayPool({urls:[url],secret:generateSecret(),pins});
 const plain=new RelayPool({urls:[url],secret:generateSecret()});
 const wrong=new RelayPool({urls:[url],secret:generateSecret(),pins:new Map([[url,'0'.repeat(64)]])});
 try{
  assert.match(url,/^wss:\/\/127\.0\.0\.1:\d+\/$/);
  await a.connect(3000);await b.connect(3000);
  const got=[];b.subscribe([{kinds:[8427]}],e=>got.push(e));await sleep(100);
  const event=signEvent({secret:generateSecret(),kind:8427,content:'over pinned tls'});await a.publish(event);
  assert.equal(await until(()=>got.length===1),true);assert.equal(got[0].content,'over pinned tls');
  await assert.rejects(plain.connect(1500),/all_nostr_relays_unavailable/,'a self-signed certificate is not trusted through a CA');
  await assert.rejects(wrong.connect(1500),/all_nostr_relays_unavailable/,'a different key is refused');
  assert.deepEqual(await probePinnedRelay(url,cert.pin,3000),{ok:true});
  const bad=await probePinnedRelay(url,'1'.repeat(64),3000);assert.equal(bad.ok,false);assert.match(bad.reason,/pin_mismatch/);
  const refused=await probePinnedRelay('wss://127.0.0.1:1/',cert.pin,3000);assert.equal(refused.ok,false);
  assert.throws(()=>pinnedWebSocket('xyz'),/invalid_relay_pin/);
 }finally{await a.close();await b.close();await plain.close();await wrong.close();await relay.close();await rm(dir,{recursive:true,force:true});}
});

test('the pinned client sends nothing when the key does not match',async()=>{
 const {dir,cert,relay,url}=await tlsRelay();
 let upgrades=0;relay.server.on('upgrade',()=>upgrades++);
 try{
  const result=await probePinnedRelay(url,'2'.repeat(64),2000);
  assert.equal(result.ok,false);await sleep(100);assert.equal(upgrades,0,'no WebSocket request reached the server');
 }finally{await relay.close();await rm(dir,{recursive:true,force:true});}
});

test('own peer reaches a TLS relay through its loopback listener',async()=>{
 const {dir,relay}=await tlsRelay();
 try{
  assert.match(relay.localUrl,/^ws:\/\/127\.0\.0\.1:\d+\/$/);
  const p=new RelayPool({urls:[relay.localUrl],secret:generateSecret()});await p.connect(2000);await p.close();
 }finally{await relay.close();await rm(dir,{recursive:true,force:true});}
});

const directoryRpc=value=>async(method)=>{
 if(method==='name_show')return{value:JSON.stringify(value),address:'ownerA',txid:'t'.repeat(64),height:50};
 if(method==='getblockchaininfo')return{chain:'main',blocks:60,headers:60,verificationprogress:1,mediantime:Math.floor(Date.now()/1000),initialblockdownload:false};
 if(method==='getblockhash')return 'g'.repeat(1).repeat(64).replace(/g/g,'6');
 throw Error('unexpected '+method);
};
const baseDirectory={schema:'spexgsp/realm/1',realmId:'moon/t',ownerAddress:'ownerA',publisher:'a'.repeat(64),worldId:'b'.repeat(64),assetRoot:'c'.repeat(64),rodGenesis:'6'.repeat(64),era:1};

test('realm directory pins: accepted for listed relays, refused for unlisted ones or malformed hashes',async()=>{
 const url='wss://203.0.113.7:7447/',pin='d'.repeat(64);
 const ok=await directoryRelayInfo(directoryRpc({...baseDirectory,relays:[url],relayPins:{[url]:pin}}),{realmName:'spexgsp/universe/t'});
 assert.deepEqual(ok.urls,[url]);assert.equal(ok.pins.get(url),pin);
 const none=await directoryRelayInfo(directoryRpc({...baseDirectory,relays:[url]}),{realmName:'spexgsp/universe/t'});assert.equal(none.pins.size,0);
 await assert.rejects(directoryRelayInfo(directoryRpc({...baseDirectory,relays:[url],relayPins:{'wss://198.51.100.1:7447/':pin}}),{realmName:'spexgsp/universe/t'}),/relay_pins/);
 await assert.rejects(directoryRelayInfo(directoryRpc({...baseDirectory,relays:[url],relayPins:{[url]:'XYZ'}}),{realmName:'spexgsp/universe/t'}),/relay_pins/);
 await assert.rejects(directoryRelayInfo(directoryRpc({...baseDirectory,relays:[url],relayPins:[pin]}),{realmName:'spexgsp/universe/t'}),/relay_pins/);
});

test('bootstrapRelays reports the owner\'s pins and leaves out the peer\'s own public URL',async()=>{
 const url='wss://203.0.113.7:7447/',other='wss://198.51.100.2:7447/',pin='e'.repeat(64);
 const rpc=directoryRpc({...baseDirectory,relays:[url,other],relayPins:{[url]:pin}});
 const pins=new Map();
 const urls=await bootstrapRelays({root:'/nonexistent',rpc,realmName:'spexgsp/universe/t',localRelays:['ws://127.0.0.1:7447/'],pins,readConfig:async()=>JSON.stringify({schema:1,relays:[]})});
 assert.deepEqual(urls,['ws://127.0.0.1:7447/',url,other]);assert.equal(pins.get(url),pin);assert.equal(pins.has(other),false);
 const own=await bootstrapRelays({root:'/nonexistent',rpc,realmName:'spexgsp/universe/t',localRelays:['ws://127.0.0.1:7447/'],pins:new Map(),skipRelays:[url],readConfig:async()=>JSON.stringify({schema:1,relays:[]})});
 assert.deepEqual(own,['ws://127.0.0.1:7447/',other]);
});

function rawClient(port,host='127.0.0.1'){
 return new Promise((resolve,reject)=>{
  const socket=net.connect(port,host,()=>{
   socket.write('GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
  });
  let head='';const state={socket,closed:false,pings:0,status:null};
  socket.on('data',d=>{head+=d.toString('latin1');if(state.status===null&&head.includes('\r\n\r\n')){state.status=head.split('\r\n')[0];resolve(state);}
   for(let i=0;i<d.length;i++)if(d[i]===0x89&&d[i+1]===0)state.pings++;});
  socket.on('close',()=>{state.closed=true;if(state.status===null)resolve(state);});
  socket.on('error',reject);
 });
}

test('relay keepalive: a connection that never answers a ping is dropped; one that answers stays',async()=>{
 const relay=await new OperatorRelay({pingMs:60}).start();
 try{
  const port=new URL(relay.url).port;
  const dead=await rawClient(port);assert.match(dead.status,/101/);
  // the dead client says nothing after the handshake and never sends a pong
  assert.equal(await until(()=>dead.closed,2000),true,'dropped after two unanswered rounds');
  assert.ok(dead.pings>=1);
  const live=await rawClient(port);
  const pong=Buffer.from([0x8a,0x80,1,2,3,4]);
  const timer=setInterval(()=>{if(!live.socket.destroyed)live.socket.write(pong);},20);
  await sleep(400);assert.equal(live.closed,false);clearInterval(timer);live.socket.destroy();
 }finally{await relay.close();}
});

test('relay limits one remote address and cuts off a client that does not read',async()=>{
 const external=Object.values(os.networkInterfaces()).flat().find(i=>i&&i.family==='IPv4'&&!i.internal)?.address;
 if(external){
  const relay=await new OperatorRelay({host:'0.0.0.0',maxPerAddress:2,pingMs:0}).start();
  try{
   const port=new URL(relay.url).port;const clients=[];
   for(let i=0;i<3;i++)clients.push(await rawClient(port,external));
   assert.match(clients[0].status,/101/);assert.match(clients[1].status,/101/);assert.match(clients[2].status,/429/);
   clients.forEach(c=>c.socket.destroy());
  }finally{await relay.close();}
 }
 const relay=await new OperatorRelay({maxBufferedBytes:1000,pingMs:0}).start();
 try{
  let wrote=0,destroyed=false;
  const slow={destroyed:false,writableLength:5000,write(){wrote++;},destroy(){destroyed=true;this.destroyed=true;}};
  relay.send({socket:slow},['NOTICE','x']);
  assert.equal(destroyed,true);assert.equal(wrote,0);
  const fine={destroyed:false,writableLength:0,write(){wrote++;},destroy(){}};relay.send({socket:fine},['NOTICE','x']);assert.equal(wrote,1);
 }finally{await relay.close();}
});

test('relay file is rewritten at start when most of it is stale',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spex-compact-'));
 try{
  const file=join(dir,'events.jsonl');
  const event=signEvent({secret:generateSecret(),kind:8427,content:'kept'});
  await writeFile(file,Array(1500).fill(JSON.stringify(event)).join('\n')+'\n');
  const status=[];
  const relay=await new OperatorRelay({file,pingMs:0,onStatus:(k,v)=>status.push([k,v])}).start();await relay.close();
  assert.equal((await readFile(file,'utf8')).trim().split('\n').length,1);
  assert.deepEqual(status.find(x=>x[0]==='OPERATOR_RELAY_COMPACTED')[1],{before:1500,after:1});
  const again=await new OperatorRelay({file,pingMs:0}).start();assert.equal(again.events.size,1);await again.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});
