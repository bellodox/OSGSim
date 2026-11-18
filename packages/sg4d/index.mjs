// SPDX-License-Identifier: MIT
import { assert, finite, vec3, quat } from '../world-protocol/index.mjs';

export function dot(a,b) { return a.reduce((s,x,i)=>s+x*b[i],0); }
export function normalizeQ(v) { assert(Array.isArray(v)&&v.length===4,'invalid quaternion dimensions');v.forEach((x,i)=>finite(x,`quaternion ${i}`));const n=Math.hypot(...v); assert(Number.isFinite(n)&&n>1e-14,'zero or invalid quaternion'); return v.map(x=>x/n); }
export function slerp(a,b,t) {
  quat(a,'a'); quat(b,'b'); finite(t,'t');
  let qb=b.slice(), d=dot(a,qb);
  if(d<0){ qb=qb.map(x=>-x); d=-d; }
  if(d>0.9995) return normalizeQ(a.map((x,i)=>x+t*(qb[i]-x)));
  const theta=Math.acos(Math.max(-1,Math.min(1,d))), s=Math.sin(theta);
  const w0=Math.sin((1-t)*theta)/s, w1=Math.sin(t*theta)/s;
  return normalizeQ(a.map((x,i)=>w0*x+w1*qb[i]));
}
export function hermite(p0,v0,p1,v1,t0,t1,t) {
  [p0,v0,p1,v1].forEach((v,i)=>vec3(v,`vector${i}`));
  [t0,t1,t].forEach((v,i)=>finite(v,`time${i}`));
  const h=t1-t0; assert(h>0,'nonpositive interval');
  const u=(t-t0)/h;
  const a=2*u**3-3*u**2+1, b=u**3-2*u**2+u, c=-2*u**3+3*u**2, d=u**3-u**2;
  return p0.map((x,i)=>a*x+b*h*v0[i]+c*p1[i]+d*h*v1[i]);
}
export function hermiteVelocity(p0,v0,p1,v1,t0,t1,t) {
  hermite(p0,v0,p1,v1,t0,t1,t); // validate the same interval and inputs
  const h=t1-t0,u=(t-t0)/h;
  return p0.map((x,i)=>(6*u*u-6*u)*x/h+(3*u*u-4*u+1)*v0[i]+
    (-6*u*u+6*u)*p1[i]/h+(3*u*u-2*u)*v1[i]);
}
export function localPosition(world,origin) {
  vec3(world,'world'); vec3(origin,'origin');
  const precise=world.map((x,i)=>x-origin[i]);
  // The subtraction happens before Float32 conversion.
  return precise.map(x=>Math.fround(x));
}
export function positiveDefinite(matrix) {
  assert(Array.isArray(matrix) && matrix.length===4 && matrix.every(r=>Array.isArray(r)&&r.length===4),'4x4 covariance required');
  for(let i=0;i<4;i++)for(let j=0;j<4;j++)finite(matrix[i][j],`cov[${i}][${j}]`);
  const L=Array.from({length:4},()=>Array(4).fill(0));
  for(let i=0;i<4;i++) for(let j=0;j<=i;j++) {
    finite(matrix[i][j],`cov[${i}][${j}]`);
    assert(Math.abs(matrix[i][j]-matrix[j][i]) <= 1e-10*Math.max(Number.MIN_VALUE,Math.abs(matrix[i][j]),Math.abs(matrix[j][i])),'nonsymmetric covariance');
    let v=matrix[i][j];for(let k=0;k<j;k++) v-=L[i][k]*L[j][k];
    if(i===j){assert(Number.isFinite(v)&&v>0,'nonpositive covariance');L[i][j]=Math.sqrt(v);}
    else L[i][j]=v/L[j][j];
  }
  return true;
}
/** 4D Gaussian conditioned on t; t_start <= t < t_end strictly controls visibility. */
export function slice4D({mean,cov,weight=1,start,end},t) {
  assert(Array.isArray(mean)&&mean.length===4,'4D mean required');
  mean.forEach((v,i)=>finite(v,`mean${i}`));
  positiveDefinite(cov);finite(start,'start');finite(end,'end');finite(t,'t');
  finite(weight,'weight');assert(weight>=0,'negative Gaussian weight');
  assert(start<end,'invalid temporal support');
  if(t<start||t>=end) return null;
  const dt=t-mean[3], tt=cov[3][3];
  const center=mean.slice(0,3).map((v,i)=>v+cov[i][3]*dt/tt);
  const covariance=Array.from({length:3},(_,i)=>Array.from({length:3},(_,j)=>cov[i][j]-cov[i][3]*cov[3][j]/tt));
  return {center,covariance,weight:weight*Math.exp(-0.5*dt**2/tt)};
}
export function quaternionToMatrix(q) {
  const [x,y,z,w]=normalizeQ(q),xx=x*x,yy=y*y,zz=z*z,xy=x*y,xz=x*z,yz=y*z,wx=w*x,wy=w*y,wz=w*z;
  return [[1-2*(yy+zz),2*(xy-wz),2*(xz+wy)],
          [2*(xy+wz),1-2*(xx+zz),2*(yz-wx)],
          [2*(xz-wy),2*(yz+wx),1-2*(xx+yy)]];
}
export function matrixToQuaternion(m) {
  validateRotation(m);
  const trace=m[0][0]+m[1][1]+m[2][2];
  let x,y,z,w;
  if(trace>0){const s=Math.sqrt(trace+1)*2;w=s/4;x=(m[2][1]-m[1][2])/s;y=(m[0][2]-m[2][0])/s;z=(m[1][0]-m[0][1])/s;}
  else if(m[0][0]>m[1][1]&&m[0][0]>m[2][2]){const s=Math.sqrt(1+m[0][0]-m[1][1]-m[2][2])*2;w=(m[2][1]-m[1][2])/s;x=s/4;y=(m[0][1]+m[1][0])/s;z=(m[0][2]+m[2][0])/s;}
  else if(m[1][1]>m[2][2]){const s=Math.sqrt(1+m[1][1]-m[0][0]-m[2][2])*2;w=(m[0][2]-m[2][0])/s;x=(m[0][1]+m[1][0])/s;y=s/4;z=(m[1][2]+m[2][1])/s;}
  else {const s=Math.sqrt(1+m[2][2]-m[0][0]-m[1][1])*2;w=(m[1][0]-m[0][1])/s;x=(m[0][2]+m[2][0])/s;y=(m[1][2]+m[2][1])/s;z=s/4;}
  return normalizeQ([x,y,z,w]);
}
/** Explicit per-interval reference-frame transform, no silent reflection or unit changes. */
export function applyBasis(point,basis) {
  vec3(point,'point');validateRotation(basis);
  return basis.map(row=>dot(row,point));
}
export function validateRotation(basis) {
  assert(Array.isArray(basis)&&basis.length===3 && basis.every(r=>Array.isArray(r)&&r.length===3),'rotation basis must be 3x3');
  basis.forEach((row,i)=>vec3(row,`basis${i}`));
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const det=dot(basis[0],cross(basis[1],basis[2]));
  assert(Math.abs(det-1)<1e-6,'basis must have determinant +1');
  for(let i=0;i<3;i++)for(let j=0;j<3;j++)assert(Math.abs(dot(basis[i],basis[j])-(i===j?1:0))<1e-6,'rotation basis must be orthonormal');
  return true;
}
