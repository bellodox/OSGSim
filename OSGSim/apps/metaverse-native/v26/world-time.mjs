// SPDX-License-Identifier: MIT
// NTP-calibrated monotonic estimate; NTP never drives the Metaverse physics loop.
import dgram from 'node:dgram';
import {lookup} from 'node:dns/promises';
import {performance} from 'node:perf_hooks';
const NTP_EPOCH=2208988800;
const DAY_MS=86400000;
const safe=x=>typeof x==='number'&&Number.isFinite(x);
const number=x=>safe(x)&&x>=0&&Number.isSafeInteger(x);
export function validateTimePolicy(p){
 if(!p||p.schema!==1||p.rate!==1||!number(p.utcOriginMs)||!safe(p.simMjd0)||p.simMjd0<1||p.simMjd0>1000000||!Number.isSafeInteger(p.era)||p.era<1||p.era>1e6)throw Error('invalid_world_time');
 if(p.rodReference!==undefined&&p.rodReference!==null&&!/^[a-f0-9]{64}$/.test(p.rodReference))throw Error('invalid_rod_time_anchor');
 return Object.freeze({...p});
}
export const worldMjd=(policy,utcMs)=>{validateTimePolicy(policy);if(!safe(utcMs))throw Error('invalid_utc');return policy.simMjd0+(utcMs-policy.utcOriginMs)/DAY_MS;};
export const worldTimeUs=(policy,utcMs)=>Math.round((utcMs-policy.utcOriginMs)*1000);
const readNtp=(buf,index)=>buf.readUInt32BE(index)*1000+(buf.readUInt32BE(index+4)*1000/2**32)-NTP_EPOCH*1000;
const writeNtp=(buf,index,ms)=>{const sec=(ms/1000+NTP_EPOCH);const whole=Math.floor(sec);buf.writeUInt32BE(whole>>>0,index);buf.writeUInt32BE(Math.floor((sec-whole)*2**32)>>>0,index+4);};
// RFC 5905 four-timestamp exchange, with sender/originate validation.
export async function queryNtp(host,{port=123,timeoutMs=1400,maxOffsetMs=300000,monotonic=()=>performance.now(),wall=()=>Date.now()}={}){
 if(typeof host!=='string'||!/^[-a-zA-Z0-9.]{1,253}$/.test(host)||!Number.isInteger(port)||port<1||port>65535)throw Error('invalid_ntp_target');
 const address=(await lookup(host,{family:4})).address;
 const s=dgram.createSocket('udp4'),request=Buffer.alloc(48);request[0]=0x23;
 const sentWall=wall(),sentMono=monotonic();writeNtp(request,40,sentWall);
 try{return await new Promise((resolve,reject)=>{
  const done=(err,value)=>{clearTimeout(timer);s.removeAllListeners('message');s.removeAllListeners('error');err?reject(err):resolve(value);};
  const timer=setTimeout(()=>done(Error('ntp_timeout')),timeoutMs);
  s.once('error',e=>done(e));s.once('message',(reply,rinfo)=>{try{
   if(rinfo.address!==address||rinfo.port!==port||reply.length<48)throw Error('ntp_invalid_reply');
   const leap=reply[0]>>6,mode=reply[0]&7,stratum=reply[1];
   if(mode!==4||leap===3||stratum===0||stratum>15||!request.subarray(40,48).equals(reply.subarray(24,32)))throw Error('ntp_untrusted_sample');
   const t1=sentWall,t2=readNtp(reply,32),t3=readNtp(reply,40),t4=sentWall+(monotonic()-sentMono);
   const rtt=(t4-t1)-(t3-t2),offset=((t2-t1)+(t3-t4))/2;
   if(![rtt,offset,t2,t3].every(safe)||rtt< -5||rtt>10000||Math.abs(offset)>maxOffsetMs)throw Error('ntp_outlier');
   done(null,{host,offsetMs:offset,delayMs:Math.max(0,rtt),uncertaintyMs:Math.max(1,rtt/2),sampleUtcMs:t4+offset});
  }catch(e){done(e);}});s.send(request,port,address,e=>{if(e)done(e);});
 });}finally{s.close();}
}
export class WorldClock{
 constructor(policy,{nowMono=()=>performance.now(),nowWall=()=>Date.now(),maxUncertaintyMs=250,maxAgeMs=300000}={}){
  this.policy=validateTimePolicy(policy);this.nowMono=nowMono;this.nowWall=nowWall;
  this.maxUncertaintyMs=maxUncertaintyMs;this.maxAgeMs=maxAgeMs;this.calibration=null;
 }
 calibrate(sample){
  if(!sample||![sample.offsetMs,sample.uncertaintyMs].every(safe)||sample.uncertaintyMs<0||sample.uncertaintyMs>1e5||Math.abs(sample.offsetMs)>86400000)throw Error('invalid_clock_sample');
  const mono=this.nowMono();if(this.calibration){const estimate=this.nowUtc().utcMs;const newEstimate=this.nowWall()+sample.offsetMs;
   if(newEstimate+100<estimate)throw Error('clock_backward_step_rejected');
   // A forward jump agreed by an NTP quorum is real elapsed time the monotonic clock did not count (e.g. the
   // machine slept). Refusing it would leave the world clock expired until restart; the native plugin re-aligns.
   if(Math.abs(newEstimate-estimate)>Math.max(250,3*sample.uncertaintyMs)&&!(sample.quorum===true&&newEstimate>estimate))
    throw Error('clock_large_step_rejected');
  }
  this.calibration={mono,utc:this.nowWall()+sample.offsetMs,uncertaintyMs:sample.uncertaintyMs,source:sample.host??'local'};
  return this.status();
 }
 nowUtc(){if(!this.calibration)throw Error('clock_not_calibrated');const elapsed=this.nowMono()-this.calibration.mono;
  if(!safe(elapsed)||elapsed<0)throw Error('nonmonotonic_clock');
  return{utcMs:this.calibration.utc+elapsed,uncertaintyMs:this.calibration.uncertaintyMs+elapsed*0.0001,ageMs:elapsed,source:this.calibration.source};
 }
 status(){const x=this.nowUtc();return{...x,simMjd:worldMjd(this.policy,x.utcMs),worldTimeUs:Math.round((x.utcMs-this.policy.utcOriginMs)*1000),ready:x.uncertaintyMs<=this.maxUncertaintyMs&&x.ageMs<=this.maxAgeMs};}
 requireReady(){const s=this.status();if(!s.ready)throw Error('world_clock_uncertain');return s;}
 /** Keep the calibration fresh. Without this the clock expires after maxAgeMs and every request fails closed. */
 startAutoCalibration(hosts,{intervalMs=60000,retryMs=10000,onError=()=>{},...options}={}){
  if(this.autoTimer)return this;
  if(!Number.isSafeInteger(intervalMs)||intervalMs<1000||intervalMs>=this.maxAgeMs)throw Error('invalid_auto_calibration_interval');
  let running=false;
  const schedule=ms=>{if(this.autoStopped)return;this.autoTimer=setTimeout(tick,ms);this.autoTimer.unref?.();};
  const tick=async()=>{
   if(running||this.autoStopped)return;running=true;let next=intervalMs;
   try{await this.calibrateFromPool(hosts,options);}catch(e){next=retryMs;try{onError(e);}catch{}}
   finally{running=false;schedule(next);}
  };
  this.autoStopped=false;schedule(intervalMs);return this;
 }
 stopAutoCalibration(){this.autoStopped=true;if(this.autoTimer){clearTimeout(this.autoTimer);this.autoTimer=null;}}
 async calibrateFromPool(hosts,options={}){
  if(!Array.isArray(hosts)||hosts.length<2||hosts.length>8||new Set(hosts).size!==hosts.length)throw Error('require_two_independent_ntp_servers');
  const query=options.query??queryNtp;
  const samples=(await Promise.all(hosts.map(h=>query(h,options).catch(()=>null)))).filter(Boolean).sort((a,b)=>a.uncertaintyMs-b.uncertaintyMs);
  if(samples.length<2)throw Error('ntp_quorum_unavailable');
  let cohort=[];for(const candidate of samples){const group=samples.filter(x=>Math.abs(x.offsetMs-candidate.offsetMs)<=Math.max(80,x.uncertaintyMs+candidate.uncertaintyMs+30));if(group.length>cohort.length)cohort=group;}
  if(cohort.length<2)throw Error('ntp_sources_disagree');
  const offsets=cohort.map(s=>s.offsetMs).sort((a,b)=>a-b),median=offsets[Math.floor(offsets.length/2)];
  const worst=cohort.reduce((m,s)=>Math.max(m,s.uncertaintyMs+Math.abs(s.offsetMs-median)),0);
  if(worst>this.maxUncertaintyMs)throw Error('ntp_quorum_uncertain');
  return this.calibrate({offsetMs:median,uncertaintyMs:worst,host:cohort.map(x=>x.host).join(','),quorum:cohort.length>=2});
 }
}
