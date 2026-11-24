#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Starts ROD Core (spacexpansed) from the installation folder when no node answers on the RPC port, then waits until
// its RPC is ready. A node that is already listening is left alone. RPC stays on loopback; no key leaves ROD Core.
import {spawn} from 'node:child_process';
import {readdir,readFile,mkdir,stat} from 'node:fs/promises';
import {openSync,closeSync,readFileSync} from 'node:fs';
import {writeFile} from 'node:fs/promises';
import {createInterface} from 'node:readline/promises';
import {createConnection} from 'node:net';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {rodLoginCandidates,rememberRodLogin,readRodConf,givenRodRpc,rodRpcUrl,ROD_MAINNET_RPC_PORT} from '../OSGSim/apps/metaverse-native/v26/single-address/local-runtime.mjs';
import {rpcClient} from '../OSGSim/apps/metaverse-native/v26/rpc-adapter.mjs';
import {requireRodMainnet} from '../OSGSim/apps/metaverse-native/v26/single-address/network-policy.mjs';

export const ZMQ_DEFAULT='tcp://127.0.0.1:28332';
const SKIP_DIRS=new Set(['node_modules','.git','.data','OmniSpatialGraph-multi','Modules','Config']);
const isFile=async f=>{try{return (await stat(f)).isFile();}catch{return false;}};

/** spacexpansed(.exe): OSGSIM_ROD_EXE, else the shallowest match under the installation folder (depth <= 4). */
export async function findRodExecutable(root,{env=process.env,platform=process.platform}={}){
 if(env.OSGSIM_ROD_EXE){if(await isFile(env.OSGSIM_ROD_EXE))return env.OSGSIM_ROD_EXE;throw Error('OSGSIM_ROD_EXE does not exist: '+env.OSGSIM_ROD_EXE);}
 const name=platform==='win32'?'spacexpansed.exe':'spacexpansed';
 const found=[];
 const walk=async(dir,depth)=>{let entries;try{entries=await readdir(dir,{withFileTypes:true});}catch{return;}
  for(const e of entries){const p=join(dir,e.name);
   if(e.isFile()&&e.name.toLowerCase()===name)found.push({p,depth});
   else if(e.isDirectory()&&depth<4&&!SKIP_DIRS.has(e.name))await walk(p,depth+1);}};
 await walk(root,0);
 found.sort((a,b)=>a.depth-b.depth||a.p.localeCompare(b.p));
 return found[0]?.p??null;
}

/** Command line: RPC server plus the two game ZMQ feeds, unless the node's own config file already sets them. */
export async function rodCoreArgs({root=null,env=process.env,read=file=>readFile(file,'utf8')}={}){
 const args=['-server=1'];
 const conf=await readRodConf({root,env,read});
 const values=conf?.values??new Map();
 const set=key=>values.has(key);
 // A config file found next to the program names the data directory the node must use.
 if(env.OSGSIM_ROD_DATADIR)args.push('-datadir='+env.OSGSIM_ROD_DATADIR);else if(conf&&root&&resolve(conf.dir).startsWith(resolve(root)))args.push('-datadir='+conf.dir);
 const zmq=env.OSGSIM_ROD_ZMQ_ADDRESS??ZMQ_DEFAULT;
 // ROD Core's built-in RPC default (11998) is also its peer-to-peer port, so the RPC port is always given explicitly.
 if(!set('rpcport'))args.push('-rpcport='+((await givenRodRpc({root,env,read}))?.port??ROD_MAINNET_RPC_PORT));
 if(!set('zmqpubgameblocks'))args.push('-zmqpubgameblocks='+zmq);
 if(!set('zmqpubgamepending'))args.push('-zmqpubgamepending='+zmq);
 return args;
}

export const tcpListening=(host,port,timeoutMs=1500)=>new Promise(done=>{
 const s=createConnection({host,port});let settled=false;
 const end=v=>{if(!settled){settled=true;s.destroy();done(v);}};
 s.setTimeout(timeoutMs,()=>end(false));s.once('connect',()=>end(true));s.once('error',()=>end(false));
});

/**
 * Makes sure ROD Core answers RPC (a node that already answers is used as it is) and is synchronized on mainnet. Returns
 * {started, executable, args}. Throws with the reason when it cannot: executable not found, the process exited (its
 * console log is quoted), RPC not ready in time, wrong chain, or not synchronized yet.
 */
export async function ensureRodCore({root,env=process.env,platform=process.platform,log=console.log,
 timeoutMs=Number(env.OSGSIM_ROD_START_TIMEOUT_MS)||600000,progressMs=10000,pollMs=1000,now=Date.now,
 find=findRodExecutable,listening=tcpListening,spawnProcess=spawn,makeRpc=rpcClient,rpcUrl=null,loginsFor=async dir=>(await rodLoginCandidates(dir,{env})).logins,remember=async(dir,login)=>{try{await rememberRodLogin(dir,login);}catch{/* the login still works for this run */}},sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 root=resolve(root);
 const url=new URL(rpcUrl??await rodRpcUrl({root,env})),port=Number(url.port),host=url.hostname;
 let started=false,executable=null,args=null,child=null,exited=null,logFile=null;
 if(!await listening(host,port)){
  {
   if(env.OSGSIM_ROD_AUTOSTART==='0')throw Error('ROD_CORE_NOT_RUNNING: nothing listens on '+url.origin+' and OSGSIM_ROD_AUTOSTART=0');
   executable=await find(root,{env,platform});
   if(!executable)throw Error('ROD_CORE_EXECUTABLE_NOT_FOUND: no '+(platform==='win32'?'spacexpansed.exe':'spacexpansed')+' under '+root+' (searched 4 levels). Put it there or set OSGSIM_ROD_EXE to its full path.');
   args=await rodCoreArgs({root,env});
   logFile=join(root,'OSGSim','.data','rod-core','console.log');
   await mkdir(dirname(logFile),{recursive:true});
   const fd=openSync(logFile,'a');
   log('ROD_CORE_STARTING '+JSON.stringify({executable,args,log:logFile}));
   try{child=spawnProcess(executable,args,{detached:true,stdio:['ignore',fd,fd],windowsHide:true});}finally{closeSync(fd);}
   child.once('exit',(code,signal)=>{exited={code,signal};});
   child.once('error',e=>{exited={code:null,signal:null,error:e.message};});
   started=true;
  }
 }else{
  // Something already listens. If an earlier launcher run started it, its console log says what it is doing.
  logFile=join(root,'OSGSim','.data','rod-core','console.log');
  log('ROD_CORE_ALREADY_LISTENING '+url.origin);
 }
 const t0=now();let lastPrint=-Infinity;
 const consoleTail=n=>{try{return readFileSync(logFile,'utf8').trim().split('\n').slice(-n).join(' | ');}catch{return '';}};
 const progress=reason=>{const t=now();if(t-lastPrint<progressMs)return;lastPrint=t;
  log('ROD_CORE_WAITING '+JSON.stringify({seconds:Math.round((t-t0)/1000),reason,...(logFile&&consoleTail(1)?{console:consoleTail(1)}:{})}));};
 const checkExit=()=>{if(exited)throw Error('ROD_CORE_EXITED_DURING_START: '+JSON.stringify(exited)+(logFile?' console: '+consoleTail(6)+' (log: '+logFile+')':''));};
 // 1. RPC answers (a node still loading its block index answers with an error until it is done). A login the node refuses
 // (HTTP 401) is skipped and the next candidate is tried; a node the launcher started may still be writing its cookie.
 let last='no answer yet',rpc=null;const refused=new Map();
 for(;;){
  checkExit();
  try{
   const logins=await loginsFor(root);
   if(!logins.length)throw Error('ROD_RPC_NOT_FOUND: no RPC login found. Give the login as one URL, http://user:password@127.0.0.1:'+url.port+' , in OSGSIM_ROD_RPC_URL or on the first line of '+join(root,'OSGSim','rod-rpc-url.txt')+'.');
   const login=logins.find(l=>!refused.has(l.source+'|'+(l.cookie??l.user)));
   if(!login){
    const tried=[...refused.values()].join(', ');
    if(started){refused.clear();throw Object.assign(Error('login refused by ROD Core while it starts ('+tried+')'),{waiting:true});}
    throw Error('ROD_RPC_LOGIN_REFUSED: '+url.origin+' answered HTTP 401 to every login tried ('+tried+'). Give the login as one URL, http://user:password@127.0.0.1:'+url.port+' , in OSGSIM_ROD_RPC_URL or on the first line of '+join(root,'OSGSim','rod-rpc-url.txt')+'.');
   }
   rpc=makeRpc({url:url.origin,...(login.cookie?{cookie:login.cookie}:{user:login.user,password:login.password})});
   try{await rpc('getblockchaininfo',[]);}
   catch(e){if(e.httpStatus===401){refused.set(login.source+'|'+(login.cookie??login.user),login.source);rpc=null;continue;}throw e;}
   log('ROD_RPC_LOGIN '+JSON.stringify({source:login.source,url:url.origin}));
   await remember(root,login);break;
  }catch(e){
   if(!e.waiting&&/^ROD_RPC_(LOGIN_REFUSED|NOT_FOUND)/.test(e.message))throw e;
   last=e.message+(/other side closed|ECONNRESET/.test(e.message)?' - the port accepts connections but does not answer RPC; RPC is the rpcport in spacexpanse.conf (this is '+url.port+')':'');rpc=null;
  }
  if(now()-t0>=timeoutMs)throw Error('ROD_CORE_RPC_NOT_READY after '+Math.round(timeoutMs/1000)+' s: '+last+(logFile?' (log: '+logFile+')':''));
  progress(last);await sleep(pollMs);
 }
 // 2. Mainnet and synchronized: the conditions the game checks. A node that is still catching up keeps syncing
 // in the background; the launcher reports where it stands and stops instead of waiting for it.
 try{
  const info=await requireRodMainnet(rpc,{now:now()});
  log('ROD_CORE_READY '+JSON.stringify({chain:info.chain,blocks:info.blocks,headers:info.headers}));
 }catch(e){
  if(/^ROD_MAINNET_REQUIRED/.test(e.message))throw e;
  const info=await rpc('getblockchaininfo',[]).catch(()=>null);
  throw Error('ROD_CORE_NOT_SYNCHRONIZED: '+e.message+(info?' (blocks '+info.blocks+' of '+info.headers+', '+(info.verificationprogress*100).toFixed(2)+'%)':'')+
   '. ROD Core keeps running and synchronizing; start the launcher again when it has caught up.');
 }
 child?.unref();
 return{started,executable,args};
}

/** Ask once for the RPC URL with its login and keep it in OSGSim/rod-rpc-url.txt (private file, loopback URL only). */
export async function askRpcUrl({root,ask,write=(file,text)=>writeFile(file,text,{mode:0o600})}){
 const text=String(await ask('Enter the ROD RPC URL with its login (http://user:password@127.0.0.1:11999): ')).trim();
 const given=await givenRodRpc({env:{OSGSIM_ROD_RPC_URL:text}});
 if(!given||!given.user||!given.password)throw Error('ROD_RPC_URL_INVALID: the URL needs the login, http://user:password@127.0.0.1:11999');
 const file=join(resolve(root),'OSGSim','rod-rpc-url.txt');await write(file,text+'\n');return file;
}

if(process.argv[1]===fileURLToPath(import.meta.url)){
 const root=process.argv.find(x=>x.startsWith('--root='))?.slice(7)??'.';
 try{
  try{await ensureRodCore({root});}
  catch(e){
   if(!/^ROD_RPC_(LOGIN_REFUSED|NOT_FOUND)/.test(e.message)||!process.stdin.isTTY||process.env.OSGSIM_ROD_RPC_URL)throw e;
   console.log(e.message);
   const rl=createInterface({input:process.stdin,output:process.stdout});
   let file;try{file=await askRpcUrl({root,ask:q=>rl.question(q)});}finally{rl.close();}
   console.log('ROD_RPC_URL_SAVED '+file);
   await ensureRodCore({root});
  }
  process.exit(0);
 }catch(e){console.error(e.message);process.exit(1);}
}
