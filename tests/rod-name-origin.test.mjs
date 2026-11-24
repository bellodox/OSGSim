// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {findRodNameOrigin} from '../OSGSim/apps/metaverse-native/v26/rod-game/name-origin.mjs';
const NAME='g/osgsimv26',GEN='a'.repeat(64),VALUE='{"schema":1,"genesis":"'+GEN+'"}';
const id=i=>i.toString(16).padStart(64,'0');
function mockChain({latest=5,origin=3,registeredValue=VALUE,withHistory=false}={}){
 const calls=[];const rows=Array.from({length:latest+1},(_,height)=>({hash:id(1000+height),tx:[]}));
 rows[origin].tx.push({txid:id(2000+origin),vout:[{n:0,scriptPubKey:{nameOp:{op:'name_register',name:NAME,value:registeredValue}}}]});
 rows[latest].tx.push({txid:id(2000+latest),vout:[{n:0,scriptPubKey:{nameOp:{op:'name_update',name:NAME,value:VALUE}}}]});
 const rpc=async(method,args=[])=>{calls.push([method,...args]);switch(method){
  case 'name_history':if(withHistory)return[{height:origin,value:registeredValue}];throw Error('name_history disabled');
  case 'name_show':return{height:latest,txid:id(2000+latest),value:VALUE};
  case 'getblockhash':return rows[args[0]]?.hash??null;
  case 'getblock':return rows.find(x=>x.hash===args[0])??null;
  default:throw Error('unexpected RPC '+method);
 }};
 return{rpc,calls,rows};
}
test('absence of -namehistory requires no daemon reindex: recover verified registration from canonical blocks, then use durable cache',async()=>{
 const chain=mockChain(),dir=await mkdtemp(join(tmpdir(),'rod-origin-'));
 try{
  const cacheFile=join(dir,'origin.json'),current=await chain.rpc('name_show',[NAME]);
  const record=await findRodNameOrigin({rpc:chain.rpc,name:NAME,current,expectedValue:VALUE,cacheFile});
  assert.equal(record.height,3);assert.equal(record.txid,id(2003));
  const before=chain.calls.filter(x=>x[0]==='getblock').length;
  const again=await findRodNameOrigin({rpc:chain.rpc,name:NAME,current,expectedValue:VALUE,cacheFile});
  assert.equal(again.height,3);assert.equal(chain.calls.filter(x=>x[0]==='getblock').length,before);
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('an expired and re-registered game cannot be authenticated with an earlier mismatching genesis',async()=>{
 const chain=mockChain({latest:6,origin:4,registeredValue:'{"schema":1,"foreign":true}'});
 await assert.rejects(findRodNameOrigin({rpc:chain.rpc,name:NAME,current:await chain.rpc('name_show',[NAME]),expectedValue:VALUE}),
  /ROD_NAME_ORIGINAL_REGISTRATION_INVALID/);
});
test('name origin refuses a chain reorganization while scanning a confirmed registration',async()=>{
 const chain=mockChain(),last=chain.rows[5].hash;let scans=0;
 const rpc=async(method,args=[])=>{
  if(method==='getblockhash'&&args[0]===5&&scans++>1)return 'f'.repeat(64);
  return chain.rpc(method,args);
 };
 await assert.rejects(findRodNameOrigin({rpc,name:NAME,current:await chain.rpc('name_show',[NAME]),expectedValue:VALUE}),
  /ROD_NAME_ORIGIN_CHAIN_CHANGED/);
 assert.notEqual(last,'f'.repeat(64));
});
