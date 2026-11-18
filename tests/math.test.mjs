import test from 'node:test';import assert from 'node:assert/strict';
import {positiveDefinite,slice4D,hermite,slerp,quaternionToMatrix,matrixToQuaternion,localPosition,applyBasis} from '../packages/sg4d/index.mjs';
const near=(a,b,eps=1e-9)=>assert.ok(Math.abs(a-b)<eps,`${a} vs ${b}`);
test('Hermite interpolates position endpoints and derivatives for straight motion',()=>{
  const p0=[0,3,-2],v=[1,2,-1],p1=[10,23,-12];
  const a=hermite(p0,v,p1,v,0,10,0),b=hermite(p0,v,p1,v,0,10,10),c=hermite(p0,v,p1,v,0,10,5);
  a.forEach((x,i)=>near(x,p0[i]));b.forEach((x,i)=>near(x,p1[i]));c.forEach((x,i)=>near(x,p0[i]+5*v[i]));
  assert.throws(()=>hermite(p0,v,p1,v,1,1,1),/interval/);
});
test('slerp handles sign-equivalent quaternions and normalizes',()=>{
  const p=[0,0,0,1],n=[0,0,0,-1],q=slerp(p,n,.5);
  near(q[3],1);near(Math.hypot(...q),1);
});
test('rotation conversion reconstructs normalized quaternion',()=>{
  const q=[0,.382683432365,0,.923879532511];const m=quaternionToMatrix(q);const recovered=matrixToQuaternion(m);
  near(Math.abs(q.reduce((s,x,i)=>s+x*recovered[i],0)),1);
});
test('4D gaussian uses correct conditional mean/covariance and strict onset',()=>{
  const g={mean:[1,2,3,5],cov:[[4,0,0,2],[0,9,0,0],[0,0,16,0],[2,0,0,25]],weight:2,start:6,end:10};
  assert.equal(slice4D(g,5.999),null);assert.equal(slice4D(g,10),null);
  const r=slice4D(g,7.5);
  near(r.center[0],1+2*2.5/25);near(r.center[1],2);near(r.covariance[0][0],4-4/25);
  near(r.weight,2*Math.exp(-.5*2.5**2/25));
});
test('rejects non-SPD covariance and reflected reference frames',()=>{
  assert.throws(()=>positiveDefinite([[1,0,0,0],[0,-1,0,0],[0,0,1,0],[0,0,0,1]]),/nonpositive/);
  assert.throws(()=>applyBasis([1,2,3],[[1,0,0],[0,1,0],[0,0,-1]]),/determinant/);
});
test('double precision subtraction before Float32 projection',()=>{
  assert.equal(localPosition([1e12+1.5,0,0],[1e12,0,0])[0],1.5);
});
