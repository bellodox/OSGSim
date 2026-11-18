import test from 'node:test';import assert from 'node:assert/strict';
import {signalArrival,causalObservation,C_M_PER_S} from '../packages/observer-model/index.mjs';

test('light travel delay for fixed reference observer equals Euclidean distance/c',()=>{
 const d=384_400_000,t=17;
 const arrival=signalArrival({emissionTime:t,sourcePosition:[0,0,0],observerAt:()=>[d,0,0]});
 assert.ok(Math.abs(arrival-(t+d/C_M_PER_S))<1e-9);
});
test('moving observer receiving signal has self-consistent future position',()=>{
 const d=1_000_000,v=100,expected=d/(C_M_PER_S-v);
 const actual=signalArrival({emissionTime:0,sourcePosition:[0,0,0],observerAt:t=>[d+v*t,0,0]});
 assert.ok(Math.abs(actual-expected)<1e-10);
});
test('no sensor sees information before its arrival time; missing locations remain unknown',()=>{
 const e={eventId:'c1',simTime:10,position:[0,0,0],source:'native'};
 assert.equal(causalObservation(e,()=>[384_400_000,0,0],10.1).status,'NOT_YET_CAUSAL');
 assert.equal(causalObservation(e,()=>[384_400_000,0,0],12).status,'RECEIVED');
 assert.equal(causalObservation({...e,position:undefined},()=>[1,0,0],12).status,'UNLOCATED_SOURCE');
});
test('invalid trajectories and propagation speeds fail closed',()=>{
 assert.throws(()=>signalArrival({emissionTime:0,sourcePosition:[0,0,0],observerAt:()=>[1,2,3],speed:-1}),/speed/);
 assert.throws(()=>signalArrival({emissionTime:0,sourcePosition:[0,0,0],observerAt:()=>[Infinity,0,0]}),/invalid observer position/);
});
