// SPDX-License-Identifier: MIT
// The launcher starts ROD Core (spacexpansed) itself and reports an address to fund the wallet.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {EventEmitter} from 'node:events';
import {findRodExecutable,rodCoreArgs,ensureRodCore,askRpcUrl,ZMQ_DEFAULT} from '../scripts/start-rod-core.mjs';
import {announceFunding} from '../OSGSim/apps/metaverse-native/v26/single-address/local-runtime.mjs';

const tmp=()=>mkdtemp(join(tmpdir(),'spex-rodcore-'));
const touch=async(file)=>{await mkdir(join(file,'..'),{recursive:true});await writeFile(file,'x');};
const freePort=()=>new Promise(r=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});

test('find: the shallowest spacexpansed under the install folder; Modules and node_modules are skipped; override respected',async()=>{
 const root=await tmp();
 try{
  assert.equal(await findRodExecutable(root,{env:{},platform:'win32'}),null);
  await touch(join(root,'Modules','Server','spacexpansed.exe'));await touch(join(root,'node_modules','x','spacexpansed.exe'));
  assert.equal(await findRodExecutable(root,{env:{},platform:'win32'}),null,'skipped folders');
  await touch(join(root,'rod','bin','SpaceXpansed.EXE'));await touch(join(root,'a','b','c','d','e','spacexpansed.exe'));
  assert.equal(await findRodExecutable(root,{env:{},platform:'win32'}),join(root,'rod','bin','SpaceXpansed.EXE'),'case-insensitive; deeper than 4 levels ignored');
  await touch(join(root,'spacexpansed.exe'));
  assert.equal(await findRodExecutable(root,{env:{},platform:'win32'}),join(root,'spacexpansed.exe'),'shallowest wins');
  assert.equal(await findRodExecutable(root,{env:{},platform:'linux'}),null,'platform-specific name');
  const own=join(root,'elsewhere','rodd.exe');await touch(own);
  assert.equal(await findRodExecutable(root,{env:{OSGSIM_ROD_EXE:own}}),own);
  await assert.rejects(findRodExecutable(root,{env:{OSGSIM_ROD_EXE:join(root,'nope.exe')}}),/OSGSIM_ROD_EXE does not exist/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('args: RPC server and both game ZMQ feeds, unless the node config already sets them (a comment does not count)',async()=>{
 const reads=conf=>({env:{OSGSIM_ROD_DATADIR:'D:/rod'},read:async file=>{assert.match(file,/spacexpanse\.conf$/);if(conf===null)throw Error('ENOENT');return conf;}});
 assert.deepEqual(await rodCoreArgs(reads(null)),['-server=1','-datadir=D:/rod','-rpcport=11999','-zmqpubgameblocks='+ZMQ_DEFAULT,'-zmqpubgamepending='+ZMQ_DEFAULT]);
 assert.deepEqual(await rodCoreArgs(reads('server=1\nzmqpubgameblocks=tcp://127.0.0.1:1\nzmqpubgamepending = tcp://127.0.0.1:1\n')),['-server=1','-datadir=D:/rod','-rpcport=11999']);
 assert.deepEqual(await rodCoreArgs(reads('rpcport=11999\nzmqpubgameblocks=tcp://127.0.0.1:1\nzmqpubgamepending=tcp://127.0.0.1:1\n')),['-server=1','-datadir=D:/rod'],'the conf rpcport is kept');
 assert.deepEqual(await rodCoreArgs(reads('[test]\nrpcport=18399\nzmqpubgameblocks=tcp://127.0.0.1:1\n')),['-server=1','-datadir=D:/rod','-rpcport=11999','-zmqpubgameblocks='+ZMQ_DEFAULT,'-zmqpubgamepending='+ZMQ_DEFAULT],'other networks\' sections are ignored');
 assert.deepEqual(await rodCoreArgs(reads('zmqpubgameblocks=tcp://127.0.0.1:1\n#zmqpubgamepending=tcp://x\n')),['-server=1','-datadir=D:/rod','-rpcport=11999','-zmqpubgamepending='+ZMQ_DEFAULT]);
 assert.deepEqual(await rodCoreArgs({env:{OSGSIM_ROD_DATADIR:'x',OSGSIM_ROD_ZMQ_ADDRESS:'tcp://127.0.0.1:9'},read:async()=>''}),['-server=1','-datadir=x','-rpcport=11999','-zmqpubgameblocks=tcp://127.0.0.1:9','-zmqpubgamepending=tcp://127.0.0.1:9']);
});

const fakeChild=()=>Object.assign(new EventEmitter(),{unref(){this.unrefed=true;}});
const NOW=1_800_000_000_000;
const clock=()=>{const c={t:NOW};c.now=()=>c.t;c.sleep=async ms=>{c.t+=ms;await new Promise(r=>setImmediate(r));};return c;};
// A fake ROD Core whose answers depend on the fake clock: warming up, then synchronizing, then ready.
const node=(c,{warmUntil=0,readyAt=0,chain='main',peers=8}={})=>()=>async method=>{
 if(method==='getnetworkinfo')return{connections:peers,networkactive:true};
 if(c.t<warmUntil)throw Object.assign(Error('ROD getblockchaininfo: Loading block index...'),{code:-28});
 const synced=c.t>=readyAt;
 return{chain,blocks:synced?100:40,headers:100,verificationprogress:synced?1:0.4,initialblockdownload:!synced,mediantime:Math.floor(c.t/1000)};
};
const base=(c,extra={})=>({log:()=>{},now:c.now,sleep:c.sleep,loginsFor:async()=>[{source:'test',cookie:'cookie'}],remember:async()=>{},...extra});

test('start: a ROD Core that already answers on the RPC port is used as it is (no second start)',async()=>{
 const root=await tmp(),c=clock();
 try{
  let spawned=0;const logs=[];
  const r=await ensureRodCore({root,...base(c,{log:x=>logs.push(x)}),listening:async()=>true,spawnProcess:()=>{spawned++;},makeRpc:node(c)});
  assert.equal(r.started,false);assert.equal(spawned,0);assert.ok(logs.some(x=>/ALREADY_LISTENING/.test(x)));assert.ok(logs.some(x=>/ROD_CORE_READY/.test(x)));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('start: spawns the executable from the folder, prints progress while the node warms up, and returns when RPC is ready',async()=>{
 const root=await tmp(),c=clock();
 try{
  const calls=[],logs=[],child=fakeChild();
  const r=await ensureRodCore({root,env:{},...base(c,{log:x=>logs.push(x)}),listening:async()=>false,find:async()=>'F:/rod/spacexpansed.exe',
   spawnProcess:(exe,args,opts)=>{calls.push([exe,args,opts]);return child;},makeRpc:node(c,{warmUntil:NOW+35000})});
  assert.equal(r.started,true);assert.equal(calls.length,1);
  assert.equal(calls[0][0],'F:/rod/spacexpansed.exe');assert.ok(calls[0][1].includes('-server=1')&&calls[0][1].some(a=>a.startsWith('-zmqpubgameblocks=')));
  assert.equal(calls[0][2].detached,true);assert.equal(calls[0][2].windowsHide,true);assert.equal(child.unrefed,true,'the node outlives the launcher');
  const waiting=logs.filter(x=>/ROD_CORE_WAITING/.test(x));
  assert.ok(waiting.length>=3&&waiting.every(x=>/Loading block index/.test(x)),'a status line about every 10 s, not silence: '+logs.join('\n'));
 }finally{await rm(root,{recursive:true,force:true});}
});

test('start: a node that is still synchronizing stops the launch at once with where it stands; it is not waited for',async()=>{
 const root=await tmp(),c=clock();
 try{
  await assert.rejects(ensureRodCore({root,...base(c),listening:async()=>true,makeRpc:node(c,{readyAt:NOW+3600000})}),
   /ROD_CORE_NOT_SYNCHRONIZED: ROD_MAINNET_STILL_SYNCHRONIZING \(blocks 40 of 100, 40\.00%\).*keeps running/);
  assert.ok(c.t-NOW<5000,'no waiting for the synchronization');
  await assert.rejects(ensureRodCore({root,...base(c),listening:async()=>true,makeRpc:node(c,{peers:0})}),/ROD_CORE_NOT_SYNCHRONIZED.*NO_PEERS/);
  await assert.rejects(ensureRodCore({root,...base(c),listening:async()=>true,makeRpc:node(c,{chain:'test'})}),/ROD_MAINNET_REQUIRED/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('start: failures say why — no executable, early exit (with the console tail), RPC never ready, autostart off',async()=>{
 const root=await tmp(),c=clock();
 try{
  const b=base(c,{listening:async()=>false});
  await assert.rejects(ensureRodCore({root,env:{},...b,find:async()=>null}),/ROD_CORE_EXECUTABLE_NOT_FOUND.*OSGSIM_ROD_EXE/);
  await assert.rejects(ensureRodCore({root,env:{OSGSIM_ROD_AUTOSTART:'0'},...b}),/ROD_CORE_NOT_RUNNING.*AUTOSTART=0/);
  const logFile=join(root,'OSGSim','.data','rod-core','console.log');
  await mkdir(join(logFile,'..'),{recursive:true});await writeFile(logFile,'Error: Cannot obtain a lock on data directory\n');
  const dying=fakeChild();
  await assert.rejects(ensureRodCore({root,env:{},...b,find:async()=>'x',makeRpc:()=>async()=>{throw Error('fetch failed');},
   spawnProcess:()=>{setImmediate(()=>dying.emit('exit',1,null));return dying;}}),/EXITED_DURING_START.*"code":1.*Cannot obtain a lock/);
  await assert.rejects(ensureRodCore({root,env:{},...b,find:async()=>'x',makeRpc:()=>async()=>{throw Error('fetch failed');},spawnProcess:()=>fakeChild()}),/RPC_NOT_READY after 600 s: fetch failed/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('start (real process): a spacexpansed in the folder is launched with the right arguments and the launcher waits for its RPC',async(t)=>{
 if(process.platform==='win32'){t.skip('uses a shell-script style fake daemon');return;}
 const root=await tmp(),port=await freePort();
 try{
  const daemon=join(root,'rod','spacexpansed');await mkdir(join(root,'rod'),{recursive:true});
  await writeFile(daemon,`#!/usr/bin/env node
const fs=require('fs'),http=require('http');
fs.writeFileSync(${JSON.stringify(join(root,'argv.json'))},JSON.stringify(process.argv.slice(2)));
let n=0;
http.createServer((q,r)=>{let body='';q.on('data',d=>body+=d);q.on('end',()=>{const m=JSON.parse(body).method;r.setHeader('content-type','application/json');
 if(m==='getnetworkinfo')return r.end(JSON.stringify({result:{connections:3,networkactive:true},error:null,id:'x'}));
 if(n++<2)return r.end(JSON.stringify({result:null,error:{code:-28,message:'Loading block index...'},id:'x'}));
 r.end(JSON.stringify({result:{chain:'main',blocks:9,headers:9,verificationprogress:1,initialblockdownload:false,mediantime:Math.floor(Date.now()/1000)},error:null,id:'x'}));});}).listen(${port},'127.0.0.1',()=>fs.writeFileSync(${JSON.stringify(join(root,'pid'))},String(process.pid)));
`);
  await chmod(daemon,0o755);
  const logs=[],opts={root,env:{},platform:'linux',log:x=>logs.push(x),pollMs:50,rpcUrl:'http://127.0.0.1:'+port,loginsFor:async()=>[{source:'test',cookie:join(root,'cookie')}],remember:async()=>{}};
  await writeFile(join(root,'cookie'),'__cookie__:pw');
  try{
   const r=await ensureRodCore(opts);
   assert.equal(r.started,true);assert.equal(r.executable,daemon);
   assert.deepEqual(JSON.parse(await readFile(join(root,'argv.json'),'utf8')),r.args);
   assert.ok(r.args.includes('-server=1')&&r.args.includes('-zmqpubgamepending='+ZMQ_DEFAULT));
   assert.ok(logs.some(x=>/ROD_CORE_READY.*"blocks":9/.test(x)),logs.join('\n'));
   const again=await ensureRodCore({...opts,log:()=>{}});
   assert.equal(again.started,false,'a second launch finds the running node and does not start another');
  }finally{try{process.kill(Number(await readFile(join(root,'pid'),'utf8')));}catch{/* already gone */}}
 }finally{await rm(root,{recursive:true,force:true});}
});

test('funding address: created once as a legacy address, remembered, re-created for another wallet or when not owned',async()=>{
 const root=await tmp();
 try{
  const created=[];let owned=true;const events=[];
  const rpc=async(m,a)=>{switch(m){
   case 'getnewaddress':created.push(a);return 'R'+'a'.repeat(30+created.length);
   case 'getaddressinfo':return{ismine:owned};
   case 'getbalances':return{mine:{trusted:1.5,untrusted_pending:0.25}};
   default:throw Error('unexpected '+m);}};
  const run=(wallet,r=rpc)=>announceFunding({rpc:r,wallet,root,onStatus:(k,v)=>events.push([k,v])});
  const first=await run('spex-auto-player');
  assert.deepEqual(created,[['spexgsp-funding','legacy']]);assert.deepEqual(first.balance,{confirmed:1.5,pending:0.25});
  assert.equal(events.at(-1)[0],'FUNDING_ADDRESS');assert.equal(events.at(-1)[1].address,first.address);
  assert.equal((await run('spex-auto-player')).address,first.address);assert.equal(created.length,1,'remembered');
  assert.notEqual((await run('other-wallet')).address,first.address);assert.equal(created.length,2,'a different wallet gets its own address');
  owned=false;await run('other-wallet');assert.equal(created.length,3,'an address the wallet no longer owns is replaced');
  owned=true;const fallback=await run('other-wallet',async(m,a)=>{if(m==='getbalances')throw Error('unknown method');if(m==='getbalance')return 2;return rpc(m,a);});
  assert.deepEqual(fallback.balance,{confirmed:2,pending:null},'older nodes: getbalance');
  assert.match(await readFile(join(root,'OSGSim','.data','spexgsp-rod','funding-address.json'),'utf8'),/other-wallet/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('diagnostics: a refused or reset connection names its system error; an already running node shows its console log',async()=>{
 const {rpcClient}=await import('../OSGSim/apps/metaverse-native/v26/rpc-adapter.mjs');
 const dead=await freePort();
 await assert.rejects(rpcClient({url:'http://127.0.0.1:'+dead,user:'u',password:'p'})('getblockchaininfo'),/ROD RPC getblockchaininfo not answered: ECONNREFUSED/);
 const server=createServer(socket=>socket.destroy());await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  await assert.rejects(rpcClient({url:'http://127.0.0.1:'+server.address().port,user:'u',password:'p'})('x'),/not answered: (?!fetch failed)\S+/);
 }finally{server.close();}
 const root=await tmp(),c=clock(),lines=[];
 try{
  const logFile=join(root,'OSGSim','.data','rod-core','console.log');
  await mkdir(join(logFile,'..'),{recursive:true});await writeFile(logFile,'old line\nLoading block index... 41%\n');
  await assert.rejects(ensureRodCore({root,env:{OSGSIM_ROD_START_TIMEOUT_MS:'25000'},...base(c,{listening:async()=>true,log:l=>lines.push(l)}),timeoutMs:25000,progressMs:10000,
   makeRpc:()=>async()=>{throw Error('ROD RPC getblockchaininfo not answered: ECONNRESET');}}),/RPC_NOT_READY/);
  const waiting=lines.filter(l=>l.startsWith('ROD_CORE_WAITING'));
  assert.ok(waiting.length>=2);assert.match(waiting[0],/ECONNRESET/);assert.match(waiting[0],/Loading block index... 41%/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('ROD Core is addressed on the conf rpcport (the P2P port 11998 is never used for RPC), with the conf login',async()=>{
 const root=await tmp(),c=clock(),seen=[],lines=[];
 try{
  const datadir=join(root,'rod');await mkdir(datadir,{recursive:true});
  await writeFile(join(datadir,'spacexpanse.conf'),'server=1\nrpcuser=xuser1\nrpcpassword=xpass1\nrpcport=11999\nport=11998\n');
  const env={OSGSIM_ROD_DATADIR:datadir};
  const result=await ensureRodCore({root,env,...base(c,{listening:async(host,port)=>{seen.push(port);return true;},log:l=>lines.push(l),loginsFor:undefined,remember:undefined}),
   makeRpc:({url,user,password})=>async method=>{
    seen.push(url);if(method==='getnetworkinfo')return{connections:8,networkactive:true};assert.equal(user+':'+password,'xuser1:xpass1');
    return{chain:'main',blocks:100,headers:100,verificationprogress:1,mediantime:Math.floor(c.now()/1000),initialblockdownload:false};}});
  assert.deepEqual(seen.slice(0,2),[11999,'http://127.0.0.1:11999']);assert.equal(result.started,false);
  // a listener that closes the connection (a P2P port) is explained
  const lines2=[];
  await assert.rejects(ensureRodCore({root,env,...base(c,{listening:async()=>true,log:l=>lines2.push(l),loginsFor:undefined,remember:undefined}),timeoutMs:12000,progressMs:1000,
   makeRpc:()=>async()=>{throw Error('ROD RPC getblockchaininfo not answered: UND_ERR_SOCKET (other side closed)');}}),/RPC_NOT_READY.*rpcport in spacexpanse\.conf/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a refused RPC login (HTTP 401, empty body) is reported as such and stops the wait; an empty 200 is not RPC',async()=>{
 const {createServer:http}=await import('node:http');
 const {rpcClient}=await import('../OSGSim/apps/metaverse-native/v26/rpc-adapter.mjs');
 let status=401;
 const server=http((req,res)=>{res.writeHead(status);res.end();});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url='http://127.0.0.1:'+server.address().port;
 try{
  const err=await rpcClient({url,user:'u',password:'p'})('getblockchaininfo').catch(e=>e);
  assert.match(err.message,/HTTP 401.*login was refused/);assert.equal(err.httpStatus,401);
  status=200;await assert.rejects(rpcClient({url,user:'u',password:'p'})('getblockchaininfo'),/empty or invalid answer.*not the RPC port/);
 }finally{server.close();}
 const root=await tmp(),c=clock();
 try{
  const started=Date.now();
  await assert.rejects(ensureRodCore({root,env:{},...base(c,{listening:async()=>true}),timeoutMs:600000,
   makeRpc:()=>async()=>{throw Object.assign(Error('ROD RPC HTTP 401'),{httpStatus:401});}}),/ROD_RPC_LOGIN_REFUSED.*rod-rpc-url\.txt/);
  assert.ok(Date.now()-started<2000,'no waiting');
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a spacexpanse.conf next to the program is found (Modules, node_modules, tests are skipped) and names the data directory',async()=>{
 const {installedConfDirs,defaultRodRpc}=await import('../OSGSim/apps/metaverse-native/v26/single-address/local-runtime.mjs');
 const root=await tmp();
 try{
  await mkdir(join(root,'node_modules','x'),{recursive:true});await writeFile(join(root,'node_modules','x','spacexpanse.conf'),'rpcport=1\n');
  await mkdir(join(root,'tests'),{recursive:true});await writeFile(join(root,'tests','spacexpanse.conf'),'rpcport=2\n');
  assert.deepEqual(await installedConfDirs(root),[]);
  const data=join(root,'rod-data');await mkdir(data,{recursive:true});
  await writeFile(join(data,'spacexpanse.conf'),'rpcuser=xuser1\nrpcpassword=xpass1\nrpcport=11999\nport=11998\n');
  assert.deepEqual(await installedConfDirs(root),[data]);
  const found=await defaultRodRpc(root,{env:{},write:async()=>{}});
  assert.equal(found.url,'http://127.0.0.1:11999');assert.match(found.cookie,/conf-rpc\.auth$/);
  assert.deepEqual(await rodCoreArgs({root,env:{},read:async f=>(await readFile(f,'utf8'))}),
   ['-server=1','-datadir='+data,'-zmqpubgameblocks='+ZMQ_DEFAULT,'-zmqpubgamepending='+ZMQ_DEFAULT]);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('a refused login: the URL is asked for once and kept in rod-rpc-url.txt; a URL without a login is refused; a missing login on a running node stops at once',async()=>{
 const root=await tmp(),c=clock(),saved=[];
 try{
  const file=await askRpcUrl({root,ask:async q=>{assert.match(q,/ROD RPC URL/);return'  http://xuser1:xpass1@127.0.0.1:11999 \n';},write:async(f,t)=>saved.push([f,t])});
  assert.equal(file,join(root,'OSGSim','rod-rpc-url.txt'));assert.deepEqual(saved,[[file,'http://xuser1:xpass1@127.0.0.1:11999\n']]);
  await assert.rejects(askRpcUrl({root,ask:async()=>'http://127.0.0.1:11999',write:async()=>{}}),/needs the login/);
  await assert.rejects(askRpcUrl({root,ask:async()=>'http://a:b@example.com:11999',write:async()=>{}}),/LOOPBACK/);
  const started=Date.now();
  await assert.rejects(ensureRodCore({root,env:{},...base(c,{listening:async()=>true}),timeoutMs:600000,
   loginsFor:async()=>[{source:'a',user:'x',password:'y'}],makeRpc:()=>async()=>{throw Object.assign(Error('401'),{httpStatus:401});}}),/ROD_RPC_LOGIN_REFUSED.*\(a\)/);
  assert.ok(Date.now()-started<2000);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('login candidates: a refused login is skipped, the first one ROD accepts is used and remembered; no password is built in',async()=>{
 const {rodLoginCandidates,rememberRodLogin,defaultRodRpc}=await import('../OSGSim/apps/metaverse-native/v26/single-address/local-runtime.mjs');
 const root=await tmp(),c=clock(),tried=[],kept=[];
 try{
  const result=await ensureRodCore({root,env:{},...base(c,{listening:async()=>true}),
   loginsFor:async()=>[{source:'old cookie',cookie:'/stale'},{source:'conf',user:'a',password:'b'},{source:'conf2',user:'xuser1',password:'xpass1'}],
   remember:async(dir,login)=>kept.push(login.source),
   makeRpc:({cookie,user,password})=>async method=>{
    if(method==='getnetworkinfo')return{connections:8,networkactive:true};
    tried.push(cookie??user+':'+password);
    if(cookie==='/stale'||user==='a'){throw Object.assign(Error('ROD RPC HTTP 401'),{httpStatus:401});}
    return{chain:'main',blocks:100,headers:100,verificationprogress:1,mediantime:Math.floor(c.now()/1000),initialblockdownload:false};}});
  assert.equal(result.started,false);assert.deepEqual(kept,['conf2']);
  assert.deepEqual(tried.slice(0,3),['/stale','a:b','xuser1:xpass1']);
  // nothing found: no built-in login, ROD_RPC_NOT_FOUND
  await assert.rejects(defaultRodRpc(root,{env:{},exists:async()=>false,read:async()=>{throw Error('none');}}),/ROD_RPC_NOT_FOUND/);
  await assert.rejects(ensureRodCore({root,env:{},...base(c,{listening:async()=>true}),loginsFor:async()=>[]}),/ROD_RPC_NOT_FOUND/);
  const data=join(root,'OSGSim','.data','spexgsp-rod');await mkdir(data,{recursive:true});await writeFile(join(data,'local-rpc.auth'),'old:old\n');
  const found=await rodLoginCandidates(root,{env:{}});
  assert.deepEqual(found.logins.map(l=>l.source),['local-rpc.auth']);assert.equal(found.url,'http://127.0.0.1:11999');
  // the remembered login comes first for every later step
  await rememberRodLogin(root,{source:'conf2',user:'xuser1',password:'xpass1'});
  assert.equal(await readFile(join(data,'working-rpc.auth'),'utf8'),'xuser1:xpass1\n');
  assert.equal((await rodLoginCandidates(root,{env:{}})).logins[0].source,'last working login');
  assert.equal((await defaultRodRpc(root,{env:{}})).cookie,join(data,'working-rpc.auth'));
  // a cookie is stored as its current content (a node restart changes it)
  await writeFile(join(root,'ck'),'__cookie__:abc\n');await rememberRodLogin(root,{cookie:join(root,'ck')});
  assert.equal(await readFile(join(data,'working-rpc.auth'),'utf8'),'__cookie__:abc\n');
 }finally{await rm(root,{recursive:true,force:true});}
});
