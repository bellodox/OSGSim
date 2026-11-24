// SPDX-License-Identifier: MIT
// Independent NIP-01 and ROD wallet evidence for a decentralized world ad.
import test from 'node:test';
import assert from 'node:assert/strict';
import {startNip01LoopbackRelay} from './support/nip01-loopback.mjs';
import {RelayPool} from '../OSGSim/apps/metaverse-native/v26/single-address/relay-pool.mjs';
import {signEvent,publicKey} from '../OSGSim/apps/metaverse-native/v26/single-address/crypto.mjs';
import {buildRodPeerAdvertisement,verifyRodPeerAdvertisement,discoverRodPeerUniverses,DISTRIBUTED_NOSTR_KIND} from '../OSGSim/apps/metaverse-native/v26/rod-game/nostr-peer.mjs';
import {gameGenesis} from '../OSGSim/apps/metaverse-native/v26/rod-game/protocol.mjs';
const s='0'.repeat(63)+'a',f='0'.repeat(63)+'b';
const world='a'.repeat(64),asset='c'.repeat(64),rod='d'.repeat(64),tip='b'.repeat(64),realmName='spexgsp/universe/moon';
const owner='rFJtzkbeQ3dxWQg9G82LHMsPvrhSLMarJU',player='p/rodpilot',game='osg'+world.slice(0,32);
const clock={schema:1,rate:1,utcOriginMs:1700000000000,simMjd0:61000,era:1};
const port={configSha256:'e'.repeat(64),portId:'moon:brighton-beach',base:'Brighton Beach',slots:[{slot:'pad-1',nativePadIndex:0,rotDegrees:90}]};
const directory={schema:'spexgsp/realm/1',realmId:'moon/test',ownerAddress:owner,publisher:publicKey(s),worldId:world,assetRoot:asset,rodGenesis:rod,era:1};
const genesis=gameGenesis({world,assetRoot:asset,port,clock,rodGenesis:rod});
const time=Math.floor(Date.now()/1000);
const records=new Map([[realmName,{height:1,address:owner,value:JSON.stringify(directory)}],
 ['g/'+game,{height:1,address:owner,value:JSON.stringify(genesis)}],[player,{height:1,address:owner,value:'{}'}]]);
function mockRpc(){return async(method,args=[])=>{switch(method){
 case 'name_show':{const value=records.get(args[0]);if(!value)throw Error('Unknown name');return value;}
 case 'getblockchaininfo':return{chain:'regtest',blocks:42};
 case 'getblockhash':return args[0]===0?rod:args[0]===42?tip:'f'.repeat(64);
 case 'signmessage':return Buffer.from(args[0]+'|'+args[1]).toString('base64');
 case 'verifymessage':return args[1]===Buffer.from(args[0]+'|'+args[2]).toString('base64');
 default:throw Error('UNEXPECTED_RPC_'+method);
 }};}
const params=()=>({rpc:mockRpc(),secret:s,realmName,worldId:world,assetRoot:asset,rodGenesis:rod,gameId:game,player,ownerAddress:owner,clock,port,
 frontier:{confirmedRoot:'1'.repeat(64),tip,height:42},nowSec:time});

test('Nostr peer ad is dual signed, ROD-bound and verified without trusting relay data',async()=>{
 const event=await buildRodPeerAdvertisement(params());
 assert.equal(event.kind,DISTRIBUTED_NOSTR_KIND);
 const witness=await verifyRodPeerAdvertisement(event,{rpc:mockRpc(),port,assetRoot:asset,rodGenesis:rod,nowSec:time});
 assert.equal(witness.claim.player,player);assert.equal(witness.genesis.worldId,world);
 assert.equal(await verifyRodPeerAdvertisement(event,{rpc:mockRpc(),assetRoot:'7'.repeat(64),nowSec:time}),null);
 assert.equal(await verifyRodPeerAdvertisement(event,{rpc:mockRpc(),nowSec:time+601}),null);
});
test('ROD identity transfer, foreign genesis and forked tip reject advertised peers',async()=>{
 const event=await buildRodPeerAdvertisement(params());
 const saved=records.get(player);
 try{records.set(player,{...saved,address:'rDU1rhqDwG2arMnnGdEobtpGr4aMASKfXw'});
  assert.equal(await verifyRodPeerAdvertisement(event,{rpc:mockRpc(),nowSec:time}),null);
 }finally{records.set(player,saved)}
 const g=records.get('g/'+game);
 try{records.set('g/'+game,{...g,address:'rDU1rhqDwG2arMnnGdEobtpGr4aMASKfXw'});
  assert.equal(await verifyRodPeerAdvertisement(event,{rpc:mockRpc(),nowSec:time}),null);
 }finally{records.set('g/'+game,g)}
 const rejectTip=async(method,args=[])=>method==='getblockhash'&&args[0]===42?'8'.repeat(64):mockRpc()(method,args);
 assert.equal(await verifyRodPeerAdvertisement(event,{rpc:rejectTip,nowSec:time}),null);
});
test('Nostr signature alone and forged ROD wallet signature never establish membership',async()=>{
 const correct=await buildRodPeerAdvertisement(params());
 const payload=JSON.parse(correct.content);payload.rodSignature='fabricated';
 const forged=signEvent({secret:f,kind:DISTRIBUTED_NOSTR_KIND,tags:correct.tags,content:JSON.stringify(payload),createdAt:time});
 assert.equal(await verifyRodPeerAdvertisement(forged,{rpc:mockRpc(),nowSec:time}),null);
});
test('Two independent relays discover one ROD-verified universe, without a central host',async()=>{
 const event=await buildRodPeerAdvertisement(params());
 const a=await startNip01LoopbackRelay({stored:[event]});const b=await startNip01LoopbackRelay({stored:[event]});
 const pool=new RelayPool({urls:[a.url,b.url],secret:f});
 try{await pool.connect(1200);
  const found=await discoverRodPeerUniverses(pool,mockRpc(),{assetRoot:asset,rodGenesis:rod,port,nowSec:time,timeoutMs:1200});
  assert.equal(found.length,1);assert.equal(found[0].claim.worldId,world);
 }finally{await pool.close();await Promise.all([a.close(),b.close()])}
});
