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

export async function createWorldServer({httpPort=4377,bridgePort=4378,dataDir=join(root,'.data'),replayPrefix=null,osgSourceDir=null,host='127.0.0.1',bridgeToken=process.env.OSG_BRIDGE_TOKEN??null}={}) {
  if(!['127.0.0.1','::1'].includes(host))throw new Error('world service requires a loopback bind address');
  if(bridgeToken!==null && !/^[A-Za-z0-9_-]{16,128}$/.test(bridgeToken))throw new Error('OSG_BRIDGE_TOKEN must be 16-128 ASCII URL-safe characters');
  await mkdir(dataDir,{recursive:true});
  const journal=await new DurableJournal(join(dataDir,'events.journal')).open();
  const assets=new AssetStore(join(dataDir,'assets'));
  let osg=null,osgError=null,httpServer,tcp;
  try {
  if(osgSourceDir){
    try{osg=await new OsgAdapter({sourceDir:osgSourceDir,storeDir:join(dataDir,'osg-store')}).open();}
    catch(e){osgError=e.message;await journal.close();throw new Error(`OSG startup failed: ${e.message}`);}
  }
  const recoveredEvents=await journal.entries();
  if(osg){try{await osg.reconcile(recoveredEvents);}catch(error){await osg.close();await journal.close();throw new Error(`OSG journal recovery failed: ${error.message}`);}}
  const peers=new Set(),nativeSockets=new Set(),pumps=new Set();
  let closing=false;
  const state={mode:replayPrefix?'recorded':'native',runId:replayPrefix?'recorder-atlantis':null,
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
  const recoveredRuns=new Set(recoveredEvents.filter(e=>e.source==='native').map(e=>e.runId));
  const retiredRuns=new Set();
  const addError=message=>{state.errors.push(message);if(state.errors.length>100)state.errors.shift();};
  const send=(socket,value)=>sendFrame(socket,JSON.stringify(value));
  const broadcast=value=>{for(const peer of peers)send(peer,value);};
  let series=Promise.resolve();
  const enqueue=fn=>{const p=series.then(fn);series=p.catch(err=>{addError(err.message);});return p;};
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
    if(replayPrefix)throw new Error('replay mode refuses native input');
    validateEnvelope(input);
    const fields=['version','type','source','runId','epoch','step','sequence','simTime','simDt','frameId','entityId','position','velocity','orientation','angularVelocity','contact'];
    const sample=Object.fromEntries(fields.filter(k=>Object.hasOwn(input,k)).map(k=>[k,input[k]]));
    sample.transportAuthenticated=authenticated;
    if(sample.type!=='PHYSICS_SAMPLE'||sample.source!=='native')throw new Error('native bridge accepts PHYSICS_SAMPLE source=native only');
    const runkey=`${sample.runId}/${sample.epoch}`;
    const changed=!!state.activeRunKey&&state.activeRunKey!==runkey;
    if(recoveredRuns.has(sample.runId)||retiredRuns.has(sample.runId))throw new Error('retired or recovered native run requires a new runId');
    if(state.runId===sample.runId && state.lastSample && sample.epoch<state.lastSample.epoch)throw new Error('regressed native epoch');
    if(changed&&retiredRuns.size>=1024)throw new Error('native run limit reached; restart service');
    const prev=state.lastStepByRun.get(runkey);
    if(prev && (sample.sequence!==prev.sequence+1||sample.step<prev.step)) throw new Error('duplicate, skipped or regressed native sample');
    if(!prev && sample.sequence!==1)throw new Error('native stream must start at sequence 1');
    const key=`${runkey}/${sample.entityId}`, before=state.lastByEntity.get(key);
    if(prev&&(sample.simTime<prev.simTime || (sample.step===prev.step&&sample.simTime!==prev.simTime)))throw new Error('inconsistent or regressed native time');
    if(prev&&sample.frameId!==prev.frameId)throw new Error('native frame changed within epoch');
    if(before&&sample.step<=before.step)throw new Error('duplicate or regressed vessel step');
    const newCount=state.samplesAccepted+1;
    const acceptedEvents=[];
    if(before && before.contact!==sample.contact) {
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
    if(!prev||newCount%50===0) {
      const assetHash=await assets.put(encodeSample(sample));
      const ev=makeEnvelope('CHECKPOINT',{runId:sample.runId,epoch:sample.epoch,step:sample.step,
        sequence:journal.head.sequence+1,simTime:sample.simTime,simDt:sample.simDt,
        entityId:sample.entityId,frameId:sample.frameId,source:'native',
        transportAuthenticated:authenticated,
        assetHash,eventId:eventIdentity({...sample,type:'CHECKPOINT'})});
      await journal.append(ev);await appendToOsg(ev,assetHash);
    }
    state.contactSequence=journal.head.sequence;
    if(changed){
      const reset=makeEnvelope('SIMULATION_RESET',{runId:sample.runId,epoch:sample.epoch,step:sample.step,sequence:journal.head.sequence+1,simTime:sample.simTime,source:'native',transportAuthenticated:authenticated,eventId:eventIdentity({...sample,type:'SIMULATION_RESET'})});
      await journal.append(reset);await appendToOsg(reset);
      if(state.runId!==sample.runId)retiredRuns.add(state.runId);
      broadcast(reset);
      // Do not mix different physical runs/epochs in a new observer's live state.
      state.lastByEntity.clear();state.lastStepByRun.clear();state.observerAnchor=null;
    }
    state.activeRunKey=runkey;
    state.lastStepByRun.set(runkey,{sequence:sample.sequence,step:sample.step,simTime:sample.simTime,frameId:sample.frameId});
    state.lastByEntity.set(key,sample);state.runId=sample.runId;state.lastSample=sample;
    if(!state.observerAnchor)state.observerAnchor=sample.position.slice();
    state.samplesAccepted=newCount;state.contactSequence=journal.head.sequence;
    broadcast(sample);
    for(const ev of acceptedEvents){state.contacts.push(ev);broadcast(ev);}

  }
  const allowedHost=req=>{try{const u=new URL(`http://${req.headers.host}`);return !u.username&&!u.password&&['127.0.0.1','localhost','[::1]'].includes(u.hostname)&&Number(u.port||80)===req.socket.localPort;}catch{return false;}};
  httpServer=http.createServer(async(req,res)=>{
    try {
      if(!allowedHost(req))return json(res,403,{error:'loopback Host required'});
      const u=new URL(req.url,`http://${req.headers.host??'localhost'}`);
      if(req.method!=='GET')return json(res,405,{error:'read-only HTTP API'});
      if(u.pathname==='/api/status')return json(res,200,{mode:state.mode,runId:state.runId,
        nativeConnected:state.nativeConnected,nativeAuthenticated:state.nativeAuthenticated,
        bridgeAuthRequired:bridgeToken!==null,samplesAccepted:state.samplesAccepted,
        latestStep:state.lastSample?.step??null,journalHead:journal.head,
        osgConnected:!!osg,osgHealthy:!!osg&&!state.osgDegraded,osgError,contacts:state.contacts.length,
        warning:replayPrefix?'Recorder fixture, not live physics':null,errors:state.errors.slice(-5)});
      if(u.pathname==='/api/recording'){
        if(!state.recorded)return json(res,404,{error:'no recorder loaded; native mode'});
        return json(res,200,{source:'recorded',entityId:'Atlantis',
          metadata:state.recorded.positions.metadata,
          samples:state.recorded.positions.samples,
          events:state.recorded.events,attitude:state.recorded.attitude.samples,
          warning:'Recorded LANDED action is not native GroundContact() proof; sample gaps remain unavailable'});
      }
      if(u.pathname==='/api/journal')return json(res,200,{events:await journal.entries()});
      if(u.pathname==='/api/entities')return json(res,200,{source:state.source,entities:[...state.lastByEntity.values()]});
      if(u.pathname==='/api/observer-evidence') {
        const observerId=u.searchParams.get('observer')??'A';
        const entity=u.searchParams.get('entity');
        if(entity!==null){try{identifier(entity,'entity');}catch{return json(res,400,{error:'invalid entity'});}}
        const timeValue=u.searchParams.get('time');const t=timeValue===null||timeValue.trim()===''?NaN:Number(timeValue);
        if(!Object.hasOwn(STUDY_OFFSETS,observerId)||!Number.isFinite(t))return json(res,400,{error:'observer A/B/C and finite time required'});
        if(!state.observerAnchor)return json(res,200,{observerId,time:t,status:'NO_NATIVE_ANCHOR',events:[]});
        const offset=STUDY_OFFSETS[observerId];
        const position=state.observerAnchor.map((x,i)=>x+offset[i]);
        return json(res,200,{observerId,time:t,observerPosition:position,
          model:'HYPOTHETICAL_STATIONARY_LIGHT_PROPAGATION_NO_OCCLUSION',
          events:state.contacts.filter(e=>(!state.activeRunKey||`${e.runId}/${e.epoch}`===state.activeRunKey)&&(!entity||e.entityId===entity))
            .map(e=>({...causalObservation(e,()=>position,t),type:e.type,entityId:e.entityId,emissionTime:e.simTime,
            transportAuthenticated:e.transportAuthenticated===true}))});
      }
      if(u.pathname==='/api/state'){
        if(!state.recorded)return json(res,200,{state:state.lastSample,source:'native'});
        const t=Number(u.searchParams.get('time')??0);
        if(!Number.isFinite(t))return json(res,400,{error:'invalid time'});
        return json(res,200,{source:'recorded',state:stateAt(state.recorded.positions.samples,t)});
      }
      if(u.pathname==='/')u.pathname='/apps/observer/index.html';
      const allowed=['/apps/observer/'];
      if(!allowed.some(prefix=>u.pathname.startsWith(prefix)))return json(res,404,{error:'not found'});
      const full=resolve(root,'.'+u.pathname);
      const relativePublicPath=relative(resolve(root,'apps','observer'),full);
      if(relativePublicPath==='..'||relativePublicPath.startsWith('..'+sep)||isAbsolute(relativePublicPath))
        return json(res,403,{error:'forbidden'});
      const content=await readFile(full);
      res.writeHead(200,{'content-type':mime[extname(full)]??'application/octet-stream','cache-control':'no-store','content-security-policy':"default-src 'self' https://cdn.jsdelivr.net; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:* https://cdn.jsdelivr.net; img-src 'self' data:;"});res.end(content);
    }catch(e){json(res,e.code==='ENOENT'?404:500,{error:e.message});}
  });
  httpServer.on('upgrade',(req,socket,head)=>{
    if(!allowedHost(req)||req.url!=='/ws'){socket.destroy();return;}
    if(!wsUpgrade(req,socket,peers,head))return;
    for(const sample of state.lastByEntity.values())send(socket,makeEnvelope('WORLD_INIT',{
      runId:sample.runId,epoch:sample.epoch,step:sample.step,sequence:sample.sequence,simTime:sample.simTime,
      source:'native',entityId:sample.entityId,frameId:sample.frameId,
      position:sample.position,velocity:sample.velocity,orientation:sample.orientation,contact:sample.contact,transportAuthenticated:sample.transportAuthenticated
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
  async function close(){closing=true;for(const peer of peers)peer.destroy();for(const s of nativeSockets)s.destroy();
    await Promise.all([new Promise(r=>httpServer.close(r)),new Promise(r=>tcp.close(r))]);
    await Promise.allSettled([...pumps]);await series;await journal.close();await osg?.close();}
  return {httpPort:actualHttp,bridgePort:actualBridge,close,state,handleSample:input=>{const copy=structuredClone(input);return enqueue(()=>acceptSample(copy));},journal,assets};
  }catch(error){if(httpServer?.listening)await new Promise(r=>httpServer.close(r));if(tcp?.listening)await new Promise(r=>tcp.close(r));await osg?.close();await journal.close();throw error;}
}

const self=fileURLToPath(import.meta.url);
if(process.argv[1] && resolve(process.argv[1])===self){
  const i=process.argv.indexOf('--replay');
  const replayPrefix=i>=0?resolve(process.argv[i+1]):null;
  const httpPort=Number(process.env.OSG_HTTP_PORT??4377),bridgePort=Number(process.env.OSG_BRIDGE_PORT??4378);
  const dataDir=process.env.OSG_DATA_DIR ? resolve(process.env.OSG_DATA_DIR) : undefined;
  const app=await createWorldServer({httpPort,bridgePort,dataDir,replayPrefix,osgSourceDir:process.env.OSG_SOURCE_DIR??null});
  console.log(`OSG Sim ${app.state.mode} viewer at http://127.0.0.1:${app.httpPort}`);
  console.log(`Native bridge (loopback only) at 127.0.0.1:${app.bridgePort}`);
  process.on('SIGINT',async()=>{await app.close();process.exit(0)});
  process.on('SIGTERM',async()=>{await app.close();process.exit(0)});
}
