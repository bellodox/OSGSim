#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Each device hosts its own OSG and Metaverse. ROD P2P/ZMQ is the primary
// synchronization path; Nostr discovery and evidence are mandatory.
import {readFile,mkdir} from 'node:fs/promises';
import {atomicWriteFile} from '../apps/metaverse-native/v26/fs-util.mjs';
import {resolve,dirname,join} from 'node:path';
import {spawn} from 'node:child_process';
import {hostname} from 'node:os';
import {OsgGraph} from '../apps/metaverse-native/v26/graph-adapter.mjs';
import {rpcClient} from '../apps/metaverse-native/v26/rpc-adapter.mjs';
import {canonicalWorldManifest} from '../apps/metaverse-native/v26/world-manifest.mjs';
import {loadBrightonPort} from '../apps/metaverse-native/v26/spawn-ports.mjs';
import {WorldClock} from '../apps/metaverse-native/v26/world-time.mjs';
import {createLocalNativeEndpoint} from '../apps/metaverse-native/v26/rod-game/local-endpoint.mjs';
import {DistributedV26World} from '../apps/metaverse-native/v26/rod-game/world-adapter.mjs';
import {RodGameSync} from '../apps/metaverse-native/v26/rod-game/sync.mjs';
import {RodGamePublisher} from '../apps/metaverse-native/v26/rod-game/publisher.mjs';
import {RodPeerNostrAdvertiser} from '../apps/metaverse-native/v26/rod-game/nostr-bootstrap.mjs';
import {RodNostrHistory} from '../apps/metaverse-native/v26/rod-game/nostr-history.mjs';
import {installedRealmName} from '../apps/metaverse-native/v26/single-address/realm-init.mjs';
import {bootstrapRodAutoConfig} from '../apps/metaverse-native/v26/rod-game/auto-config.mjs';
import {LiveLane,bindingResolver} from '../apps/metaverse-native/v26/rod-game/live-lane.mjs';
import {acquireLocalRunLock} from '../apps/metaverse-native/v26/single-address/local-runtime.mjs';
import {OperatorRelay} from '../apps/metaverse-native/v26/single-address/operator-relay.mjs';
import {loadRelayTls,relayUrl} from '../apps/metaverse-native/v26/single-address/relay-cert.mjs';
import {probePinnedRelay} from '../apps/metaverse-native/v26/single-address/pinned-websocket.mjs';
import {publicKey as nostrPublicKey} from '../apps/metaverse-native/v26/single-address/crypto.mjs';
const H=/^[a-f0-9]{64}$/;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const argv=process.argv.slice(2);
const options={relay:argv.find(x=>x.startsWith('--relay='))?.slice(8)??null,
 universe:argv.find(x=>x.startsWith('--universe='))?.slice(11)??null,
 choose:argv.includes('--choose'),list:argv.includes('--list-universes'),
 noRelay:argv.includes('--no-relay'),relayPort:argv.find(x=>x.startsWith('--relay-port='))?.slice(13)??null};
for(const arg of argv)if(!arg.startsWith('--relay=')&&!arg.startsWith('--universe=')&&!arg.startsWith('--relay-port=')&&
 !['--choose','--list-universes','--no-relay'].includes(arg))throw Error('ROD_UNKNOWN_OPTION_'+arg);
if(options.relayPort!==null&&(!/^\d{1,5}$/.test(options.relayPort)||Number(options.relayPort)>65535))throw Error('ROD_INVALID_RELAY_PORT');
// One peer per installation: it owns the wallet profile, the OSG store and the relay.
const runLock=await acquireLocalRunLock(process.cwd());
// SpeXGSP carries its own Nostr relay. Every peer runs it; no third-party relay is used. It listens on loopback
// unless TLS material exists: the certificate -CreateUniverse generated for the owner's relayHost (OSGSim/.data/
// spexgsp-single-address/relay-tls), or OSGSIM_RELAY_TLS_CERT / OSGSIM_RELAY_TLS_KEY for a certificate from a CA.
let operatorRelay=null,publicRelayUrl=null;
if(!options.noRelay){
 const tls=await loadRelayTls(process.env,{dir:resolve('OSGSim','.data','spexgsp-single-address','relay-tls')});
 const relayOptions={host:process.env.OSGSIM_RELAY_HOST??(tls?'0.0.0.0':'127.0.0.1'),tls,
  file:resolve('OSGSim','.data','spexgsp-single-address','relay-events.jsonl'),
  onStatus:(k,v)=>console.log('SPEXGSP_ROD_'+k+' '+JSON.stringify(v))};
 try{operatorRelay=await new OperatorRelay({...relayOptions,port:Number(options.relayPort??7447)}).start();}
 catch(e){
  // An explicitly requested port must be honoured; the default only matters to other machines when it is public.
  if(e.code!=='EADDRINUSE'||options.relayPort!==null||tls){await runLock.release();throw e;}
  console.error('SPEXGSP_ROD_RELAY_DEFAULT_PORT_BUSY using a free loopback port');
  operatorRelay=await new OperatorRelay({...relayOptions,port:0}).start();
 }
}
const localRelays=operatorRelay?[operatorRelay.localUrl]:[];
if(operatorRelay?.tls){
 const tls=operatorRelay.tls,listenPort=new URL(operatorRelay.url).port;
 publicRelayUrl=tls.host?relayUrl(tls.host,Number(listenPort)):null;
 console.log('SPEXGSP_ROD_RELAY_PUBLIC '+JSON.stringify({url:publicRelayUrl??operatorRelay.url,certificate:tls.source,pin:tls.pin,
  routerAndFirewall:'forward TCP '+listenPort+' on the router to this PC; Windows firewall (administrator): netsh advfirewall firewall add rule name="SpeXGSP relay" dir=in action=allow protocol=TCP localport='+listenPort}));
 // The check only proves that this PC can reach its own public address; some routers do not loop traffic back, so a
 // failure here is a hint, not proof, that other computers cannot connect.
 if(publicRelayUrl)void probePinnedRelay(publicRelayUrl,tls.pin).then(r=>console.log('SPEXGSP_ROD_RELAY_PUBLIC_CHECK '+JSON.stringify(
  r.ok?{reachable:true,url:publicRelayUrl}:{reachable:false,reason:r.reason,url:publicRelayUrl,note:'port forwarding or firewall may be missing; test from another network'})));
}
// All computers use the same Metaverse/ROD/port/relay protocol configuration.
// Device-owned wallet identity, local storage, and the chosen universe are
// derived automatically. There is no legacy mode or manual split configuration.
const boot=await bootstrapRodAutoConfig({root:process.cwd(),relayOverride:options.relay,localRelays,skipRelays:publicRelayUrl?[publicRelayUrl]:[],
 universe:options.universe,autoSelect:!options.choose,choose:options.choose,listOnly:options.list,
 autoRegisterPlayer:true,keepNostrOpen:true,
 onStatus:(k,v)=>console.log('SPEXGSP_ROD_'+k+' '+JSON.stringify(v))});
if(boot.listOnly){await operatorRelay?.close();await runLock.release();console.log('SPEXGSP_ROD_VERIFIED_UNIVERSES '+JSON.stringify(boot.worlds));process.exit(0)}
const file=boot.configFile,startupNostr=boot.nostr;

const configFile=resolve(file),dir=dirname(configFile),c=JSON.parse(await readFile(configFile,'utf8')),at=x=>resolve(dir,x);
for(const k of ['metaverseRoot','osgMultiSourceDir','dataDir','rodRpc','worldId','assetRoot','gameId','playerName','walletAddress','clock','runNonce','ntpHosts'])if(!c[k])throw Error('ROD_DISTRIBUTED_MISSING_'+k);
if(!H.test(c.worldId)||!H.test(c.assetRoot)||!/^[A-Za-z0-9]{1,40}$/.test(c.gameId)||!/^[A-Za-z0-9_.-]{1,48}$/.test(c.playerName)||!/^[-A-Za-z0-9_.:]{8,128}$/.test(c.runNonce)||!Array.isArray(c.ntpHosts)||!c.ntpHosts.length)throw Error('ROD_DISTRIBUTED_CONFIG_INVALID');
const root=at(c.metaverseRoot),data=at(c.dataDir);await mkdir(data,{recursive:true});
const manifest=await canonicalWorldManifest(root);if(manifest.worldId!==c.assetRoot)throw Error('DISTRIBUTED_METAVERSE_ASSET_MANIFEST_MISMATCH');
const port=await loadBrightonPort(join(root,'Config','Moon','Base','Brighton.cfg'),{available:null});
if(c.portSlots!==undefined&&c.portSlots!==port.slots.length)throw Error('ROD_CANONICAL_PORT_SLOTS_MUST_MATCH_INSTALLED_BASE');
const clock=new WorldClock(c.clock);await clock.calibrateFromPool(c.ntpHosts);clock.startAutoCalibration(c.ntpHosts,{onError:e=>console.error('SPEXGSP_ROD_NTP_RECALIBRATION '+e.message)});
const rc=c.rodRpc,rpc=rpcClient({url:rc.url,cookie:rc.cookie?at(rc.cookie):undefined,user:rc.user,password:rc.password});
if(await rpc('getblockhash',[0])!==c.rodGenesis||!H.test(c.rodGenesis??''))throw Error('DISTRIBUTED_ROD_GENESIS_MISMATCH');
const player='p/'+c.playerName;
const onStatus=(type,data)=>console.log('SPEXGSP_ROD_'+type+' '+JSON.stringify(data));
let graph=null,sync=null,publisher=null,endpoint=null,native=null,nostr=null,nostrAdvertiser=null,history=null,lane=null;let stopped=false;
const saveChains=new Map();
const save=(name,value)=>{const f=join(data,name),run=(saveChains.get(f)??Promise.resolve()).then(()=>atomicWriteFile(f,JSON.stringify(value,null,2)+'\n'));saveChains.set(f,run.catch(()=>{}));return run};
// Stop producers first, then the transports they publish to, then storage; the own relay and the lock go last.
const close=async()=>{if(stopped)return;stopped=true;clock.stopAutoCalibration();if(native&&!native.killed)native.kill();await sync?.close();lane?.stop();await publisher?.close();await history?.close();await nostrAdvertiser?.close();await (nostr??startupNostr)?.close();await endpoint?.close();if(!endpoint)await graph?.close();await operatorRelay?.close();await runLock.release()};
process.on('SIGINT',()=>{void close().then(()=>process.exit(0))});process.on('SIGTERM',()=>{void close().then(()=>process.exit(0))});
let step='opening the peer',ready=false;const stepSince=()=>Date.now();let stepAt=stepSince();const at_=name=>{step=name;stepAt=stepSince();};
// A startup step that takes longer than 10 s is named every 10 s, so a silent window always says what it waits for.
const startupWatch=setInterval(()=>{if(stopped||ready)return;const waiting=sync?.phase??step;console.log('SPEXGSP_ROD_STARTUP_WAITING '+JSON.stringify({step:waiting,seconds:Math.round((Date.now()-stepAt)/1000)}));},10000);startupWatch.unref?.();
try{
 // Nostr is a required part of the same startup, not an alternative launcher.
 // A device owning the confirmed g/ game name may bootstrap the first peer;
 // every other device must discover an already advertised ROD-bound universe.
 const realmName=c.realmName??await installedRealmName(root);
 nostr=startupNostr;
 if(!nostr?.relay||!nostr?.identity)throw Error('NOSTR_MANDATORY_SESSION_MISSING');
 if(nostr.selected&&(nostr.selected.worldId!==c.worldId||nostr.selected.gameId!==c.gameId))
  throw Error('ROD_NOSTR_BOOTSTRAP_SELECTION_CHANGED');
 onStatus('NOSTR_MANDATORY_READY',{knownRelays:nostr.relay.clients.size,world:c.worldId,source:nostr.selected?.source??'first-registered-peer'});
 at_('opening the local OSG store');graph=await new OsgGraph().open(at(c.osgMultiSourceDir),join(data,'osg-graph'));
 const state=new DistributedV26World({graph,rpc,worldId:c.worldId,clock:c.clock,port,now:()=>clock.requireReady().utcMs,
  onCommit:async(_snapshot,event)=>{if(event){if(publisher)await publisher.capture(event);if(history)await history.capture(event);}}});
 at_('initialising the world state');await state.init();
 state.onLiveFrame=frame=>publisher?.captureFrame(frame);
 sync=new RodGameSync({rpc,world:c.worldId,game:c.gameId,port,clock:c.clock,assetRoot:c.assetRoot,graph,startHeight:c.startHeight??null,zmqAddress:c.zmqAddress,python:c.python??'python',pollMs:c.pollMs??20000,
   onStatus,onUnsafe:reason=>state.suspendAuthority(reason),materialize:projection=>{lane?.observeProjection(projection);return state.importRodProjection(projection,{localPlayer:player});}});
 // The local native endpoint is not a server for other devices. The ROD
 // network synchronizes world changes and ZMQ notifies each local ROD node.
 // The first verified ROD reconciliation is mandatory before DLL admission.
 at_('starting ROD sync (first reconciliation)');await sync.start();at_('after ROD sync');
 // Live motion lane (ephemeral Nostr events). ROD remains the authority; see rod-game/live-lane.mjs.
 if(c.liveLane!==false&&process.env.OSGSIM_LIVE_LANE!=='0'){
  lane=new LiveLane({relay:nostr.relay,secret:nostr.identity,world:c.worldId,clock:c.clock,onStatus,now:()=>clock.nowUtc().utcMs,
   resolve:bindingResolver(()=>sync.projection)});
  state.setLiveSource(()=>lane.frames());lane.start();
  onStatus('NOSTR_LIVE_LANE_READY',{pubkey:lane.pubkey});
 }
 at_('opening the player outbox');publisher=await new RodGamePublisher({lane,nostrPubkey:nostrPublicKey(nostr.identity),rpc,world:c.worldId,game:c.gameId,player,ownerAddress:c.walletAddress,clockEra:c.clock.era,source:sync,
  filename:join(data,'ROD-PLAYER-OUTBOX.json'),limit:c.chainLimit??15,onStatus}).init();
 at_('opening the Nostr history');history=await new RodNostrHistory({world:state,graph,relay:nostr.relay,rpc,secret:nostr.identity,
  worldId:c.worldId,assetRoot:c.assetRoot,rodGenesis:c.rodGenesis,port,
  dir:join(data,'nostr-history'),onStatus}).init();
 onStatus('NOSTR_SLOW_HISTORY_READY',{local:history.status().local});
 nostrAdvertiser=new RodPeerNostrAdvertiser({bridge:nostr,rpc,realmName:nostr.selected?.realmName??realmName,worldId:c.worldId,
  assetRoot:c.assetRoot,rodGenesis:c.rodGenesis,gameId:c.gameId,player,ownerAddress:c.walletAddress,clock:c.clock,port,onStatus});
 // The ROD publisher must never wait for slow relays, and a tick must not start while the previous one still runs.
 let rodPumping=false,nostrPumping=false;
 const pumpRod=async()=>{if(rodPumping)return;rodPumping=true;
  try{await publisher.pump({intervalMs:c.samplePublishMs??1500})}catch(e){onStatus('PLAYER_PUBLICATION_PENDING',{reason:e.message})}finally{rodPumping=false}};
 const pumpNostr=async()=>{if(nostrPumping)return;nostrPumping=true;try{
  try{const out=await history.publishPending({max:4});if(out.acknowledged)onStatus('NOSTR_SLOW_HISTORY_PUBLISHED',out)}catch(e){onStatus('NOSTR_SLOW_HISTORY_PENDING',{reason:e.message})}
  try{const frontier=graph.get('metaverse:rod:frontier');
   // A universe is advertised as LIVE only after its local native Metaverse
   // process has started and its owner spawn is confirmed through ROD.
   if(frontier&&native?.pid&&sync.projection?.confirmed?.actors?.[player]?.ownerProof)
    await nostrAdvertiser.tick({...frontier,roster:sync.projection?.confirmed?.order??[],nostrHistory:history?.availableFrontier()??null})}
  catch(e){onStatus('NOSTR_ADVERTISEMENT_PENDING',{reason:e.message})}
 }finally{nostrPumping=false}};
 const pump=()=>Promise.all([pumpRod(),pumpNostr()]);
 const pubTimer=setInterval(()=>void pump(),c.publishPollMs??1200);pubTimer.unref?.();
 const backfill=()=>history.pull().catch(e=>onStatus('NOSTR_SLOW_HISTORY_PULL_PENDING',{reason:e.message}));
 void backfill(); // Start full-history recovery immediately after the verified ROD world opens.
 const backfillTimer=setInterval(()=>void backfill(),120000);backfillTimer.unref?.();
 const statusTimer=setInterval(()=>void save('ROD-PEER-STATUS.json',{schema:1,computer:hostname(),worldId:c.worldId,gameId:c.gameId,player,localEndpoint:endpoint?.url??null,nostrSlow:history?.status()??null,liveLane:lane?.status()??null,runNonce:c.runNonce,rod:sync.status(),publisher:{seq:publisher.state.seq,paused:publisher.state.paused},localOsgHead:graph.head,nativePid:native?.pid??null,utcMs:Date.now()}).catch(e=>onStatus('STATUS_ERROR',{reason:e.message})),1600);
 statusTimer.unref?.();
 at_('first publish pump');await pump();at_('waiting for the ROD-confirmed join');
 // ROD-confirmed join order assigns actors deterministically across devices.
 // The local native endpoint never independently allocates peer0 to every new joiner.
 let lastNotice=0;
 while(!stopped){
  const entry=sync.projection?.actors?.[player],confirmed=sync.projection?.confirmed?.actors?.[player];
  if(entry?.ship&&confirmed?.ship){
   if(entry.ship.owner!==c.walletAddress)throw Error('ROD_PLAYER_NAME_OWNER_OR_ACTOR_MISMATCH');
   // Spawn a native vessel only once the join is buried under joinDepth blocks,
   // so a one-block reorganization cannot re-assign the pad or actor id.
   const need=Math.max(1,Number(process.env.OSGSIM_JOIN_DEPTH)||c.joinDepth||6),depth=Number.isSafeInteger(confirmed.joinHeight)?(sync.chainHeight??0)-confirmed.joinHeight+1:need;
   if(depth>=need){onStatus('PLAYER_CONFIRMED',{actor:entry.ship.actor,slot:entry.ship.slot,depth,confirmedRoot:sync.projection.confirmedRoot});break;}
   if(Date.now()-lastNotice>15000){onStatus('WAITING_FOR_JOIN_DEPTH',{depth,need});lastNotice=Date.now()}
   await delay(500);continue;
  }
  if(Date.now()-lastNotice>15000){onStatus('WAITING_FOR_ROD_CONFIRMED_JOIN',{name:player,tx:publisher.state.lastTxid??null});lastNotice=Date.now()}
  await delay(500);
 }
 ready=true;clearInterval(startupWatch);
 if(!stopped){
  // Never expose a local native endpoint before the device's own ROD
  // admission has been confirmed. The publisher can join without a hub.
  endpoint=await createLocalNativeEndpoint({world:state,rpc,worldId:c.worldId,clock:c.clock,port,host:'127.0.0.1',listenPort:c.localEndpointPort??0,runNonce:c.runNonce,now:()=>clock.requireReady().utcMs});
  onStatus('LOCAL_WORLD_READY',{localEndpoint:endpoint.url,world:c.worldId,game:c.gameId,rodGenesis:c.rodGenesis});
 }
 if(!stopped&&c.launchNative!==false){
  const config={metaverseRoot:root,rodRpc:rc,walletAddress:c.walletAddress,ntpHosts:c.ntpHosts,worldId:c.worldId,assetRoot:c.assetRoot,
   runNonce:c.runNonce,expectedRodGenesis:c.rodGenesis,relayTransport:'rod-zmq',localWorldUrl:endpoint.url,expectedLocalUrl:endpoint.url,portSlots:port.slots.length,dataDir:join(data,'native-player'),nostrHistoryJournal:join(data,'nostr-history','local-deltas.jsonl')};
  // Config paths must remain absolute for the new process's working directory.
  if(config.rodRpc.cookie&&!config.rodRpc.cookie.startsWith('/')&&!/^[A-Za-z]:\\/.test(config.rodRpc.cookie))config.rodRpc={...rc,cookie:at(rc.cookie)};
  const path=join(data,'ROD-NATIVE-PLAYER.json');await save('ROD-NATIVE-PLAYER.json',config);
  native=spawn(process.execPath,[join(root,'OSGSim','scripts','spexgsp-rod-player.mjs'),'--config='+path],{cwd:root,stdio:'inherit',windowsHide:false});
  if(!native.pid)throw Error('ROD_NATIVE_PLAYER_LAUNCH_FAILED');
  native.on('exit',(code,signal)=>{onStatus('NATIVE_EXIT',{code,signal});void close().then(()=>{process.exitCode=code??1})});
  onStatus('NATIVE_PLAYER_LAUNCHED',{pid:native.pid,actor:sync.projection.actors[player].ship.actor});
 }
 while(!stopped)await delay(1000);
 clearInterval(pubTimer);clearInterval(statusTimer);clearInterval(backfillTimer);
}catch(e){await close();console.error('SPEXGSP_ROD_FATAL '+e.stack);process.exitCode=1}
