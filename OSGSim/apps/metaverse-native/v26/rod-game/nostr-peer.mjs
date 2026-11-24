// SPDX-License-Identifier: MIT
// Nostr is mandatory discovery and complementary authenticated evidence.
// ROD game events and the local OSG projection remain the *only* world authority.
// Peer advertisements are intentionally a NEW kind (30328), leaving legacy
// fenced-host kind 30326 and its verification protocol untouched.
import {signEvent,verifyEvent,publicKey} from '../single-address/crypto.mjs';
import {canonical} from '../ownership.mjs';
import {gameGenesis,verifyGameGenesis} from './protocol.mjs';

export const DISTRIBUTED_NOSTR_KIND=30328;
const H=/^[a-f0-9]{64}$/;
const PLAYER=/^p\/[A-Za-z0-9_.-]{1,48}$/;
const GAME=/^[A-Za-z0-9]{1,40}$/;
const REALM=/^[-a-z0-9/.]{1,120}$/;
const ADDRESS=/^[123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]{25,64}$/;
const prefix='OSGSIM/ROD-NOSTR-DISTRIBUTED/v1\n';
const compact=value=>JSON.stringify(value);
const fail=message=>{throw Error(message)};

/** The realm issuer, not a random relay or wallet, fixes the world identity. */
export function verifyDistributedRealm({directory,gameRecord,gameId,genesis,rodGenesis}) {
 if(!directory||!H.test(directory.worldId??'')||!H.test(directory.assetRoot??'')||!H.test(directory.rodGenesis??'')||
    directory.rodGenesis!==rodGenesis||!ADDRESS.test(directory.ownerAddress??'')||!H.test(directory.publisher??'')||
    !GAME.test(gameId??'')||!gameRecord||gameRecord.address!==directory.ownerAddress||!Number.isSafeInteger(gameRecord.height)||gameRecord.height<1)
  fail('ROD_DISTRIBUTED_REALM_UNVERIFIED');
 verifyGameGenesis(gameRecord.value,genesis);
 if(genesis.worldId!==directory.worldId||genesis.assetRoot!==directory.assetRoot||genesis.rodGenesis!==rodGenesis)
  fail('ROD_DISTRIBUTED_GENESIS_FOREIGN_REALM');
 return {worldId:directory.worldId,gameId,assetRoot:directory.assetRoot,rodGenesis};
}

export function evidenceMessage(claim,nostrPubkey){return prefix+canonical({...claim,nostrPubkey});}

/** Sign with both ROD wallet and NIP-01 device identity. Never export a ROD key. */
export async function buildRodPeerAdvertisement({rpc,secret,realmName,worldId,assetRoot,rodGenesis,gameId,player,ownerAddress,
  clock,port,frontier,nostrHistory=null,nowSec=Math.floor(Date.now()/1000),ttl=480}={}) {
 if(typeof rpc!=='function'||!REALM.test(realmName??'')||!H.test(worldId??'')||!H.test(assetRoot??'')||
    !H.test(rodGenesis??'')||!GAME.test(gameId??'')||!PLAYER.test(player??'')||!ADDRESS.test(ownerAddress??'')||
    !H.test(frontier?.confirmedRoot??'')||!H.test(frontier?.tip??'')||!Number.isSafeInteger(frontier?.height)||
    frontier.height<1||!Number.isSafeInteger(nowSec)||ttl<60||ttl>600)
  fail('ROD_NOSTR_ADVERTISEMENT_INVALID');
 const key=publicKey(secret);
 const name=await rpc('name_show',[player]);
 if(name?.address!==ownerAddress||!Number.isSafeInteger(name?.height)||name.height<1)
  fail('ROD_NOSTR_PLAYER_NAME_NOT_CONFIRMED');
 const directoryRecord=await rpc('name_show',[realmName]);
 const directory=JSON.parse(directoryRecord.value);
 if(directoryRecord.address!==directory.ownerAddress||directory.worldId!==worldId||directory.assetRoot!==assetRoot||directory.rodGenesis!==rodGenesis)
  fail('ROD_NOSTR_DIRECTORY_INVALID');
 const gameRecord=await rpc('name_show',['g/'+gameId]);
 verifyDistributedRealm({directory,gameRecord,gameId,genesis:gameGenesis({world:worldId,assetRoot,rodGenesis,clock,port}),rodGenesis});
 const claim={schema:'spexgsp/rod-peer/1',realmName,worldId,assetRoot,rodGenesis,gameId,player,ownerAddress,
   portHash:port.configSha256,clockEra:clock.era,confirmedRoot:frontier.confirmedRoot,tip:frontier.tip,height:frontier.height,
   issuedAt:nowSec,expiresAt:nowSec+ttl};
 if(nostrHistory!==null){if(!Number.isSafeInteger(nostrHistory.sequence)||nostrHistory.sequence<0||!H.test(nostrHistory.eventHead??''))fail('ROD_NOSTR_ARCHIVE_FRONTIER_INVALID');claim.osgSequence=nostrHistory.sequence;claim.osgEventHead=nostrHistory.eventHead;}
 const signature=await rpc('signmessage',[ownerAddress,evidenceMessage(claim,key)]);
 if(typeof signature!=='string'||!signature||await rpc('verifymessage',[ownerAddress,signature,evidenceMessage(claim,key)])!==true)
  fail('ROD_NOSTR_WALLET_SIGNATURE_INVALID');
 return signEvent({secret,kind:DISTRIBUTED_NOSTR_KIND,
  tags:[['d',`${worldId}:${player.slice(2)}`],['w',worldId],['t','spexgsp-rod-peer']],
  content:compact({...claim,rodSignature:signature}),createdAt:nowSec});
}

/** Re-check against the local canonical ROD node. An advertisement is only a locator. */
export async function verifyRodPeerAdvertisement(event,{rpc,port,assetRoot=null,rodGenesis=null,nowSec=Math.floor(Date.now()/1000)}={}) {
 if(!verifyEvent(event)||event.kind!==DISTRIBUTED_NOSTR_KIND||event.created_at>nowSec+60||event.created_at<nowSec-1200||
    !Array.isArray(event.tags)||!event.tags.some(t=>t[0]==='t'&&t[1]==='spexgsp-rod-peer'))return null;
 let c;try{c=JSON.parse(event.content);}catch{return null}
 if(c.schema!=='spexgsp/rod-peer/1'||!REALM.test(c.realmName??'')||!PLAYER.test(c.player??'')||
    !ADDRESS.test(c.ownerAddress??'')||!H.test(c.worldId??'')||!H.test(c.assetRoot??'')||!H.test(c.rodGenesis??'')||
    !GAME.test(c.gameId??'')||!H.test(c.portHash??'')||!H.test(c.confirmedRoot??'')||!H.test(c.tip??'')||
    !Number.isSafeInteger(c.height)||c.height<1||!Number.isSafeInteger(c.clockEra)||c.clockEra<1||
    !Number.isSafeInteger(c.issuedAt)||!Number.isSafeInteger(c.expiresAt)||c.issuedAt!==event.created_at||
    c.expiresAt<=nowSec||c.expiresAt>c.issuedAt+600||typeof c.rodSignature!=='string'||
    !event.tags.some(t=>t[0]==='d'&&t[1]===`${c.worldId}:${c.player.slice(2)}`)||
    !event.tags.some(t=>t[0]==='w'&&t[1]===c.worldId)||
    (assetRoot!==null&&c.assetRoot!==assetRoot)||(rodGenesis!==null&&c.rodGenesis!==rodGenesis)||
    (port&&port.configSha256!==c.portHash)||
    (('osgSequence'in c||'osgEventHead'in c)&&(!Number.isSafeInteger(c.osgSequence)||c.osgSequence<0||!H.test(c.osgEventHead??''))))return null;
 try{
  const [chain,genesis,tip,name,directoryRecord,gameRecord]=await Promise.all([
    rpc('getblockchaininfo'),rpc('getblockhash',[0]),rpc('getblockhash',[c.height]),
    rpc('name_show',[c.player]),rpc('name_show',[c.realmName]),rpc('name_show',['g/'+c.gameId])]);
  if(genesis!==c.rodGenesis||chain.blocks<c.height||tip!==c.tip||name.address!==c.ownerAddress||
     name.height<1||directoryRecord.height<1||directoryRecord.address!==JSON.parse(directoryRecord.value).ownerAddress)return null;
  const directory=JSON.parse(directoryRecord.value),g=JSON.parse(gameRecord.value);
  if(directory.schema!=='spexgsp/realm/1'||directory.worldId!==c.worldId||directory.assetRoot!==c.assetRoot||
     directory.rodGenesis!==c.rodGenesis||g.portHash!==c.portHash||g.clock?.era!==c.clockEra||
     g.clock?.schema!==1||g.clock?.rate!==1||!Number.isSafeInteger(g.clock?.utcOriginMs)||
     !Number.isFinite(g.clock?.simMjd0))return null;
  const expected=gameGenesis({world:c.worldId,assetRoot:c.assetRoot,rodGenesis:c.rodGenesis,port:{configSha256:c.portHash},clock:g.clock});
  verifyDistributedRealm({directory,gameRecord,gameId:c.gameId,genesis:expected,rodGenesis:c.rodGenesis});
  const {rodSignature,...claim}=c;
  if(await rpc('verifymessage',[c.ownerAddress,rodSignature,evidenceMessage(claim,event.pubkey)])!==true)return null;
  return {event,claim,genesis:g,directory,realmName:c.realmName};
 }catch{return null}
}

export async function discoverRodPeerUniverses(relay,rpc,{port=null,assetRoot=null,rodGenesis=null,timeoutMs=6000,nowSec=Math.floor(Date.now()/1000)}={}){
 if(!relay?.subscribe||typeof rpc!=='function')fail('ROD_NOSTR_DISCOVERY_UNAVAILABLE');
 const events=[];
 const sub=relay.subscribe([{kinds:[DISTRIBUTED_NOSTR_KIND],'#t':['spexgsp-rod-peer'],limit:300}],e=>{
  if(events.length<300)events.push(e);
 });
 try{if(!await sub.eose(timeoutMs))fail('ROD_NOSTR_DISCOVERY_EOSE_TIMEOUT');}finally{sub.close()}
 const verified=[];
 for(const ev of events){const found=await verifyRodPeerAdvertisement(ev,{rpc,port,assetRoot,rodGenesis,nowSec});if(found)verified.push(found)}
 // Multiple peers advertising the same world are redundant sources, not forks.
 // Disagreement about immutable genesis is rejected; the claimed frontier is
 // never used as authority until the local ROD/OSG synchronizer verifies it.
 const byWorld=new Map();
 for(const item of verified){const old=byWorld.get(item.claim.worldId);
  if(old&&(old.claim.gameId!==item.claim.gameId||canonical(old.genesis)!==canonical(item.genesis)||old.claim.realmName!==item.claim.realmName))
   fail('ROD_NOSTR_CONFLICTING_VERIFIED_UNIVERSE');
  if(!old||item.claim.height>old.claim.height||item.claim.height===old.claim.height&&item.event.created_at>old.event.created_at)
   byWorld.set(item.claim.worldId,item);
 }
 return [...byWorld.values()].sort((a,b)=>a.claim.realmName.localeCompare(b.claim.realmName)||a.claim.worldId.localeCompare(b.claim.worldId));
}
