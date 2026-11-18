import test from 'node:test';import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {parsePosition,parseAttitude,parseEvents,polarToCartesian,stateAt} from '../packages/recorder/index.mjs';
const fixtures='fixtures/recordings/Atlantis';
test('real Metaverse recorder excerpt parsed with truthful metadata and no gap interpolation',async()=>{
  const data=await readFile(fixtures+'.pos','utf8');const out=parsePosition(data);
  assert.equal(out.metadata.reference,'Earth');assert.equal(out.metadata.frame,'EQUATORIAL');
  assert.equal(out.metadata.coordinates,'POLAR');assert.ok(out.samples.length>20);
  assert.ok(Math.abs(out.samples[0].position[0])>100000);
  assert.equal(stateAt(out.samples,100).unavailable,true);
  assert.deepEqual(stateAt(out.samples,out.samples.at(-1).time).position,out.samples.at(-1).position);
  assert.equal(stateAt(out.samples,out.samples[0].time+1).interpolated,true);
});
test('polar radial conversion and tangent velocity',()=>{
  const a=polarToCartesian(10,0,0);assert.deepEqual(a,[10,0,0]);
});
test('attitude stays in recorded horizon frame rather than unverified world quaternion',async()=>{
  const att=parseAttitude(await readFile(fixtures+'.att','utf8'));
  assert.equal(att.samples[0].frame,'HORIZON');assert.equal(att.samples[0].angles.length,3);
  assert.ok(!('orientation' in att.samples[0]));
});
test('recorded LANDED is source evidence but not a native contact event',async()=>{
  const events=parseEvents(await readFile(fixtures+'.atc','utf8'));
  const landed=events.find(x=>x.kind==='LANDED');assert.equal(landed.time,217.2886439);
  assert.equal(landed.detail,'Earth');
});
test('rejects unsupported and changing reference frames',()=>{
  const raw='STARTMJD 1\nREF Earth\nFRM EQUATORIAL\nCRD POLAR\n0 10 0 0 1 0 0\nREF Moon\n1 10 0 0 1 0 0\n';
  assert.throws(()=>parsePosition(raw),/mixed reference/);
});
