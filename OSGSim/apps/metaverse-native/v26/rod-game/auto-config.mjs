// SPDX-License-Identifier: MIT
// Zero-manual-input discovery for an already ROD-enabled universe.
// Verifies Nostr + ROD before preparing any local native launch configuration.
// Existing legacy-only (host-fenced) ads cannot silently become ROD worlds.
import {mkdir,stat} from 'node:fs/promises';
import {atomicWriteFile} from '../fs-util.mjs';
import {join,resolve} from 'node:path';
import {randomBytes} from 'node:crypto';
import {createInterface} from 'node:readline/promises';
import {stdin,stdout} from 'node:process';
import {identifyInstall,discoverLocalRpc,announceFunding,NTP_HOSTS} from '../single-address/local-runtime.mjs';
import {rpcClient} from '../rpc-adapter.mjs';
import {canonicalWorldManifest} from '../world-manifest.mjs';
import {loadBrightonPort} from '../spawn-ports.mjs';
import {installedRealmName} from '../single-address/realm-init.mjs';
import {openRodNostr} from './nostr-bootstrap.mjs';
import {ensureRodPlayerName} from './player-identity.mjs';
import {findRodNameOrigin} from './name-origin.mjs';
import {selectRodZmqEndpoints} from './zmq-preflight.mjs';
const H=/^[a-f0-9]{64}$/;
const isFile=async path=>{try{return(await stat(path)).isFile()}catch{return false}};
export async function locateOsgRuntime(root){for(const dir of [process.env.OSG_MULTI_SOURCE_DIR,join(root,'OmniSpatialGraph-multi'),join(root,'OSGSim','OmniSpatialGraph-multi')].filter(Boolean)){
 if(await isFile(join(dir,'dist/core/src/index.js'))&&await isFile(join(dir,'dist/storage-lance/src/index.js')))return resolve(dir);
 }throw Error('ROD_AUTO_OSG_MULTI_NOT_INSTALLED');}
/** The only interactive step is an explicit request to choose among already
 * cryptographically verified Nostr + ROD universes. Normal startup is silent. */
export async function promptUniverseChoice(worlds,{input=stdin,output=stdout}={}){
 if(!Array.isArray(worlds)||!worlds.length)throw Error('ROD_NOSTR_NO_VERIFIED_DISTRIBUTED_UNIVERSE');
 if(worlds.length===1)return worlds[0];
 if(!input.isTTY)throw Error('ROD_UNIVERSE_SELECTION_REQUIRES_TERMINAL_OR_UNIVERSE_FLAG');
 const menu=worlds.map((w,i)=>`${i+1}. ${w.realmName}  ${w.worldId}  [${w.source}]`).join('\n');
 const ui=createInterface({input,output});
 try{
  output.write('Verified Nostr / ROD universes:\n'+menu+'\n');
  for(let attempt=0;attempt<3;attempt++){
   const answer=(await ui.question('Choose universe number: ')).trim();
   const index=Number(answer);
   if(/^\d+$/.test(answer)&&Number.isSafeInteger(index)&&index>=1&&index<=worlds.length)return worlds[index-1];
  }
  throw Error('ROD_UNIVERSE_SELECTION_NOT_COMPLETED');
 }finally{ui.close()}
}

/** One-time configuration is derived from independently verified public state. */
export async function bootstrapRodAutoConfig({root:location=process.cwd(),rpcAdapter=rpcClient,
 relayOverride=null,localRelays=[],skipRelays=[],universe=null,autoSelect=true,listOnly=false,
 autoRegisterPlayer=true,playerRegistrationTimeoutMs=3600000,choose=false,keepNostrOpen=false,onStatus=()=>{},
 openNostr=openRodNostr,findGraph=locateOsgRuntime,
 findInstall=identifyInstall,findRealm=installedRealmName,findRpc=discoverLocalRpc,
 findManifest=canonicalWorldManifest,findPort=loadBrightonPort,ensurePlayer=ensureRodPlayerName,selectUniverse=promptUniverseChoice}={}){
 // --universe may name the realm (e.g. spexgsp/universe/mine); it is then also looked up in the ROD directory.
 const root=await findInstall(location),realmName=/^[a-z]+\/[a-z0-9/._:-]{2,240}$/.test(universe??'')?universe:await findRealm(root);
 const runtime=await findRpc(root,{rpcClient:rpcAdapter});
 const {rpc,config:rodRpc}=runtime;
 // Informational: a failure here must not stop the launch.
 await announceFunding({rpc,wallet:runtime.wallet,root,onStatus}).catch(e=>onStatus('FUNDING_ADDRESS_UNAVAILABLE',{reason:e.message}));
 const {worldId:assetRoot}=await findManifest(root);
 const rodGenesis=await rpc('getblockhash',[0]);if(!H.test(rodGenesis))throw Error('ROD_AUTO_GENESIS_INVALID');
 const port=await findPort(join(root,'Config','Moon','Base','Brighton.cfg'),{available:null});
 const bridge=await openNostr({root,rpc,port,assetRoot,rodGenesis,relayOverride,localRelays,skipRelays,realmName,requested:universe,
  autoSelect,deferChoice:choose,onStatus});
 let handedOff=false;
 try{
  if(listOnly){return{worlds:bridge.worlds.map(x=>({worldId:x.worldId,realmName:x.realmName,gameId:x.gameId,source:x.source})),listOnly:true};}
  const chosen=bridge.selected??(choose&&bridge.worlds.length?await selectUniverse(bridge.worlds):null);
  if(!chosen)throw Error('ROD_AUTO_NO_VERIFIED_DISTRIBUTED_UNIVERSE');
  if(universe&&chosen.worldId!==universe&&chosen.realmName!==universe)throw Error('ROD_AUTO_UNIVERSE_MISMATCH');
  const gameRecord=await rpc('name_show',['g/'+chosen.gameId]);
  if(!Number.isSafeInteger(gameRecord.height)||gameRecord.height<1)throw Error('ROD_AUTO_GAME_NOT_CONFIRMED');
  // No mandatory daemon reindex: verify the original g/ registration from
  // name_history when available or from the confirmed on-chain blocks.
  const cacheDir=join(root,'OSGSim','.data','rod-primary-world',chosen.worldId.slice(0,16));
  const origin=await findRodNameOrigin({rpc,name:'g/'+chosen.gameId,current:gameRecord,
   expectedValue:gameRecord.value,cacheFile:join(cacheDir,'game-origin.json'),onStatus});
  // Enforce all non-spending prerequisites BEFORE registering a player name.
  const graphDir=await findGraph(root);
  const endpoints=selectRodZmqEndpoints(await rpc('getzmqnotifications',[]),{requested:process.env.OSGSIM_ROD_ZMQ_ADDRESS??null});
  const dataDir=join(root,'OSGSim','.data','rod-primary-world',chosen.worldId.slice(0,16));
  await mkdir(dataDir,{recursive:true});
  const identity=await ensurePlayer({rpc,worldId:chosen.worldId,
   nostrPubkey:(await import('../single-address/crypto.mjs')).publicKey(bridge.identity),
   journalFile:join(dataDir,'player-registration.json'),allowRegistration:autoRegisterPlayer,
   timeoutMs:playerRegistrationTimeoutMs,onStatus});
  const config={schema:1,metaverseRoot:root,osgMultiSourceDir:graphDir,dataDir,rodRpc,
   worldId:chosen.worldId,assetRoot,rodGenesis,gameId:chosen.gameId,startHeight:origin.height,
   playerName:identity.playerName,walletAddress:identity.address,clock:chosen.clock,
   runNonce:randomBytes(16).toString('hex'),zmqAddress:endpoints.length===1?endpoints[0]:null,
   python:process.env.OSGSIM_PYTHON??'python',ntpHosts:NTP_HOSTS,
   portSlots:port.slots.length,joinDepth:6,localEndpointPort:0,chainLimit:15,publishPollMs:1200,
   samplePublishMs:1200,pollMs:20000,launchNative:true,
   realmName:chosen.realmName,autoSelect:true,universe:chosen.worldId};
  const configFile=join(dataDir,'ROD-DISTRIBUTED.json');
  await atomicWriteFile(configFile,JSON.stringify(config,null,2)+'\n');
  onStatus('ROD_AUTO_CONFIG_READY',{worldId:chosen.worldId,gameId:chosen.gameId,player:identity.name});
  const result={configFile,config,selected:chosen,worlds:bridge.worlds};
  if(keepNostrOpen){handedOff=true;result.nostr=bridge;}
  return result;
 }finally{if(!handedOff)await bridge.close()}
}
