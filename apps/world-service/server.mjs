// SPDX-License-Identifier: MIT
import http from 'node:http';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve,join,extname,dirname,relative,sep,isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeEnvelope, validateEnvelope, eventIdentity, MAX_ENVELOPE_BYTES,identifier } from '../../packages/world-protocol/index.mjs';
import { DurableJournal, AssetStore,encodeSample } from '../../packages/osg-physical/journal.mjs';
import { OsgAdapter } from '../../packages/osg-physical/osg-adapter.mjs';
import { parsePosition,parseAttitude,parseEvents,stateAt } from '../../packages/recorder/index.mjs';
import {causalObservation,STUDY_OFFSETS} from '../../packages/observer-model/index.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const MAX_CONNECTION_BUFFER=256*1024;
const mime={'.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8','.svg':'image/svg+xml'};
function json(res,status,obj){const body=JSON.stringify(obj);res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(body),'cache-control':'no-store'});res.end(body);}
import {wsUpgrade,sendFrame} from './websocket.mjs';

import {validateTerrain} from '../../packages/landing-scene/schema.mjs';
import {ServiceScheduler} from './scheduler.mjs';
import {OsgWorldAdapter} from '../../packages/osg-physical/world-adapter.mjs';

export async function createWorldServer({httpPort=4377,bridgePort=4378,dataDir=join(root,'.data'),replayPrefix=null,osgSourceDir=null,host='127.0.0.1',bridgeToken=process.env.OSG_BRIDGE_TOKEN??null,osgWorldMode=false,osgMultiSourceDir=null,worldBatchMs=250,worldClients={},landingDemo=false}={}) {
  if(!['127.0.0.1','::1'].includes(host))throw new Error('world service requires a loopback bind address');
  if(bridgeToken!==null && !/^[A-Za-z0-9_-]{16,128}$/.test(bridgeToken))throw new Error('OSG_BRIDGE_TOKEN must be 16-128 ASCII URL-safe characters');
  await mkdir(dataDir,{recursive:true});
  if(osgWorldMode&&(!osgMultiSourceDir||replayPrefix))throw new Error('World mode requires OSG_MULTI_SOURCE_DIR pointing to a built osg-multi checkout and native ingestion mode');
  if(!Number.isSafeInteger(worldBatchMs)||worldBatchMs<25||worldBatchMs>5000)throw new Error('invalid world batch interval');
  for(const [id,token] of Object.entries(worldClients))if(id==='osg-host'||!/^[A-Za-z0-9_-]{1,64}$/.test(id)||typeof token!=='string'||token.length<16)throw new Error('invalid world client configuration');
  if(new Set(Object.values(worldClients)).size!==Object.keys(worldClients).length)throw new Error('world clients need distinct tokens');
  const journal=await new DurableJournal(join(dataDir,'events.journal')).open();
  const assets=new AssetStore(join(dataDir,'assets'));
  let osg=null,world=null,worldTimer=null,osgError=null,httpServer,tcp;
  try {
  if(osgWorldMode)world=await new OsgWorldAdapter({sourceDir:osgMultiSourceDir,storeDir:join(dataDir,'osg-store'),assets}).open();
  if(osgSourceDir&&!osgWorldMode){
    try{osg=await new OsgAdapter({sourceDir:osgSourceDir,storeDir:join(dataDir,'osg-store')}).open();}
    catch(e){osgError=e.message;await journal.close();throw new Error(`OSG startup failed: ${e.message}`);}
  }
  const recoveredEvents=await journal.entries();
  if(osg){try{await osg.reconcile(recoveredEvents);}catch(error){await osg.close();await journal.close();throw new Error(`OSG journal recovery failed: ${error.message}`);}}
  const sceneTerrains=new Map();
  const peers=new Set(),initializingPeers=new Set(),nativeSockets=new Set(),pumps=new Set(),worldWrites=new Set();
  let closing=false;
  const state={mode:landingDemo?'landing-demo':replayPrefix?'recorded':'native',runId:replayPrefix?'recorder-atlantis':null,
    lastSample:null,samplesAccepted:0,nativeConnected:false,nativeAuthenticated:false,source:replayPrefix?'recorded':'native',
    errors:[],contacts:recoveredEvents.filter(e=>e.type==='CONTACT_BEGIN'||e.type==='CONTACT_END'),lastByEntity:new Map(),lastStepByRun:new Map(),
    recorded:null,contactSequence:journal.head.sequence,osgDegraded:false,activeRunKey:null,
    observerAnchor:null};
  if(replayPrefix) {
    const [p,a,e]=await Promise.all(['.pos','.att','.atc'].map(ext=>readFile(replayPrefix+ext,'utf8')));
    const positions=parsePosition(p),attitude=parseAttitude(a),events=parseEvents(e);
    state.recorded={positions,attitude,events};
    const landed=events.find(e=>e.kind==='LANDED');
    if(landed)state.contacts.push({type:'CONTACT_BEGIN',simTime:landed.time,source:'recorded',
      note:'Flight recorder LANDED action; NOT native GroundContact() evidence',entityId:'Atlantis'});
  }
  const recoveredRuns=new Set([...recoveredEvents.filter(e=>e.source==='native').map(e=>e.runId),...(world?world.world.streams().streams.map(s=>s.runId):[])]);
  const retiredRuns=new Set();
  const addError=message=>{state.errors.push(message);if(state.errors.length>100)state.errors.shift();};
  const send=(socket,value)=>sendFrame(socket,JSON.stringify(value));
  const broadcast=value=>{for(const peer of peers)if(!initializingPeers.has(peer))send(peer,value);};
  function sendWorld(socket,update){
    // Keep each message below the existing bounded WebSocket frame size.
    const stream=update.streams?.find(x=>x.runId===update.runId&&x.epoch===update.epoch);
    const metadata={...update,frames:[],events:[],origins:undefined,streams:stream?[stream]:[]};
    if(update.type==='OSG_WORLD_SNAPSHOT')send(socket,metadata);
    for(const frame of update.frames??[])send(socket,{...metadata,type:'OSG_WORLD_UPDATE',frames:[frame],origins:update.origins?.[frame.sample.entityId]?{[frame.sample.entityId]:update.origins[frame.sample.entityId]}:undefined});
    for(const event of update.events??[])send(socket,{...metadata,type:'OSG_WORLD_UPDATE',events:[event]});
  }
  const scheduler=new ServiceScheduler();
  const enqueue=(fn,priority='telemetry')=>scheduler.enqueue(async()=>{try{return await fn();}catch(error){addError(error.message);throw error;}},priority);
  let lastIngressAt=null,lastPublicationAt=null;
  async function appendToOsg(event,assetHash=null) {
    if(!osg)return;
    try{
      // Reconcile entire durable log after any previous graph error, before the new publish.
      if(state.osgDegraded)await osg.reconcile(await journal.entries());
      else await osg.appendObservedEvent(event,assetHash);
      state.osgDegraded=false;osgError=null;
    }catch(e){state.osgDegraded=true;osgError=e.message;addError(`OSG publication pending: ${e.message}`);}
  }
  async function acceptSample(input,{authenticated=false}={}) {
    if(closing)throw new Error('service is closing');
    if(world?.fault)throw new Error('OSG world publication stopped; start a new verified run');
    if(replayPrefix||landingDemo)throw new Error('replay mode refuses native input');
    validateEnvelope(input);
    const fields=['version','type','source','runId','epoch','step','sequence','simTime','simDt','frameId','entityId','position','velocity','orientation','angularVelocity','contact','entityName','wireFormat','capturedAtUnixMs','visual'];
    let sample=Object.fromEntries(fields.filter(k=>Object.hasOwn(input,k)).map(k=>[k,input[k]]));
    sample.transportAuthenticated=authenticated;
    const removed=sample.type==='ENTITY_REMOVED';
    if(!['PHYSICS_SAMPLE','ENTITY_REMOVED'].includes(sample.type)||sample.source!=='native')throw new Error('native bridge accepts physical samples and entity removals only');
    state.nativeWireFormat=sample.wireFormat??1;
    const runkey=`${sample.runId}/${sample.epoch}`;
    const changed=!!state.activeRunKey&&state.activeRunKey!==runkey;
    if(recoveredRuns.has(sample.runId)||retiredRuns.has(sample.runId))throw new Error('retired or recovered native run requires a new runId');
    if(state.runId===sample.runId && state.activeEpoch!==undefined && sample.epoch<state.activeEpoch)throw new Error('regressed native epoch');
    if(changed&&retiredRuns.size>=1024)throw new Error('native run limit reached; restart service');
    const prev=state.lastStepByRun.get(runkey);
    if(prev && (sample.sequence!==prev.sequence+1||sample.step<prev.step)) throw new Error('duplicate, skipped or regressed native sample');
    if(!prev && sample.sequence!==1)throw new Error('native stream must start at sequence 1');
    const key=`${runkey}/${sample.entityId}`;
    let before=state.lastByEntity.get(key);
    if(removed&&!before)before=[...state.lastByEntity.values()].find(x=>x.runId===sample.runId&&x.entityId===sample.entityId);
    if(removed){if(!before)throw new Error('removal requires an observed entity');sample={...before,...sample,simDt:0};}
    if(prev&&(sample.simTime<prev.simTime || (sample.step===prev.step&&sample.simTime!==prev.simTime)))throw new Error('inconsistent or regressed native time');
    if(prev&&sample.frameId!==prev.frameId)throw new Error('native frame changed within epoch');
    if(before&&!removed&&sample.step<=before.step)throw new Error('duplicate or regressed vessel step');
    if(!removed&&sample.visual){
      const visual={...sample.visual},terrainKey=`${runkey}/${sample.entityId}/${visual.terrainId??''}`;
      if(visual.terrain){
        const bytes=Buffer.from(JSON.stringify(validateTerrain(visual.terrain)));
        const hash=await assets.put(bytes),existing=sceneTerrains.get(terrainKey);
        if(existing&&existing!==hash)throw new Error('terrain identity changed within run');
        if(sceneTerrains.size>=128)sceneTerrains.delete(sceneTerrains.keys().next().value);
        sceneTerrains.set(terrainKey,hash);visual.terrainHash=hash;delete visual.terrain;
      }else if(visual.terrainId){
        visual.terrainHash=sceneTerrains.get(terrainKey)??(before?.visual?.terrainId===visual.terrainId?before.visual.terrainHash:undefined);
        if(!visual.terrainHash)throw new Error('terrain reference has no captured asset');
      }
      sample.visual=visual;
    }
    const newCount=state.samplesAccepted+1;
    const acceptedEvents=[],worldEvents=[];
    if(!removed&&before && before.contact!==sample.contact) {
      const typ=sample.contact?'CONTACT_BEGIN':'CONTACT_END';
      const contactAssetHash=await assets.put(encodeSample(sample));
      const ev=makeEnvelope(typ,{runId:sample.runId,epoch:sample.epoch,step:sample.step,
        sequence:journal.head.sequence+1,simTime:sample.simTime,simDt:sample.simDt,
        frameId:sample.frameId,entityId:sample.entityId,position:sample.position,source:'native',
        transportAuthenticated:authenticated,assetHash:contactAssetHash,
        eventId:eventIdentity({...sample,type:typ})});
      // A contact event is not visible to observers until it is fsynced.
      await journal.append(ev);await appendToOsg(ev,contactAssetHash);
      acceptedEvents.push(ev);
    }
    if(!removed&&(!prev||newCount%50===0)) {
      const assetHash=await assets.put(encodeSample(sample));
      const ev=makeEnvelope('CHECKPOINT',{runId:sample.runId,epoch:sample.epoch,step:sample.step,
        sequence:journal.head.sequence+1,simTime:sample.simTime,simDt:sample.simDt,
        entityId:sample.entityId,frameId:sample.frameId,source:'native',
        transportAuthenticated:authenticated,
        assetHash,eventId:eventIdentity({...sample,type:'CHECKPOINT'})});
      await journal.append(ev);await appendToOsg(ev,assetHash);
    }
    if(removed){const event=makeEnvelope('ENTITY_REMOVED',{runId:sample.runId,epoch:sample.epoch,step:sample.step,sequence:journal.head.sequence+1,simTime:sample.simTime,simDt:0,frameId:sample.frameId,entityId:sample.entityId,source:'native',transportAuthenticated:authenticated,eventId:eventIdentity(sample)});await journal.append(event);await appendToOsg(event);acceptedEvents.push(event);}
    state.contactSequence=journal.head.sequence;
    if(changed){
      const reset=makeEnvelope('SIMULATION_RESET',{runId:sample.runId,epoch:sample.epoch,step:sample.step,sequence:journal.head.sequence+1,simTime:sample.simTime,source:'native',transportAuthenticated:authenticated,eventId:eventIdentity({...sample,type:'SIMULATION_RESET'})});
      await journal.append(reset);await appendToOsg(reset);
      if(state.runId!==sample.runId)retiredRuns.add(state.runId);
      if(world)worldEvents.push(reset);else broadcast(reset);
      // Do not mix different physical runs/epochs in a new observer's live state.
      state.lastByEntity.clear();state.lastStepByRun.clear();state.observerAnchor=null;
    }
    state.activeRunKey=runkey;state.activeEpoch=sample.epoch;
    state.lastStepByRun.set(runkey,{sequence:sample.sequence,step:sample.step,simTime:sample.simTime,frameId:sample.frameId});
    if(removed)state.lastByEntity.delete(key);else state.lastByEntity.set(key,sample);state.runId=sample.runId;state.lastSample=removed?[...state.lastByEntity.values()].at(-1)??null:sample;
    if(!removed&&!state.observerAnchor)state.observerAnchor=sample.position.slice();
    state.samplesAccepted=newCount;state.contactSequence=journal.head.sequence;
    if(world){
      world.accept(sample,[...worldEvents,...acceptedEvents]);
      if(world.pending.length>=128)await flushWorld();
    }else broadcast(sample);
    for(const ev of acceptedEvents){if(ev.type!=='ENTITY_REMOVED')state.contacts.push(ev);if(!world)broadcast(ev);}

  }
  async function flushWorld(){
    if(!world)return;
    try{for(const update of await world.flush()){lastPublicationAt=Date.now();for(const peer of peers)if(!initializingPeers.has(peer))sendWorld(peer,update);}osgError=null;}
    catch(error){osgError=error.message;addError('OSG world publication stopped: '+error.message);throw error;}
  }
  const allowedHost=req=>{try{const u=new URL(`http://${req.headers.host}`);return !u.username&&!u.password&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)&&Number(u.port||80)===req.socket.localPort;}catch{return false;}};
  httpServer=http.createServer(async(req,res)=>{
    try {
      if(!allowedHost(req))return json(res,403,{error:'loopback Host required'});
      if(closing)return json(res,503,{error:'service is closing'});
      const u=new URL(req.url,`http://${req.headers.host??'localhost'}`);
      if(world&&req.method==='POST'&&['/api/world/annotations','/api/world/activities'].includes(u.pathname)){
        const origin=req.headers.origin;
        if(origin&&origin!==`http://${req.headers.host}`)return json(res,403,{error:'same origin required'});
        const authorization=req.headers.authorization??'';
        const client=Object.entries(worldClients).find(([,token])=>{
          const a=Buffer.from(authorization),b=Buffer.from('Bearer '+token);
          return a.length===b.length&&timingSafeEqual(a,b);
        });
        if(!client)return json(res,403,{error:'configured world client token required'});
        if(worldWrites.has(client[0])||worldWrites.size>=32)return json(res,429,{error:'world client write already pending; retry after its result'});
        const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>16384)return json(res,413,{error:'request too large'});chunks.push(chunk);}
        let body;try{body=new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks));}catch{return json(res,400,{error:'request body must be valid UTF-8'});}
        if(worldWrites.has(client[0])||worldWrites.size>=32)return json(res,429,{error:'world write queue is full'});
        worldWrites.add(client[0]);
        try{
          const input=JSON.parse(body);
          if(u.pathname==='/api/world/activities'&&input.action==='get'){const contextId=world.contextId(input.runId,input.epoch);return json(res,200,{actor:client[0],...await world.activities.list({contextId,actor:client[0],activityId:input.activityId})});}
          const revision=await enqueue(async()=>{const result=u.pathname==='/api/world/activities'?await world.submitActivity(client[0],input):await world.world.annotate(client[0],input.id,{text:input.text},input.expectedHead);broadcast({type:'OSG_WORLD_REVISION',head:world.revision.head,generation:world.revision.generation});return result;},'background');
          return json(res,200,{...revision,actor:client[0]});
        }catch(error){return json(res,['STALE_HEAD','ACTIVITY_CONFLICT'].includes(error.code)?409:error.code==='ACTIVITY_BUSY'?429:400,{error:error.message,code:error.code??'INVALID_REQUEST',head:world.revision.head});}
        finally{worldWrites.delete(client[0]);}
      }
      if(closing)return json(res,503,{error:'service is closing'});
      if(req.method!=='GET')return json(res,405,{error:'read-only HTTP API'});
      if(u.pathname==='/api/status')return json(res,200,{mode:state.mode,landingDemo,runId:state.runId,
        nativeConnected:state.nativeConnected,nativeAuthenticated:state.nativeAuthenticated,
        nativeWireFormat:state.nativeWireFormat??null,nativeLifecycleSupported:state.nativeWireFormat===2,bridgeAuthRequired:bridgeToken!==null,samplesAccepted:state.samplesAccepted,
        latestStep:state.lastSample?.step??null,journalHead:journal.head,
        osgConnected:!!(osg||world),osgHealthy:world?!world.fault:!!osg&&!state.osgDegraded,osgError,contacts:state.contacts.length,
        version:'0.3.1-dev',freshness:{lastIngressAgeMs:lastIngressAt===null?null:Date.now()-lastIngressAt,lastPublicationAgeMs:lastPublicationAt===null?null:Date.now()-lastPublicationAt,budgetMs:1000,queues:scheduler.status},participationProtocol:world?.participationProtocol??null,osgWorldMode:!!world,worldEngine:world?'osg-multi':null,worldRevision:world?.revision??null,worldPendingSamples:world?.pending.length??0,
        warning:replayPrefix?'Recorder fixture, not live physics':null,errors:state.errors.slice(-5)});
      if(u.pathname.startsWith('/api/world/')){
        if(!world)return json(res,409,{error:'OSG world mode is not enabled'});
        try{
          if(u.pathname==='/api/world/activities')return json(res,200,await world.activities.list({contextId:u.searchParams.get('contextId')??undefined,head:u.searchParams.get('head')??undefined,after:u.searchParams.get('after')??undefined,state:u.searchParams.get('state')??undefined,actor:u.searchParams.get('actor')??undefined,activityId:u.searchParams.get('activityId')??undefined,limit:Number(u.searchParams.get('limit')??256)}));
          if(u.pathname==='/api/world/history')return json(res,200,world.world.streams(u.searchParams.get('head')??undefined));
          if(u.pathname==='/api/world/annotations')return json(res,200,world.world.annotations());
          if(u.pathname==='/api/world/entities')return json(res,200,world.world.entities());
          if(u.pathname==='/api/world/events'){const query={};for(const key of ['runId','head','direction'])if(u.searchParams.has(key))query[key]=u.searchParams.get(key);for(const key of ['epoch','fromSequence','limit','timeMicros'])if(u.searchParams.has(key))query[key]=Number(u.searchParams.get(key));return json(res,200,await world.eventPage(query));}
          if(u.pathname==='/api/world/state'){
            const query={};for(const key of ['runId','head'])if(u.searchParams.has(key))query[key]=u.searchParams.get(key);
            for(const key of ['epoch','timeMicros'])if(u.searchParams.has(key))query[key]=Number(u.searchParams.get(key));
            return json(res,200,await world.snapshot(query));
          }
          return json(res,404,{error:'unknown world endpoint'});
        }catch(error){return json(res,400,{error:error.message});}
      }
      if(u.pathname==='/api/scene/demo')return json(res,200,JSON.parse(await readFile(join(root,'fixtures/landing/demo.json'),'utf8')));
      if(u.pathname.startsWith('/api/scene/asset/')){
        const hash=u.pathname.slice('/api/scene/asset/'.length);if(!/^[a-f0-9]{64}$/.test(hash))return json(res,400,{error:'invalid scene asset hash'});
        const bytes=await assets.get(hash);if(bytes.length>128*1024)throw new Error('terrain asset exceeds limit');
        validateTerrain(JSON.parse(bytes.toString('utf8')));res.writeHead(200,{'content-type':'application/json','cache-control':'private, max-age=31536000, immutable','content-length':bytes.length});return res.end(bytes);
      }
      if(u.pathname==='/api/recording'){
        if(!state.recorded)return json(res,404,{error:'no recorder loaded; native mode'});
        return json(res,200,{source:'recorded',entityId:'Atlantis',
          metadata:state.recorded.positions.metadata,
          samples:state.recorded.positions.samples,
          events:state.recorded.events,attitude:state.recorded.attitude.samples,
          warning:'Recorded LANDED action is not native GroundContact() proof; sample gaps remain unavailable'});
      }
      if(u.pathname==='/api/journal')return json(res,200,{events:await journal.entries()});
      if(u.pathname==='/api/entities'&&world){const snapshot=await world.snapshot();return json(res,200,{source:'osg',head:snapshot.head,entities:snapshot.frames.map(x=>x.sample)});}
      if(u.pathname==='/api/entities')return json(res,200,{source:state.source,entities:[...state.lastByEntity.values()]});
      if(u.pathname==='/api/observer-evidence') {
        const observerId=u.searchParams.get('observer')??'A';
        const entity=u.searchParams.get('entity');
        if(entity!==null){try{identifier(entity,'entity');}catch{return json(res,400,{error:'invalid entity'});}}
        const timeValue=u.searchParams.get('time');const t=timeValue===null||timeValue.trim()===''?NaN:Number(timeValue);
        if(!Object.hasOwn(STUDY_OFFSETS,observerId)||!Number.isFinite(t))return json(res,400,{error:'observer A/B/C and finite time required'});
        let evidenceAnchor=state.observerAnchor,evidenceContacts=state.contacts,evidenceRunKey=state.activeRunKey,evidenceHead=null;
        if(world){const query={};for(const key of ['head','runId'])if(u.searchParams.has(key))query[key]=u.searchParams.get(key);if(u.searchParams.has('epoch'))query.epoch=Number(u.searchParams.get('epoch'));const committed=await world.snapshot(query);evidenceHead=committed.head;evidenceAnchor=committed.observerAnchor??null;evidenceContacts=committed.events;evidenceRunKey=committed.runId!=null?`${committed.runId}/${committed.epoch}`:null;}
        if(!evidenceAnchor)return json(res,200,{observerId,time:t,status:'NO_NATIVE_ANCHOR',events:[]});
        const offset=STUDY_OFFSETS[observerId];
        const position=evidenceAnchor.map((x,i)=>x+offset[i]);
        return json(res,200,{observerId,time:t,observerPosition:position,...(world?{source:'osg',head:evidenceHead}:{}),
          model:'HYPOTHETICAL_STATIONARY_LIGHT_PROPAGATION_NO_OCCLUSION',
          events:evidenceContacts.filter(e=>['CONTACT_BEGIN','CONTACT_END'].includes(e.type)).filter(e=>(!evidenceRunKey||`${e.runId}/${e.epoch}`===evidenceRunKey)&&(!entity||e.entityId===entity))
            .map(e=>({...causalObservation(e,()=>position,t),type:e.type,entityId:e.entityId,emissionTime:e.simTime,
            transportAuthenticated:e.transportAuthenticated===true}))});
      }
      if(u.pathname==='/api/state'&&world){const snapshot=await world.snapshot();return json(res,200,{source:'osg',head:snapshot.head,state:snapshot.frames[0]?.sample??null});}
      if(u.pathname==='/api/state'){
        if(!state.recorded)return json(res,200,{state:state.lastSample,source:'native'});
        const t=Number(u.searchParams.get('time')??0);
        if(!Number.isFinite(t))return json(res,400,{error:'invalid time'});
        return json(res,200,{source:'recorded',state:stateAt(state.recorded.positions.samples,t)});
      }
      if(u.pathname==='/')u.pathname='/apps/observer/index.html';
      const allowed=['/apps/observer/','/packages/sg4d/','/packages/landing-scene/','/packages/world-protocol/primitives.mjs','/fixtures/landing/assets/'];
      if(!allowed.some(prefix=>u.pathname.startsWith(prefix)))return json(res,404,{error:'not found'});
      const full=resolve(root,'.'+u.pathname);
      const publicPrefix=allowed.find(prefix=>u.pathname.startsWith(prefix));
      const relativePublicPath=relative(resolve(root,'.'+(publicPrefix.endsWith('/')?publicPrefix:dirname(publicPrefix))),full);
      if(relativePublicPath==='..'||relativePublicPath.startsWith('..'+sep)||isAbsolute(relativePublicPath))
        return json(res,403,{error:'forbidden'});
      const content=await readFile(full);
      res.writeHead(200,{'content-type':mime[extname(full)]??'application/octet-stream','cache-control':'no-store','content-security-policy':"default-src 'self' https://cdn.jsdelivr.net; script-src 'self' https://cdn.jsdelivr.net; worker-src blob:; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:* https://cdn.jsdelivr.net; img-src 'self' data:;"});res.end(content);
    }catch(e){json(res,e.code==='ENOENT'?404:500,{error:e.message});}
  });
  httpServer.requestTimeout=10000;httpServer.headersTimeout=5000;
  httpServer.on('upgrade',(req,socket,head)=>{
    if(!allowedHost(req)||req.url!=='/ws'){socket.destroy();return;}
    if(!wsUpgrade(req,socket,peers,head))return;
    if(world){
      initializingPeers.add(socket);
      enqueue(async()=>{try{sendWorld(socket,await world.snapshot());}finally{initializingPeers.delete(socket);}},'background').catch(error=>{addError(error.message);socket.destroy();});
      return;
    }
    for(const sample of state.lastByEntity.values())send(socket,makeEnvelope('WORLD_INIT',{
      runId:sample.runId,epoch:sample.epoch,step:sample.step,sequence:sample.sequence,simTime:sample.simTime,
      source:'native',entityId:sample.entityId,frameId:sample.frameId,
      position:sample.position,velocity:sample.velocity,orientation:sample.orientation,...(sample.visual?{visual:sample.visual}:{}),contact:sample.contact,transportAuthenticated:sample.transportAuthenticated
    }));
    for(const contact of state.contacts.filter(e=>state.activeRunKey&&`${e.runId}/${e.epoch}`===state.activeRunKey).slice(-128))send(socket,contact);
  });
  tcp=net.createServer(socket=>{
    socket.on('error',e=>addError(e.message));
    if(closing||replayPrefix||nativeSockets.size>0){socket.destroy();return;}
    nativeSockets.add(socket);state.nativeConnected=bridgeToken===null;state.nativeAuthenticated=false;
    const session={authenticated:false,failed:false,awaitingHello:bridgeToken!==null,authorizedRun:null};
    let buffer='';socket.setEncoding('utf8');
    const fail=error=>{if(!session.failed)addError(error.message);session.failed=true;socket.destroy();};
    socket.setTimeout(bridgeToken===null?0:5000,()=>fail(new Error('bridge HELLO timeout')));
    let processing=false,closed=false;
    const release=()=>{if(closed&&!processing){nativeSockets.delete(socket);state.nativeConnected=false;state.nativeAuthenticated=false;}};
    async function processChunk(chunk){
      processing=true;
      socket.pause();buffer+=chunk;
      if(Buffer.byteLength(buffer)>MAX_CONNECTION_BUFFER){fail(new Error('bridge input buffer overflow'));processing=false;release();return;}
      try{
        let end;
        while(!session.failed&&(end=buffer.indexOf('\n'))>=0){
          const line=buffer.slice(0,end);buffer=buffer.slice(end+1);
          if(!line.trim())continue;
          if(Buffer.byteLength(line)>MAX_ENVELOPE_BYTES)throw new Error('oversized bridge frame');
          const frame=JSON.parse(line);
          if(session.awaitingHello){
            const msg=validateEnvelope(frame);
            if(msg.type!=='HELLO')throw new Error('bridge HELLO required before telemetry');
            const given=Buffer.from(msg.bridgeToken),expected=Buffer.from(bridgeToken);
            if(given.length!==expected.length||!timingSafeEqual(given,expected))throw new Error('bridge authentication rejected');
            session.awaitingHello=false;session.authorizedRun=msg.runId;session.authenticated=true;
            state.nativeAuthenticated=true;state.nativeConnected=true;socket.setTimeout(0);continue;
          }
          if(frame.type==='HELLO')throw new Error('duplicate bridge HELLO');
          if(session.authorizedRun&&frame.runId!==session.authorizedRun)throw new Error('bridge run changed without handshake');
          lastIngressAt=Date.now();
          await enqueue(()=>acceptSample(frame,session));
        }
        if(Buffer.byteLength(buffer)>MAX_ENVELOPE_BYTES)throw new Error('oversized bridge frame');
      }catch(e){fail(e);}
      finally{processing=false;release();if(!session.failed&&!closed)socket.resume();}
    }
    socket.on('data',chunk=>{const pump=processChunk(chunk);pumps.add(pump);pump.finally(()=>pumps.delete(pump));});
    socket.on('close',()=>{closed=true;release();});
  });
  const listen=(server,port)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.off('error',reject);resolve(server.address().port);});});
  const actualHttp=await listen(httpServer,httpPort);
  let actualBridge;try{actualBridge=await listen(tcp,bridgePort);}catch(e){httpServer.close();throw e;}
  if(world){let queued=false;worldTimer=setInterval(()=>{
    if(queued||closing||world.fault||!world.pending.length)return;queued=true;
    enqueue(flushWorld).catch(()=>{}).finally(()=>{queued=false;});
  },worldBatchMs);worldTimer.unref();}
  async function close(){closing=true;clearInterval(worldTimer);for(const peer of peers)peer.destroy();for(const s of nativeSockets)s.destroy();
    await Promise.all([new Promise(r=>httpServer.close(r)),new Promise(r=>tcp.close(r))]);
    await Promise.allSettled([...pumps]);await scheduler.idle();try{if(world&&!world.fault)await flushWorld();}finally{await journal.close();await osg?.close();await world?.close();}}
  return {httpPort:actualHttp,bridgePort:actualBridge,close,state,world,flushWorld:()=>enqueue(flushWorld),handleSample:input=>{const copy=structuredClone(input);return enqueue(()=>acceptSample(copy));},journal,assets};
  }catch(error){clearInterval(worldTimer);await world?.close();if(httpServer?.listening)await new Promise(r=>httpServer.close(r));if(tcp?.listening)await new Promise(r=>tcp.close(r));await osg?.close();await journal.close();throw error;}
}

const self=fileURLToPath(import.meta.url);
if(process.argv[1] && resolve(process.argv[1])===self){
  const i=process.argv.indexOf('--replay');
  const replayPrefix=i>=0?resolve(process.argv[i+1]):null;
  const landingDemo=process.argv.includes('--landing-demo');
  const httpPort=Number(process.env.OSG_HTTP_PORT??4377),bridgePort=Number(process.env.OSG_BRIDGE_PORT??4378);
  const dataDir=process.env.OSG_DATA_DIR ? resolve(process.env.OSG_DATA_DIR) : undefined;
  const app=await createWorldServer({httpPort,bridgePort,dataDir,replayPrefix,landingDemo,osgSourceDir:process.env.OSG_SOURCE_DIR??null,osgWorldMode:!replayPrefix&&!landingDemo&&process.env.OSG_WORLD_MODE!=='0',osgMultiSourceDir:process.env.OSG_MULTI_SOURCE_DIR??null,worldBatchMs:Number(process.env.OSG_WORLD_BATCH_MS??250),worldClients:JSON.parse(process.env.OSG_WORLD_CLIENTS??'{}')});
  console.log(`OSG Sim ${app.state.mode} viewer at http://127.0.0.1:${app.httpPort}`);
  console.log(`Native bridge (loopback only) at 127.0.0.1:${app.bridgePort}`);
  process.on('SIGINT',async()=>{await app.close();process.exit(0)});
  process.on('SIGTERM',async()=>{await app.close();process.exit(0)});
}
