// SPDX-License-Identifier: MIT
import {hermite,hermiteVelocity,slerp,slice4D,quaternionToMatrix} from '../sg4d/index.mjs';
import {add,sub,mul,mv,transpose} from './math.mjs';
import {validateVisual} from './schema.mjs';

/** Shared spacetime translation for a rigid cloud. Every local splat shares this
 * temporal factor; evaluating it once is algebraically identical to slicing each
 * translated splat. The local spatial covariance/appearance stays in the asset.
 */
export function motionSlice(a,b,t){
  const duration=b.simTime-a.simTime;if(!(duration>0)||t<a.simTime||t>b.simTime)throw Error('outside motion segment');
  const mid=(a.simTime+b.simTime)/2,v=mul(sub(b.position,a.position),1/duration),mean=add(a.position,mul(v,duration/2)),variance=(duration/2)**2;
  const cov=Array.from({length:4},(_,i)=>Array.from({length:4},(_,j)=>i===3&&j===3?variance:i===3?v[j]*variance:j===3?v[i]*variance:(i===j?1:0)+v[i]*v[j]*variance));
  const sliced=slice4D({mean:[...mean,mid],cov,weight:1,start:a.simTime,end:b.simTime+Number.EPSILON*Math.max(1,Math.abs(b.simTime))*2},t);
  // Conditional Gaussian centre is linear. Preserve known acceleration using the
  // existing Hermite residual; do not extrapolate or interpolate discontinuities.
  const exact=hermite(a.position,a.velocity,b.position,b.velocity,a.simTime,b.simTime,t);
  return {...sliced,center:add(sliced.center,sub(exact,add(mean,mul(v,t-mid)))),temporalWeight:sliced.weight};
}
export function interpolateSamples(a,b,t){
  if(t===a.simTime)return a;if(t===b.simTime)return b;
  const dt=b.simTime-a.simTime;
  if(a.runId!==b.runId||a.epoch!==b.epoch||a.frameId!==b.frameId||a.visual?.bodyName!==b.visual?.bodyName||dt<=0||dt>2||a.type==='ENTITY_REMOVED'||b.type==='ENTITY_REMOVED')return null;
  const motion=motionSlice(a,b,t),u=(t-a.simTime)/dt;
  const result={...a,simTime:t,position:motion.center,velocity:hermiteVelocity(a.position,a.velocity,b.position,b.velocity,a.simTime,b.simTime,t),interpolated:true,motion};
  if(a.orientation&&b.orientation)result.orientation=slerp(a.orientation,b.orientation,u);else delete result.orientation;
  if(a.visual&&b.visual)result.visual={...a.visual,bodyPosition:a.visual.bodyPosition.map((x,i)=>x*(1-u)+b.visual.bodyPosition[i]*u),bodyOrientation:slerp(a.visual.bodyOrientation,b.visual.bodyOrientation,u),sunPosition:a.visual.sunPosition.map((x,i)=>x*(1-u)+b.visual.sunPosition[i]*u)};
  return result;
}
export function bodyLocal(sample){
  const v=sample.visual,bodyInverse=transpose(quaternionToMatrix(v.bodyOrientation));
  // Subtract in float64 before any GPU Float32 conversion.
  return {position:mv(bodyInverse,sub(sample.position,v.bodyPosition)),bodyInverse};
}
export class LandingTimeline {
  constructor({limit=512}={}){this.limit=limit;this.reset();}
  reset(){this.key=null;this.entities=new Map();this.latest=-Infinity;}
  accept(sample){
    const key=`${sample.runId}/${sample.epoch}`;
    if(sample.type==='SIMULATION_RESET'){this.reset();this.key=key;return;}
    if(!['PHYSICS_SAMPLE','WORLD_INIT','ENTITY_REMOVED'].includes(sample.type))return;
    if(this.key!==key){this.reset();this.key=key;}
    if(sample.visual)validateVisual(sample.visual);
    const history=this.entities.get(sample.entityId)??[];const last=history.at(-1);
    if(last&&sample.simTime<last.simTime)return;
    if(last&&sample.simTime===last.simTime)history.pop();history.push(sample);
    if(history.length>this.limit)history.splice(0,history.length-this.limit);
    this.entities.set(sample.entityId,history);this.latest=Math.max(this.latest,sample.simTime);
  }
  at(t){
    const out=[];
    for(const history of this.entities.values()){
      let a=null,b=null;for(const sample of history){if(sample.simTime<=t)a=sample;else{b=sample;break;}}
      if(!a||a.type==='ENTITY_REMOVED')continue;
      const s=b?interpolateSamples(a,b,t):a;
      if(s)out.push(s);
    }return out;
  }
}
