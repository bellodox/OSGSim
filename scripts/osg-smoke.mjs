#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Real OSG/LanceDB integration smoke. Run only with a separately built pinned OSG checkout.
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {OsgAdapter} from '../packages/osg-physical/osg-adapter.mjs';
import {makeEnvelope} from '../packages/world-protocol/index.mjs';
const sourceDir=process.env.OSG_SOURCE_DIR;
if(!sourceDir) {console.error('BLOCKED_ENVIRONMENT: OSG_SOURCE_DIR missing');process.exit(2);}
const dest=process.env.OSG_SMOKE_DIR?resolve(process.env.OSG_SMOKE_DIR):await mkdtemp(join(tmpdir(),'osg-physical-smoke-'));
let service=null;
try{
  await mkdir(dest,{recursive:true});
  const event=(type,step)=>makeEnvelope(type,{runId:'osg-adapter-selftest',epoch:0,step,sequence:step,
    entityId:'vessel-A',frameId:'metaverse-global-ecliptic',source:'recorded',
    simTime:step*.125,eventId:`osg-smoke-${type.toLowerCase()}-${step}`});
  const log=[event('CONTACT_BEGIN',1),event('CONTACT_END',2)];
  const storeDir=join(dest,'store');
  service=await new OsgAdapter({sourceDir,storeDir}).open();
  const initial=await service.reconcile(log);
  if(initial.processed!==2 || initial.changed!==2)throw Error('initial import failed');
  const again=await service.reconcile(log);
  if(again.processed!==2||again.changed!==0)throw Error('OSG graph entries were not idempotent');
  const result=await service.verify();
  if(result.elements<2||result.commits<2)throw Error('OSG verify insufficient rows');
  await service.close();service=null;
  service=await new OsgAdapter({sourceDir,storeDir}).open();
  const restart=await service.reconcile(log);
  if(restart.changed!==0)throw Error('OSG re-open generated duplicate changes');
  const after=await service.verify();
  if(after.elements!==result.elements||after.commits!==result.commits)throw Error('OSG graph changed after restart');
  const report={result:'PASS',scope:'real OSG adapter append/replay/reopen/verify only',sourceDir:resolve(sourceDir),
    entryCount:log.length,initial,again,restart,verified:after,storeDir};
  await writeFile(join(dest,'result.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}catch(e){console.error('OSG_SMOKE_FAILED: '+e.stack);process.exitCode=1;}
finally{await service?.close();}
