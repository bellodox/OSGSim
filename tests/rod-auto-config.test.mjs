// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {discoverRodDirectoryUniverse} from '../OSGSim/apps/metaverse-native/v26/rod-game/nostr-bootstrap.mjs';
import {mkdtemp,rm,readFile} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {bootstrapRodAutoConfig} from '../OSGSim/apps/metaverse-native/v26/rod-game/auto-config.mjs';
import {gameGenesis} from '../OSGSim/apps/metaverse-native/v26/rod-game/protocol.mjs';
const W='a'.repeat(64),AS='b'.repeat(64),GEN='c'.repeat(64),ADDR='rFJtzkbeQ3dxWQg9G82LHMsPvrhSLMarJU',GAME='osgsimtest';
const CLOCK={schema:1,utcOriginMs:1790000000000,simMjd0:61000,rate:1,era:1};
const port={portId:'moon:brighton-beach',slots:[{slot:'pad-1'}],configSha256:'d'.repeat(64)};
const GENESIS_VALUE=JSON.stringify(gameGenesis({world:W,assetRoot:AS,rodGenesis:GEN,clock:CLOCK,port}));
const chosen={worldId:W,realmName:'spexgsp/universe/test',gameId:GAME,assetRoot:AS,rodGenesis:GEN,clock:CLOCK,source:'distributed-peer'};
test('unattended join config derives world from Nostr/ROD, wallet player, and native install',async()=>{
 const root=await mkdtemp(join(tmpdir(),'spex-auto-cfg-'));let closed=0,registration=0;
 const rpc=async(method,args=[])=>{if(method==='getblockhash')return GEN;
  if(method==='getzmqnotifications')return[{type:'pubgamepending',address:'tcp://127.0.0.1:28332'},{type:'pubgameblocks',address:'tcp://127.0.0.1:28332'}];
  if(method==='name_show'&&args[0]==='g/'+GAME)return{height:15,txid:'9'.repeat(64),value:GENESIS_VALUE};
  if(method==='name_history')return[{height:4,op:'name_register',txid:'1'.repeat(64),value:GENESIS_VALUE},{height:15,op:'name_update',value:GENESIS_VALUE}];
  throw Error('unexpected '+method)};
 const deps={root,findInstall:async()=>root,findRealm:async()=>chosen.realmName,
  findRpc:async()=>({rpc,config:{url:'http://127.0.0.1:20841/wallet/alice'}}),findManifest:async()=>({worldId:AS}),
  findPort:async()=>port,findGraph:async()=>join(root,'OmniSpatialGraph-multi'),
  openNostr:async()=>({selected:chosen,worlds:[chosen],identity:'1'.repeat(64),close:async()=>{closed++}}),
  ensurePlayer:async({worldId,allowRegistration,nostrPubkey})=>{registration++;assert.equal(worldId,W);
   assert.equal(allowRegistration,true);assert.match(nostrPubkey,/^[a-f0-9]{64}$/);return{name:'p/alice',playerName:'alice',address:ADDR}}};
 try{const result=await bootstrapRodAutoConfig(deps);const c=JSON.parse(await readFile(result.configFile,'utf8'));
  assert.equal(c.worldId,W);assert.equal(c.gameId,GAME);assert.equal(c.playerName,'alice');
  assert.equal(c.startHeight,4);assert.equal(c.clock.simMjd0,61000);assert.equal(c.zmqAddress,'tcp://127.0.0.1:28332');
  assert.equal(registration,1);assert.equal(closed,1);
  const list=await bootstrapRodAutoConfig({...deps,listOnly:true});assert.equal(list.worlds[0].gameId,GAME);
  assert.equal(registration,1,'listing worlds must not trigger wallet spend');
 }finally{await rm(root,{recursive:true,force:true})}
});
test('unregistered game or missing full history cannot trigger automatic player-wallet spending',async()=>{
 const root=await mkdtemp(join(tmpdir(),'spex-auto-cfg-'));let spent=false,closed=0;
 const rpc=async(method)=>{if(method==='getblockhash')return GEN;
  if(method==='getzmqnotifications')return[];
  if(method==='name_show')return{height:15,txid:'8'.repeat(64),value:GENESIS_VALUE};
  if(method==='name_history')throw Error('index disabled');if(method==='getblock')return null;throw Error(method)};
 const deps={root,findInstall:async()=>root,findRealm:async()=>chosen.realmName,
  findRpc:async()=>({rpc,config:{}}),findManifest:async()=>({worldId:AS}),findPort:async()=>port,
  openNostr:async()=>({selected:chosen,worlds:[chosen],identity:'1'.repeat(64),close:async()=>{closed++}}),
  ensurePlayer:async()=>{spent=true;throw Error('never reach')}};
 try{await assert.rejects(bootstrapRodAutoConfig(deps),/ROD_NAME_ORIGIN_FULL_BLOCK_REQUIRED/);assert.equal(spent,false);assert.equal(closed,1);
 }finally{await rm(root,{recursive:true,force:true})}
});

test('with no peer online, a joiner finds the universe from the ROD realm directory and its g/ genesis alone',async()=>{
 const realm={schema:'spexgsp/realm/1',realmId:'moon/test',worldId:W,assetRoot:AS,rodGenesis:GEN,ownerAddress:ADDR,publisher:'a'.repeat(64),era:1};
 const genesis=gameGenesis({world:W,assetRoot:AS,rodGenesis:GEN,clock:CLOCK,port});
 const ownedGame={name:'g/'+GAME,value:JSON.stringify(genesis),address:ADDR,height:8,txid:'9'.repeat(64)};
 const foreign={name:'g/zzOther',value:JSON.stringify(genesis),address:'rDU1rhqDwG2arMnnGdEobtpGr4aMASKfXw',height:9,txid:'8'.repeat(64)};
 const rpc=async(method,args=[])=>{if(method==='getblockhash')return GEN;
  if(method==='getblockchaininfo')return{chain:'main',blocks:100,headers:100,verificationprogress:1,mediantime:Math.floor(Date.now()/1000),initialblockdownload:false};
  if(method==='name_show'&&args[0]==='spexgsp/universe/test')return{value:JSON.stringify(realm),address:ADDR,height:5,txid:'7'.repeat(64)};
  if(method==='name_scan')return[{name:'d/x',value:'{}',address:ADDR,height:1},ownedGame,foreign,{name:'p/alice',value:'{}',address:ADDR,height:2}];
  throw Error('unexpected RPC '+method)};
 const found=await discoverRodDirectoryUniverse({rpc,realmName:'spexgsp/universe/test',port,assetRoot:AS,rodGenesis:GEN});
 assert.deepEqual({worldId:found.worldId,gameId:found.gameId,source:found.source},{worldId:W,gameId:GAME,source:'rod-directory'},'a g/ name held by anyone but the realm owner is ignored');
 assert.equal(await discoverRodDirectoryUniverse({rpc,realmName:'spexgsp/universe/test',port,assetRoot:'f'.repeat(64),rodGenesis:GEN}),null,'other installation fingerprint');
 assert.equal(await discoverRodDirectoryUniverse({rpc:async(m,a)=>m==='name_show'?Promise.reject(Error('name not found')):rpc(m,a),realmName:'spexgsp/universe/test',port,assetRoot:AS,rodGenesis:GEN}),null,'realm not registered');
});

test('verified Nostr relay session remains open across slow registration when handed to runtime',async()=>{
 const root=await mkdtemp(join(tmpdir(),'spex-relay-handoff-'));let closed=0;
 const rpc=async(m,args=[])=>{if(m==='getblockhash')return GEN;
  if(m==='name_show')return{height:10,txid:'7'.repeat(64),value:GENESIS_VALUE};
  if(m==='name_history')return[{height:3,value:GENESIS_VALUE}];
  if(m==='getzmqnotifications')return[{type:'pubgamepending',address:'tcp://127.0.0.1:28332'},{type:'pubgameblocks',address:'tcp://127.0.0.1:28332'}];
  throw Error(m)};
 const bridge={selected:chosen,worlds:[chosen],identity:'1'.repeat(64),close:async()=>{closed++}};
 const deps={root,keepNostrOpen:true,findInstall:async()=>root,findRealm:async()=>chosen.realmName,
  findRpc:async()=>({rpc,config:{url:'http://127.0.0.1:20841/wallet/player'}}),
  findManifest:async()=>({worldId:AS}),findPort:async()=>port,findGraph:async()=>join(root,'multi'),
  openNostr:async()=>bridge,ensurePlayer:async()=>({name:'p/alice',playerName:'alice',address:ADDR})};
 try{const selected=await bootstrapRodAutoConfig(deps);assert.equal(selected.nostr,bridge);assert.equal(closed,0);
  await selected.nostr.close();assert.equal(closed,1);
 }finally{await rm(root,{recursive:true,force:true})}
});
test('an explicit verified universe choice selects without repeated relay discovery',async()=>{
 const root=await mkdtemp(join(tmpdir(),'spex-relay-choice-'));let calls=0;
 const other={...chosen,worldId:'f'.repeat(64),realmName:'spexgsp/universe/other'};
 const rpc=async(m,args=[])=>{if(m==='getblockhash')return GEN;
  if(m==='name_show')return{height:10,txid:'7'.repeat(64),value:GENESIS_VALUE};
  if(m==='name_history')return[{height:3,value:GENESIS_VALUE}];
  if(m==='getzmqnotifications')return[{type:'pubgamepending',address:'tcp://127.0.0.1:28332'},{type:'pubgameblocks',address:'tcp://127.0.0.1:28332'}];
  throw Error(m)};
 const bridge={selected:null,worlds:[chosen,other],identity:'1'.repeat(64),close:async()=>{}};
 const deps={root,choose:true,autoSelect:false,findInstall:async()=>root,findRealm:async()=>chosen.realmName,
  findRpc:async()=>({rpc,config:{url:'http://127.0.0.1:20841/wallet/player'}}),
  findManifest:async()=>({worldId:AS}),findPort:async()=>port,findGraph:async()=>join(root,'multi'),
  openNostr:async({deferChoice})=>{assert.equal(deferChoice,true);return bridge},
  selectUniverse:async(worlds)=>{calls++;return worlds[0]},ensurePlayer:async()=>({name:'p/alice',playerName:'alice',address:ADDR})};
 try{const selected=await bootstrapRodAutoConfig(deps);assert.equal(selected.config.worldId,W);assert.equal(calls,1);
 }finally{await rm(root,{recursive:true,force:true})}
});
