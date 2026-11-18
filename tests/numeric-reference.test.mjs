import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {hermite,hermiteVelocity,matrixToQuaternion,quaternionToMatrix,slice4D,positiveDefinite} from '../packages/sg4d/index.mjs';
import {causalObservation} from '../packages/observer-model/index.mjs';
const reference=JSON.parse(await readFile(new URL('../fixtures/numeric-reference.json',import.meta.url),'utf8'));
const near=(a,b)=>{if(Array.isArray(a)){assert.equal(a.length,b.length);a.forEach((v,i)=>near(v,b[i]));}else assert.ok(Math.abs(a-b)<1e-9*Math.max(1,Math.abs(b)),`${a} vs ${b}`);};
test('24 independent SciPy Hermite position and derivative reference cases',()=>{
 for(const c of reference.cases){const args=[c.p0,c.v0,c.p1,c.v1,c.t0,c.t1,c.t];near(hermite(...args),c.position);near(hermiteVelocity(...args),c.velocity);}
});
test('24 independent SciPy matrix/quaternion reference cases',()=>{
 for(const c of reference.cases){near(quaternionToMatrix(c.quaternion),c.matrix);
 const q=matrixToQuaternion(c.matrix);near(Math.abs(q.reduce((sum,v,i)=>sum+v*c.quaternion[i],0)),1);}
});
test('24 independent NumPy block-solve conditional Gaussian reference cases',()=>{
 for(const c of reference.cases){const s=slice4D(c.gaussian,c.gaussianTime);near(s.center,c.center);near(s.covariance,c.covariance);}
});
test('small covariance units preserve positive definiteness and symmetry checks',()=>{
 const m=Array.from({length:4},(_,i)=>Array.from({length:4},(_,j)=>i===j?1e-16:0));
 assert.equal(positiveDefinite(m),true);m[0][1]=1e-17;assert.throws(()=>positiveDefinite(m),/nonsymmetric/);
});
test('no early causal receipt is introduced by an arbitrary comparison epsilon',()=>{
 assert.equal(causalObservation({simTime:1,position:[0,0,0]},()=>[0,0,0],1-1e-12).status,'NOT_YET_CAUSAL');
});
