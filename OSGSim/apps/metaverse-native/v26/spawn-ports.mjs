// SPDX-License-Identifier: MIT
// Surface ports are only admitted after verifying the actual Metaverse base file.
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {dirname} from 'node:path';
const hash=s=>createHash('sha256').update(s).digest('hex');
const id=/^[A-Za-z0-9_.:-]{1,96}$/;
export function parseBrightonBase(text){
 if(typeof text!=='string'||!/^BASE-V2\.0/m.test(text)||!/^Name\s*=\s*Brighton Beach\s*$/m.test(text))throw Error('unsupported_base_file');
 const pads=[];const blocks=[...text.matchAll(/^LPAD1[ \t]*\r?\n([\s\S]*?)^END[ \t]*$/gm)];
 for(const [,body] of blocks){
  const match=body.match(/(?:^|\n)\s*POS\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/);
  const rot=body.match(/(?:^|\n)\s*ROT\s+(-?[\d.]+)/);
  if(!match||!rot)throw Error('invalid_pad_definition');
  const xyz=match.slice(1).map(Number),heading=Number(rot[1]);
  if(![...xyz,heading].every(Number.isFinite)||Math.abs(xyz[0])>100000||Math.abs(xyz[1])>100000||Math.abs(xyz[2])>100000)throw Error('invalid_pad_coordinates');
  pads.push({slot:`pad-${pads.length+1}`,nativePadIndex:pads.length,scenarioPadIndex:pads.length+1,relativeMetres:xyz,rotDegrees:heading});
 }
 if(pads.length<2||pads.length>40)throw Error('invalid_brighton_capacity');
 return{schema:1,base:'Brighton Beach',body:'Moon',slots:pads,configSha256:hash(text)};
}
export async function loadBrightonPort(file,{available=2}={}){
 const text=await readFile(file,'utf8'),port=parseBrightonBase(text);if(available===null)available=port.slots.length;if(!Number.isInteger(available)||available<2||available>port.slots.length)throw Error('invalid_port_capacity');
 return{...port,portId:'moon:brighton-beach',slots:port.slots.slice(0,available),allowedClasses:['ShuttlePB']};
}
export function canonicalSpawn(spawn,port){
 if(!port?.slots||!spawn||!id.test(spawn.actor)||!id.test(spawn.nativeName)||!id.test(spawn.vesselClass)||!id.test(spawn.asset)||spawn.vesselClass!=='ShuttlePB'||spawn.portId!==port.portId||!port.slots.find(s=>s.slot===spawn.slot)||!/^[a-f0-9]{64}$/.test(spawn.eventId))throw Error('unauthorized_spawn');
 return{...spawn};
}
const SCENE=/^[a-zA-Z0-9_.:-]{1,96}$/;
export function quaternionToMetaverseAngles(q){
 if(!Array.isArray(q)||q.length!==4||!q.every(Number.isFinite)||Math.abs(Math.hypot(...q)-1)>0.005)throw Error('invalid_resume_quaternion');
 const [x,y,z,w]=q, r02=2*(x*z+y*w),r12=2*(y*z-x*w),r22=1-2*(x*x+y*y),r01=2*(x*y-z*w),r00=1-2*(y*y+z*z);
 const pitch=-Math.asin(Math.max(-1,Math.min(1,r02))),roll=-Math.atan2(-r12,r22),yaw=-Math.atan2(-r01,r00);
 return [roll,pitch,yaw].map(a=>a*180/Math.PI);
}

export function ownerScenario(template,spawn,port,simMjd,{resumeFrame=null}={}){
 canonicalSpawn(spawn,port);
 if(typeof template!=='string'||!template.includes('BEGIN_ENVIRONMENT')||!template.includes('BEGIN_SHIPS')||!Number.isFinite(simMjd))throw Error('invalid_scenario_template');
 const pad=port.slots.find(s=>s.slot===spawn.slot);const name=spawn.nativeName;
 if(!SCENE.test(name)||!SCENE.test(spawn.actor)||simMjd<0||simMjd>1000000)throw Error('invalid_scenario_parameters');
 const environment=template.replace(/(\bDate\s+MJD\s+)[-+\d.]+/,(_,a)=>a+simMjd.toFixed(12));
 if(environment===template&& !new RegExp('\\bDate MJD '+simMjd.toFixed(12)).test(template))throw Error('missing_scenario_epoch');
 const focal=environment.replace(/(BEGIN_FOCUS\s*\r?\n\s*Ship\s+)[^\r\n]+/,(_,a)=>a+name)
 .replace(/(BEGIN_CAMERA[\s\S]*?\bTARGET\s+)[^\r\n]+/,(_,a)=>a+name);
 const begin=focal.indexOf('BEGIN_SHIPS'),end=focal.indexOf('END_SHIPS',begin);
 if(begin<0||end<0)throw Error('missing_scenario_vessels');
 // Keep scenario environment and non-player static objects; do not copy an old owner Glider.
 const original=focal.slice(begin+'BEGIN_SHIPS'.length,end);
 const keep=original.split(/(?=^\S[^\r\n]*:[^\r\n]*$)/m).filter(x=>!/^\s*Glider[^\r\n]*:ShuttlePB/m.test(x)).join('').trim();
 let local=`${name}:ShuttlePB\n  STATUS Landed Moon\n  BASE Brighton Beach:${pad.scenarioPadIndex}\n  POS -33.4375 41.125\n  HEADING ${pad.rotDegrees.toFixed(2)}\n  PRPLEVEL 0:0.820 1:0.972\nEND`;
 if(spawn.recovered && ['DEPARTED','LANDED'].includes(spawn.phase)){
  const sample=resumeFrame?.sample;if(!sample||sample.entityName!==name||sample.frameId!=='metaverse-moon-relative-v26'||!['LANDED','FREEFLIGHT'].includes(sample.mode))throw Error('reconnect_requires_last_authoritative_physics');
  if(sample.mode==='LANDED'){
   const [lng,lat,hdg,alt]=sample.surface??[];if(![lng,lat,hdg,alt].every(Number.isFinite)||Math.abs(lng)>Math.PI||Math.abs(lat)>Math.PI/2)throw Error('invalid_resume_surface');
   local=`${name}:ShuttlePB\n  STATUS Landed Moon\n  POS ${(lng*180/Math.PI).toFixed(12)} ${(lat*180/Math.PI).toFixed(12)}\n  HEADING ${(hdg*180/Math.PI).toFixed(12)}\n  PRPLEVEL 0:0.820 1:0.972\nEND`;
  } else {
   if(!Array.isArray(sample.position)||!Array.isArray(sample.velocity)||![...sample.position,...sample.velocity].every(Number.isFinite))throw Error('invalid_resume_vectors');
   const ang=quaternionToMetaverseAngles(sample.orientation);
   // Offline physics is explicitly suspended: restore the last accepted state at the current epoch.
   const values=v=>v.map(x=>x.toFixed(9)).join(' ');
   local=`${name}:ShuttlePB\n  STATUS Orbiting Moon\n  RPOS ${values(sample.position)}\n  RVEL ${values(sample.velocity)}\n  AROT ${values(ang)}\n  PRPLEVEL 0:0.820 1:0.972\nEND`;
  }
 }

 return focal.slice(0,begin+'BEGIN_SHIPS'.length)+'\n'+(keep?keep+'\n':'')+local+'\n'+focal.slice(end);
}
export async function stageScenario({templateFile,outputFile,spawn,port,simMjd,resumeFrame=null}){
 const text=await readFile(templateFile,'utf8'),output=ownerScenario(text,spawn,port,simMjd,{resumeFrame});
 await mkdir(dirname(outputFile),{recursive:true});
 try{await writeFile(outputFile,output,{flag:'wx'});}catch(e){
  // An unattended task may be restarted with the same world/run. Only exact
  // content matches are idempotent; never overwrite a different scenario.
  if(e.code!=='EEXIST')throw e;
  if(await readFile(outputFile,'utf8')!==output)throw Error('spawn_scenario_run_nonce_collision');
 }
 return{outputFile,sha256:hash(output),simMjd};
}
