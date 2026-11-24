// SPDX-License-Identifier: MIT
// Crash-recoverable, wallet-owned player name for a discovered ROD world.
// The selected ROD realm and g/ registration are verified before this runs.
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {sleep,atomicWriteFile} from '../fs-util.mjs';
import {validateMove} from './protocol.mjs';
import {findRodNameOrigin} from './name-origin.mjs';
import {isDefiniteRpcRefusal,retryDelayMs} from './rpc-errors.mjs';
const ADDRESS=/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{25,64}$/;
const H=/^[a-f0-9]{64}$/;
const atomic=(path,value)=>atomicWriteFile(path,JSON.stringify(value)+'\n',{sync:true});
// v1 names derive only from public data (world id, Nostr key) and can be
// registered in advance by anyone who knows both. A wallet-private salt (v2)
// makes the name unpredictable to everyone but the wallet that signs it.
export function playerNameForWorld(worldId,nostrPubkey,salt=null){
 if(!H.test(worldId??'')||!H.test(nostrPubkey??'')||(salt!==null&&!H.test(salt)))throw Error('ROD_PLAYER_IDENTITY_INVALID');
 const input=salt===null?'OSGSIM/PLAYER/v1\n'+worldId+'\n'+nostrPubkey:'OSGSIM/PLAYER/v2\n'+worldId+'\n'+nostrPubkey+'\n'+salt;
 return 'p/spex'+createHash('sha256').update(input).digest('hex').slice(0,28);
}
/** Deterministic, wallet-recoverable salt: the signature (RFC 6979, so stable)
 * of a fixed message by a labelled anchor address. A restored wallet keeps the
 * label and therefore the salt and name; no secret ever leaves the wallet. */
export async function deriveWalletSalt({rpc,worldId,nostrPubkey,anchor=null}={}){
 const label='osgsim/anchor/'+worldId.slice(0,16);let labelled=true;
 if(!anchor){
  try{const found=await rpc('getaddressesbylabel',[label]);anchor=Object.keys(found??{}).sort()[0]??null;}
  catch(e){if(e.code===-32601)labelled=false;else if(e.code!==-11)throw e;} // -11: label does not exist yet
 }
 // Legacy (P2PKH) only: signmessage, used for the session challenge, cannot sign with segwit addresses.
 if(!anchor)anchor=await rpc('getnewaddress',[labelled?label:'','legacy']);
 if(!ADDRESS.test(anchor??''))throw Error('ROD_PLAYER_ANCHOR_INVALID');
 await checkOwner(rpc,anchor);
 const message='OSGSIM/PLAYER-SALT/v1\n'+worldId+'\n'+nostrPubkey;
 const signature=await rpc('signmessage',[anchor,message]);
 if(typeof signature!=='string'||!signature||await rpc('verifymessage',[anchor,signature,message])!==true)throw Error('ROD_PLAYER_SALT_SIGNATURE_INVALID');
 return{anchor,salt:createHash('sha256').update('OSGSIM/PLAYER-SALT/sig\n'+signature).digest('hex'),recoverable:labelled};
}
async function checkOwner(rpc,address){const info=await rpc('getaddressinfo',[address]).catch(()=>rpc('validateaddress',[address]));
 if(info?.ismine!==true)throw Error('ROD_PLAYER_WALLET_NOT_OWNER');}
// The p/ name is a mutable game-event account. After the initial registration,
// name_update legitimately replaces its value. A reconnect must verify the
// immutable registration identity from confirmed name_history, not demand that
// the current value still equals the original registration certificate.
async function confirmed(rpc,name,address,value,worldId,cacheFile=null){
 let current;
 try{current=await rpc('name_show',[name]);}
 catch(e){if(/(?:not found|not registered|unknown name|name does not exist|no such name)/i.test(String(e.message)))return null;throw e;}
 if(current.address!==address||!Number.isSafeInteger(current.height)||current.height<1)
  throw Error('ROD_PLAYER_REGISTRATION_CONFLICT');
 if(current.value===value)return current;
 // An updated account must carry a canonical move for this particular world.
 // Never adopt an unrelated registration solely because the local wallet now
 // happens to own its output.
 let replacement;try{replacement=JSON.parse(current.value);}catch{}
 const moves=Object.entries(replacement?.g??{}).filter(([game,move])=>{
  try{validateMove(move,{world:worldId,game});return move.player===name;}catch{return false;}
 });
 if(moves.length!==1)throw Error('ROD_PLAYER_REGISTRATION_CONFLICT_ACTIVE_NAME_VALUE_INVALID');
 const original=await findRodNameOrigin({rpc,name,current,expectedValue:value,cacheFile});
 if(!Number.isSafeInteger(original.height)||original.height<1)
  throw Error('ROD_PLAYER_REGISTRATION_HISTORY_MISMATCH');
 return current;
}
/** Never repeat an unknown broadcast after a crash; require a unique pending witness. */
export async function ensureRodPlayerName({rpc,worldId,nostrPubkey,journalFile,address=null,salted=true,
 allowRegistration=false,timeoutMs=3600000,pollMs=3000,onStatus=()=>{}}={}){
 if(typeof rpc!=='function'||!journalFile||!Number.isSafeInteger(timeoutMs)||timeoutMs<=0)throw Error('ROD_PLAYER_ENROLL_CONFIG_INVALID');
 const originCache=journalFile.replace(/\.json$/,'')+'-origin.json';
 const value=JSON.stringify({schema:'spexgsp/player/1',worldId,nostrPubkey}),legacyName=playerNameForWorld(worldId,nostrPubkey);
 let journal;try{journal=JSON.parse(await readFile(journalFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 let name=legacyName,anchor=null;
 if(journal&&journal.name===legacyName&&!journal.anchor){/* in-flight or finished v1 enrollment: keep it */}
 else if(salted){
  if(journal&&!journal.anchor)throw Error('ROD_PLAYER_JOURNAL_IDENTITY_CONFLICT');
  let legacyOwned=false;
  if(!journal){ // A wallet that already owns its v1 account keeps it (no second account, no second slot).
   try{const old=await rpc('name_show',[legacyName]);await checkOwner(rpc,old.address);legacyOwned=true;}catch{}
  }
  if(!legacyOwned){
   const derived=await deriveWalletSalt({rpc,worldId,nostrPubkey,anchor:journal?.anchor??null});
   anchor=derived.anchor;name=playerNameForWorld(worldId,nostrPubkey,derived.salt);
  }
 }
 if(journal&&(journal.schema!==1||journal.name!==name||journal.worldId!==worldId||journal.value!==value))throw Error('ROD_PLAYER_JOURNAL_IDENTITY_CONFLICT');
 if(journal?.address){if(address&&address!==journal.address)throw Error('ROD_PLAYER_JOURNAL_ADDRESS_CONFLICT');address=journal.address;}
 if(!address){
  // Recover an already registered deterministic name on a new installation,
  // but only if the currently selected ROD wallet owns its receiving address.
  try{const existing=await rpc('name_show',[name]);
   await confirmed(rpc,name,existing.address,value,worldId,originCache);
   await checkOwner(rpc,existing.address);address=existing.address;
  }catch(e){if(!/(?:not found|not registered|unknown name|name does not exist|no such name)/i.test(String(e.message)))throw e;}
 }
 if(!address){if(!allowRegistration)throw Error('ROD_PLAYER_ADDRESS_REQUIRED');address=await rpc('getnewaddress',['','legacy'])}
 if(!ADDRESS.test(address))throw Error('ROD_PLAYER_ADDRESS_INVALID');await checkOwner(rpc,address);
 if(!journal){journal={schema:1,name,worldId,address,value,status:'NEW',txid:null,...(anchor?{anchor}:{})};await atomic(journalFile,journal)}
 const done=async rec=>{journal={...journal,status:'CONFIRMED',txid:rec.txid??journal.txid,height:rec.height};await atomic(journalFile,journal);
  return{name,playerName:name.slice(2),address,record:rec};};
 const already=await confirmed(rpc,name,address,value,worldId,originCache);if(already)return done(already);
 if(journal.status==='CONFIRMED')throw Error('ROD_PLAYER_CONFIRMED_NAME_WAS_ORPHANED');
 if(!allowRegistration&&journal.status==='NEW')throw Error('ROD_PLAYER_AUTOREGISTRATION_NOT_ENABLED');
 const deadline=Date.now()+timeoutMs;let refusals=0;
 while(Date.now()<deadline){
  const current=await confirmed(rpc,name,address,value,worldId,originCache);if(current)return done(current);
  const pending=await rpc('name_pending',[name]);
  if(!Array.isArray(pending))throw Error('ROD_PLAYER_PENDING_RPC_UNAVAILABLE');
  const matching=pending.filter(x=>x.name===name);
  if(matching.length>1||matching.some(x=>x.value!==value||x.address&&x.address!==address||!H.test(x.txid??'')))
   throw Error('ROD_PLAYER_PENDING_CONFLICT');
  if(matching.length===1){if(journal.txid&&journal.txid!==matching[0].txid)throw Error('ROD_PLAYER_PENDING_TX_CHANGED');
   journal={...journal,txid:matching[0].txid,status:'PENDING'};await atomic(journalFile,journal);
  }else if(journal.status==='NEW'&&allowRegistration){
   // Persist immutable intent before the RPC; do not assume a thrown RPC means
   // the transaction was never submitted to the mempool.
   journal={...journal,status:'BROADCAST_UNKNOWN'};await atomic(journalFile,journal);
   let refused=null;
   const txid=await rpc('name_register',[name,value,{destAddress:address}]).catch(e=>{
    // A definite refusal (locked or empty wallet, rejected transaction) broadcast nothing.
    if(isDefiniteRpcRefusal(e)){refused=e;return null;}
    onStatus('ROD_PLAYER_NAME_SUBMIT_UNCERTAIN',{reason:e.message});return null;});
   if(refused){
    refusals++;journal={...journal,status:'NEW'};await atomic(journalFile,journal);
    onStatus('ROD_PLAYER_NAME_REGISTER_REFUSED',{reason:refused.message,code:refused.code,attempt:refusals,fundAddress:address,hint:'send ROD to fundAddress (and unlock the wallet if it is encrypted); registration is retried automatically'});
    await sleep(retryDelayMs(refusals));continue;
   }
   if(txid){if(!H.test(txid))throw Error('ROD_PLAYER_REGISTRATION_BAD_TXID');journal={...journal,txid,status:'PENDING'};await atomic(journalFile,journal)}
   onStatus('ROD_PLAYER_REGISTRATION_SENT',{name,txid:journal.txid??null});
  }else if(journal.status==='BROADCAST_UNKNOWN'&&!matching.length){
   // An unobserved outbox event cannot be safely rebroadcast automatically.
   throw Error('ROD_PLAYER_REGISTRATION_OUTCOME_AMBIGUOUS');
  }else if(journal.status==='PENDING'&&!matching.length){
   // It could have been mined concurrently, so recheck chain next iteration.
   // If it vanished from both the chain and mempool, do not double spend.
   const again=await confirmed(rpc,name,address,value,worldId,originCache);if(again)return done(again);
   throw Error('ROD_PLAYER_REGISTRATION_DISAPPEARED');
  }
  await sleep(pollMs);
 }
 throw Error('ROD_PLAYER_REGISTRATION_WAITING_FOR_CONFIRMATION');
}
