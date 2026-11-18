// SPDX-License-Identifier: MIT
import {assert} from '../world-protocol/primitives.mjs';
import {matrixToQuaternion,quaternionToMatrix} from '../sg4d/index.mjs';
export const add=(a,b)=>a.map((v,i)=>v+b[i]);
export const sub=(a,b)=>a.map((v,i)=>v-b[i]);
export const mul=(a,s)=>a.map(v=>v*s);
export const dot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
export const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export const unit=a=>{const n=Math.hypot(...a);assert(n>1e-15,'zero direction');return mul(a,1/n);};
export const transpose=a=>a[0].map((_,i)=>a.map(r=>r[i]));
export const mv=(a,v)=>a.map(r=>dot(r,v));
export const mm=(a,b)=>a.map(r=>transpose(b).map(c=>dot(r,c)));
export const identity=()=>[[1,0,0],[0,1,0],[0,0,1]];
export function tangent(lon,lat){
  const c=Math.cos(lat),s=Math.sin(lat),x=Math.cos(lon),z=Math.sin(lon);
  // Native left-handed XYZ -> browser right-handed east/up/south.
  return [[-z,0,x],[c*x,s,c*z],[s*x,-c,s*z]];
}
export function sphere(lon,lat,r){return [r*Math.cos(lat)*Math.cos(lon),r*Math.sin(lat),r*Math.cos(lat)*Math.sin(lon)];}
export function surfacePoint(t,x,z,height){
  const basis=tangent(t.longitude,t.latitude),anchor=sphere(t.longitude,t.latitude,t.radius);
  // Geodesic direction from the tangent plane, identical to native sample queries.
  return mul(unit(add(anchor,mv(transpose(basis),[x,0,-z]))),t.radius+height);
}
export function rotationAxis(axis,angle){
  const [x,y,z]=unit(axis),c=Math.cos(angle),s=Math.sin(angle),d=1-c;
  return [[c+x*x*d,x*y*d-z*s,x*z*d+y*s],[y*x*d+z*s,c+y*y*d,y*z*d-x*s],[z*x*d-y*s,z*y*d+x*s,c+z*z*d]];
}
export function frameFromNormal(normal){
  const n=unit(normal),u=unit(cross(Math.abs(n[1])<.95?[0,1,0]:[1,0,0],n)),v=cross(n,u);
  return matrixToQuaternion(transpose([u,v,n]));
}
/** Jacobi eigensolver: preserve the complete symmetric conditional covariance. */
export function covarianceFrame(input){
  const a=input.map(r=>r.slice()),vectors=identity();
  for(let iteration=0;iteration<24;iteration++){
    let p=0,q=1;for(const [i,j] of [[0,2],[1,2]])if(Math.abs(a[i][j])>Math.abs(a[p][q])){p=i;q=j;}
    if(Math.abs(a[p][q])<1e-12*Math.max(1,...a.map((r,i)=>Math.abs(r[i]))))break;
    const phi=.5*Math.atan2(2*a[p][q],a[q][q]-a[p][p]),c=Math.cos(phi),s=Math.sin(phi);
    const j=identity();j[p][p]=j[q][q]=c;j[p][q]=s;j[q][p]=-s;
    const next=mm(mm(transpose(j),a),j),v=mm(vectors,j);
    for(let i=0;i<3;i++)for(let k=0;k<3;k++){a[i][k]=next[i][k];vectors[i][k]=v[i][k];}
  }
  const scale=a.map((r,i)=>{assert(r[i]>0&&Number.isFinite(r[i]),'invalid sliced covariance');return Math.sqrt(r[i]);});
  return {scale,rotation:matrixToQuaternion(vectors)};
}
export function covariance(scale,q){const r=quaternionToMatrix(q);return mm(r.map(row=>row.map((v,i)=>v*scale[i]**2)),transpose(r));}
