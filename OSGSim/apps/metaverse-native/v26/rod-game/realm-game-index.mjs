// SPDX-License-Identifier: MIT
// Find the g/ game bound to a confirmed realm directory. Every candidate comes from canonical ROD name
// state and is verified against a genesis rebuilt from its own clock; nothing is taken from a relay.
import {verifyDistributedRealm} from './nostr-peer.mjs';
import {gameGenesis} from './protocol.mjs';
const GAME=/^g\/[A-Za-z0-9]{1,40}$/;

export async function resolveRegisteredRealmGame({rpc,directory,port,rodGenesis,explicitGameId=null,pageSize=250,maxPages=16}={}){
 if(typeof rpc!=='function'||!directory?.worldId||!port?.configSha256||!rodGenesis)throw Error('ROD_REALM_GAME_LOOKUP_INVALID');
 if(explicitGameId!==null&&!/^[A-Za-z0-9]{1,40}$/.test(explicitGameId))throw Error('ROD_REALM_GAME_HINT_INVALID');
 const match=record=>{
  if(!GAME.test(record?.name??''))return null;
  let value;try{value=JSON.parse(record.value);}catch{return null;}
  const clock=value?.clock;if(!clock||typeof clock!=='object')return null;
  try{verifyDistributedRealm({directory,gameRecord:record,gameId:record.name.slice(2),
   genesis:gameGenesis({world:directory.worldId,assetRoot:directory.assetRoot,rodGenesis,port,clock}),rodGenesis});}
  catch{return null;}
  return{gameId:record.name.slice(2),clock};
 };
 if(explicitGameId!==null){
  const resolved=match({...await rpc('name_show',['g/'+explicitGameId]),name:'g/'+explicitGameId});
  if(!resolved)throw Error('ROD_REALM_GAME_HINT_NOT_CANONICAL');
  return resolved;
 }
 if(!Number.isSafeInteger(pageSize)||pageSize<2||pageSize>500||!Number.isSafeInteger(maxPages)||maxPages<1||maxPages>100)
  throw Error('ROD_REALM_GAME_SCAN_LIMIT_INVALID');
 // name_scan returns current name records (value, address, height), so no per-name lookup is needed.
 let from='g/',exhausted=false;const matches=new Map();
 for(let page=0;page<maxPages;page++){
  const rows=await rpc('name_scan',[from,pageSize]);
  if(!Array.isArray(rows)||rows.length>pageSize)throw Error('ROD_REALM_GAME_SCAN_INVALID');
  for(const item of rows){if(typeof item?.name!=='string')throw Error('ROD_REALM_GAME_SCAN_INVALID');
   if(!item.name.startsWith('g/'))continue;
   const found=match(item);if(found)matches.set(found.gameId,found);
  }
  const lastName=rows.at(-1)?.name;
  if(!rows.length||!lastName?.startsWith('g/')||rows.length<pageSize){exhausted=true;break}
  if(lastName<=from)throw Error('ROD_REALM_GAME_SCAN_STALLED');
  from=lastName;
 }
 if(!exhausted)throw Error('ROD_REALM_GAME_SCAN_LIMIT_EXCEEDED');
 if(matches.size>1)throw Error('ROD_REALM_AMBIGUOUS_DISTRIBUTED_GAME');
 return [...matches.values()][0]??null;
}
