import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorldServer} from '../apps/world-service/server.mjs';
import {makeEnvelope,validateEnvelope} from '../packages/world-protocol/index.mjs';
import {DurableJournal} from '../packages/osg-physical/journal.mjs';
import {hermite,applyBasis,matrixToQuaternion} from '../packages/sg4d/index.mjs';
import {parsePosition,stateAt} from '../packages/recorder/index.mjs';

const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f){for(let i=0;i<200;i++){if(await f())return;await pause(10);}throw Error('timeout');}
const sample=(n,fields={})=>makeEnvelope('PHYSICS_SAMPLE',{runId:'review-run',epoch:0,step:n,sequence:n,
 simTime:n,simDt:1,entityId:'vessel-A',frameId:'metaverse-global-ecliptic',source:'native',
 position:[1000,n,0],velocity:[0,1,0],orientation:[0,0,0,1],contact:false,...fields});
async function appTest(fn,options={}){
 const dir=await mkdtemp(join(tmpdir(),'osg-review-'));
 const app=await createWorldServer({httpPort:0,bridgePort:0,dataDir:dir,...options});
 try{await fn(app);}finally{await app.close();await rm(dir,{recursive:true,force:true});}
}
async function socket(app){const s=net.connect(app.bridgePort,'127.0.0.1');s.on('error',()=>{});await new Promise(r=>s.once('connect',r));return s;}

test('failed producer cannot inject valid queued frames after an invalid frame',()=>appTest(async app=>{
 const s=await socket(app);
 try{s.write('{invalid json}\n'+JSON.stringify(sample(1))+'\n');await until(()=>app.state.errors.length>0);await pause(50);
 assert.equal(app.state.samplesAccepted,0);}finally{s.destroy();}
}));
test('replay service refuses native ingress instead of mixing authorities',()=>appTest(async app=>{
 const s=await socket(app);try{s.write(JSON.stringify(sample(1))+'\n');await pause(60);assert.equal(app.state.samplesAccepted,0);}finally{s.destroy();}
},{replayPrefix:'fixtures/recordings/Atlantis'}));
test('regressing time, repeated vessel step and frame changes fail before state mutation',()=>appTest(async app=>{
 await app.handleSample(sample(1));
 await assert.rejects(app.handleSample(sample(2,{simTime:0})),/time/);
 await assert.rejects(app.handleSample(sample(2,{step:1,simTime:1})),/step/);
 await assert.rejects(app.handleSample(sample(2,{frameId:'different-frame'})),/frame/);
 assert.equal(app.state.samplesAccepted,1);
}));
test('completed epochs cannot be replayed and existing observers receive reset',()=>appTest(async app=>{
 const messages=[],ws=new WebSocket(`ws://127.0.0.1:${app.httpPort}/ws`);
 ws.addEventListener('message',e=>messages.push(JSON.parse(e.data)));
 await new Promise(r=>ws.addEventListener('open',r,{once:true}));
 try{
  await app.handleSample(sample(1));
  await app.handleSample(sample(1,{epoch:1}));
  await until(()=>messages.some(e=>e.type==='PHYSICS_SAMPLE'&&e.epoch===1));
  assert.ok(messages.some(e=>e.type==='SIMULATION_RESET'&&e.epoch===1));
  await assert.rejects(app.handleSample(sample(1)),/epoch|retired/);
 }finally{ws.close();}
}));
test('native frames require their coordinate frame and do not accept producer provenance claims',()=>{
 const s=sample(1);delete s.frameId;assert.throws(()=>validateEnvelope(s),/frameId/);
});
test('producer extras cannot leak token or forge transport provenance to observers',()=>appTest(async app=>{
 await app.handleSample(sample(1,{bridgeToken:'secret_do_not_publish',transportAuthenticated:true,extra:'untrusted'}));
 assert.equal(app.state.lastSample.bridgeToken,undefined);
 assert.equal(app.state.lastSample.transportAuthenticated,false);
 assert.equal(app.state.lastSample.extra,undefined);
}));
test('two journal writer instances cannot silently fork one file',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'osg-lock-'));let a,b;
 try{a=await new DurableJournal(join(dir,'j')).open();
  await assert.rejects(async()=>{b=await new DurableJournal(join(dir,'j')).open();},/lock|writer/);
 }finally{await b?.close();await a?.close();await rm(dir,{recursive:true,force:true});}
});
test('journal snapshots append inputs before asynchronous queueing',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'osg-snapshot-'));const j=await new DurableJournal(join(dir,'j')).open();
 try{const e=makeEnvelope('CHECKPOINT',{runId:'run',epoch:0,step:1,sequence:1,eventId:'checkpoint'});
  const pending=j.append(e);e.step=99;await pending;assert.equal((await j.entries())[0].step,1);
 }finally{await j.close();await rm(dir,{recursive:true,force:true});}
});
test('journal deduplication scopes caller event IDs to run and epoch',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'osg-ids-'));const j=await new DurableJournal(join(dir,'j')).open();
 try{for(const runId of ['one','two'])await j.append(makeEnvelope('CHECKPOINT',{runId,epoch:0,step:1,sequence:1,eventId:'same'}));
 assert.equal((await j.entries()).length,2);
 }finally{await j.close();await rm(dir,{recursive:true,force:true});}
});
test('Hermite velocity equals the derivative of the returned position',()=>{
 const samples=[{time:0,position:[0,0,0],velocity:[0,0,0]},{time:2,position:[2,0,0],velocity:[0,0,0]}];
 const s=stateAt(samples,1);assert.equal(s.velocity[0],1.5);
 assert.throws(()=>hermite([0,0,0],[0,0,0],[1,0,0],[0,0,0],0,2,NaN),/time|finite|invalid/);
});
test('rotation APIs reject determinant-one shear and malformed rotations',()=>{
 assert.throws(()=>applyBasis([1,2,3],[[1,2,0],[0,1,0],[0,0,1]]),/orth|basis/);
 assert.throws(()=>matrixToQuaternion([[1,0,0],[0,1,0],[0,0,-1]]),/rotation|determinant/);
});
test('recorder cannot silently mix time origins or accept unsupported coordinate frames',()=>{
 const header='STARTMJD 50000\nREF Earth\nFRM ECLIPTIC\nCRD CARTESIAN\n';
 assert.throws(()=>parsePosition(header+'0 1 0 0 0 0 0\nSTARTMJD 50001\n1 1 0 0 0 0 0'),/MJD|origin|metadata/);
 assert.throws(()=>parsePosition(header.replace('ECLIPTIC','UNKNOWN')+'0 1 0 0 0 0 0'),/frame/);
});
