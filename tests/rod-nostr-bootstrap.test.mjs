// SPDX-License-Identifier: MIT
// Automatic Nostr peer universe selection + fail-closed ROD trust checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {startNip01LoopbackRelay} from './support/nip01-loopback.mjs';
import {RelayPool} from '../OSGSim/apps/metaverse-native/v26/single-address/relay-pool.mjs';
import {publicKey} from '../OSGSim/apps/metaverse-native/v26/single-address/crypto.mjs';
import {gameGenesis} from '../OSGSim/apps/metaverse-native/v26/rod-game/protocol.mjs';
import {buildRodPeerAdvertisement} from '../OSGSim/apps/metaverse-native/v26/rod-game/nostr-peer.mjs';
import {openRodNostr,selectRodUniverse,RodPeerNostrAdvertiser} from '../OSGSim/apps/metaverse-native/v26/rod-game/nostr-bootstrap.mjs';
const secret='0'.repeat(63)+'a',client='0'.repeat(63)+'b',W='a'.repeat(64),R='b'.repeat(64),A='c'.repeat(64),TIP='d'.repeat(64),GAME='osgsimtest';
const address='rFJtzkbeQ3dxWQg9G82LHMsPvrhSLMarJU',realm='spexgsp/universe/rod-moon';
const port={configSha256:'e'.repeat(64),portId:'moon:brighton-beach',slots:[{slot:'pad-1',nativePadIndex:0,rotDegrees:90}]};
const clock={schema:1,utcOriginMs:1790000000000,simMjd0:61000,rate:1,era:1};
const time=Math.floor(Date.now()/1000);
const dir={schema:'spexgsp/realm/1',realmId:'moon/rod-moon',worldId:W,ownerAddress:address,publisher:publicKey(secret),assetRoot:A,rodGenesis:R,era:1};
const store=new Map([
 [realm,{address,height:1,value:JSON.stringify(dir)}],['g/'+GAME,{address,height:1,value:JSON.stringify(gameGenesis({world:W,assetRoot:A,rodGenesis:R,port,clock}))}],
 ['p/alice',{address,height:2,value:'{}'}]
]);
const rpc=async(method,args=[])=>{switch(method){
 case 'name_show':{const x=store.get(args[0]);if(!x)throw Error('unknown_name');return x}
 case 'getblockchaininfo':return{chain:'regtest',blocks:200};
 case 'getblockhash':return args[0]===0?R:args[0]===200?TIP:'1'.repeat(64);
 case 'signmessage':return Buffer.from(args[0]+'|'+args[1]).toString('base64');
 case 'verifymessage':return args[1]===Buffer.from(args[0]+'|'+args[2]).toString('base64');
 default:throw Error('unexpected_mock_RPC_'+method);
}};
const advertised=()=>buildRodPeerAdvertisement({rpc,secret,realmName:realm,worldId:W,assetRoot:A,rodGenesis:R,gameId:GAME,
 player:'p/alice',ownerAddress:address,clock,port,frontier:{confirmedRoot:'f'.repeat(64),tip:TIP,height:200},nowSec:time});

test('ROD/Nostr integrated bootstrap selects verified peer advertisement from live relays',async()=>{
 const event=await advertised();const local=await startNip01LoopbackRelay({stored:[event]});const pool=new RelayPool({urls:[local.url],secret:client,clock:()=>time*1000});
 try{await pool.connect(1000);
  const bootstrap=await openRodNostr({root:process.cwd(),rpc,port,assetRoot:A,rodGenesis:R,expectedWorldId:W,expectedGameId:GAME,
   pool,secret:client,clock:()=>time*1000,nowSec:time});
  assert.equal(bootstrap.selected.worldId,W);assert.equal(bootstrap.selected.source,'distributed-peer');
  assert.equal(bootstrap.selected.clock.utcOriginMs,clock.utcOriginMs);
  assert.equal(bootstrap.worlds.length,1);
 }finally{await pool.close();await local.close()}
});
test('a universe neither advertised nor registered in the ROD realm directory is rejected before native services start',async()=>{
 const local=await startNip01LoopbackRelay();const pool=new RelayPool({urls:[local.url],secret:client,clock:()=>time*1000});
 try{await pool.connect(1000);
  await assert.rejects(openRodNostr({root:process.cwd(),rpc,port,assetRoot:A,rodGenesis:R,pool,secret:client,clock:()=>time*1000,nowSec:time,maxAttempts:1}),
   /NO_DISTRIBUTED_UNIVERSE_ADVERTISED/);
 }finally{await pool.close();await local.close()}
});
test('Competing immutable genesis or explicit wrong selection cannot silently switch world',()=>{
 const a={worldId:W,assetRoot:A,rodGenesis:R,realmName:realm,gameId:GAME};
 assert.throws(()=>selectRodUniverse([a],{requested:'0'.repeat(64),assetRoot:A,rodGenesis:R}),/NOT_FOUND/);
 assert.throws(()=>selectRodUniverse([a,{...a,worldId:'2'.repeat(64),realmName:'spexgsp/universe/other'}],{autoSelect:false}),/MULTIPLE/);
 assert.equal(selectRodUniverse([a],{assetRoot:A,rodGenesis:R}).worldId,W);
});
test('Registered peer re-advertises a verified ROD frontier using the mandatory Nostr connection',async()=>{
 const local=await startNip01LoopbackRelay();const pool=new RelayPool({urls:[local.url],secret:client,clock:()=>time*1000});
 try{await pool.connect(1000);
  const bridge={relay:pool,identity:client,clock:()=>time*1000};
  const advertiser=new RodPeerNostrAdvertiser({bridge,rpc,realmName:realm,worldId:W,assetRoot:A,rodGenesis:R,gameId:GAME,
   player:'p/alice',ownerAddress:address,clock,port});
  await advertiser.tick({confirmedRoot:'f'.repeat(64),tip:TIP,height:200,roster:['p/alice']});
  assert.equal(local.received.length,1);
  await advertiser.tick({confirmedRoot:'1'.repeat(64),tip:TIP,height:200,roster:['p/alice']});
  assert.equal(local.received.length,1,'never publish conflicting replaceable events with identical created_at');
 }finally{await pool.close();await local.close()}
});
