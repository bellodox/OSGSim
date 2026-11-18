// SPDX-License-Identifier: MIT
import {slice4D} from '../sg4d/index.mjs';
import {covarianceFrame} from './math.mjs';
/** Deterministic presentation of captured thrust levels. The nozzle positions and
 * eight-meter lengths are from ShuttlePB.cpp. These are visual exhaust splats,
 * not simulated dust, temperature measurements or native particle replay.
 */
export function exhaustSplats(sample,t){
  if(sample.visual?.vesselClass!=='ShuttlePB')return [];
  const out=[],emitters=sample.visual.exhausts?.map(e=>({p:e.position,v:e.direction.map(x=>x*e.length/.2),level:e.level,width:e.width}))??[{p:[0,.3,-4.35],v:[0,0,-40],level:sample.visual.main},{p:[0,-1.5,1],v:[0,-40,0],level:sample.visual.hover},{p:[0,-1.5,-1],v:[0,-40,0],level:sample.visual.hover}];
  for(const e of emitters){if(e.level<=0)continue;
    for(let i=0;i<24;i++){
      const birth=(Math.floor(t*120)-i)/120,mid=birth+.1,tt=.005,spread=(e.width??1)*(.06+.25*i/24);
      const cov=Array.from({length:4},(_,a)=>Array.from({length:4},(_,b)=>a===3&&b===3?tt:a===3?e.v[b]*tt:b===3?e.v[a]*tt:(a===b?spread**2:0)+e.v[a]*e.v[b]*tt));
      const s=slice4D({mean:[...e.p.map((p,k)=>p+e.v[k]*.1),mid],cov,weight:.4*e.level,start:birth,end:birth+.2},t);if(!s)continue;
      const f=covarianceFrame(s.covariance);out.push({center:s.center,scale:f.scale,rotation:f.rotation,color:[1,.3+.4*(1-i/24),.08,s.weight],normal:[0,1,0],group:0});
    }
  }return out;
}
