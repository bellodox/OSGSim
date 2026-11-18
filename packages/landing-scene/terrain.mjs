// SPDX-License-Identifier: MIT
import {validateTerrain} from './schema.mjs';
import {sphere,tangent,surfacePoint,mv,sub,cross,unit,frameFromNormal} from './math.mjs';
/** Resample the exported grid, never invent craters or elevate a coarse source.
 * The geometric detail remains bounded by the captured elevation resolution.
 */
export function terrainSplats(terrain,{subdivisions=7}={}){
  const t=validateTerrain(terrain),basis=tangent(t.longitude,t.latitude),origin=sphere(t.longitude,t.latitude,t.radius),out=[];
  const step=t.spacing/subdivisions,half=(t.size-1)*t.spacing/2;
  const elevation=(x,z)=>{
    const i=Math.min(t.size-2,Math.max(0,Math.floor(x))),j=Math.min(t.size-2,Math.max(0,Math.floor(z))),u=x-i,v=z-j;
    const a=t.heights[j*t.size+i],b=t.heights[j*t.size+i+1],c=t.heights[(j+1)*t.size+i],d=t.heights[(j+1)*t.size+i+1];
    return a*(1-u)*(1-v)+b*u*(1-v)+c*(1-u)*v+d*u*v;
  };
  const point=(x,z)=>mv(basis,sub(surfacePoint(t,x*t.spacing-half,z*t.spacing-half,elevation(x,z)),origin));
  for(let z=0;z<(t.size-1)*subdivisions;z++)for(let x=0;x<(t.size-1)*subdivisions;x++){
    const u=(x+.5)/subdivisions,v=(z+.5)/subdivisions,center=point(u,v),n=unit(cross(sub(point(u+.02,v),center),sub(point(u,v+.02),center)));
    const index=(Math.round(v)*t.size+Math.round(u))*3,color=t.albedo?t.albedo.slice(index,index+3):[.24,.235,.22];
    out.push({center,normal:n,scale:[step*.6,step*.6,.03],rotation:frameFromNormal(n),color:[...color,.995],group:0});
  }
  return {splats:out,origin,basis,albedoKnown:!!t.albedo,elevationLevel:t.elevationLevel};
}
