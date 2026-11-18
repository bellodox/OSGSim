import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import net from 'node:net';
import {createWorldServer} from '../apps/world-service/server.mjs';
import {makeEnvelope} from '../packages/world-protocol/index.mjs';
const sample=(seq,contact=false)=>makeEnvelope('PHYSICS_SAMPLE',{runId:'sdk-run-1',epoch:0,step:seq,sequence:seq,
  simTime:seq*.5,simDt:.5,frameId:'metaverse-global-ecliptic',entityId:'vessel-lander',source:'native',
  position:[10,20,30-seq],velocity:[0,0,-1],orientation:[0,0,0,1],contact});
const send=(port,msg)=>new Promise((resolve,reject)=>{const s=net.connect(port,'127.0.0.1',()=>{s.write(msg+'\n',()=>{s.end();resolve();});});s.on('error',reject);});
async function until(fn,ms=2000){const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,15));}throw new Error('timed out');}
test('native poststep transition yields exactly one durable CONTACT_BEGIN, rejects duplicate source sequence',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'osg-live-'));
  const app=await createWorldServer({httpPort:0,bridgePort:0,dataDir:dir});
  try{
    const s=net.connect(app.bridgePort,'127.0.0.1');await new Promise(r=>s.on('connect',r));
    s.write([sample(1,false),sample(2,false),sample(3,true),sample(4,true)].map(JSON.stringify).join('\n')+'\n');
    await until(()=>app.state.samplesAccepted===4);
    assert.equal(app.state.contacts.length,1);assert.equal(app.state.contacts[0].type,'CONTACT_BEGIN');
    assert.equal(app.state.contacts[0].step,3);assert.equal(app.state.contacts[0].source,'native');
    s.write(JSON.stringify(sample(4,true))+'\n');
    await until(()=>app.state.errors.some(x=>x.includes('duplicate')));
    assert.equal((await app.journal.entries()).length,2); // initial state checkpoint + contact
    s.destroy();
    const r=await fetch(`http://127.0.0.1:${app.httpPort}/api/status`);const status=await r.json();
    assert.equal(status.contacts,1);assert.equal(status.journalHead.sequence,2);
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
test('HTTP recording has exact source, gap policy and no false native attribution',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'osg-replay-'));
  const app=await createWorldServer({httpPort:0,bridgePort:0,dataDir:dir,replayPrefix:resolve('fixtures/recordings/Atlantis')});
  try{
    const base=`http://127.0.0.1:${app.httpPort}`;
    const re=await (await fetch(base+'/api/recording')).json();
    assert.equal(re.source,'recorded');assert.equal(re.events.find(e=>e.kind==='LANDED').time,217.2886439);
    const st=await(await fetch(base+'/api/state?time=100')).json();assert.equal(st.state.unavailable,true);
    const html=await(await fetch(base+'/')).text();assert.match(html,/Physical event/);
    const status=await(await fetch(base+'/api/status')).json();assert.equal(status.nativeConnected,false);
  }finally{await app.close();await rm(dir,{recursive:true,force:true});}
});
