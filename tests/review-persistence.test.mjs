import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {encodeSample,decodeSample,AssetStore} from '../packages/osg-physical/journal.mjs';
import {OsgAdapter} from '../packages/osg-physical/osg-adapter.mjs';
import {createWorldServer} from '../apps/world-service/server.mjs';
const s={version:1,type:'PHYSICS_SAMPLE',source:'native',runId:'persisted-run',epoch:0,step:1,sequence:1,simTime:1,simDt:1,
 entityId:'vessel',frameId:'metaverse-global-ecliptic',position:[10,0,0],velocity:[0,0,0],contact:false};
test('physical assets preserve unknown orientation and independently encode contact/angular velocity',()=>{
 const a=decodeSample(encodeSample(s));assert.equal(a.orientation,null);assert.equal(a.angularVelocity,null);assert.equal(a.contact,false);
 const b=decodeSample(encodeSample({...s,contact:true,angularVelocity:[1,2,3],orientation:[0,0,0,1]}));
 assert.equal(b.contact,true);assert.deepEqual(b.angularVelocity,[1,2,3]);assert.deepEqual(b.orientation,[0,0,0,1]);
 const old=Buffer.alloc(96);old.writeDoubleLE(1,11*8);assert.equal(decodeSample(old).formatVersion,1);assert.equal(decodeSample(old).contact,null);
 old.writeDoubleLE(NaN,0);assert.throws(()=>decodeSample(old),/binary sample/);
});
test('server restart refuses replay of a run even if it stopped before its first contact',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'osg-run-proof-'));let app;
 try{app=await createWorldServer({httpPort:0,bridgePort:0,dataDir:dir});await app.handleSample(s);await app.close();
  app=await createWorldServer({httpPort:0,bridgePort:0,dataDir:dir});
  await assert.rejects(app.handleSample(s),/recovered/);assert.equal(app.state.samplesAccepted,0);
 }finally{await app?.close();await rm(dir,{recursive:true,force:true});}
});
test('recorder import preserves raw action and position source assets for independent replay',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'osg-source-proof-'));
 try{const p=spawnSync(process.execPath,['scripts/import-recording.mjs','fixtures/recordings/Atlantis',dir],{encoding:'utf8'});assert.equal(p.status,0,p.stderr);
  const report=JSON.parse(await readFile(join(dir,'import-report.json'),'utf8'));const store=new AssetStore(join(dir,'assets'));
  for(const ext of ['pos','atc'])assert.deepEqual(await store.get(report.sourceAssets[ext]),await readFile('fixtures/recordings/Atlantis.'+ext));
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('OSG adapter rejects unsafe canonical timestamp conversion before publishing',async()=>{
 const a=new OsgAdapter({});a.store={};let calls=0;a._commit=async()=>{calls++;};
 await assert.rejects(a.appendObservedEvent({...s,type:'CHECKPOINT',eventId:'too-large',simTime:1e12},null),/safe integer/);assert.equal(calls,0);
});
