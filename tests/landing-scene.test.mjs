// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {parseMesh,decodeDDS,meshToSplats} from '../packages/landing-scene/mesh-import.mjs';
import {encodeSplats,decodeSplats} from '../packages/landing-scene/asset.mjs';
import {covariance,covarianceFrame,mv,mm,transpose,tangent,sphere,sub,add,identity} from '../packages/landing-scene/math.mjs';
import {slice4D,quaternionToMatrix} from '../packages/sg4d/index.mjs';
import {motionSlice,interpolateSamples,LandingTimeline,bodyLocal} from '../packages/landing-scene/timeline.mjs';
import {terrainSplats} from '../packages/landing-scene/terrain.mjs';
import {exhaustSplats} from '../packages/landing-scene/exhaust.mjs';
import {validateVisual} from '../packages/landing-scene/schema.mjs';
import {validateEnvelope} from '../packages/world-protocol/index.mjs';
import {createWorldServer} from '../apps/world-service/server.mjs';
const near=(a,b,e=1e-7)=>{if(Array.isArray(a)){assert.equal(a.length,b.length);a.forEach((x,i)=>near(x,b[i],e));}else assert.ok(Math.abs(a-b)<e,`${a} != ${b}`);};
const demo=JSON.parse(await readFile('fixtures/landing/demo.json','utf8'));
const sample=(index=0)=>structuredClone(demo.frames[index]);

test('full conditional covariance survives scale/quaternion conversion, including off-diagonal terms',()=>{
 for(let n=1;n<=20;n++){
  const a=[[1+n*.02,.3,-.7],[.2,2,.1],[.4,-.5,.8]],cov=mm(a,transpose(a)),f=covarianceFrame(cov);near(covariance(f.scale,f.rotation),cov,1e-8);
 }
});
test('shared 4D cloud translation equals independent per-splat conditioning',()=>{
 const a={simTime:2,position:[10,-3,0],velocity:[4,2,-1]},b={simTime:4,position:[18,1,-2],velocity:[4,2,-1]},local=[.7,-.2,3];
 const cov=[[17,8,-4,4],[8,5,-2,2],[-4,-2,2,-1],[4,2,-1,1]];
 for(const t of [2,2.2,3,3.8,4]){
  const direct=slice4D({mean:[14+local[0],-1+local[1],-1+local[2],3],cov,start:2,end:4.00001},t),shared=motionSlice(a,b,t);
  near(add(shared.center,local),direct.center);near(shared.covariance,direct.covariance);
 }
});
test('4D trajectory residual preserves acceleration and never invents contact between samples',()=>{
 const a=sample(0),b=sample(10);a.position=[0,0,0];a.velocity=[0,0,0];b.position=[1,0,0];b.velocity=[2,0,0];b.contact=true;
 const s=interpolateSamples(a,b,.5);near(s.position,[.25,0,0]);near(s.velocity,[1,0,0]);assert.equal(s.contact,false);assert.ok(s.motion);
});
test('gaps, reference-body changes and epochs do not form motion segments',()=>{
 const a=sample(),b=sample(30);assert.equal(interpolateSamples(a,b,1),null);
 b.simTime=1;b.epoch++;assert.equal(interpolateSamples(a,b,.5),null);b.epoch=a.epoch;b.visual.bodyName='Earth';assert.equal(interpolateSamples(a,b,.5),null);
});
test('unknown orientation is preserved, not replaced with a fabricated attitude',()=>{
 const a=sample(),b=sample(1);delete a.orientation;delete b.orientation;assert.equal(interpolateSamples(a,b,.05).orientation,undefined);
});
test('timeline handles deletion, independent observers, pinned snapshots, and reset',()=>{
 const a=new LandingTimeline(),b=new LandingTimeline();for(const s of demo.frames){a.accept(s);b.accept(s);}
 assert.equal(a.at(15)[0].simTime,15);assert.equal(b.at(1)[0].simTime,1);
 a.accept({...sample(160),type:'ENTITY_REMOVED',simTime:16.1});assert.equal(a.at(16.1).length,0);assert.equal(a.at(15).length,1);
 a.accept({...sample(),type:'SIMULATION_RESET',epoch:1});assert.equal(a.entities.size,0);assert.equal(b.at(1).length,1);
});
test('global planetary coordinates retain centimeter offsets after local conversion',()=>{
 const a=sample(),b=bodyLocal(a),p=add(demo.terrain.radius?[demo.terrain.radius,0,0]:[0,0,0],[.015625,0,0]);
 a.visual.bodyPosition=[1e12,1e12,1e12];a.position=add(a.visual.bodyPosition,p);near(bodyLocal(a).position,p,1e-4);
 const basis=tangent(demo.terrain.longitude,demo.terrain.latitude);near(mm(basis,transpose(basis)),identity());
 assert.ok(b.position.every(Number.isFinite));
});
test('source DDS decoding agrees with independent Pillow reference pixels',async()=>{
 const tex=decodeDDS(await readFile('fixtures/landing/upstream/ShuttlePB.dds'));
 const p=(x,y)=>Array.from(tex.rgba.subarray((y*tex.width+x)*4,(y*tex.width+x)*4+4));
 near(p(64,64),[16,52,82,187],1.1);near(p(100,100),[16,52,82,170],1.1);near(p(0,0),[255,255,255,255],.1);
});
test('actual mesh groups/materials and deterministic splat asset have pinned provenance',async()=>{
 const mesh=parseMesh(await readFile('fixtures/landing/upstream/ShuttlePB.msh','utf8'));assert.equal(mesh.groups.length,7);assert.equal(mesh.materials.length,2);assert.equal(mesh.textures.length,2);
 const manifest=JSON.parse(await readFile('fixtures/landing/assets/ShuttlePB.json','utf8')),bytes=await readFile('fixtures/landing/assets/'+manifest.hash+'.splat');
 assert.equal(createHash('sha256').update(bytes).digest('hex'),manifest.hash);const splats=decodeSplats(bytes);assert.equal(splats.length,manifest.count);assert.ok(splats.length>10000);
 assert.ok(splats.some(s=>s.center[2]<-3.5));assert.ok(splats.some(s=>s.group===2&&s.center[0]<-2.5));
 assert.equal(createHash('sha256').update(encodeSplats(splats)).digest('hex'),manifest.hash);
});
test('asset decoder rejects malformed dimensions and nonfinite data',()=>{
 assert.throws(()=>decodeSplats(new Uint8Array(4)),/invalid/);
 const bytes=encodeSplats([{center:[0,0,0],scale:[1,1,1],rotation:[0,0,0,1],color:[1,1,1,1],normal:[0,1,0]}]);
 new DataView(bytes.buffer).setFloat32(16,NaN,true);assert.throws(()=>decodeSplats(bytes),/nonfinite/);
});
test('captured terrain preserves its elevation grid and reports unknown albedo',()=>{
 const patch=terrainSplats(demo.terrain);assert.equal(patch.albedoKnown,false);assert.equal(patch.splats.length,3136);assert.ok(patch.splats.every(s=>s.normal[1]>.99));
 assert.ok(patch.splats.some(s=>s.center[1]<0)); // spherical curvature is retained
 const bad=structuredClone(demo.terrain);bad.heights.pop();assert.throws(()=>terrainSplats(bad),/length/);
});
test('4D exhaust is deterministic in simulation time and absent at zero thrust',()=>{
 const a=sample(50),first=exhaustSplats(a,5.025);assert.ok(first.length>0);assert.deepEqual(first,exhaustSplats(a,5.025));
 a.visual.hover=0;a.visual.main=0;assert.deepEqual(exhaustSplats(a,5.025),[]);
});
test('visual schema refuses invalid rotation, invalid engine levels and terrain identity',()=>{
 const v=sample().visual;validateVisual(v);assert.throws(()=>validateVisual({...v,main:2}),/main/);assert.throws(()=>validateVisual({...v,bodyOrientation:[0,0,0,0]}),/normalization/);
 assert.throws(()=>validateVisual({...v,terrain:{...demo.terrain,id:'different'}}),/identity/);
});
test('server durably stores one terrain asset and carries its hash in later accepted states',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'osg-scene-test-'));let server;
 try{
  server=await createWorldServer({httpPort:0,bridgePort:0,dataDir:dir});
  const a={...sample(),type:'PHYSICS_SAMPLE',source:'native'};a.visual.terrain=demo.terrain;await server.handleSample(a);
  const b={...sample(1),type:'PHYSICS_SAMPLE',source:'native'};await server.handleSample(b);
  const hash=server.state.lastSample.visual.terrainHash;assert.match(hash,/^[a-f0-9]{64}$/);assert.equal(server.state.lastSample.visual.terrain,undefined);
  const url='http://127.0.0.1:'+server.httpPort;const asset=await (await fetch(url+'/api/scene/asset/'+hash)).json();assert.deepEqual(asset,demo.terrain);
  const state=await (await fetch(url+'/api/state')).json();assert.equal(state.state.visual.terrainHash,hash);
  for(const path of ['/packages/sg4d/index.mjs','/packages/world-protocol/primitives.mjs','/packages/landing-scene/timeline.mjs'])assert.equal((await fetch(url+path)).status,200);
  assert.equal((await fetch(url+'/packages/world-protocol/index.mjs')).status,404);
  const bad={...sample(2),type:'PHYSICS_SAMPLE',source:'native'};bad.visual.terrain={...demo.terrain,heights:Array(81).fill(1)};await assert.rejects(server.handleSample(bad),/identity changed/);
 }finally{await server?.close();await rm(dir,{recursive:true,force:true});}
});
test('demo service refuses native ingestion and clearly identifies its source',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'osg-demo-test-'));let server;
 try{server=await createWorldServer({httpPort:0,bridgePort:0,dataDir:dir,landingDemo:true});const status=await (await fetch('http://127.0.0.1:'+server.httpPort+'/api/status')).json();assert.equal(status.landingDemo,true);assert.equal(status.mode,'landing-demo');await assert.rejects(server.handleSample({...sample(),type:'PHYSICS_SAMPLE',source:'native'}),/refuses native/);}
 finally{await server?.close();await rm(dir,{recursive:true,force:true});}
});

test('real OSG retains scene asset references across pinned reads and cold restart',{skip:process.env.OSG_MULTI_SOURCE_DIR?false:'Set OSG_MULTI_SOURCE_DIR'},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'osg-scene-world-'));let server;
 const options={httpPort:0,bridgePort:0,dataDir:dir,osgWorldMode:true,osgMultiSourceDir:process.env.OSG_MULTI_SOURCE_DIR};
 try{
  server=await createWorldServer(options);
  const a={...sample(),type:'PHYSICS_SAMPLE',source:'native'};a.visual.terrain=demo.terrain;
  await server.handleSample(a);await server.flushWorld();const first=await server.world.snapshot();const head=first.head,hash=first.frames[0].sample.visual.terrainHash;
  const b={...sample(1),type:'PHYSICS_SAMPLE',source:'native'};await server.handleSample(b);await server.flushWorld();
  const pinned=await server.world.snapshot({runId:a.runId,epoch:0,head,timeMicros:0});assert.equal(pinned.frames[0].sample.visual.terrainHash,hash);assert.equal(pinned.frames[0].sample.simTime,0);
  await server.close();server=await createWorldServer(options);const recovered=await server.world.snapshot();assert.equal(recovered.frames[0].sample.visual.terrainHash,hash);assert.equal(recovered.frames[0].sample.simTime,.1);
  const response=await fetch(`http://127.0.0.1:${server.httpPort}/api/scene/asset/${hash}`);assert.equal(response.status,200);assert.deepEqual(await response.json(),demo.terrain);
 }finally{await server?.close();await rm(dir,{recursive:true,force:true});}
});
