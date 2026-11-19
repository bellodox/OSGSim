// SPDX-License-Identifier: MIT
import {decodeSplats} from '/packages/landing-scene/asset.mjs';
import {LandingTimeline,bodyLocal} from '/packages/landing-scene/timeline.mjs';
import {terrainSplats} from '/packages/landing-scene/terrain.mjs';
import {exhaustSplats} from '/packages/landing-scene/exhaust.mjs';
import {validateTerrain} from '/packages/landing-scene/schema.mjs';
import {add,sub,mul,dot,unit,mv,mm,transpose,tangent,sphere,rotationAxis} from '/packages/landing-scene/math.mjs';
import {quaternionToMatrix,matrixToQuaternion} from '/packages/sg4d/index.mjs';
const H=[[1,0,0],[0,1,0],[0,0,-1]];
const vector=(pc,a)=>new pc.Vec3(...a);
const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
async function read(url){const r=await fetch(url);if(!r.ok)throw Error(`${url}: HTTP ${r.status}`);return r;}

export async function createPlayCanvasScene(canvas,status){
  const pc=await import('./vendor/playcanvas-2.24.0.mjs');
  const manifest=await (await read('/fixtures/landing/assets/ShuttlePB.json')).json();
  const bytes=await (await read(`/fixtures/landing/assets/${manifest.hash}.splat`)).arrayBuffer();
  if(await digest(bytes)!==manifest.hash)throw Error('Vessel splat asset hash mismatch');
  const asset=decodeSplats(bytes),timeline=new LandingTimeline(),formatCache=new Map();
  const app=new pc.Application(canvas,{graphicsDeviceOptions:{antialias:false,preserveDrawingBuffer:true}});
  app.setCanvasFillMode(pc.FILLMODE_NONE);app.setCanvasResolution(pc.RESOLUTION_AUTO);
  app.autoRender=false;
  app.systems.gsplat.on('frame:request',()=>{app.renderNextFrame=true;});
  app.graphicsDevice.maxPixelRatio=Math.min(devicePixelRatio||1,2);
  const camera=new pc.Entity('Observer Camera');camera.addComponent('camera',{clearColor:new pc.Color(.002,.003,.005),fov:50,nearClip:.1,farClip:50000});app.root.addChild(camera);
  const models=new Map(),patches=new Map(),pending=new Map();let activePatch=null,terrainCloud=null,disposed=false,revision=0,lastUpdate=null;
  const stats={ready:true,slicedSegments:0,slicedExhaust:0,renderTime:null,vessels:0,splats:0,terrain:null,error:null,source:null};
  const resize=new ResizeObserver(()=>{app.resizeCanvas();app.renderNextFrame=true;});resize.observe(canvas);
  const format=()=>{if(!formatCache.has('full'))formatCache.set('full',pc.GSplatFormat.createDefaultFormat(app.graphicsDevice));return formatCache.get('full');};
  function cloud(name,capacity,parent=app.root){
    const resource=new pc.GSplatContainer(app.graphicsDevice,Math.max(1,capacity),format());
    const entity=new pc.Entity(name);entity.addComponent('gsplat',{resource});parent.addChild(entity);
    const textures=Object.fromEntries(['dataCenter','dataScale','dataRotation','dataColor'].map(key=>[key,resource.getTexture(key)]));
    let points=[];
    function upload(splats,reflect=false){
      if(splats.length>capacity)throw Error('Splat budget exceeded');points=splats;
      const center=textures.dataCenter.lock(),scale=textures.dataScale.lock(),rotation=textures.dataRotation.lock(),color=textures.dataColor.lock(),centers=resource.centers;
      const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity],half=pc.FloatPacking.float2Half;
      for(let i=0;i<splats.length;i++){
        const s=splats[i],p=reflect?mv(H,s.center):s.center,q=reflect?matrixToQuaternion(mm(mm(H,quaternionToMatrix(s.rotation)),H)):s.rotation;
        for(let k=0;k<3;k++){center[4*i+k]=centers[3*i+k]=p[k];scale[4*i+k]=half(s.scale[k]);lo[k]=Math.min(lo[k],p[k]-3*Math.max(...s.scale));hi[k]=Math.max(hi[k],p[k]+3*Math.max(...s.scale));}
        for(let k=0;k<4;k++){rotation[4*i+k]=half(q[k]);color[4*i+k]=half(s.color[k]);}
      }
      for(const texture of Object.values(textures))texture.unlock();
      if(splats.length)resource.aabb=new pc.BoundingBox(vector(pc,lo.map((v,i)=>(v+hi[i])/2)),vector(pc,lo.map((v,i)=>(hi[i]-v)/2+.01)));
      resource.update(splats.length,true);entity.enabled=splats.length>0;
    }
    let lightKey='';
    function light(direction){
      const key=direction.map(v=>Math.round(v*10000)).join(',');if(key===lightKey)return;lightKey=key;
      const colors=textures.dataColor.lock(),half=pc.FloatPacking.float2Half;
      for(let i=0;i<points.length;i++){
        const s=points[i],brightness=.055+.945*Math.max(0,dot(s.normal,direction));
        for(let k=0;k<3;k++)colors[4*i+k]=half(s.color[k]*brightness);colors[4*i+3]=half(s.color[3]);
      }textures.dataColor.unlock();resource.update(points.length,false);
      // A texture write must invalidate the unified work buffer even if the entity
      // transform did not change (e.g. a stationary ship with changing sunlight).
      entity.gsplat.workBufferUpdate=pc.WORKBUFFER_UPDATE_ONCE;
    }
    upload([]);return {entity,resource,upload,light,destroy(){entity.destroy();resource.destroy();}};
  }
  function destroyModel(m){for(const c of m.groups.values())c.destroy();m.plume.destroy();m.shadow.destroy();m.root.destroy();}
  function model(id){
    if(models.has(id))return models.get(id);
    if(models.size>=8)throw Error('Landing scene supports at most eight visible vessels');
    const root=new pc.Entity('Vessel '+id);app.root.addChild(root);const groups=new Map();
    for(let group=0;group<7;group++){
      const splats=asset.filter(s=>s.group===group),c=cloud('ShuttlePB group '+group,splats.length,root);c.upload(splats,true);groups.set(group,c);
    }
    const plume=cloud('4D engine exhaust',768,root),shadow=cloud('Projected vessel shadow',Math.ceil(asset.length/12));
    const value={root,groups,plume,shadow};models.set(id,value);return value;
  }
  async function requestTerrain(hash){
    if(patches.has(hash)||pending.has(hash))return;
    const promise=(async()=>{
      const r=await read('/api/scene/asset/'+hash),data=await r.arrayBuffer();if(data.byteLength>128*1024||await digest(data)!==hash)throw Error('Terrain asset hash mismatch');
      const t=validateTerrain(JSON.parse(new TextDecoder().decode(data)));if(disposed)return;patches.set(hash,{data:t,...terrainSplats(t)});revision++;if(patches.size>8)patches.delete(patches.keys().next().value);
    })().catch(e=>{stats.assetError=e.message;revision++;}).finally(()=>pending.delete(hash));pending.set(hash,promise);
  }
  function ingest(sample){
    const key=timeline.key;timeline.accept(sample);revision++;
    if(key!==timeline.key){for(const m of models.values())destroyModel(m);models.clear();activePatch=null;terrainCloud?.destroy();terrainCloud=null;}
    if(sample.visual?.terrainHash)void requestTerrain(sample.visual.terrainHash);
  }
  function installTerrain(t){const checked=validateTerrain(t);patches.set(checked.id,{data:checked,...terrainSplats(checked)});revision++;}
  function animateWing(m,group,state,sun){
    const left=group===2,index=left?0:1,axis=left?[-.9619,-.2735,0]:[.9619,-.2735,0],hinge=left?[-1.3,-.725,-1.5]:[1.3,-.725,-1.5];
    const angle=((state[index]-.5)*20-(state[2]-.5)*30)*Math.PI/180,a=rotationAxis(axis,angle),render=mm(mm(H,a),H),q=matrixToQuaternion(render),offset=mv(H,sub(hinge,mv(a,hinge)));
    const c=m.groups.get(group);c.entity.setLocalPosition(...offset);c.entity.setLocalRotation(new pc.Quat(...q));c.light(mv(transpose(a),sun));
  }
  function update({simTime=0,azimuth=36,zoom=1,elevation=22,selectedEntity=null,source='unknown'}={}){
    if(disposed)return;
    // Paused observers still tick, but unchanged physical/camera state must not
    // rebuild and upload 50,000 splats on every browser animation frame.
    const updateKey=JSON.stringify([revision,simTime,azimuth,zoom,elevation,selectedEntity,source]);
    if(updateKey===lastUpdate)return;
    app.renderNextFrame=true;
    stats.error=stats.assetError??null;stats.renderTime=simTime;stats.source=source;
    const samples=timeline.at(simTime),selected=samples.find(s=>s.entityId===selectedEntity)??samples[0];
    for(const m of models.values()){m.root.enabled=false;m.shadow.entity.enabled=false;}
    stats.vessels=0;stats.splats=0;stats.terrain=null;if(terrainCloud)terrainCloud.entity.enabled=false;
    if(!selected?.visual||!selected.orientation){terrainCloud&&(terrainCloud.entity.enabled=false);stats.error='Scene capture or orientation unavailable';return;}
    const v=selected.visual;
    if(v.vesselClass!=='ShuttlePB'){stats.error='No captured splat asset for '+v.vesselClass;return;}
    if(v.bodyName!=='Moon'){stats.error='Landing assets are scoped to Moon / ShuttlePB';return;}
    const patch=patches.get(v.terrainHash)??patches.get(v.terrainId),local=bodyLocal(selected),radial=Math.hypot(...local.position),lon=Math.atan2(local.position[2],local.position[0]),lat=Math.asin(local.position[1]/radial);
    if(patch&&(patch.data.id!==v.terrainId||patch.data.bodyName!==v.bodyName||patch.data.radius!==v.bodyRadius)){stats.error='Terrain identity does not match the selected state';return;}
    const basis=patch?.basis??tangent(lon,lat),origin=patch?.origin??sphere(lon,lat,v.bodyRadius),cameraOrigin=mv(basis,sub(local.position,origin));
    const sun=unit(mv(basis,mv(local.bodyInverse,sub(v.sunPosition,v.bodyPosition))));
    if(patch&&activePatch!==patch){terrainCloud?.destroy();terrainCloud=cloud('Captured Moon surface',patch.splats.length);terrainCloud.upload(patch.splats);activePatch=patch;}
    if(terrainCloud){terrainCloud.entity.enabled=!!patch;terrainCloud.light(sun);stats.terrain={id:patch?.data.id,elevationLevel:patch?.elevationLevel,albedoKnown:patch?.albedoKnown};stats.splats+=patch?.splats.length??0;}
    const visible=new Set(samples.filter(s=>s.visual?.vesselClass==='ShuttlePB'&&s.visual.bodyName===v.bodyName&&s.orientation).map(s=>s.entityId));
    for(const [id,m] of models)if(!visible.has(id)){destroyModel(m);models.delete(id);}
    for(const s of samples){
      if(s.visual?.vesselClass!=='ShuttlePB'||s.visual.bodyName!==v.bodyName||!s.orientation)continue;
      const m=model(s.entityId),b=bodyLocal(s),rotation=mm(mm(mm(basis,b.bodyInverse),quaternionToMatrix(s.orientation)),H),position=mv(basis,sub(b.position,origin));
      m.root.enabled=true;m.root.setPosition(...position);m.root.setRotation(new pc.Quat(...matrixToQuaternion(rotation)));
      const localSun=mv(transpose(quaternionToMatrix(s.orientation)),sub(s.visual.sunPosition,s.position)),light=unit(localSun);
      for(const [group,c]of m.groups){if(group===2||group===3)animateWing(m,group,s.visual.animations,light);else c.light(light);}
      const plumes=exhaustSplats(s,simTime);m.plume.upload(plumes,true);m.plume.entity.gsplat.workBufferUpdate=pc.WORKBUFFER_UPDATE_ONCE;
      stats.slicedExhaust+=plumes.length;if(s.motion)stats.slicedSegments++;
      stats.vessels++;stats.splats+=asset.length+plumes.length;
      // Project the actual cloud silhouette along captured sunlight. This is a
      // visual shadow approximation on the sampled grid, not native depth replay.
      if(patch&&sun[1]>.03&&position[1]<1500){
        const shadows=[];for(let i=0;i<asset.length;i+=12){
          const p=add(position,mv(rotation,mv(H,asset[i].center))),hit=terrainHit(p,sun,patch);if(!hit)continue;
          shadows.push({center:hit,scale:[.14,.14,.018],rotation:[Math.SQRT1_2,0,0,Math.SQRT1_2],normal:[0,1,0],color:[.003,.003,.004,.32]});
        }m.shadow.upload(shadows);stats.splats+=shadows.length;
      }
    }
    const yaw=azimuth*Math.PI/180,pitch=elevation*Math.PI/180,distance=22/zoom;
    camera.setPosition(...add(cameraOrigin,[Math.sin(yaw)*Math.cos(pitch)*distance,Math.sin(pitch)*distance,Math.cos(yaw)*Math.cos(pitch)*distance]));camera.lookAt(...add(cameraOrigin,[0,.1,0]));
    canvas.dataset.splats=String(stats.splats);canvas.dataset.sliced=String(stats.slicedSegments);canvas.dataset.renderTime=String(simTime);canvas.dataset.vessels=String(stats.vessels);
    lastUpdate=updateKey;
  }
  function terrainHit(p,sun,patch){
    const t=patch.data,half=(t.size-1)*t.spacing/2,heights=t.heights;
    function height(x,z){const u=(x+half)/t.spacing,v=(-z+half)/t.spacing;if(u<0||v<0||u>t.size-1||v>t.size-1)return null;const i=Math.min(t.size-2,Math.floor(u)),j=Math.min(t.size-2,Math.floor(v)),a=u-i,b=v-j;return heights[j*t.size+i]*(1-a)*(1-b)+heights[j*t.size+i+1]*a*(1-b)+heights[(j+1)*t.size+i]*(1-a)*b+heights[(j+1)*t.size+i+1]*a*b-(x*x+z*z)/(2*t.radius);}
    let hit=p.slice();for(let n=0;n<3;n++){const y=height(hit[0],hit[2]);if(y==null)return null;const d=(p[1]-y)/sun[1];if(d<0)return null;hit=sub(p,mul(sun,d));}hit[1]+=.035;return hit;
  }
  app.start();status?.('4D GAUSSIAN SCENE');
  return {ingest,installTerrain,update,stats,timeline,async settled(){await Promise.all(pending.values());},destroy(){disposed=true;resize.disconnect();for(const m of models.values())destroyModel(m);terrainCloud?.destroy();app.destroy();}};
}
