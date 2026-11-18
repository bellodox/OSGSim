import test from 'node:test';import assert from 'node:assert/strict';
import {makeEnvelope,validateEnvelope,SequenceGate,eventIdentity} from '../packages/world-protocol/index.mjs';
const sample=(sequence=1)=>makeEnvelope('PHYSICS_SAMPLE',{runId:'native-1',epoch:0,step:sequence,sequence,simTime:sequence/60,simDt:1/60,
  entityId:'vessel-A',frameId:'metaverse-global-ecliptic',position:[1,2,3],velocity:[4,5,6],orientation:[0,0,0,1],source:'native',contact:false});
test('valid physical sample',()=>assert.equal(validateEnvelope(sample()).type,'PHYSICS_SAMPLE'));
test('rejects invalid/oversize/NaN input',()=>{
  assert.throws(()=>validateEnvelope({...sample(),position:[NaN,2,3]}),/position/);
  assert.throws(()=>validateEnvelope({...sample(),version:2}),/version/);
  assert.throws(()=>validateEnvelope({...sample(),entityId:'../bad'}),/entityId/);
  assert.throws(()=>validateEnvelope({...sample(),orientation:[0,0,0,0]}),/normalization/);
  assert.throws(()=>validateEnvelope({...sample(),evil:'x'.repeat(100000)}),/oversized/);
});
test('sequence gate rejects missing/out-of-order events',()=>{
  const gate=new SequenceGate();gate.accept(sample(1));assert.throws(()=>gate.accept(sample(3)),/out-of-order/);
  gate.accept(sample(2));assert.throws(()=>gate.accept(sample(2)),/out-of-order/);
});
test('event identity is stable by causal tuple',()=>{
  const a=sample(2);assert.equal(eventIdentity({...a,type:'CONTACT_BEGIN'}),eventIdentity({...a,type:'CONTACT_BEGIN'}));
  assert.notEqual(eventIdentity({...a,type:'CONTACT_BEGIN'}),eventIdentity({...a,type:'CONTACT_END'}));
});
test('commands are deliberately bounded',()=>{
  const base={runId:'native-1',epoch:0,step:5,sequence:1,commandId:'c1',entityId:'v1',actorId:'operator',operation:'set-thruster',level:.5};
  assert.equal(makeEnvelope('COMMAND_REQUEST',base).level,.5);
  assert.throws(()=>makeEnvelope('COMMAND_REQUEST',{...base,operation:'delete-everything'}),/operation/);
});
