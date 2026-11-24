#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Unattended local native simulator. One wallet, one Metaverse process, one verified OSG world.
import {readFile,mkdir,rm,open as openFile} from 'node:fs/promises';
import {atomicWriteFile} from '../apps/metaverse-native/v26/fs-util.mjs';
import {journalFrontierReader} from '../apps/metaverse-native/v26/rod-game/nostr-history.mjs';
import {resolve,dirname,join} from 'node:path';
import {hostname} from 'node:os';
import {spawn} from 'node:child_process';
import {rpcClient} from '../apps/metaverse-native/v26/rpc-adapter.mjs';
import {canonicalWorldManifest} from '../apps/metaverse-native/v26/world-manifest.mjs';
import {WorldClock} from '../apps/metaverse-native/v26/world-time.mjs';
import {loadBrightonPort,stageScenario} from '../apps/metaverse-native/v26/spawn-ports.mjs';
import {enrollMessage} from '../apps/metaverse-native/v26/hub.mjs';
const flag=process.argv.find(x=>x.startsWith('--config='))?.slice(9);
if(!flag)throw Error('Use --config=v26-player.json');
const configFile=resolve(flag),base=dirname(configFile),c=JSON.parse(await readFile(configFile,'utf8')),at=x=>resolve(base,x);
for(const k of ['metaverseRoot','rodRpc','walletAddress','ntpHosts','worldId','runNonce','localWorldUrl','expectedRodGenesis'])if(!c[k])throw Error('missing_player_configuration_'+k);
if(!/^[A-Za-z0-9_.:-]{8,128}$/.test(c.runNonce))throw Error('invalid_player_run_nonce');
const root=at(c.metaverseRoot),{worldId:assetRoot}=await canonicalWorldManifest(root);
if(c.assetRoot!==assetRoot||!/^[a-f0-9]{64}$/.test(c.worldId))throw Error('world_asset_manifest_mismatch');
const worldId=c.worldId; // SPEXGSP_V267_DIRECT_VERIFIED_PROXY
// The parent bootstrap already verified the signed announcement and canonical
// ROD fence. A second v26.3 discovery would select incompatible tags/URLs.
if(c.relayTransport!=='rod-zmq')throw Error('ROD_PLAYER_REQUIRES_ROD_ZMQ_PRIMARY');
const discovered={url:c.localWorldUrl};
if(!c.localWorldUrl||!c.expectedRodGenesis)
 throw Error('PLAYER_SIGNED_WORLD_ATTESTATION_MISSING');
const endpoint=new URL(discovered.url);
if(!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname))throw Error('ROD_NATIVE_WORLD_ENDPOINT_MUST_BE_LOCAL');
if((c.expectedLocalUrl||c.expectedHubUrl)&&endpoint.href!==new URL(c.expectedLocalUrl||c.expectedHubUrl).href)throw Error('rod_local_world_endpoint_not_expected');
const api=async(path,{method='GET',body=null}={})=>{
 const res=await fetch(new URL(path,endpoint),{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(12000)});
 const json=await res.json();if(!res.ok)throw Error(json.error||`world_http_${res.status}`);return json;
};
const snapshot=await api('/world');if(snapshot.worldId!==worldId)throw Error('not_the_discovered_world');
const port=await loadBrightonPort(join(root,'Config','Moon','Base','Brighton.cfg'),{available:null});
if(c.portSlots!==undefined&&c.portSlots!==port.slots.length)throw Error('ROD_NATIVE_PORT_SLOTS_MISMATCH');
if(port.configSha256!==snapshot.port.configSha256)throw Error('spawn_port_definition_mismatch');
const rc=c.rodRpc,rpc=rpcClient({url:rc.url,cookie:rc.cookie?at(rc.cookie):undefined,user:rc.user,password:rc.password});
const rodChain=await rpc('getblockchaininfo'),rodGenesis=await rpc('getblockhash',[0]);if(rodGenesis!==c.expectedRodGenesis)throw Error('PLAYER_ROD_GENESIS_MISMATCH');
if(!['regtest','test','main'].includes(rodChain.chain))throw Error('unsupported_local_ROD_network');
const challenge=await api('/enroll-challenge?address='+encodeURIComponent(c.walletAddress)+(c.slot?'&slot='+encodeURIComponent(c.slot):''));
const text=enrollMessage({worldId,address:c.walletAddress,nonce:challenge.nonce,portId:challenge.portId,slot:challenge.slot});
const signature=await rpc('signmessage',[c.walletAddress,text]);
if((await rpc('verifymessage',[c.walletAddress,signature,text]))!==true)throw Error('local_wallet_signature_failed');
const enrollment=await api('/enroll',{method:'POST',body:{challengeId:challenge.id,address:c.walletAddress,nonce:challenge.nonce,portId:challenge.portId,slot:challenge.slot,signature}});
const ship=enrollment.ship;if(ship.owner!==c.walletAddress||ship.worldId!==worldId)throw Error('foreign_spawn_claim');
const clock=new WorldClock(snapshot.clock);await clock.calibrateFromPool(c.ntpHosts);const target=clock.requireReady().simMjd;
const scenarioRel=`OSGSim\\v26-${c.runNonce}-${ship.actor}`,scenarioFile=join(root,'Scenarios',...scenarioRel.split('\\'))+'.scn';
await stageScenario({templateFile:join(root,'Scenarios','Missions','In orbit around Moon.scn'),outputFile:scenarioFile,spawn:ship,port,simMjd:target,resumeFrame:enrollment.resumeFrame});
const dataDir=at(c.dataDir??`OSGSim/.data/v26-player-${c.runNonce}`);await mkdir(dataDir,{recursive:true});
// This child does not open a competing Nostr writer; the parent owns the signed per-device OSG history archive.
const readMirror=journalFrontierReader(c.nostrHistoryJournal?at(c.nostrHistoryJournal):null);
// The hub session, wallet signing, NTP clock, world verification and scene proof run inside SpeXGSP.dll (it was the Node sidecar).
// The DLL writes its events and status to these files.
const nativeEventFile=join(dataDir,'native-events.jsonl'),nativeStatusFile=join(dataDir,'native-status.json');
await rm(nativeEventFile,{force:true});await rm(nativeStatusFile,{force:true});
const rodEnv=rc.cookie?{SPEX_GSP_RPC_COOKIE:at(rc.cookie)}:{SPEX_GSP_RPC_USER:String(rc.user),SPEX_GSP_RPC_PASSWORD:String(rc.password)};
const exe=join(root,'Modules','Server','SpaceXpanse.exe');const nativeStartUtcMs=Date.now();
const native=spawn(exe,[`--scenariox="${scenarioRel}"`],{cwd:root,windowsVerbatimArguments:true,env:{...process.env,SPEX_GSP_ACTOR:ship.actor,SPEX_GSP_VESSEL:ship.nativeName,SPEX_GSP_ASSET:ship.asset,SPEX_GSP_RUN_NONCE:c.runNonce,
 SPEX_GSP_HUB_URL:endpoint.toString().replace(/\/$/,''),SPEX_GSP_ADDRESS:c.walletAddress,SPEX_GSP_RPC_URL:rc.url,...rodEnv,SPEX_GSP_NTP_HOSTS:c.ntpHosts.join(','),
 SPEX_GSP_ROOT:root,SPEX_GSP_CAPTURE_SCRIPT:join(root,'OSGSim','scripts','Capture-SpeXGSP-v26-DX9.ps1'),SPEX_GSP_DATA_DIR:dataDir,SPEX_GSP_EVENT_FILE:nativeEventFile,SPEX_GSP_STATUS_FILE:nativeStatusFile},stdio:'ignore'});
if(!native.pid)throw Error('native_Metaverse_process_not_started');
let eventOffset=0,eventTail='';
const readNativeStatus=async()=>{try{return JSON.parse(await readFile(nativeStatusFile,'utf8'));}catch{return null;}};
const pumpEvents=async()=>{
 let handle;try{handle=await openFile(nativeEventFile,'r');}catch{return;}
 try{const {size}=await handle.stat();
  // The file was started again (a new simulation in the same Metaverse): read it from the beginning.
  if(size<eventOffset){eventOffset=0;eventTail='';}
  if(size<=eventOffset)return;const buffer=Buffer.alloc(size-eventOffset);await handle.read(buffer,0,buffer.length,eventOffset);eventOffset=size;
  const lines=(eventTail+buffer.toString('utf8')).split('\n');eventTail=lines.pop();
  for(const line of lines)if(line.trim()){try{console.log('SPEXGSP_V26_PLAYER_EVENT '+JSON.stringify(JSON.parse(line)));}catch{console.error('SPEXGSP_NATIVE_EVENT_UNREADABLE '+line.slice(0,200));}}
 }finally{await handle.close();}
};
// A DLL that never reports is otherwise silent: it is missing, not loaded, or older than this release.
const helloWatch=setTimeout(async()=>{if(!(await readNativeStatus()))console.log('SPEXGSP_V26_PLAYER_EVENT '+JSON.stringify({type:'native_dll_not_connected',actor:ship.actor,seconds:30,hint:'no status from the SpeXGSP.dll in the Metaverse; it is missing, not loaded, or older than this release (it must contain the hub client; replace Modules\\Plugin\\SpeXGSP.dll)'}));},30000);helloWatch.unref?.();
const statusFile=join(dataDir,`V26-${ship.actor}-STATUS.json`);
let lastRecovery=null,lastError=null,stopping=false;
const stats=async()=>{
 const state=await readNativeStatus();const nostrFrontier=await readMirror();
 const result={schema:263,computerName:hostname(),actor:ship.actor,worldId,runNonce:c.runNonce,rodChain:rodChain.chain,rodGenesis,walletAddress:c.walletAddress,ship,scenario:scenarioRel,pid:native.pid,nativeStartUtcMs,status:state,nostrFrontier,utcMs:clock.status().utcMs,lastRecovery,error:lastError};
 const bytes=JSON.stringify(result,null,2);await atomicWriteFile(statusFile,bytes,{mode:0o666});await atomicWriteFile(join(dataDir,'V26-SELF-STATUS.json'),bytes,{mode:0o666});
 return result;
};
let statsBusy=false;const timer=setInterval(()=>{if(statsBusy)return;statsBusy=true;void pumpEvents().then(()=>stats()).catch(e=>{lastError=e.message;console.error('SPEXGSP_STATUS_ERROR '+e.message)}).finally(()=>{statsBusy=false});},1500);
// The world clock that matters runs in the DLL (it recalibrates itself); this one only placed the ship in the scenario.
const recovery=null;
console.log('SPEXGSP_V26_PLAYER_RUNNING '+JSON.stringify({worldId,actor:ship.actor,owner:c.walletAddress,pid:native.pid,scenario:scenarioRel,runNonce:c.runNonce}));
const stop=async()=>{if(stopping)return;stopping=true;clearInterval(timer);clearTimeout(helloWatch);if(recovery)clearInterval(recovery);await pumpEvents().catch(()=>{});await stats().catch(()=>{});};
native.on('error',e=>{lastError=e.message;void stop().then(()=>{console.error('SPEXGSP_V26_NATIVE_SPAWN_ERROR '+e.message);process.exit(1);});});
native.on('exit',(code,signal)=>{void stop().then(()=>{console.error('SPEXGSP_V26_NATIVE_EXIT '+JSON.stringify({code,signal}));process.exit(code??1);});});
process.on('SIGINT',()=>{native.kill();void stop()});process.on('SIGTERM',()=>{native.kill();void stop()});
