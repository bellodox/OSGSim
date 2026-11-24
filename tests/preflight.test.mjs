// SPDX-License-Identifier: MIT
// The launcher's pre-start checks. The previous inline PowerShell version failed on every machine because
// PowerShell stripped the double quotes from a `python -c` argument; these checks run as plain argv arrays.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,cp,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {runPreflight} from '../scripts/preflight.mjs';
const repo=join(dirname(fileURLToPath(import.meta.url)),'..');
const ok={status:0,stdout:'27.3.0\n',stderr:''};
const recorder=(reply=()=>ok)=>{const calls=[];return{calls,run:(cmd,args)=>{calls.push([cmd,...args]);return reply(cmd,args);}};};

test('preflight: every check passes and no argument needs shell quoting',async()=>{
 const {calls,run}=recorder();
 const results=await runPreflight({root:repo,run,requireEngine:false,python:'py-test'});
 assert.deepEqual(results.map(r=>r.check),['node','pyzmq','release files','runtime syntax','zmq framing selftest']);
 assert.ok(results.every(r=>r.ok),JSON.stringify(results));
 assert.ok(calls.length>=4&&calls.flat().every(a=>!/["']/.test(a)),'argv arrays only: '+JSON.stringify(calls));
 assert.deepEqual(calls[0],['py-test','-c','import zmq;print(zmq.__version__)']);
});

test('preflight: Node older than 22 stops before anything else runs',async()=>{
 const {calls,run}=recorder();
 const results=await runPreflight({root:repo,run,nodeVersion:'20.11.0',requireEngine:false});
 assert.equal(results.length,1);assert.equal(results[0].ok,false);assert.match(results[0].detail,/Node\.js 22 or newer.*20\.11\.0/);assert.equal(calls.length,0);
});

test('preflight: a missing pyzmq or missing python is reported and later checks are skipped',async()=>{
 const missing=await runPreflight({root:repo,requireEngine:false,run:(cmd)=>cmd==='python'?{status:1,stdout:'',stderr:'Traceback...\nModuleNotFoundError: No module named zmq'}:ok});
 assert.deepEqual(missing.map(r=>[r.check,r.ok]),[['node',true],['pyzmq',false]]);assert.match(missing[1].detail,/No module named zmq/);
 const absent=await runPreflight({root:repo,requireEngine:false,run:()=>({error:Error('spawn python ENOENT')})});
 assert.equal(absent[1].ok,false);assert.match(absent[1].detail,/ENOENT/);
});

test('preflight: the installed Metaverse engine is required unless told otherwise',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spex-pre-'));
 try{
  const results=await runPreflight({root:dir,run:()=>ok});
  assert.equal(results.at(-1).check,'metaverse engine');assert.equal(results.at(-1).ok,false);assert.match(results.at(-1).detail,/executable missing.*SpaceXpanse\.exe/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('preflight CLI: runs for real against a release tree (node, pyzmq, file hashes, syntax, ZMQ selftest)',async(t)=>{
 const python=['python','python3'].find(p=>spawnSync(p,['-c','import zmq']).status===0);
 if(!python){t.skip('python with pyzmq not available');return;}
 const dir=await mkdtemp(join(tmpdir(),'spex-pre-real-'));
 try{
  for(const f of ['scripts/preflight.mjs','scripts/verify-release.mjs','scripts/make-manifest.mjs','OSGSim/scripts/spexgsp-rod-peer.mjs','OSGSim/apps/metaverse-native/v26/rod-game/native-zmq.py']){
   await mkdir(dirname(join(dir,f)),{recursive:true});await cp(join(repo,f),join(dir,f));}
  await mkdir(join(dir,'Modules','Server'),{recursive:true});await writeFile(join(dir,'Modules','Server','SpaceXpanse.exe'),'x');
  assert.equal(spawnSync(process.execPath,[join(dir,'scripts','make-manifest.mjs'),'--root='+dir,'--version=1.0.0']).status,0);
  const env={...process.env,OSGSIM_PYTHON:python};
  const good=spawnSync(process.execPath,[join(dir,'scripts','preflight.mjs'),'--root='+dir],{encoding:'utf8',env});
  assert.equal(good.status,0,good.stdout+good.stderr);assert.match(good.stdout,/OK    pyzmq pyzmq|OK    pyzmq: pyzmq \d/);assert.match(good.stdout,/OK    zmq framing selftest/);
  await writeFile(join(dir,'OSGSim','scripts','spexgsp-rod-peer.mjs'),'// tampered\n');
  const bad=spawnSync(process.execPath,[join(dir,'scripts','preflight.mjs'),'--root='+dir],{encoding:'utf8',env});
  assert.equal(bad.status,1);assert.match(bad.stdout,/FAIL  release files.*hash_mismatch_OSGSim\/scripts\/spexgsp-rod-peer\.mjs|FAIL  release files.*size_mismatch/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
