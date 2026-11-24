// SPDX-License-Identifier: MIT
// Time bootstrap BEFORE inspecting short-lived Nostr announcements.
// Independent NTP sources discipline the wall offset, not Metaverse's MJD.
import {queryNtp} from '../world-time.mjs';
// One NTP query implementation (world-time.mjs). The offset limit is applied below, so a device clock that is too far off
// is reported as bootstrap_NTP_uncertainty_out_of_bounds, not as an unreachable server.
export const readNtpOffset=(host,{port=123}={})=>queryNtp(host,{port,timeoutMs:1800,maxOffsetMs:Infinity});
export async function disciplineBootstrapClock(hosts,{query=readNtpOffset,maxUncertaintyMs=160,maxOffsetMs=3600000,now=Date.now}={}){
 if(!Array.isArray(hosts)||new Set(hosts).size<2)throw Error('bootstrap_requires_two_NTP_sources');
 const samples=(await Promise.all(hosts.map(h=>query(h).catch(()=>null)))).filter(Boolean);
 if(samples.length<2)throw Error('bootstrap_NTP_quorum_unavailable');
 const cohort=samples.map(x=>({x,members:samples.filter(y=>Math.abs(y.offsetMs-x.offsetMs)<=80+Math.max(x.uncertaintyMs,y.uncertaintyMs))})).sort((a,b)=>b.members.length-a.members.length)[0].members;
 if(cohort.length<2)throw Error('bootstrap_NTP_sources_disagree');
 const offsets=cohort.map(x=>x.offsetMs).sort((a,b)=>a-b);const offset=offsets[Math.floor(offsets.length/2)];
 const uncertainty=Math.max(...cohort.map(x=>Math.abs(x.offsetMs-offset)+x.uncertaintyMs));
 if(!Number.isFinite(offset)||Math.abs(offset)>maxOffsetMs||uncertainty>maxUncertaintyMs)throw Error('bootstrap_NTP_uncertainty_out_of_bounds');
 const refMono=performance.now(),refUtc=now()+offset;
 return{offsetMs:offset,uncertaintyMs:uncertainty,sources:cohort.map(x=>x.host),clock:()=>refUtc+(performance.now()-refMono)};
}
