// SPDX-License-Identifier: MIT
import { assert, finite } from '../world-protocol/index.mjs';
import { hermite,hermiteVelocity } from '../sg4d/index.mjs';

const NUMBER=/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
function readNumber(s) { assert(NUMBER.test(s),`invalid recorder number: ${s}`); return finite(Number(s),'number'); }
function directivesAndRows(text) {
  const metadata={}; const rows=[]; let last=-Infinity;
  for(const [index,raw] of text.split(/\r?\n/).entries()) {
    const line=raw.trim(); if(!line || line.startsWith(';') || line.startsWith('#')) continue;
    const parts=line.split(/\s+/), key=parts[0].toUpperCase();
    if(['STARTMJD','REF','FRM','CRD'].includes(key)) {
      if (key==='STARTMJD') metadata.startMjd=readNumber(parts[1]);
      if (key==='REF') metadata.reference=parts.slice(1).join(' ');
      if (key==='FRM') metadata.frame=parts[1].toUpperCase();
      if (key==='CRD') metadata.coordinates=parts[1].toUpperCase();
      continue;
    }
    if(!NUMBER.test(parts[0])) throw new Error(`unknown recorder line ${index+1}: ${line}`);
    const time=readNumber(parts[0]);assert(time>last,'nonascending recorder time');last=time;
    rows.push({time,values:parts.slice(1).map(readNumber),line:index+1,meta:{...metadata}});
  }
  return {metadata,rows};
}
export function polarToCartesian(radius,phi,theta) {
  return [radius*Math.cos(theta)*Math.cos(phi), radius*Math.sin(theta), radius*Math.cos(theta)*Math.sin(phi)];
}
export function polarVelocityToCartesian(radius,phi,theta,vr,vphi,vtheta) {
  const cp=Math.cos(phi),sp=Math.sin(phi),ct=Math.cos(theta),st=Math.sin(theta);
  return [vr*ct*cp-radius*st*cp*vtheta-radius*ct*sp*vphi,
          vr*st+radius*ct*vtheta,
          vr*ct*sp-radius*st*sp*vtheta+radius*ct*cp*vphi];
}
export function parsePosition(text) {
  const {metadata,rows}=directivesAndRows(text);
  assert(rows.length>0,'no positions');
  const samples=rows.map(row=>{
    const {coordinates,reference,frame,startMjd}=row.meta;
    assert(row.values.length===6,'position row must contain six values');
    assert(reference && frame && coordinates && Number.isFinite(startMjd),'position metadata missing');
    assert(['ECLIPTIC','EQUATORIAL'].includes(frame),'unsupported position frame');
    let position,velocity;
    if(coordinates==='CARTESIAN') { position=row.values.slice(0,3);velocity=row.values.slice(3); }
    else if(coordinates==='POLAR') {
      const [r,phi,theta,vr,vphi,vtheta]=row.values;
      assert(r>0,'radius must be positive');
      position=polarToCartesian(r,phi,theta);
      velocity=polarVelocityToCartesian(r,phi,theta,vr,vphi,vtheta);
    } else throw new Error('unsupported coordinate system');
    return {time:row.time,position,velocity,reference,frame,startMjd,coordinates,line:row.line};
  });
  const ref=samples[0];
  assert(samples.every(s=>s.reference===ref.reference && s.frame===ref.frame), 'mixed reference frames must be split into epochs before interpolation');
  assert(samples.every(s=>s.startMjd===ref.startMjd),'mixed STARTMJD time origins must be split before interpolation');
  return {metadata:{...metadata,startMjd:ref.startMjd,reference:ref.reference,frame:ref.frame,coordinates:ref.coordinates},samples};
}
export function parseAttitude(text) {
  const {metadata,rows}=directivesAndRows(text);
  return {metadata,samples:rows.map(row=>{
    assert(row.values.length>=3,'attitude needs three angles');
    return {time:row.time,angles:row.values.slice(0,3),reference:row.meta.reference,frame:row.meta.frame,line:row.line};
  })};
}
export function parseEvents(text) {
  const events=[];
  for(const [i,raw] of text.split(/\r?\n/).entries()) {
    const line=raw.trim();if(!line)continue;
    const [t,...rest]=line.split(/\s+/);
    events.push({time:readNumber(t),kind:rest[0],detail:rest.slice(1).join(' '),line:i+1});
  }
  return events;
}
export function stateAt(samples,t) {
  finite(t,'time');
  assert(samples.length>0,'empty recording');
  if(t<=samples[0].time) return {...samples[0],interpolated:false};
  if(t>=samples.at(-1).time) return {...samples.at(-1),interpolated:false};
  let lo=0,hi=samples.length-1;
  while(lo+1<hi) {const mid=Math.floor((lo+hi)/2);if(samples[mid].time<=t)lo=mid;else hi=mid;}
  const a=samples[lo],b=samples[hi];
  if(b.time-a.time>10 && t!==a.time && t!==b.time) {
    return {time:t,unavailable:true,lastKnownTime:a.time,nextKnownTime:b.time};
  }
  if(t===a.time)return {...a,interpolated:false};
  return {...a,time:t,position:hermite(a.position,a.velocity,b.position,b.velocity,a.time,b.time,t),
    velocity:hermiteVelocity(a.position,a.velocity,b.position,b.velocity,a.time,b.time,t),
    interpolated:true, sourceInterval:[lo,hi]};
}
