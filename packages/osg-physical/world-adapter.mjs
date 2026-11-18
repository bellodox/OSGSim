// SPDX-License-Identifier: MIT
// Node host for the separately built experimental OSG temporal-world API.
import {pathToFileURL} from 'node:url';
import {join,resolve} from 'node:path';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {encodeSample,decodeSample} from './journal.mjs';
import {assert,validateEnvelope} from '../world-protocol/index.mjs';

function encode(sample,events){
  const {simTime,simDt,position,velocity,orientation,angularVelocity,contact,...metadata}=sample;
  const header=Buffer.from(JSON.stringify({metadata,events}));
  const bytes=Buffer.alloc(4+header.length+136);bytes.writeUInt32LE(header.length);
  header.copy(bytes,4);encodeSample(sample).copy(bytes,4+header.length);return bytes;
}
function decode(record){
  const bytes=Buffer.from(record.payload),size=bytes.readUInt32LE();
  assert(size<=bytes.length-4-136,'invalid world sample header');
  const {metadata,events}=JSON.parse(bytes.subarray(4,4+size).toString('utf8'));
  const {formatVersion,...physical}=decodeSample(bytes.subarray(4+size));
  for(const key of ['orientation','angularVelocity','contact'])if(physical[key]==null)delete physical[key];
  const sample=validateEnvelope({...metadata,...physical});
  assert(sample.sequence===record.sequence&&sample.step===record.step&&Math.round(sample.simTime*1e6)===record.timeMicros&&sample.entityId===record.entityId&&sample.frameId===record.frameId,'world sample metadata mismatch');
  assert(Array.isArray(events),'invalid world events');events.forEach(validateEnvelope);
  return {sample,events};
}
export class OsgWorldAdapter {
  constructor({sourceDir,storeDir,assets}){this.sourceDir=sourceDir;this.storeDir=storeDir;this.assets=assets;this.pending=[];this.pendingBytes=0;this.fault=null;}
  async open(){
    assert(this.sourceDir,'World mode requires OSG_MULTI_SOURCE_DIR');
    const root=resolve(this.sourceDir);
    const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
    assert(manifest.name==='osg-multi'&&manifest.bin?.['osg-multi'],'World mode requires the osg-multi package, not the standard osg build');
    const [{WorldGraph},{openStore},{ParticipationGraph,participationProtocol}]=await Promise.all([
      import(pathToFileURL(join(root,'dist/core/src/world.js')).href),
      import(pathToFileURL(join(root,'dist/storage-lance/src/index.js')).href),
      import(pathToFileURL(join(root,'dist/core/src/participation.js')).href)
    ]);
    assert(participationProtocol==='osg-participation-1','Rebuild the matching osg-multi participation API');
    this.store=await openStore(this.storeDir,true);
    try{this.world=await WorldGraph.open(this.store,this.assets);this.activities=new ParticipationGraph(this.store);this.participationProtocol=participationProtocol;this.sessionId=randomUUID();this.runActivities=new Map();}catch(error){this.store.close();throw error;}
    return this;
  }
  get revision(){return this.world.revision;}
  accept(sample,events){
    assert(!this.fault,'world writer faulted; start a new verified run');
    const payload=encode(sample,events);
    assert(this.pending.length<512&&this.pendingBytes+payload.length<=2*1024*1024,'world publication backlog exceeded');
    this.pending.push({runId:sample.runId,epoch:sample.epoch,record:{sequence:sample.sequence,step:sample.step,timeMicros:Math.round(sample.simTime*1e6),entityId:sample.entityId,frameId:sample.frameId,operation:sample.type==='ENTITY_REMOVED'?'delete':'state',marked:events.length>0,payload}});
    this.pendingBytes+=payload.length;
  }
  async flush(){
    assert(!this.fault,'world writer faulted');
    const updates=[];
    try{
      while(this.pending.length){
        const {runId,epoch}=this.pending[0];let end=1;
        while(end<this.pending.length&&this.pending[end].runId===runId&&this.pending[end].epoch===epoch&&end<128)end++;
        const group=this.pending.slice(0,end);
        let revision=await this.world.append(runId,epoch,group.map(x=>x.record));
        const contextId=this.contextId(runId,epoch);
        if(!this.runActivities.has(contextId)){
          const started=await this.activities.submit('osg-host',{sessionId:this.sessionId,requestId:contextId,contextId,activityId:'native-ingestion',action:'start',text:'Native telemetry ingestion; transport evidence is recorded per sample. This activity is not simulator attestation.',expectedVersion:null});
          this.runActivities.set(contextId,started.version);
          await this.world.refresh();revision=this.revision;
        }
        // Read through hash-verified graph history, never publish the ingress buffer directly.
        const saved=await this.world.range({runId,epoch,head:revision.head,fromSequence:group[0].record.sequence,limit:group.length});
        assert(saved.records.length===group.length,'committed segment reconstruction incomplete');
        updates.push({type:'OSG_WORLD_UPDATE',...revision,runId,epoch,frames:saved.records.map(decode),streams:this.world.streams(revision.head).streams});
        this.pending.splice(0,end);this.pendingBytes=this.pending.reduce((n,x)=>n+x.record.payload.length,0);
      }
      return updates;
    }catch(error){this.fault=error.message;throw error;}
  }
  async snapshot({runId,epoch,timeMicros,head}={}){
    const listing=this.world.streams(head);
    const stream=runId!=null?listing.streams.find(x=>x.runId===runId&&x.epoch===epoch):listing.streams.slice().sort((a,b)=>b.generation-a.generation)[0];
    if(!stream)return {type:'OSG_WORLD_SNAPSHOT',head:listing.head,streams:listing.streams,frames:[],events:[]};
    const query={runId:stream.runId,epoch:stream.epoch,head:listing.head,...(timeMicros!=null?{timeMicros}:{})};
    const state=await this.world.read(query);
    // Sparse committed marker index avoids scanning dense trajectories for contacts.
    const marked=await this.world.markedPage({...query,direction:'backward',limit:128}),events=marked.records.slice().reverse().flatMap(record=>decode(record).events);
    assert(events.length<=10000,'world event query exceeds limit');
    const origins={};
    for(const record of state.records){const first=await this.world.first({...query,entityId:record.entityId});if(first)origins[record.entityId]=decode(first).sample.position;}
    const first=await this.world.range({runId:stream.runId,epoch:stream.epoch,head:listing.head,fromSequence:1,limit:1});
    const observerAnchor=first.records[0]?decode(first.records[0]).sample.position:null;
    return {type:'OSG_WORLD_SNAPSHOT',head:state.head,runId:stream.runId,epoch:stream.epoch,streams:listing.streams,
      frames:state.records.map(r=>({sample:{...decode(r).sample,type:'WORLD_INIT'},events:[]})),events,origins,observerAnchor,eventHistory:{truncated:marked.nextSequence!==null,nextSequence:marked.nextSequence,direction:'backward',head:state.head}};
  }
  async eventPage(query){
    const page=await this.world.markedPage(query);
    return {...page,records:undefined,events:page.records.flatMap(record=>decode(record).events)};
  }
  contextId(runId,epoch){return `simulation/${runId}/${epoch}`;}
  async submitActivity(actor,input){
    const {runId,epoch}=input;
    assert(this.world.streams().streams.some(s=>s.runId===runId&&s.epoch===epoch),'activity needs an existing committed run and epoch');
    const result=await this.activities.submit(actor,{sessionId:input.sessionId,requestId:input.requestId,
      contextId:this.contextId(runId,epoch),activityId:input.activityId,action:input.action,text:input.text,
      expectedVersion:input.expectedVersion,requires:input.requires});
    await this.world.refresh();return result;
  }
  async close(){
    try{
      if(this.activities&&!this.fault)for(const [contextId,version]of this.runActivities){
        await this.activities.submit('osg-host',{sessionId:this.sessionId,requestId:'close/'+contextId,contextId,
          activityId:'native-ingestion',action:'finish',text:'Ingestion host closed. This does not assert completion of the simulation.',expectedVersion:version});
      }
    }finally{this.store?.close();}
  }
}
