// SPDX-License-Identifier: MIT
// User-supplied baseline/instrumented flight-recording comparison; NO fabricated performance result.
import {readFile} from 'node:fs/promises';import {parsePosition,stateAt} from '../packages/recorder/index.mjs';
const [baselineFile,instrumentedFile]=process.argv.slice(2);
if(!baselineFile||!instrumentedFile){console.error('Usage: node scripts/compare-trajectories.mjs BASELINE.pos BRIDGE_ENABLED.pos');process.exit(2);}
const b=parsePosition(await readFile(baselineFile,'utf8'));
const c=parsePosition(await readFile(instrumentedFile,'utf8'));
if(b.metadata.frame!==c.metadata.frame || b.metadata.reference!==c.metadata.reference || b.metadata.startMjd!==c.metadata.startMjd){
  throw new Error('Frames, reference bodies and initial MJDs must agree');
}
const POSITION_LIMIT_METERS=2.0,VELOCITY_LIMIT_MPS=0.25;
let n=0,maxP=0,maxV=0,failures=0;
if(b.samples[0].time!==c.samples[0].time||b.samples.at(-1).time!==c.samples.at(-1).time)failures++;
for(const r of b.samples){
  const other=stateAt(c.samples,r.time);
  if(other.unavailable||Math.abs((other.time??NaN)-r.time)>1e-4){failures++;continue;}
  const p=Math.hypot(...r.position.map((x,i)=>x-other.position[i]));
  const v=Math.hypot(...r.velocity.map((x,i)=>x-other.velocity[i]));
  maxP=Math.max(maxP,p);maxV=Math.max(maxV,v);n++;
  if(p>POSITION_LIMIT_METERS||v>VELOCITY_LIMIT_MPS)failures++;
}
const result={status:failures||n<2?'FAIL':'PASS',comparedSamples:n,failures,
  maxPositionErrorMeters:maxP,maxVelocityErrorMps:maxV,
  predefinedLimits:{positionMeters:POSITION_LIMIT_METERS,velocityMps:VELOCITY_LIMIT_MPS}};
console.log(JSON.stringify(result,null,2));
if(failures||n<2)process.exitCode=1;
