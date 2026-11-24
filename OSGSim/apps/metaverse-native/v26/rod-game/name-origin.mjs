// SPDX-License-Identifier: MIT
// Verify the original name registration without demanding -namehistory/reindex.
// name_history is a fast path. A full ROD node can always walk confirmed
// blocks when its optional name-history index is not available.
import {readFile} from 'node:fs/promises';
import {atomicWriteFile} from '../fs-util.mjs';
import {canonical} from '../ownership.mjs';
const H=/^[a-f0-9]{64}$/;
const equalJson=(a,b)=>{try{return canonical(JSON.parse(a))===canonical(JSON.parse(b))}catch{return a===b}};
const validateRecord=(record,name,expectedValue)=>{
 if(!Number.isSafeInteger(record?.height)||record.height<1||
    !equalJson(record.value,expectedValue))throw Error('ROD_NAME_ORIGINAL_REGISTRATION_INVALID_'+name);
 return record;
};
export async function findRodNameOrigin({rpc,name,current=null,expectedValue,cacheFile=null,onStatus=()=>{}}={}){
 if(typeof rpc!=='function'||!/^[gp]\/[A-Za-z0-9_.-]{1,64}$/.test(name??'')||typeof expectedValue!=='string')
  throw Error('ROD_NAME_ORIGIN_ARGUMENTS_INVALID');
 const latest=current??await rpc('name_show',[name]);
 if(!Number.isSafeInteger(latest.height)||latest.height<1)throw Error('ROD_NAME_ORIGIN_NO_CONFIRMED_RECORD');
 // Prefer the upstream name-history index when installed. The registration
 // value must match independently verified game genesis / player identity.
 try{
  const records=await rpc('name_history',[name]);
  if(Array.isArray(records)&&records.length){
   const first=records.find(x=>x.op==='name_register'||x.op==='name_firstupdate')??records[0];
   return validateRecord(first,name,expectedValue);
  }
 }catch(e){if(/ROD_NAME_ORIGINAL_REGISTRATION_INVALID/.test(e.message))throw e;}
 let cache=null;
 if(cacheFile)try{cache=JSON.parse(await readFile(cacheFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 // ROD names never expire and an existing name cannot be registered again (names/main.cpp,
 // tx-nameregister-existing-name), so a cached registration stays valid while its block is still canonical.
 // Later name_updates do not invalidate it.
 if(cache?.schema===1&&cache.name===name&&cache.value===expectedValue&&
    Number.isSafeInteger(cache.height)&&cache.height>=1&&cache.height<=latest.height&&H.test(cache.blockHash??'')){
  const currentHash=await rpc('getblockhash',[cache.height]);
  if(currentHash===cache.blockHash)return validateRecord(cache,name,expectedValue);
 }
 const tipHash=await rpc('getblockhash',[latest.height]);
 for(let height=latest.height;height>=1;height--){
  const hash=await rpc('getblockhash',[height]);
  const block=await rpc('getblock',[hash,2]);
  if(!Array.isArray(block?.tx))throw Error('ROD_NAME_ORIGIN_FULL_BLOCK_REQUIRED');
  for(const tx of block.tx){
   if(!Array.isArray(tx.vout))continue;
   for(const out of tx.vout){const op=out.scriptPubKey?.nameOp;
    if(!op||op.name!==name||!['name_register','name_firstupdate'].includes(op.op))continue;
    // The nearest registration before the current name update is the active
    // identity. Never accidentally adopt an expired prior registration.
    const initial=validateRecord({height,txid:tx.txid,blockHash:hash,value:op.value},name,expectedValue);
    if(await rpc('getblockhash',[latest.height])!==tipHash)throw Error('ROD_NAME_ORIGIN_CHAIN_CHANGED_DURING_SCAN');
    if(cacheFile)await atomicWriteFile(cacheFile,JSON.stringify({schema:1,name,value:expectedValue,
      lastKnownHeight:latest.height,lastKnownTxid:latest.txid,...initial})+'\n');
    return initial;
   }
  }
  if(height%500===0)onStatus('ROD_NAME_ORIGIN_CATCHUP',{name,scannedThrough:height,startHeight:latest.height});
 }
 throw Error('ROD_NAME_ORIGIN_REGISTRATION_NOT_FOUND');
}
