import {LandingTimeline} from '/packages/landing-scene/timeline.mjs';
import {worldFeedFresh} from './freshness.mjs';
import {worldFrames} from './world-state.mjs';
import {mountActivities} from './activities.mjs';
// SPDX-License-Identifier: MIT
import { createPlayCanvasScene } from './playcanvas-bridge.mjs';
import { applyNativeFrame } from './native-state.mjs';

const q=s=>document.querySelector(s);
const params=new URLSearchParams(location.search);
const id=['A','B','C'].includes(params.get('observer'))?params.get('observer'):'A';
const initialYaw={A:36,B:-58,C:112}[id];
const elements={
  connection:q('#connection-status'), time:q('#sim-time-large'),current:q('#timeline-time'),
  play:q('#play-pause'),playIcon:q('#play-icon'),seek:q('#timeline'),
  renderer:q('#renderer-label'),message:q('#scene-message'),status:q('#storage-status'),
  graph:q('#backend-status'),data:q('#data-status'),contact:q('#contact'),
  authority:q('#authority'),height:q('#altitude'),velocity:q('#velocity'),
  radius:q('#radius'),step:q('#step'),frame:q('#frame-label'),source:q('#source-label'),
  eventList:q('#event-list'),count:q('#event-count')
};
q('#observer-label').innerHTML=id+'<span class="outline-triangle">△</span>';
for(const x of ['A','B','C'])if(x===id)q('#link-'+x).classList.add('active');
q('#camera-yaw').value=String(initialYaw);q('#yaw-value').textContent=initialYaw+'°';
const canvas=q('#scene-2d'),ctx=canvas.getContext('2d');
const sceneTimeline=new LandingTimeline();
const pollActivities=mountActivities(document.querySelector('.side-stack'));
const state={worldMode:false,worldLive:true,worldHead:null,worldPinnedHead:null,worldStream:null,worldRequest:0,mode:'waiting',samples:[],events:[],position:null,runId:null,
  sceneClock:null,sceneLoading:false,cameraElevation:22,simTime:0,minTime:0,maxTime:240,playing:false,azimuth:initialYaw,zoom:1,source:'unknown',
  lastNative:null,contactNative:false,pc:null,heightReference:0,recordingGap:false,
  error:null,frame:'UNAVAILABLE',authenticated:false,nativeLive:false,requestedEntity:params.get('entity')};
const number=(n,d=2)=>Number.isFinite(n)?n.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d}):'—';
const radius=v=>Math.hypot(...v);
const clamp=(x,a,b)=>Math.min(b,Math.max(a,x));
const setText=(selector,v)=>q(selector).textContent=v;
function appendEvent(type,simTime,source,description,eventId=null) {
  const key=eventId??`${type}/${simTime}/${source}`;
  if(state.events.some(e=>e.key===key))return;
  state.events.push({key,type,simTime,source,description});
  state.events.sort((a,b)=>b.simTime-a.simTime);
  elements.count.textContent=`${String(state.events.length).padStart(2,'0')} EVENTS`;
  elements.eventList.replaceChildren();
  for(const e of state.events.slice(0,8)){
    const row=document.createElement('div');row.className='event-row';
    const dot=document.createElement('div');dot.className='event-dot';
    const info=document.createElement('div');info.className='event-info';
    const title=document.createElement('strong');title.textContent=e.type.replaceAll('_',' ');
    const detail=document.createElement('small');detail.textContent=`T+${number(e.simTime,3)} · ${e.source.toUpperCase()} · ${e.description}`;
    info.append(title,detail);row.append(dot,info);elements.eventList.append(row);
  }
}
function interpolate(t){
  const values=state.samples;
  if(values.length===0)return null;
  if(t<=values[0].time)return {...values[0],interpolated:false};
  if(t>=values.at(-1).time)return {...values.at(-1),interpolated:false};
  let i=0,j=values.length-1;
  while(i+1<j){const m=(i+j)>>1;if(values[m].time<=t)i=m;else j=m;}
  const a=values[i],b=values[j],delta=b.time-a.time;
  if(delta>10&&t>a.time&&t<b.time)return {unavailable:true,lastKnownTime:a.time,nextKnownTime:b.time};
  if(t===a.time)return {...a,interpolated:false};
  const u=(t-a.time)/delta,pa=a.position,pb=b.position,va=a.velocity,vb=b.velocity;
  const h00=2*u**3-3*u**2+1,h10=u**3-2*u**2+u,h01=-2*u**3+3*u**2,h11=u**3-u**2;
  return {...a,time:t,position:pa.map((v,k)=>h00*v+h10*delta*va[k]+h01*pb[k]+h11*delta*vb[k]),
    velocity:pa.map((v,k)=>(6*u*u-6*u)*v/delta+(3*u*u-4*u+1)*va[k]+(-6*u*u+6*u)*pb[k]/delta+(3*u*u-2*u)*vb[k]),interpolated:true};
}
function getPhysicalState(){
  if(state.mode==='landing-demo')return sceneTimeline.at(state.simTime).find(s=>s.entityId===state.selectedEntity)??null;
  if(state.mode==='recorded')return interpolate(state.simTime);
  if(state.mode==='native')return state.lastNative;
  return null;
}
function isContactKnown(t){
  const previous=state.events.filter(e=>['CONTACT_BEGIN','CONTACT_END'].includes(e.type)&&e.simTime<=t).sort((a,b)=>b.simTime-a.simTime)[0];
  return previous?.type==='CONTACT_BEGIN';
}
function contactOpacity(t){
  const start=state.events.filter(e=>e.type==='CONTACT_BEGIN'&&e.simTime<=t).sort((a,b)=>b.simTime-a.simTime)[0];
  if(!start)return 0;
  const stop=state.events.filter(e=>e.type==='CONTACT_END'&&e.simTime>=start.simTime&&e.simTime<=t).sort((a,b)=>b.simTime-a.simTime)[0];
  if(stop||t>=start.simTime+8)return 0;
  // Explicit validity interval. A historical LANDED marker is not native contact proof.
  return clamp(.28+.65*Math.exp(-Math.max(0,t-start.simTime)/6),0,1);
}
function renderTelemetry(s){
  if(state.mode==='landing-demo'&&s){
    const body=s.visual.bodyPosition,h=Math.hypot(...s.position.map((v,i)=>v-body[i]))-s.visual.bodyRadius;
    elements.height.textContent=number(h,2);elements.velocity.textContent=number(radius(s.velocity),2);elements.radius.textContent=number(s.visual.bodyRadius/1000,2);elements.step.textContent=String(s.step);elements.contact.textContent=s.contact?'DEMO END STATE':'SYNTHETIC DESCENT';elements.message.textContent='SYNTHETIC RENDERER FIXTURE · NOT NATIVE EVIDENCE';return;
  }
  const missing=s?.unavailable;
  if(!s||missing){
    elements.height.textContent='—';elements.velocity.textContent='—';elements.radius.textContent='—';
    elements.step.textContent='—';
    const known=isContactKnown(state.simTime);
    elements.contact.textContent=known?(state.mode==='native'?'NATIVE EVENT':'RECORDER LANDED'):'UNESTABLISHED';
    elements.contact.className=known?'emphasis':'';
    elements.message.textContent=missing?`SOURCE GAP: ${number(s.lastKnownTime,1)} – ${number(s.nextKnownTime,1)} s`:'NO AUTHORITATIVE SAMPLE';
    return;
  }
  const r=radius(s.position),h=r-state.heightReference;
  elements.height.textContent=number(h,1);elements.velocity.textContent=number(radius(s.velocity),2);
  elements.radius.textContent=number(r/1000,2);elements.step.textContent=String(s.step??(s.interpolated?'INTERPOLATED':'RECORDED'));
  const active=isContactKnown(state.simTime);
  elements.contact.textContent=active?(state.mode==='native'?'POSTSTEP CONTACT EVENT':'RECORDER LANDED'):
    (state.mode==='native'&&s.contact?'GROUND CONTACT · INITIAL STATE':'NO CONFIRMED EVENT');
  elements.contact.className=active?'emphasis':'';
  elements.message.textContent=state.worldMode&&!state.worldLive?'OSG HISTORICAL SAMPLE · '+(state.worldPinnedHead??'').slice(0,12):state.mode==='native'?(state.nativeLive?'LIVE SDK POSTSTEP SAMPLE':'SOURCE IDLE OR DELAYED · LAST COMMITTED SAMPLE'):s.interpolated?'HERMITE INTERPOLATION · RECONSTRUCTED':'ORIGINAL FLIGHT-RECORDER SAMPLE';
}
function resizeCanvas(){
  const r=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2);
  const w=Math.max(1,Math.floor(r.width*dpr)),h=Math.max(1,Math.floor(r.height*dpr));
  if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
  ctx.setTransform(dpr,0,0,dpr,0,0);
  return {w:r.width,h:r.height};
}
function projectedLateral(position) {
  const ref=state.mode==='recorded' ? state.samples.at(-1)?.position : state.nativeOrigin;
  if(!ref)return 0;
  const n=ref.map(x=>x/Math.hypot(...ref));
  const eastN=Math.hypot(n[0],n[2]);
  const east=eastN>1e-12?[-n[2]/eastN,0,n[0]/eastN]:[1,0,0];
  const north=[n[1]*east[2]-n[2]*east[1],n[2]*east[0]-n[0]*east[2],n[0]*east[1]-n[1]*east[0]];
  const delta=position.map((v,i)=>v-ref[i]); // double subtraction first
  const a=state.azimuth*Math.PI/180;
  const dot=(x,y)=>x.reduce((v,k,i)=>v+k*y[i],0);
  return dot(delta,east)*Math.cos(a)+dot(delta,north)*Math.sin(a);
}
function drawScene(s){
  const {w,h}=resizeCanvas();
  ctx.clearRect(0,0,w,h);
  const back=ctx.createLinearGradient(0,0,w,h);back.addColorStop(0,'#0b1820');back.addColorStop(.7,'#101f26');back.addColorStop(1,'#1b2224');
  ctx.fillStyle=back;ctx.fillRect(0,0,w,h);
  ctx.strokeStyle='rgba(94,143,152,.12)';ctx.lineWidth=1;
  for(let x=0;x<w;x+=45){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}
  for(let y=0;y<h;y+=45){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}
  // Perspective reference geometry is illustrative; positions come from the recording.
  const az=state.azimuth*Math.PI/180,ground=h*.78;
  const lateralScale=state.mode==='recorded'&&state.samples.length?
    Math.max(100,...state.samples.map(p=>Math.abs(projectedLateral(p.position)))):1000;
  const projectedX=p=>w*.5+projectedLateral(p)/lateralScale*w*.32*state.zoom;
  ctx.save();ctx.translate(w*.5,ground);
  for(let ring=1;ring<=8;ring++){
    ctx.beginPath();ctx.ellipse(0,2,ring*75*state.zoom,ring*19*state.zoom,az*.2,0,Math.PI*2);
    ctx.strokeStyle=`rgba(114,169,174,${.15-ring*.009})`;ctx.stroke();
  }
  ctx.beginPath();ctx.moveTo(-w*.6,0);ctx.lineTo(w*.6,0);
  ctx.lineWidth=2;ctx.strokeStyle='rgba(122,199,180,.49)';ctx.stroke();
  const grad=ctx.createLinearGradient(0,0,0,h-ground);grad.addColorStop(0,'rgba(52,84,78,.36)');grad.addColorStop(1,'rgba(33,56,53,.5)');
  ctx.fillStyle=grad;ctx.fillRect(-w*.5,0,w,h-ground);
  ctx.restore();
  const base=state.mode==='recorded'?6371020.2683:state.heightReference;
  if(state.mode==='recorded' && state.samples.length){
    ctx.beginPath();let previous=null;
    for(const p of state.samples){
      if(previous&&p.time-previous.time>10){previous=null;continue;}
      const scaled=clamp((radius(p.position)-base)/16600,0,1);
      const x=projectedX(p.position);
      const y=ground-12-scaled*h*.56*state.zoom;
      if(!previous)ctx.moveTo(x,y);else ctx.lineTo(x,y);
      previous=p;
    }
    ctx.lineWidth=2;ctx.strokeStyle='rgba(128,202,179,.56)';ctx.stroke();
  }
  if(!s||s.unavailable){
    ctx.save();ctx.textAlign='center';ctx.fillStyle='#b9a078';ctx.font='11px monospace';
    ctx.fillText(s?.unavailable?'NO RECORDED SAMPLES FOR THIS INTERVAL':'AWAITING SIMULATION TELEMETRY',w*.5,h*.48);ctx.restore();return;
  }
  const altitude=Math.max(0,radius(s.position)-base);
  const heightScaled=clamp(altitude/16600,0,1);
  const x=projectedX(s.position);
  const y=ground-12-heightScaled*h*.56*state.zoom;
  ctx.save();
  const glow=ctx.createRadialGradient(x,y,4,x,y,52);
  glow.addColorStop(0,'rgba(154,226,202,.22)');glow.addColorStop(1,'rgba(154,226,202,0)');
  ctx.fillStyle=glow;ctx.fillRect(x-55,y-55,110,110);
  ctx.translate(x,y);ctx.rotate(Math.sin(az)*.1);
  ctx.fillStyle='#d0dce1';ctx.strokeStyle='#8bbcb8';ctx.lineWidth=1.4;
  ctx.beginPath();ctx.moveTo(0,-20);ctx.lineTo(10,-6);ctx.lineTo(7,19);ctx.lineTo(-7,19);ctx.lineTo(-10,-6);ctx.closePath();ctx.fill();ctx.stroke();
  ctx.strokeStyle='#d9a775';ctx.beginPath();ctx.moveTo(-8,14);ctx.lineTo(-19,24);ctx.moveTo(8,14);ctx.lineTo(19,24);ctx.stroke();
  ctx.restore();
  ctx.strokeStyle='rgba(128,202,179,.50)';ctx.setLineDash([4,6]);ctx.beginPath();ctx.moveTo(x,y+25);ctx.lineTo(x,ground);ctx.stroke();ctx.setLineDash([]);
  ctx.fillStyle='#9eb7b8';ctx.font='10px monospace';ctx.fillText(`+${number(altitude,1)} m`,x+19,Math.min(ground-15,y+5));
  const opacity=contactOpacity(state.simTime);
  if(opacity>0){
    ctx.save();ctx.globalAlpha=opacity;ctx.translate(x,ground);
    for(let k=1;k<=4;k++){
      ctx.beginPath();ctx.ellipse(0,0,12+k*19,3+k*6,0,0,Math.PI*2);
      ctx.strokeStyle=`rgba(227,160,99,${.7-k*.1})`;ctx.lineWidth=2;ctx.stroke();
    }
    ctx.restore();
  }
}
function tick(now){
  if(state.worldMode)state.nativeLive=worldFeedFresh(state.latestStatus,{connected:state.feedConnected,live:state.worldLive,runId:state.worldStream?.runId,frameAgeMs:performance.now()-(state.lastWorldFrameAt??-Infinity),sourceAgeMs:state.lastNative?.capturedAtUnixMs>0?Date.now()-state.lastNative.capturedAtUnixMs:Infinity});
  const previous=state.previousNow??now,dt=clamp((now-previous)/1000,0,.15);state.previousNow=now;
  if(['recorded','landing-demo'].includes(state.mode)&&state.playing){
    state.simTime+=dt;
    if(state.simTime>state.maxTime){state.simTime=state.maxTime;state.playing=false;elements.playIcon.textContent='▶';}
    elements.seek.value=String((state.simTime-state.minTime)/(state.maxTime-state.minTime)*1000);
  }
  if(state.mode==='native'&&state.lastNative)state.simTime=state.lastNative.simTime;
  const s=getPhysicalState();
  elements.time.textContent='T + '+number(state.simTime,3).padStart(9,'0');
  elements.current.textContent=number(state.simTime,3)+' s';
  renderTelemetry(s);
  if(state.pc){
    const live=state.mode==='native'&&(!state.worldMode||state.worldLive)&&state.nativeLive;
    let renderTime=state.simTime;
    if(live&&state.sceneClock){const c=state.sceneClock;renderTime=Math.min(sceneTimeline.latest,c.time+(now-c.now)/1000*c.rate);}
    try{state.pc.update({simTime:renderTime,azimuth:state.azimuth,zoom:state.zoom,elevation:state.cameraElevation,selectedEntity:state.selectedEntity,source:state.mode==='landing-demo'?'synthetic':state.worldMode?'osg':'native'});
      const info=state.pc.stats,terrain=info.terrain;
      q('#scene-details').textContent=info.error??`${info.vessels} vessel · ${info.splats.toLocaleString()} splats · ${terrain?(terrain.albedoKnown?'captured surface':'captured elevations / neutral surface'):'terrain pending'}`;
    }catch(error){q('#scene-details').textContent='SCENE ERROR: '+error.message;}
  }else drawScene(s);
  requestAnimationFrame(tick);
}
async function refreshStatus(){
  try{const res=await fetch('/api/status');const info=await res.json();state.latestStatus=info;
    void pollActivities(info);
    elements.status.textContent=`JOURNAL: #${info.journalHead.sequence} · ${info.journalHead.hash.slice(0,11)}`;
    state.worldMode=info.osgWorldMode===true;state.nativeConnected=info.nativeConnected===true;
    elements.graph.textContent='OSG: '+(info.osgConnected?(info.osgHealthy?'CONNECTED':'DEGRADED'):'NOT CONFIGURED');
    elements.connection.textContent=info.nativeConnected?'NATIVE BRIDGE ONLINE':info.mode==='recorded'?'RECORDING REPLAY':'WAITING FOR NATIVE BRIDGE';
    state.mode=info.landingDemo?'landing-demo':info.mode;state.authenticated=info.nativeAuthenticated===true;
    state.nativeLive=state.feedConnected===true&&info.nativeConnected===true&&
      (state.worldMode?(state.worldLive&&info.osgHealthy):(!state.lastNative||(state.lastNative.runId===info.runId&&state.lastNative.step===info.latestStep)));
    if(state.worldMode&&state.worldHead)elements.graph.textContent='OSG COMMIT: '+state.worldHead.slice(0,13);
    if(info.mode==='native'&&!state.worldMode)state.runId=info.runId;
    if(info.errors?.length)state.error=info.errors.at(-1);
    if(info.mode==='native'){
      try {
        const evidenceQuery=state.worldMode&&state.worldStream?`&runId=${encodeURIComponent(state.worldStream.runId)}&epoch=${state.worldStream.epoch}${state.worldPinnedHead?'&head='+encodeURIComponent(state.worldPinnedHead):''}`:'';
        const r=await fetch(`/api/observer-evidence?observer=${id}&time=${state.simTime}${evidenceQuery}${state.selectedEntity?'&entity='+encodeURIComponent(state.selectedEntity):''}`);
        if(r.ok){
          const evidence=await r.json();
          const shown=Array.isArray(evidence.events)?evidence.events:[];
          const newest=shown.at(-1);
          q('#causal-status').textContent=evidence.status==='NO_NATIVE_ANCHOR'?'NO OBSERVER POSITION':
            (newest?newest.status.replaceAll('_',' '):'NO LOCATED CONTACT EVENTS');
          q('#causal-description').textContent=newest?.arrivalTime!=null?
            `Est. signal delay ${number(newest.delaySeconds,6)} s · ${state.authenticated?'local bridge token verified':'unauthenticated loopback'} · hypothetical sensor`:
            'Hypothetical stationary observer, no real instrument or occlusion model';
        }
      }catch(e){q('#causal-status').textContent='CAUSAL SERVICE OFFLINE';}
    }
  }catch(e){elements.connection.textContent='SERVICE OFFLINE';state.error=e.message;}
}
async function init(){
  try{await refreshStatus();
    if(state.mode==='landing-demo'){await loadLandingDemo();requestAnimationFrame(tick);setInterval(refreshStatus,1000);return;}
    const res=state.mode!=='native'?await fetch('/api/recording'):null;
    if(res?.ok){const info=await res.json();state.mode='recorded';state.source='recorded';state.samples=info.samples;
      state.minTime=state.samples[0].time;state.maxTime=state.samples.at(-1).time;state.simTime=state.minTime;
      state.heightReference=radius(state.samples.at(-1).position);
      state.frame=`${info.metadata.reference} ${info.metadata.frame}`;
      elements.authority.textContent='FLIGHT RECORDER';elements.authority.className='warning';
      elements.frame.textContent=state.frame.toUpperCase();elements.source.textContent='RECORDED / SOURCE EXCERPT';
      elements.data.textContent='SOURCE: VERIFIED REPOSITORY EXCERPT';
      q('#causal-status').textContent='NOT AVAILABLE FOR RECORDED SOURCE';
      q('#timeline-range').textContent=`${number(state.minTime,1)} – ${number(state.maxTime,1)} s`;
      elements.playing=false;
      for(const ev of info.events){if(['LANDED','GEAR','SPEEDBRAKE'].includes(ev.kind)){
        appendEvent(ev.kind==='LANDED'?'CONTACT_BEGIN':ev.kind,ev.time,'recorded',ev.kind==='LANDED'?'Recorded LANDED action, not SDK ground contact':ev.detail);
      }}
    }else{
      state.mode='native';state.heightReference=0;elements.authority.textContent='METAVERSE SDK';
      elements.frame.textContent='METAVERSE GLOBAL';elements.source.textContent='ACCEPTED PHYSICS SAMPLES';
      elements.data.textContent='SOURCE: NATIVE WHEN CONNECTED';
      q('.metric:nth-child(3)>span').textContent='RADIAL OFFSET FROM INITIAL SAMPLE';
    }
    const protocol=location.protocol==='https:'?'wss:':'ws:';
    function connect(){
    const ws=new WebSocket(`${protocol}//${location.host}/ws`);
    ws.addEventListener('open',()=>{state.feedConnected=true;refreshStatus();});
    ws.addEventListener('message',event=>{
      let data;try{data=JSON.parse(event.data);}catch{return;}
      if(state.mode==='recorded')return;
      if(data.type==='OSG_WORLD_REVISION'){state.worldHead=data.head;return;}
      if(data.type==='OSG_WORLD_UPDATE'||data.type==='OSG_WORLD_SNAPSHOT'){
        state.worldMode=true;state.worldHead=data.head;
        if(!state.worldLive)return;
        displayWorld(data);
      }else if(!state.worldMode)displayNative(data);
    });
    ws.addEventListener('close',()=>{state.feedConnected=false;state.nativeLive=false;if(state.mode==='native')elements.connection.textContent='DISCONNECTED';setTimeout(connect,1000);});
    }
    connect();
    setInterval(refreshStatus,1000);
  }catch(e){elements.message.textContent='INITIALIZATION ERROR: '+e.message;}
  requestAnimationFrame(tick);
}
function displayNative(data){
  const old=sceneTimeline.entities.get(data.entityId)?.at(-1);
  sceneTimeline.accept(data);state.pc?.ingest(data);
  if(data.type==='PHYSICS_SAMPLE'||data.type==='WORLD_INIT'){
    const dt=old?data.simTime-old.simTime:0,wall=old&&data.capturedAtUnixMs&&old.capturedAtUnixMs?(data.capturedAtUnixMs-old.capturedAtUnixMs)/1000:0;
    const rate=wall>0?Math.min(1000,Math.max(0,dt/wall)):1;
    state.sceneClock={time:Math.max(data.simTime-.25*rate,old?.simTime??data.simTime),now:performance.now(),rate};
    if(data.visual&&!state.pc&&!state.sceneLoading)void enableScene();
  }
  const result=applyNativeFrame(state,data);
  if(result.reset||result.removed){elements.eventList.replaceChildren();elements.count.textContent='00 EVENTS';}
  if(result.removed){state.nativeLive=false;elements.source.textContent=`REMOVED · ${data.entityId}`;}
  if(result.sample){if(data.visual)q('#scene-title').textContent=data.visual.vesselClass.toUpperCase()+' / '+data.visual.bodyName.toUpperCase();state.nativeLive=state.worldMode?(state.worldLive&&state.nativeConnected===true):true;elements.source.textContent=`${state.worldMode?'OSG':'NATIVE'} · ${data.entityId}`;elements.frame.textContent=data.frameId;}
  if(result.event)appendEvent(data.type,data.simTime,'native','Poststep GroundContact transition',data.eventId);
}
function displayWorld(data){
  if(data.frames?.some(f=>f.sample?.type==='PHYSICS_SAMPLE'))state.lastWorldFrameAt=performance.now();
  for(const frame of worldFrames(data))displayNative(frame);
  const origin=data.origins?.[state.selectedEntity];
  if(origin){state.nativeOrigin=origin.slice();state.heightReference=radius(origin);}
  if(data.runId!=null){
    state.runId=data.runId;state.worldStream={runId:data.runId,epoch:data.epoch};
    const stream=data.streams?.find(x=>x.runId===data.runId&&x.epoch===data.epoch);
    if(stream){state.minTime=stream.firstTimeMicros/1e6;state.maxTime=stream.lastTimeMicros/1e6;
      q('#timeline-range').textContent=`${number(state.minTime,2)} – ${number(state.maxTime,2)} s · OSG`;
      if(state.worldLive)elements.seek.value='1000';}
  }
  elements.graph.textContent='OSG COMMIT: '+data.head.slice(0,13);
  elements.data.textContent='SOURCE: COMMITTED OSG HISTORY';
}
async function seekWorld(timeMicros=null){
  const request=++state.worldRequest,requestedAgainst=state.worldHead;
  try{
    const query=new URLSearchParams();
    if(timeMicros!=null&&state.worldStream){
      query.set('runId',state.worldStream.runId);query.set('epoch',state.worldStream.epoch);
      query.set('timeMicros',String(timeMicros));query.set('head',state.worldPinnedHead);
    }
    const response=await fetch('/api/world/state?'+query),data=await response.json();
    if(!response.ok)throw new Error(data.error);
    if(request!==state.worldRequest)return;
    if(state.worldLive&&state.worldHead!==requestedAgainst&&state.worldHead!==data.head)return;
    if(state.worldLive)state.worldHead=data.head;
    displayWorld(data);
  }catch(error){elements.message.textContent='OSG QUERY FAILED: '+error.message;}
}
q('#play-pause').addEventListener('click',()=>{
  if(state.worldMode){
    state.worldLive=!state.worldLive;state.worldPinnedHead=state.worldLive?null:state.worldHead;
    elements.playIcon.textContent=state.worldLive?'Ⅱ':'▶';
    if(state.worldLive)seekWorld();return;
  }
  if(!['recorded','landing-demo'].includes(state.mode))return;state.playing=!state.playing;elements.playIcon.textContent=state.playing?'Ⅱ':'▶';
});
q('#reset').addEventListener('click',()=>{
  if(state.worldMode){state.worldLive=true;state.worldPinnedHead=null;elements.playIcon.textContent='Ⅱ';seekWorld();return;}
  state.playing=false;state.simTime=state.minTime;elements.seek.value='0';elements.playIcon.textContent='▶';
});
elements.seek.addEventListener('input',e=>{
  if(state.worldMode){
    if(state.worldLive)state.worldPinnedHead=state.worldHead;
    state.worldLive=false;elements.playIcon.textContent='▶';
    seekWorld(Math.round((state.minTime+Number(e.target.value)/1000*(state.maxTime-state.minTime))*1e6));return;
  }
  if(!['recorded','landing-demo'].includes(state.mode))return;state.playing=false;elements.playIcon.textContent='▶';state.simTime=state.minTime+Number(e.target.value)/1000*(state.maxTime-state.minTime);
});
q('#camera-yaw').addEventListener('input',e=>{state.azimuth=Number(e.target.value);setText('#yaw-value',state.azimuth+'°');});
q('#camera-zoom').addEventListener('input',e=>{state.zoom=Number(e.target.value);setText('#zoom-value',number(state.zoom,1)+'×');});
async function enableScene(){
  if(state.pc||state.sceneLoading)return;state.sceneLoading=true;
  const button=q('#enable-playcanvas');button.disabled=true;button.textContent='LOADING LANDING SCENE…';
  try{
    q('#scene-3d').hidden=false;
    const renderer=await createPlayCanvasScene(q('#scene-3d'),label=>elements.renderer.textContent=label);
    for(const history of sceneTimeline.entities.values())for(const sample of history)renderer.ingest(sample);
    if(state.demoTerrain)renderer.installTerrain(state.demoTerrain);
    state.pc=renderer;q('#scene-wrap').classList.add('is-4d');canvas.hidden=true;q('#scene-3d').hidden=false;
    button.textContent='4D SCENE ENABLED';
  }catch(e){q('#scene-3d').hidden=true;button.disabled=false;button.textContent='RETRY 4D SCENE';elements.renderer.textContent='LOCAL CANVAS';q('#scene-details').textContent='3D UNAVAILABLE: '+e.message;}
  finally{state.sceneLoading=false;}
}
async function loadLandingDemo(){
  const response=await fetch('/api/scene/demo');if(!response.ok)throw Error('Landing demo unavailable');const demo=await response.json();
  if(demo.provenance!=='SYNTHETIC_RENDERER_FIXTURE_NOT_NATIVE_SIMULATION')throw Error('Demo provenance mismatch');
  state.demoTerrain=demo.terrain;for(const sample of demo.frames)sceneTimeline.accept(sample);
  state.selectedEntity=demo.frames[0].entityId;state.minTime=demo.frames[0].simTime;state.maxTime=demo.frames.at(-1).simTime;state.simTime=0;state.heightReference=0;state.playing=false;
  q('#scene-title').textContent='SHUTTLEPB / MOON LANDING';
  q('#timeline-range').textContent=`0 – ${state.maxTime} s · DEMO`;
  elements.authority.textContent='SYNTHETIC DEMO';elements.authority.className='warning';elements.connection.textContent='LANDING RENDERER DEMO';
  elements.source.textContent='ACTUAL VESSEL ASSET · SYNTHETIC MOTION';elements.frame.textContent='MOON BODY / METERS';elements.data.textContent='DEMO · NOT SDK ACCEPTANCE';
  await enableScene();
}
q('#enable-playcanvas').addEventListener('click',enableScene);
q('#camera-elevation').addEventListener('input',e=>{state.cameraElevation=Number(e.target.value);q('#elevation-value').textContent=state.cameraElevation+'°';});
const clock=()=>{q('#clock-utc').textContent=new Date().toISOString().slice(11,19)+' UTC';};clock();setInterval(clock,1000);
init();
