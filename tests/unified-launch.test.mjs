// SPDX-License-Identifier: MIT
// The one launcher, and the release integrity check it runs before anything else.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,mkdir,writeFile,rm,cp} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=join(dirname(fileURLToPath(import.meta.url)),'..');
const load=name=>readFile(join(root,name),'utf8');

test('the launcher verifies the release, then runs the universe tool or the peer with the relay options',async()=>{
 const ps=await load('Start-SpeXGSP.ps1'),bat=await load('Start-SpeXGSP.bat');
 assert.match(bat,/Start-SpeXGSP\.ps1/);
 const verify=ps.indexOf("scripts/preflight.mjs"),peer=ps.indexOf("spexgsp-rod-peer.mjs"),create=ps.indexOf('spexgsp-create-universe.mjs');
 assert.ok(verify>0&&peer>verify&&create>verify,'preflight (which verifies the release) runs first');
 assert.ok(!/\$python|-c '/.test(ps),'no inline python or quoted -c arguments in the PowerShell launcher');
 for(const flag of ['--relay=','--relay-port=','--no-relay','--universe=','--choose','--list-universes'])assert.ok(ps.includes(flag),flag);
 const peerSource=await load('OSGSim/scripts/spexgsp-rod-peer.mjs');
 for(const option of ['--relay=','--relay-port=','--no-relay','--universe=','--choose','--list-universes'])assert.ok(peerSource.includes(option),option);
 assert.match(peerSource,/host:'127\.0\.0\.1'/,'the local world endpoint is loopback only');
});

test('release manifest round trip: generated, verified, and a changed or missing file stops the launch',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spex-release-'));
 try{
  await mkdir(join(dir,'scripts'),{recursive:true});await mkdir(join(dir,'OSGSim','.data'),{recursive:true});
  await cp(join(root,'scripts','make-manifest.mjs'),join(dir,'scripts','make-manifest.mjs'));
  await cp(join(root,'scripts','verify-release.mjs'),join(dir,'scripts','verify-release.mjs'));
  await writeFile(join(dir,'a.txt'),'one');await writeFile(join(dir,'OSGSim','.data','runtime.json'),'{}');
  await writeFile(join(dir,'Start-SpeXGSP.bat'),'@echo off\r\n'); // a locally changed wrapper must not block a launch
  const node=(...args)=>spawnSync(process.execPath,args,{encoding:'utf8'});
  assert.equal(node(join(dir,'scripts','make-manifest.mjs'),'--root='+dir).status!==0,true,'a version is required');
  execFileSync(process.execPath,[join(dir,'scripts','make-manifest.mjs'),'--root='+dir,'--version=1.2.3']);
  const manifest=JSON.parse(await readFile(join(dir,'RELEASE-FILES.json'),'utf8'));
  assert.deepEqual(manifest.files.map(f=>f.path),['a.txt','scripts/make-manifest.mjs','scripts/verify-release.mjs'],'runtime state and the .bat wrapper are not hashed');
  assert.equal(node(join(dir,'scripts','verify-release.mjs'),'--root='+dir).status,0);
  await writeFile(join(dir,'a.txt'),'two');
  const changed=node(join(dir,'scripts','verify-release.mjs'),'--root='+dir);
  assert.notEqual(changed.status,0);assert.match(changed.stderr,/size_mismatch_a\.txt|hash_mismatch_a\.txt/);
  await rm(join(dir,'a.txt'));const gone=node(join(dir,'scripts','verify-release.mjs'),'--root='+dir);
  assert.notEqual(gone.status,0);assert.match(gone.stderr,/missing_a\.txt/);
  // All differing files are listed in one run, with what to do about it.
  await writeFile(join(dir,'a.txt'),'x');await writeFile(join(dir,'scripts','make-manifest.mjs'),'// other\n');
  const several=node(join(dir,'scripts','verify-release.mjs'),'--root='+dir);
  assert.match(several.stderr,/2 of 3 files differ.*(?:size|hash)_mismatch_a\.txt.*(?:size|hash)_mismatch_scripts\/make-manifest\.mjs.*Extract the complete release zip/s);
 }finally{await rm(dir,{recursive:true,force:true})}
});
