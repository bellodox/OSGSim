#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Compile native-independent C++ wire serializer and validate its output in JS protocol parser.
import {spawnSync} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {validateEnvelope} from '../packages/world-protocol/index.mjs';
const dir=await mkdtemp(join(tmpdir(),'osg-wire-cmake-'));
const run=(exe,args)=>{
 const result=spawnSync(exe,args,{encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024});
 if(result.error)throw result.error;
 if(result.status!==0)throw Error(`${exe} ${args.join(' ')} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
 return result.stdout;
};
try {
 const cmake=spawnSync('cmake',['--version'],{encoding:'utf8'});
 let binary;
 if(cmake.error?.code==='ENOENT'&&process.platform!=='win32'){
  binary=join(dir,'osg_wire_smoke');
  run(process.env.CXX??'g++',['-std=c++17','-O2','-DNDEBUG','-Wall','-Wextra','-Werror','-I',resolve('native/include'),resolve('native/tests/wire_smoke.cpp'),'-o',binary]);
  console.log('CMake unavailable: used direct C++17 compiler; CTest was not run');
 }else{
 run('cmake',['-S',resolve('native/tests'),'-B',dir]);
 run('cmake',['--build',dir,'--config','Release']);
 run('ctest',['--test-dir',dir,'-C','Release','--output-on-failure']);
 binary=process.platform==='win32'?join(dir,'Release','osg_wire_smoke.exe'):join(dir,'osg_wire_smoke');
 }
 const sample=validateEnvelope(JSON.parse(run(binary,[]).trim()));
 if(sample.runId!=='native-smoke-1'||sample.position[0]!==1000000000.125||
     sample.contact!==true||sample.capturedAtUnixMs!==1763500000123||Math.abs(Math.hypot(...sample.orientation)-1)>1e-12)
   throw Error('Native C++ output did not match the JS wire oracle');
 const removed=validateEnvelope(JSON.parse(run(binary,['removed']).trim()));if(removed.type!=='ENTITY_REMOVED'||removed.entityId!=='vessel-17'||removed.wireFormat!==2)throw Error('Removal wire mismatch');
 const named=validateEnvelope(JSON.parse(run(binary,['named']).trim()));if(named.entityId!=='vessel-17'||named.entityName!=='A B \"quoted\" €')throw Error('Display-name encoding mismatch');
 const visual=validateEnvelope(JSON.parse(run(binary,['visual']).trim()));if(visual.visual?.terrain?.heights.length!==81||visual.visual.vesselClass!=='ShuttlePB')throw Error('Visual wire mismatch');
 console.log('PASS: C++17 native serializer assertions and JavaScript wire protocol roundtrip');
}finally{await rm(dir,{recursive:true,force:true});}
