// SPDX-License-Identifier: MIT
// The local world endpoint: the public summary never carries frames or proofs; /view needs a wallet-signed session.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createV26Hub} from '../OSGSim/apps/metaverse-native/v26/hub.mjs';

const worldId='a'.repeat(64),address='rFJtzkbeQ3dxWQg9G82LHMsPvrhSLMarJU';
test('frames and proofs require a fresh wallet-authenticated session; the world summary stays public',async()=>{
 const now=Date.now(),runNonce='native-unit-run',runId='native-accepted-run';
 const state={worldId,clock:{},port:{portId:'moon:brighton-beach'},root:'b'.repeat(64),osgHead:'c'.repeat(65),
  ships:{peer0:{owner:address,nativeName:'Shuttle-peer0'}},sequence:1,eventHead:'d'.repeat(64),events:[],authorityRevision:1,nextActorId:1,frames:{peer0:{private:true}},proofs:{}};
 const stub={graph:{close(){}},port:state.port,worldId,
  async init(){},async snapshot(){return structuredClone(state)}};
 const rpc=async (method)=>{assert.equal(method,'verifymessage');return true};
 const hub=await createV26Hub({world:stub,rpc,host:'127.0.0.1',listenPort:0,runNonce,now:()=>now});
 await assert.rejects(createV26Hub({world:stub,rpc,host:'0.0.0.0'}),/loopback_only/);
 try{
  const base=hub.url;
  const response=await fetch(base+'/view');
  assert.equal(response.status,401);
  const publicSummary=await fetch(base+'/world');assert.equal(publicSummary.status,200);
  const summary=await publicSummary.json();assert.ok(!('frames' in summary)&&!('proofs' in summary));
  const challenge=await (await fetch(base+'/session-challenge?actor=peer0&runId='+runId)).json();
  const session=await fetch(base+'/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
   challengeId:challenge.id,actor:'peer0',address,nonce:challenge.nonce,runId,runNonce,signature:'mock-signature'})});
  assert.equal(session.status,200);const token=(await session.json()).token;
  assert.match(token,/^[a-f0-9]{64}$/);
  const view=await fetch(base+'/view',{headers:{authorization:'Bearer '+token}});
  assert.equal(view.status,200);assert.deepEqual((await view.json()).frames,{peer0:{private:true}});
  assert.equal((await fetch(base+'/acceptance?runNonce='+runNonce,{headers:{authorization:'Bearer '+token}})).status,404,'legacy route removed');
  const rejected=await fetch(base+'/view',{headers:{authorization:'Bearer '+'f'.repeat(64)}});
  assert.equal(rejected.status,401);
 }finally{await hub.close()}
});
