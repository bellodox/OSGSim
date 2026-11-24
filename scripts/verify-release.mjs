#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Byte-exact distribution completeness. SHA-256 inventory is not publisher authentication.
import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join,sep} from 'node:path';
const where=process.argv.find(x=>x.startsWith('--root='))?.slice(7)??'.';
const root=resolve(where),m=JSON.parse(await readFile(join(root,'RELEASE-FILES.json'),'utf8'));
if(m.schema!==1||typeof m.version!=='string'||!Array.isArray(m.files)||!m.files.length)throw Error('invalid_release_manifest');
const seen=new Set(),problems=[];let checked=0;
for(const x of m.files){if(typeof x.path!=='string'||!/^[a-zA-Z0-9_.\-\/ ()]+$/.test(x.path)||x.path.startsWith('/')||x.path.includes('..')||seen.has(x.path))throw Error('bad_or_duplicate_manifest_path');seen.add(x.path)
 const file=resolve(root,x.path);if(!file.startsWith(root+sep))throw Error('manifest_path_escape');
 // Every differing file is collected, so one run shows the whole damage instead of the first file only.
 let size;try{size=(await stat(file)).size;}catch{problems.push('missing_'+x.path);continue;}
 if(size!==x.bytes){problems.push('size_mismatch_'+x.path);continue;}
 const digest=createHash('sha256').update(await readFile(file)).digest('hex');if(digest!==x.sha256){problems.push('hash_mismatch_'+x.path);continue;}
 checked++;
}
if(problems.length)throw Error(`release_files_differ: ${problems.length} of ${m.files.length} files differ from release ${m.version}: ${problems.slice(0,12).join(', ')}${problems.length>12?', ...':''}. Extract the complete release zip over this folder and overwrite every file.`);
console.log(JSON.stringify({status:'verified',release:m.version,files:checked,root}));
