import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';import net from 'node:net';
import {createWorldServer} from '../apps/world-service/server.mjs';import {makeEnvelope} from '../packages/world-protocol/index.mjs';

const token='LocalBridgeTestKey_0123456789';
const base={runId:'test-auth-record',epoch:0,simDt:.2,source:'native',frameId:'metaverse-global-ecliptic',entityId:'lander',
  position:[1739000,0,0],velocity:[-5,0,0],orientation:[0,0,0,1]};
const sample=(n,contact)=>makeEnvelope('PHYSICS_SAMPLE',{...base,step:n,sequence:n,simTime:n*.2,contact});
async function waitFor(pred){for(let i=0;i<100;i++){if(pred())return;await new Promise(r=>setTimeout(r,10));}throw Error('timeout');}
test('native-journal verification distinguishes locally authenticated sample from simulator provenance',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'osg-native-proof-'));
  const app=await createWorldServer({httpPort:0,bridgePort:0,dataDir:dir,bridgeToken:token});
  let client;
  try{
    client=net.createConnection(app.bridgePort,'127.0.0.1');await new Promise(r=>client.once('connect',r));
    const hello=makeEnvelope('HELLO',{runId:base.runId,source:'native',step:0,sequence:0,epoch:0,bridgeToken:token});
    client.write([hello,sample(1,false),sample(2,true)].map(JSON.stringify).join('\n')+'\n');
    await waitFor(()=>app.state.contacts.length===1);
    assert.equal(app.state.contacts[0].transportAuthenticated,true);
    const r=spawnSync(process.execPath,['scripts/verify-native-journal.mjs',dir],{cwd:resolve('.'),encoding:'utf8'});
    assert.equal(r.status,0,r.stderr||r.stdout);
    const evidence=JSON.parse(r.stdout);
    assert.equal(evidence.status,'LOCAL_AUTHENTICATED_STREAM_EVIDENCE');
    assert.equal(evidence.authenticatedContacts,1);
    assert.equal(evidence.payloadsVerified,1);
  }finally{client?.destroy();await app.close();await rm(dir,{recursive:true,force:true});}
});
