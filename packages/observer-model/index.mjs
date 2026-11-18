// SPDX-License-Identifier: MIT
// Kinematic signal-arrival model for explicit stationary/moving observers.
// This is not an implementation of GR, full radiative transfer, or physical sensor occlusion.
import {assert,finite,vec3} from '../world-protocol/index.mjs';
export const C_M_PER_S=299792458;
const distance=(a,b)=>Math.hypot(...a.map((x,i)=>x-b[i]));

/** Solve t_recv = t_emit + |observer(t_recv) - source(t_emit)| / speed.
 * A subluminal observer motion and a continuous trajectory are required for contraction.
 */
export function signalArrival({emissionTime,sourcePosition,observerAt,speed=C_M_PER_S,maxIterations=64}) {
  finite(emissionTime,'emissionTime');vec3(sourcePosition,'sourcePosition');finite(speed,'speed');
  assert(speed>0,'propagation speed must be positive');assert(typeof observerAt==='function','observer trajectory callback required');
  let receive=emissionTime+distance(sourcePosition,vec3(observerAt(emissionTime),'observer position'))/speed;
  for(let i=0;i<maxIterations;i++) {
    const next=emissionTime+distance(sourcePosition,vec3(observerAt(receive),'observer position'))/speed;
    if(Math.abs(next-receive)<=1e-11*Math.max(1,next-emissionTime))return next;
    if(!Number.isFinite(next)||next-emissionTime>1e12)break;
    receive=next;
  }
  throw new Error('signal arrival did not converge; check observer trajectory and speed');
}
export function causalObservation(event, observerAt, queryTime, speed=C_M_PER_S) {
  finite(queryTime,'queryTime');
  if(!Array.isArray(event.position))return {eventId:event.eventId??null,status:'UNLOCATED_SOURCE',arrivalTime:null};
  const arrivalTime=signalArrival({emissionTime:event.simTime,sourcePosition:event.position,observerAt,speed});
  return {eventId:event.eventId??null,source:event.source??'unknown',arrivalTime,
    status:queryTime>=arrivalTime?'RECEIVED':'NOT_YET_CAUSAL',
    delaySeconds:arrivalTime-event.simTime};
}
export const STUDY_OFFSETS=Object.freeze({
  A:Object.freeze([0,0,0]),
  B:Object.freeze([1_000_000,0,0]),
  C:Object.freeze([384_400_000,0,0])
});
