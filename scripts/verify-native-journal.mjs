// SPDX-License-Identifier: MIT
// Verify *local authenticated stream and asset consistency*. Cannot attest SDK DLL load.
import {resolve,join} from 'node:path';
import {DurableJournal,AssetStore,decodeSample} from '../packages/osg-physical/journal.mjs';
const dir=resolve(process.argv[2]??'.data');
const journal=await new DurableJournal(join(dir,'events.journal'),{readOnly:true}).open();
const assets=new AssetStore(join(dir,'assets'));
try {
  const events=await journal.entries();
  const native=events.filter(e=>e.source==='native');
  const begins=native.filter(e=>e.type==='CONTACT_BEGIN');
  const authenticated=begins.filter(e=>e.transportAuthenticated===true);
  let payloadsVerified=0;const problems=[];
  for(const e of begins){
    if(!e.assetHash){problems.push(`missing physical asset for ${e.eventId}`);continue;}
    try{
      const sample=decodeSample(await assets.get(e.assetHash));
      if(Math.abs(sample.simTime-e.simTime)>1e-10)problems.push(`sample time mismatch for ${e.eventId}`);
      if(!Array.isArray(e.position)||e.position.some((x,i)=>x!==sample.position[i]))problems.push(`sample position mismatch for ${e.eventId}`);
      if(sample.contact!==true)problems.push(`asset lacks independently encoded contact=true for ${e.eventId}`);
      payloadsVerified++;
    }catch(error){problems.push(`${e.eventId}: ${error.message}`);}
  }
  const valid=begins.length>0 && begins.length===authenticated.length &&
    payloadsVerified===begins.length && problems.length===0;
  const result={status:valid?'LOCAL_AUTHENTICATED_STREAM_EVIDENCE':'NOT_VERIFIED',
    journalHead:journal.head,nativeEvents:native.length,contacts:begins.length,
    authenticatedContacts:authenticated.length,payloadsVerified,problems,
    warning:'Local token proves shared configuration only; actual DLL load, SDK origin and real Moon physics remain separately testable.'};
  console.log(JSON.stringify(result,null,2));
  if(!valid)process.exitCode=2;
}finally{await journal.close();}
