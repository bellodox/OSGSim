// SPDX-License-Identifier: MIT
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {ensureRodPlayerName,playerNameForWorld} from '../OSGSim/apps/metaverse-native/v26/rod-game/player-identity.mjs';
import {buildMove} from '../OSGSim/apps/metaverse-native/v26/rod-game/protocol.mjs';
const W='a'.repeat(64),KEY='b'.repeat(64),ADDRESS='rFJtzkbeQ3dxWQg9G82LHMsPvrhSLMarJU',name=playerNameForWorld(W,KEY),HASH='c'.repeat(64);
const fixture=async()=>{const dir=await mkdtemp(join(tmpdir(),'spex-ident-'));const recorded={chain:null,pending:[],broadcasts:0,history:null};
 const rpc=async(method,args=[])=>{switch(method){case 'getnewaddress':return ADDRESS;
 case 'getaddressinfo':return{ismine:true};case 'name_show':if(!recorded.chain)throw Error('name not found');return recorded.chain;
 case 'name_pending':return recorded.pending;case 'getblockhash':return HASH;case 'getblock':return null;case 'name_history':if(!recorded.history)throw Error('name history disabled');return recorded.history;case 'name_register':recorded.broadcasts++;recorded.pending=[{name:args[0],value:args[1],address:ADDRESS,txid:HASH}];return HASH;
 default:throw Error('unexpected '+method)}};return{dir,rpc,recorded,file:join(dir,'player.json'),close:()=>rm(dir,{recursive:true,force:true})}}
test('deterministic distinct world-bound ROD player identities',()=>{assert.match(name,/^p\/spex[a-f0-9]{28}$/);assert.notEqual(name,playerNameForWorld('1'.repeat(64),KEY));assert.notEqual(name,playerNameForWorld(W,'1'.repeat(64)))});
test('automatic registration is durable, waits for confirmation and does not duplicate RPC',async()=>{const f=await fixture();try{
 await assert.rejects(ensureRodPlayerName({salted:false,rpc:f.rpc,worldId:W,nostrPubkey:KEY,journalFile:f.file,allowRegistration:true,timeoutMs:45,pollMs:10}),/WAITING_FOR_CONFIRMATION/);
 assert.equal(f.recorded.broadcasts,1);const record=JSON.parse(await readFile(f.file,'utf8'));
 f.recorded.chain={name,address:ADDRESS,value:record.value,height:4,txid:HASH};f.recorded.pending=[];
 const selected=await ensureRodPlayerName({salted:false,rpc:f.rpc,worldId:W,nostrPubkey:KEY,journalFile:f.file,allowRegistration:true});
 assert.equal(selected.name,name);assert.equal(selected.address,ADDRESS);assert.equal(f.recorded.broadcasts,1);
 }finally{await f.close()}});
test('foreign name, missing wallet authorization and ambiguous RPC reject',async()=>{const f=await fixture();try{
 f.recorded.chain={address:'rDU1rhqDwG2arMnnGdEobtpGr4aMASKfXw',value:'{}',height:6};
 await assert.rejects(ensureRodPlayerName({salted:false,rpc:f.rpc,worldId:W,nostrPubkey:KEY,journalFile:f.file,allowRegistration:true}),/CONFLICT/);
 }finally{await f.close()}});

test('reconnect accepts a confirmed wallet-owned player name after its first ROD game move',async()=>{
 const f=await fixture();try{
  const registration=JSON.stringify({schema:'spexgsp/player/1',worldId:W,nostrPubkey:KEY});
  const move=buildMove({world:W,game:'osgsimtest',player:name,seq:1,previous:'0'.repeat(64),kind:'join',payload:{owner:ADDRESS,asset:W,clockEra:1}});
  f.recorded.chain={name,address:ADDRESS,value:JSON.stringify({g:{osgsimtest:move}}),height:20,txid:HASH};
  f.recorded.history=[{op:'name_register',height:2,value:registration},{op:'name_update',height:20,value:f.recorded.chain.value}];
  const first=await ensureRodPlayerName({salted:false,rpc:f.rpc,worldId:W,nostrPubkey:KEY,journalFile:f.file,allowRegistration:true});
  const second=await ensureRodPlayerName({salted:false,rpc:f.rpc,worldId:W,nostrPubkey:KEY,journalFile:f.file,allowRegistration:true});
  assert.equal(first.name,name);assert.equal(second.address,ADDRESS);assert.equal(f.recorded.broadcasts,0);
 }finally{await f.close()}
});
test('reconnect rejects an updated player name without matching confirmed registration history',async()=>{
 const f=await fixture();try{
  const move=buildMove({world:W,game:'osgsimtest',player:name,seq:1,previous:'0'.repeat(64),kind:'join',payload:{owner:ADDRESS,asset:W,clockEra:1}});
  f.recorded.chain={name,address:ADDRESS,value:JSON.stringify({g:{osgsimtest:move}}),height:20};
  await assert.rejects(ensureRodPlayerName({salted:false,rpc:f.rpc,worldId:W,nostrPubkey:KEY,journalFile:f.file,allowRegistration:true}),/ROD_NAME_ORIGIN_FULL_BLOCK_REQUIRED/);
  f.recorded.history=[{op:'name_register',height:2,value:'{}'}];
  await assert.rejects(ensureRodPlayerName({salted:false,rpc:f.rpc,worldId:W,nostrPubkey:KEY,journalFile:f.file,allowRegistration:true}),/ROD_NAME_ORIGINAL_REGISTRATION_INVALID/);
 }finally{await f.close()}
});
