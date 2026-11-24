#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Launcher checks that must pass before anything is provisioned or started. They live here, not in
// Start-SpeXGSP.ps1, because this file runs under the test suite; arguments are passed as an array, so
// no shell quoting is involved.
import {spawnSync} from 'node:child_process';
import {stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const MIN_NODE_MAJOR=22; // the relay client uses the global WebSocket
// The line that says what went wrong: the 'XxxError: ...' line of a traceback, otherwise the last line.
const reason=text=>{const lines=String(text??'').split('\n').map(l=>l.trim()).filter(Boolean);
 return lines.find(l=>/^(?:\w+\.)*\w*(?:Error|Exception)\b.*:/.test(l))??lines.at(-1)??'(no output)';};
const exists=async file=>{try{return (await stat(file)).isFile();}catch{return false;}};

/** Returns [{check, ok, detail}] in the order the checks ran; stops at the first failure. */
export async function runPreflight({root,python=process.env.OSGSIM_PYTHON??'python',requireEngine=true,
 nodeVersion=process.versions.node,run=(cmd,args)=>spawnSync(cmd,args,{encoding:'utf8',windowsHide:true})}={}){
 root=resolve(root);const results=[];
 const step=async(check,fn)=>{let detail;try{detail=await fn();}catch(e){results.push({check,ok:false,detail:e.message});return false;}
  results.push({check,ok:true,detail:detail??''});return true;};
 const exec=(cmd,args)=>{const r=run(cmd,args);if(r.error)throw Error(`${cmd}: ${r.error.message}`);
  if(r.status!==0)throw Error(`${cmd} ${args.join(' ')} exited ${r.status}: ${reason(r.stderr||r.stdout)}`);
  return String(r.stdout??'').trim();};
 const major=Number(nodeVersion.split('.')[0]);
 const checks=[
  ['node',()=>{if(!(major>=MIN_NODE_MAJOR))throw Error(`Node.js ${MIN_NODE_MAJOR} or newer is required (found ${nodeVersion})`);return 'v'+nodeVersion;}],
  ['pyzmq',()=>'pyzmq '+exec(python,['-c','import zmq;print(zmq.__version__)'])],
  ['release files',()=>exec(process.execPath,[join(root,'scripts','verify-release.mjs'),'--root='+root])],
  ...(requireEngine?[['metaverse engine',async()=>{const exe=join(root,'Modules','Server','SpaceXpanse.exe');
   if(!await exists(exe))throw Error('installed native SpaceXpanse Metaverse executable missing: '+exe);return exe;}]]:[]),
  ['runtime syntax',()=>{exec(process.execPath,['--check',join(root,'OSGSim','scripts','spexgsp-rod-peer.mjs')]);return 'ok';}],
  ['zmq framing selftest',()=>exec(python,[join(root,'OSGSim','apps','metaverse-native','v26','rod-game','native-zmq.py'),'--selftest'])],
 ];
 for(const [name,fn] of checks)if(!await step(name,fn))break;
 return results;
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const root=process.argv.find(x=>x.startsWith('--root='))?.slice(7)??'.';
 const results=await runPreflight({root});
 for(const r of results)console.log((r.ok?'OK    ':'FAIL  ')+r.check+(r.detail?': '+r.detail:''));
 process.exit(results.length&&results.every(r=>r.ok)?0:1);
}
