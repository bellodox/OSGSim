#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Owner tool: create a new SpeXGSP universe on ROD mainnet. It registers two names owned by one address:
//   <realmName>   realm directory  {schema:'spexgsp/realm/1', realmId, ownerAddress, publisher, worldId, assetRoot, rodGenesis, era, relays?, relayPins?}
//                 relayHost in realm-authority.json (an IP address or name) makes this tool generate the relay's TLS certificate
//                 and publish the relay URL plus the certificate key hash, so joiners trust the relay through ROD alone.
//   g/<gameId>    game genesis     {schema:1, protocol, worldId, assetRoot, rodGenesis, portHash, clock}
// Joiners verify both from their own ROD node (rod-game/nostr-bootstrap.mjs discoverRodDirectoryUniverse).
// Re-running continues an interrupted creation: every value is fixed in a journal before anything is broadcast,
// and a name is only registered again after the earlier transaction is provably absent for several blocks.
import {readFile} from 'node:fs/promises';
import {sleep,atomicWriteFile} from '../apps/metaverse-native/v26/fs-util.mjs';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {identifyInstall,discoverLocalRpc,secretFile} from '../apps/metaverse-native/v26/single-address/local-runtime.mjs';
import {rpcClient} from '../apps/metaverse-native/v26/rpc-adapter.mjs';
import {requireRodMainnet} from '../apps/metaverse-native/v26/single-address/network-policy.mjs';
import {publicKey} from '../apps/metaverse-native/v26/single-address/crypto.mjs';
import {genesisWorldId} from '../apps/metaverse-native/v26/single-address/realm-init.mjs';
import {DEFAULT_REALM_NAME,safeRelayUrl} from '../apps/metaverse-native/v26/single-address/resolver.mjs';
import {ensureRelayCertificate,validRelayHost,relayUrl,RELAY_DEFAULT_PORT} from '../apps/metaverse-native/v26/single-address/relay-cert.mjs';
import {canonicalWorldManifest} from '../apps/metaverse-native/v26/world-manifest.mjs';
import {loadBrightonPort} from '../apps/metaverse-native/v26/spawn-ports.mjs';
import {validateTimePolicy} from '../apps/metaverse-native/v26/world-time.mjs';
import {gameGenesis} from '../apps/metaverse-native/v26/rod-game/protocol.mjs';
import {isDefiniteRpcRefusal} from '../apps/metaverse-native/v26/rod-game/rpc-errors.mjs';
import {discoverRodDirectoryUniverse} from '../apps/metaverse-native/v26/rod-game/nostr-bootstrap.mjs';
import {canonical} from '../apps/metaverse-native/v26/ownership.mjs';

const H=/^[a-f0-9]{64}$/,REALM=/^[a-z]+\/[a-z0-9/._:-]{2,240}$/,REALM_ID=/^[a-z0-9][a-z0-9:/._-]{2,96}$/,GAME=/^[A-Za-z0-9]{1,40}$/;
const UNIX_EPOCH_MJD=40587,DAY_MS=86400000,REREGISTER_AFTER_BLOCKS=3;
const log=(type,info={})=>console.log('SPEXGSP_CREATE_'+type+' '+JSON.stringify(info));
const missingName=e=>/name.*(?:not found|does not exist|unknown)|no such name/i.test(String(e?.message??e));
const atomic=(file,value)=>atomicWriteFile(file,JSON.stringify(value,null,1)+'\n');

/** Validate the owner's realm-authority.json. Only the fields below are read. */
export function readAuthority(raw){
 const a=JSON.parse(raw);
 if(a?.schema!==1)throw Error('REALM_AUTHORITY_SCHEMA_MUST_BE_1');
 const realmName=a.realmName??DEFAULT_REALM_NAME;
 if(!REALM.test(realmName))throw Error('REALM_AUTHORITY_INVALID_REALM_NAME');
 if(!REALM_ID.test(a.realmId??''))throw Error('REALM_AUTHORITY_INVALID_REALM_ID');
 if(!GAME.test(a.gameId??''))throw Error('REALM_AUTHORITY_INVALID_GAME_ID (1-40 letters/digits)');
 if(a.ownerAddress!==undefined&&a.ownerAddress!==null&&(typeof a.ownerAddress!=='string'||!/^[1-9A-HJ-NP-Za-km-z]{25,64}$/.test(a.ownerAddress)))
  throw Error('REALM_AUTHORITY_OWNER_ADDRESS_MUST_BE_LEGACY_BASE58');
 const relays=a.relays??[];
 if(!Array.isArray(relays)||relays.length>6)throw Error('REALM_AUTHORITY_RELAYS_MAX_6');
 // relayHost is an IP address, optionally with its port: "203.0.113.7", "203.0.113.7:7447" or "[2001:db8::1]:7447". No host names.
 let relayHost=a.relayHost??null,relayPort=a.relayPort??RELAY_DEFAULT_PORT;
 if(typeof relayHost==='string'&&!validRelayHost(relayHost)){
  const m=/^\[([^\]]+)\]:(\d{1,5})$/.exec(relayHost)??/^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(relayHost);
  if(m){
   if(a.relayPort!==undefined&&a.relayPort!==Number(m[2]))throw Error('REALM_AUTHORITY_RELAY_PORT_CONFLICT: relayHost and relayPort name different ports');
   relayHost=m[1];relayPort=Number(m[2]);
  }
 }
 if(relayHost!==null&&!validRelayHost(relayHost))throw Error('REALM_AUTHORITY_INVALID_RELAY_HOST (an IP address, optionally with :port; no host names)');
 if(!Number.isInteger(relayPort)||relayPort<1||relayPort>65535)throw Error('REALM_AUTHORITY_INVALID_RELAY_PORT');
 const own=relayHost?relayUrl(relayHost,relayPort):null;
 const list=[...new Set([...relays.map(u=>safeRelayUrl(u)),...(own?[safeRelayUrl(own)]:[])])];
 if(list.length>6)throw Error('REALM_AUTHORITY_RELAYS_MAX_6');
 return{realmName,realmId:a.realmId,gameId:a.gameId,ownerAddress:a.ownerAddress??null,relays:list,relayHost,relayUrl:own};
}

/** The two name values, fixed once per creation and stored in the journal. */
export function universeValues({realmId,ownerAddress,publisher,assetRoot,rodGenesis,genesisNonce,port,utcOriginMs,relays,relayPins={}}){
 const worldId=genesisWorldId({realmId,rodGenesis,assetRoot,genesisNonce});
 const directory={schema:'spexgsp/realm/1',realmId,ownerAddress,publisher,worldId,assetRoot,rodGenesis,era:1,...(relays.length?{relays}:{}),...(Object.keys(relayPins??{}).length?{relayPins}:{})};
 const clock=validateTimePolicy({schema:1,utcOriginMs,simMjd0:UNIX_EPOCH_MJD+utcOriginMs/DAY_MS,rate:1,era:1});
 const game=gameGenesis({world:worldId,assetRoot,rodGenesis,port,clock:{...clock}});
 const directoryValue=JSON.stringify(directory),gameValue=JSON.stringify(game);
 for(const v of [directoryValue,gameValue])if(Buffer.byteLength(v,'utf8')>2048)throw Error('ROD_NAME_VALUE_EXCEEDS_2048_BYTES');
 return{worldId,directoryValue,gameValue};
}

/** Register one name idempotently. Returns when the name is confirmed with exactly this value and owner. */
export async function registerName({rpc,name,value,ownerAddress,record,save,pollMs=5000,timeoutMs=3*3600000}){
 const deadline=Date.now()+timeoutMs;let refusals=0;
 while(Date.now()<deadline){
  let shown=null;try{shown=await rpc('name_show',[name]);}catch(e){if(!missingName(e))throw e;}
  if(shown){
   if(shown.value!==value||shown.address!==ownerAddress)throw Error('ROD_NAME_ALREADY_REGISTERED_WITH_OTHER_VALUE_OR_OWNER: '+name);
   if(Number.isSafeInteger(shown.height)&&shown.height>=1){record.txid=shown.txid;record.height=shown.height;record.status='CONFIRMED';await save();return shown;}
  }
  const pending=(await rpc('name_pending',[name])).filter(x=>x.name===name);
  if(pending.some(x=>x.value!==value))throw Error('ROD_NAME_PENDING_WITH_OTHER_VALUE: '+name);
  if(pending.length){if(record.txid!==pending[0].txid){record.txid=pending[0].txid;record.status='PENDING';await save();}
   log('WAITING_FOR_CONFIRMATION',{name,txid:record.txid});await sleep(pollMs);continue;}
  const height=(await rpc('getblockchaininfo',[])).blocks;
  // Broadcast earlier but neither pending nor confirmed: only re-register once it has stayed absent for a few blocks.
  if(record.status==='PENDING'&&Number.isSafeInteger(record.sentHeight)&&height-record.sentHeight<REREGISTER_AFTER_BLOCKS){await sleep(pollMs);continue;}
  try{
   record.status='SENDING';record.sentHeight=height;await save();
   const txid=await rpc('name_register',[name,value,{destAddress:ownerAddress}]);
   if(!H.test(txid??''))throw Error('ROD_NAME_REGISTER_RETURNED_INVALID_TXID');
   record.txid=txid;record.status='PENDING';await save();log('NAME_REGISTER_SENT',{name,txid});
  }catch(e){
   if(!isDefiniteRpcRefusal(e)){record.status='PENDING';await save();throw Error('ROD_NAME_REGISTER_OUTCOME_UNKNOWN: re-run this tool to continue safely ('+e.message+')');}
   record.status='REFUSED';await save();refusals++;
   log('NAME_REGISTER_REFUSED',{name,reason:e.message,code:e.code,fundAddress:ownerAddress,hint:'fund and unlock the wallet that holds ownerAddress; retrying'});
   await sleep(Math.min(60000,pollMs*refusals));continue;
  }
  await sleep(pollMs);
 }
 throw Error('ROD_NAME_REGISTRATION_TIMEOUT: '+name+' (re-run to continue)');
}

export async function createUniverse({root,rpc,walletRpc=null,wallets=[],now=()=>Date.now(),pollMs=5000}={}){
 const authority=readAuthority(await readFile(join(root,'OSGSim','realm-authority.json'),'utf8'));
 await requireRodMainnet(rpc);
 const rodGenesis=await rpc('getblockhash',[0]);if(!H.test(rodGenesis))throw Error('ROD_GENESIS_INVALID');
 const {worldId:assetRoot}=await canonicalWorldManifest(root);
 const port=await loadBrightonPort(join(root,'Config','Moon','Base','Brighton.cfg'),{available:null});
 // The same device Nostr identity the peer uses; it is published as the realm's publisher key.
 const publisher=publicKey(await secretFile(join(root,'OSGSim','.data','spexgsp-single-address','device-nostr-secret')));
 const journalFile=join(root,'OSGSim','.data','universe-create',authority.realmName.replace(/[^a-z0-9]+/g,'_')+'.json');
 let journal=null;try{journal=JSON.parse(await readFile(journalFile,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;}
 // The relay certificate is created (or reused) before the values are fixed: its key hash goes into the directory.
 let relayPins={};
 if(authority.relayHost){
  const cert=await ensureRelayCertificate({dir:join(root,'OSGSim','.data','spexgsp-single-address','relay-tls'),host:authority.relayHost,now:now()});
  relayPins={[authority.relayUrl]:cert.pin};
  log('RELAY_CERTIFICATE',{url:authority.relayUrl,pin:cert.pin,created:cert.created});
 }
 // Pick the wallet that signs: the one holding ownerAddress, or the peer's own wallet for a fresh address.
 let signer=rpc,ownerAddress=journal?.ownerAddress??authority.ownerAddress;
 if(ownerAddress){
  let found=false;
  for(const candidate of [rpc,...(walletRpc?wallets.map(walletRpc):[])]){
   const info=await candidate('getaddressinfo',[ownerAddress]).catch(()=>null);if(info?.ismine===true){signer=candidate;found=true;break;}
  }
  if(!found)throw Error('OWNER_ADDRESS_NOT_IN_ANY_LOADED_WALLET: '+ownerAddress);
 }else ownerAddress=await rpc('getnewaddress',['spexgsp-universe-owner','legacy']);
 if(journal){
  for(const k of ['realmName','realmId','gameId'])if(journal[k]!==authority[k])throw Error('UNIVERSE_JOURNAL_CONFLICTS_WITH_REALM_AUTHORITY_'+k);
  if(authority.relayHost&&canonical(journal.relayPins??{})!==canonical(relayPins))throw Error('RELAY_CERTIFICATE_DIFFERS_FROM_THE_ONE_IN_THE_UNIVERSE_JOURNAL: keep OSGSim\\.data\\spexgsp-single-address\\relay-tls unchanged until the universe is created');
  if(journal.rodGenesis!==rodGenesis||journal.assetRoot!==assetRoot||journal.publisher!==publisher||journal.portHash!==port.configSha256)
   throw Error('UNIVERSE_JOURNAL_FROM_DIFFERENT_INSTALL_OR_CHAIN: move '+journalFile+' away to start a new creation');
 }else{
  journal={schema:1,realmName:authority.realmName,realmId:authority.realmId,gameId:authority.gameId,ownerAddress,publisher,rodGenesis,assetRoot,
   portHash:port.configSha256,genesisNonce:randomBytes(32).toString('hex'),utcOriginMs:Math.floor(now()/1000)*1000,relays:authority.relays,relayPins,
   realm:{status:'NEW'},game:{status:'NEW'}};
  const {worldId,directoryValue,gameValue}=universeValues({...journal,port});
  Object.assign(journal,{worldId,directoryValue,gameValue});await atomic(journalFile,journal);
 }
 const check=universeValues({...journal,port});
 if(check.worldId!==journal.worldId||check.directoryValue!==journal.directoryValue||check.gameValue!==journal.gameValue)throw Error('UNIVERSE_JOURNAL_VALUES_TAMPERED');
 log('PLAN',{realmName:journal.realmName,gameName:'g/'+journal.gameId,worldId:journal.worldId,ownerAddress:journal.ownerAddress,fundAddress:journal.ownerAddress,relays:journal.relays,relayPins:journal.relayPins,journal:journalFile});
 // Both registrations update the one journal: serialize the writes (each atomic write uses one temp file).
 let saving=Promise.resolve();const save=()=>(saving=saving.catch(()=>{}).then(()=>atomic(journalFile,journal)));
 await Promise.all([
  registerName({rpc:signer,name:journal.realmName,value:journal.directoryValue,ownerAddress:journal.ownerAddress,record:journal.realm,save,pollMs}),
  registerName({rpc:signer,name:'g/'+journal.gameId,value:journal.gameValue,ownerAddress:journal.ownerAddress,record:journal.game,save,pollMs}),
 ]);
 // Prove that joiners will find exactly this universe from ROD alone.
 const found=await discoverRodDirectoryUniverse({rpc,realmName:journal.realmName,port,assetRoot,rodGenesis});
 if(!found||found.worldId!==journal.worldId||found.gameId!==journal.gameId||canonical(found.clock)!==canonical(JSON.parse(journal.gameValue).clock))
  throw Error('CREATED_UNIVERSE_NOT_DISCOVERABLE_FROM_ROD');
 journal.status='CREATED';await save();
 log('DONE',{realmName:journal.realmName,worldId:journal.worldId,gameId:journal.gameId,ownerAddress:journal.ownerAddress,
  next:'start SpeXGSP normally; joiners use the same Metaverse installation and realm name',
  ...(authority.relayUrl?{relay:authority.relayUrl+' - start SpeXGSP on this PC, forward TCP '+new URL(authority.relayUrl).port+' on the router to it and allow it in the firewall'}:{})});
 return journal;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=await identifyInstall(process.cwd());
 const runtime=await discoverLocalRpc(root,{rpcClient});
 await createUniverse({root,rpc:runtime.rpc,walletRpc:runtime.walletRpc,wallets:runtime.wallets});
}
