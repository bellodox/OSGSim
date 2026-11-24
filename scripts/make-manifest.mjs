#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Regenerates RELEASE-FILES.json: byte size and SHA-256 of every distributed file. Start-SpeXGSP.ps1 refuses to
// run when any listed file differs (scripts/verify-release.mjs). Run this after every change to a distributed file.
// An inventory detects accidental corruption or a partial copy; it does not authenticate the publisher.
import {readdir,readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join,relative,sep} from 'node:path';
const root=resolve(process.argv.find(x=>x.startsWith('--root='))?.slice(7)??'.');
const version=process.argv.find(x=>x.startsWith('--version='))?.slice(10);
if(!/^\d+\.\d+\.\d+[A-Za-z0-9.-]*$/.test(version??''))throw Error('usage: make-manifest.mjs --version=<x.y.z> [--root=<dir>]');
// Runtime state, local builds and the provisioned OSG Multi checkout are not part of the distribution.
const SKIP_DIRS=new Set(['node_modules','.git','.data','OmniSpatialGraph-multi','out']);
// The plugin DLL is shipped but may be rebuilt in place with -BuildNative; the player checks its HELLO features instead.
// Start-SpeXGSP.bat is a three-line wrapper that only starts the verified .ps1; hashing it adds a lockout, not protection.
const SKIP_FILES=new Set(['RELEASE-FILES.json','Modules/Plugin/SpeXGSP.dll','Start-SpeXGSP.bat']);
const walk=async dir=>{const out=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);
 if(e.isDirectory()){if(SKIP_DIRS.has(e.name))continue;out.push(...await walk(p));}else if(e.isFile())out.push(p);}return out;};
const files=[];
for(const p of (await walk(root)).map(f=>relative(root,f).split(sep).join('/')).filter(f=>!SKIP_FILES.has(f)).sort()){
 if(!/^[a-zA-Z0-9_.\-\/ ()]+$/.test(p))throw Error('unsafe_path_for_manifest_'+p);
 const data=await readFile(join(root,p));files.push({path:p,bytes:(await stat(join(root,p))).size,sha256:createHash('sha256').update(data).digest('hex')});
}
await writeFile(join(root,'RELEASE-FILES.json'),JSON.stringify({schema:1,version,files},null,1)+'\n');
console.log(JSON.stringify({status:'written',version,files:files.length}));
