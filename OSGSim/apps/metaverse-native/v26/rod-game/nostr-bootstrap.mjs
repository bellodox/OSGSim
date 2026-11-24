// SPDX-License-Identifier: MIT
// Universe discovery: signed peer advertisements on the operator relays, with the confirmed ROD realm
// directory as the fallback. ROD is the trust root either way; a relay only carries locators.
import {join} from 'node:path';
import {sleep} from '../fs-util.mjs';
import {RelayPool} from '../single-address/relay-pool.mjs';
import {bootstrapRelays} from '../single-address/universe-catalog.mjs';
import {getRodDirectory} from '../single-address/resolver.mjs';
import {secretFile} from '../single-address/local-runtime.mjs';
import {disciplineBootstrapClock} from '../single-address/bootstrap-clock.mjs';
import {discoverRodPeerUniverses,buildRodPeerAdvertisement} from './nostr-peer.mjs';
import {resolveRegisteredRealmGame} from './realm-game-index.mjs';
const H=/^[a-f0-9]{64}$/;

export function selectRodUniverse(candidates,{requested=null,assetRoot,rodGenesis}={}){
 if(!Array.isArray(candidates)||candidates.length>64)throw Error('ROD_NOSTR_INVALID_UNIVERSE_CATALOG');
 const matching=candidates.filter(x=>(!assetRoot||x.assetRoot===assetRoot)&&(!rodGenesis||x.rodGenesis===rodGenesis));
 if(requested){const chosen=matching.filter(x=>x.worldId===requested||x.realmName===requested);
  if(chosen.length!==1)throw Error('ROD_NOSTR_REQUESTED_UNIVERSE_NOT_FOUND');return chosen[0];}
 if(!matching.length)throw Error('ROD_NOSTR_NO_VERIFIED_DISTRIBUTED_UNIVERSE');
 if(matching.length===1)return matching[0];
 // No lexicographic auto-choice: an explicit choice or a unique verified match is required.
 throw Error('ROD_NOSTR_MULTIPLE_UNIVERSES_SELECT_ONE');
}

/** The universe registered in the confirmed ROD realm directory: realm name -> worldId, then the g/ game
 * whose genesis binds that world. Works while no peer is online to advertise it. */
export async function discoverRodDirectoryUniverse({rpc,realmName,port,assetRoot,rodGenesis}={}){
 if(!realmName)return null;
 let found;try{found=await getRodDirectory(rpc,{realmName});}catch{return null;}
 const directory=found.directory;
 if(directory.assetRoot!==assetRoot||directory.rodGenesis!==rodGenesis)return null;
 const game=await resolveRegisteredRealmGame({rpc,directory,port,rodGenesis});
 if(!game)return null;
 return{worldId:directory.worldId,realmName,assetRoot,rodGenesis,gameId:game.gameId,clock:game.clock,source:'rod-directory'};
}

/** Peer advertisements (Nostr) first; the ROD realm directory always contributes as well. */
export async function discoverRodUniverses({relay,rpc,port,assetRoot,rodGenesis,realmName=null,timeoutMs=6000,nowSec=Math.floor(Date.now()/1000),onStatus=()=>{}}={}){
 let peers=[];
 try{peers=await discoverRodPeerUniverses(relay,rpc,{port,assetRoot,rodGenesis,timeoutMs,nowSec});}
 catch(e){onStatus('NOSTR_PEER_DISCOVERY_UNAVAILABLE',{reason:String(e.message).slice(0,160)});}
 const candidates=peers.map(x=>({worldId:x.claim.worldId,realmName:x.claim.realmName,assetRoot:x.claim.assetRoot,
  rodGenesis:x.claim.rodGenesis,gameId:x.claim.gameId,clock:x.genesis.clock,source:'distributed-peer',advert:x}));
 const fromRod=await discoverRodDirectoryUniverse({rpc,realmName,port,assetRoot,rodGenesis});
 if(fromRod)candidates.push(fromRod);
 const byWorld=new Map();
 for(const item of candidates){const old=byWorld.get(item.worldId);
  if(old&&(old.gameId!==item.gameId||JSON.stringify(old.clock)!==JSON.stringify(item.clock)||old.realmName!==item.realmName))
   throw Error('ROD_NOSTR_CONFLICTING_DISCOVERED_UNIVERSE');
  if(!old||item.source==='distributed-peer')byWorld.set(item.worldId,item);
 }
 return [...byWorld.values()].sort((a,b)=>a.realmName.localeCompare(b.realmName)||a.worldId.localeCompare(b.worldId));
}

/** Keep a live Nostr connection for discovery AND evidence, not only a preflight ping. */
export async function openRodNostr({root,rpc,port,assetRoot,rodGenesis,relayOverride=null,localRelays=[],realmName=null,requested=null,
  autoSelect=true,deferChoice=false,expectedWorldId=null,expectedGameId=null,secret=null,pool=null,clock=null,skipRelays=[],
  onStatus=()=>{},nowSec=null,maxAttempts=12,retryMs=2500}={}){
 if(!root||typeof rpc!=='function'||!port||!H.test(assetRoot??'')||!H.test(rodGenesis??''))throw Error('ROD_NOSTR_CONFIGURATION_INVALID');
 const disciplined=clock?{clock}:await disciplineBootstrapClock(['time.cloudflare.com','time.google.com','pool.ntp.org']);
 const identity=secret??await secretFile(join(root,'OSGSim','.data','spexgsp-single-address','device-nostr-secret'));
 const pins=new Map();
 const urls=pool?[]:await bootstrapRelays({root,relayOverride,rpc,localRelays,realmName,pins,skipRelays});
 const relay=pool??new RelayPool({urls,secret:identity,clock:disciplined.clock,pins});
 try{
  if(!pool)await relay.connect();
  if(!Number.isSafeInteger(maxAttempts)||maxAttempts<1||maxAttempts>30)throw Error('ROD_NOSTR_DISCOVERY_ATTEMPTS_INVALID');
  let worlds=[];
  for(let attempt=0;attempt<maxAttempts;attempt++){
   worlds=await discoverRodUniverses({relay,rpc,port,assetRoot,rodGenesis,realmName,onStatus,nowSec:nowSec??Math.floor(disciplined.clock()/1000)});
   if(worlds.length&&(!(requested??expectedWorldId)||worlds.some(x=>x.worldId===(requested??expectedWorldId)||x.realmName===(requested??expectedWorldId))))break;
   if(attempt+1<maxAttempts)await sleep(retryMs);
  }
  onStatus('NOSTR_ROD_CATALOG',{verified:worlds.map(x=>({realmName:x.realmName,worldId:x.worldId,source:x.source,gameId:x.gameId}))});
  let selected=null;
  if(worlds.length&&(!(requested??expectedWorldId)||worlds.some(x=>x.worldId===(requested??expectedWorldId)||x.realmName===(requested??expectedWorldId))))
   selected=deferChoice&&!autoSelect&&!requested&&!expectedWorldId&&worlds.length>1
    ?null:selectRodUniverse(worlds,{requested:requested??expectedWorldId,assetRoot,rodGenesis});
  else{
   onStatus('NOSTR_NO_MATCHING_UNIVERSE_HINT',{localAssetRoot:assetRoot,realmName,hint:'A universe matches only when its realm directory names the same asset fingerprint (the installed Metaverse configuration, celestial-body modules and executables). Check that the Metaverse installation is identical to the owner\'s and that the realm name is right.'});
   throw Error('ROD_NOSTR_NO_DISTRIBUTED_UNIVERSE_ADVERTISED');}
  if(selected){
   if(expectedWorldId&&selected.worldId!==expectedWorldId||expectedGameId&&selected.gameId!==expectedGameId)
    throw Error('ROD_NOSTR_DISCOVERED_WORLD_CONFLICTS_WITH_LOCAL_CONFIGURATION');
   onStatus('NOSTR_DISTRIBUTED_WORLD_SELECTED',{worldId:selected.worldId,realmName:selected.realmName,gameId:selected.gameId,source:selected.source});
  }
  return {relay,identity,selected,worlds,clock:disciplined.clock,async close(){if(!pool)await relay.close();}};
 }catch(e){if(!pool)await relay.close();throw e;}
}

export class RodPeerNostrAdvertiser{
 constructor({bridge,rpc,realmName,worldId,assetRoot,rodGenesis,gameId,player,ownerAddress,clock,port,onStatus=()=>{}}={}){
  Object.assign(this,{bridge,rpc,realmName,worldId,assetRoot,rodGenesis,gameId,player,ownerAddress,clock,port,onStatus});
  this.lastRoot=null;this.lastTime=0;this.pending=false;this.closed=false;
 }
 async tick(frontier){if(this.closed||this.pending||!frontier?.confirmedRoot||!H.test(frontier.tip??'')||!Number.isSafeInteger(frontier.height)||
   frontier.height<1||!frontier.roster?.includes(this.player))return;
  const nowSec=Math.floor(this.bridge.clock()/1000);
  if(nowSec<=this.lastTime||frontier.confirmedRoot===this.lastRoot&&nowSec-this.lastTime<120)return;
  this.pending=true;
  try{const event=await buildRodPeerAdvertisement({rpc:this.rpc,secret:this.bridge.identity,realmName:this.realmName,
   worldId:this.worldId,assetRoot:this.assetRoot,rodGenesis:this.rodGenesis,gameId:this.gameId,player:this.player,ownerAddress:this.ownerAddress,
   clock:this.clock,port:this.port,frontier:{confirmedRoot:frontier.confirmedRoot,tip:frontier.tip,height:frontier.height},nostrHistory:frontier.nostrHistory??null,nowSec});
   await this.bridge.relay.publish(event);
   this.lastRoot=frontier.confirmedRoot;this.lastTime=nowSec;
   this.onStatus('NOSTR_ROD_PEER_ADVERTISED',{eventId:event.id,worldId:this.worldId,rodHeight:frontier.height});
  }finally{this.pending=false;}
 }
 async close(){this.closed=true;}
}
