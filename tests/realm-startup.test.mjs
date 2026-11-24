// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {genesisWorldId} from '../OSGSim/apps/metaverse-native/v26/single-address/realm-init.mjs';
import {acquireLocalRunLock,defaultRodRpc,ROD_MAINNET_RPC_PORT} from '../OSGSim/apps/metaverse-native/v26/single-address/local-runtime.mjs';
const g='3'.repeat(64),a='4'.repeat(64),n='5'.repeat(64);

test('The same immutable genesis does not depend on relay IP or current native process',()=>{
 const one=genesisWorldId({realmId:'moon/default',rodGenesis:g,assetRoot:a,genesisNonce:n});
 assert.equal(one,genesisWorldId({realmId:'moon/default',rodGenesis:g,assetRoot:a,genesisNonce:n}));
 assert.notEqual(one,genesisWorldId({realmId:'moon/default',rodGenesis:g,assetRoot:a,genesisNonce:'6'.repeat(64)}));
});

test('Only one peer can control a Metaverse installation; the lock is released after it stops',async()=>{
 const root=await mkdtemp(join(tmpdir(),'spex-lock-'));
 try{
  const first=await acquireLocalRunLock(root);
  await assert.rejects(acquireLocalRunLock(root),/SPEXGSP_PEER_ALREADY_(RUNNING|STARTING)/);
  await first.release();const second=await acquireLocalRunLock(root);await second.release();
 }finally{await rm(root,{recursive:true,force:true})}
});

test('A lock written before this boot is reclaimed even if its PID now belongs to a live process',async()=>{
 const root=await mkdtemp(join(tmpdir(),'spex-lock-'));
 try{
  const {hostname}=await import('node:os');
  const file=join(root,'OSGSim','.data','spexgsp-single-address','peer.lock');await mkdir(join(file,'..'),{recursive:true});
  // PID 1 is always alive; the lock is from long before boot.
  await writeFile(file,JSON.stringify({schema:1,pid:1,host:hostname(),nonce:'x',startedUtc:1})+'\n');
  const {utimes}=await import('node:fs/promises');await utimes(file,new Date(Date.now()-60000),new Date(Date.now()-60000));
  const lock=await acquireLocalRunLock(root);await lock.release();
 }finally{await rm(root,{recursive:true,force:true})}
});

test('ROD RPC: a URL with its login, else spacexpanse.conf (11999 when it sets no rpcport)',async()=>{
 assert.equal(ROD_MAINNET_RPC_PORT,11999);
 const root='/install',seen=[],noConf=async()=>{throw Object.assign(Error('ENOENT'),{code:'ENOENT'});};
 const exists=async f=>{seen.push(f);return f.endsWith('/AppData/SpaceXpanse/.cookie');};
 const out=await defaultRodRpc(root,{env:{APPDATA:'/AppData',USERPROFILE:'/home/u'},exists,read:noConf});
 assert.deepEqual(out,{url:'http://127.0.0.1:11999',cookie:'/AppData/SpaceXpanse/.cookie'});
 assert.ok(seen[0].endsWith('working-rpc.auth'),'the login that worked at the last start is tried first');
 const custom=await defaultRodRpc(root,{env:{OSGSIM_ROD_RPC_COOKIE:'/c'},exists:async f=>f==='/c',read:noConf});
 assert.equal(custom.url,`http://127.0.0.1:${ROD_MAINNET_RPC_PORT}`);
 assert.equal(custom.cookie,'/c','the cookie location can be set');
 await assert.rejects(defaultRodRpc(root,{env:{},exists:async()=>false,read:noConf}),/ROD_RPC_NOT_FOUND/);
 // A node with rpcuser/rpcpassword creates no .cookie: the login is taken from the config file.
 const conf='server=1\nrpcuser=xuser1\nrpcpassword=xpass1\nrpcbind=127.0.0.1\nrpcport=11999\nport=11998\n[test]\nrpcuser=user1\nrpcpassword=pass1\nrpcport=18399\n[regtest]\nrpcport=18443\n';
 const written=[];
 const fromConf=await defaultRodRpc(root,{env:{APPDATA:'/AppData'},exists:async()=>false,read:async f=>{if(!/spacexpanse\.conf$/.test(f))throw Object.assign(Error('ENOENT'),{code:'ENOENT'});assert.match(f,/SpaceXpanse[\\/]spacexpanse\.conf$/);return conf;},write:async(f,t)=>written.push([f,t])});
 assert.equal(fromConf.url,'http://127.0.0.1:11999');assert.match(fromConf.cookie,/conf-rpc\.auth$/);
 assert.deepEqual(written,[[fromConf.cookie,'xuser1:xpass1\n']],'main section only, never the [test] login');
 const other=await defaultRodRpc(root,{env:{APPDATA:'/AppData'},exists:async()=>false,read:async f=>{if(!/spacexpanse\.conf$/.test(f))throw Object.assign(Error('ENOENT'),{code:'ENOENT'});return'rpcport=12345\nrpcuser=a\nrpcpassword=b\n';},write:async()=>{}});
 assert.equal(other.url,'http://127.0.0.1:12345');
 await assert.rejects(defaultRodRpc(root,{env:{APPDATA:'/AppData'},exists:async()=>false,read:async f=>{if(!/spacexpanse\.conf$/.test(f))throw Object.assign(Error('ENOENT'),{code:'ENOENT'});return'rpcport=abc\n';}}),/INVALID_RPCPORT/);
});

test('ROD RPC: http://user:password@127.0.0.1:port from OSGSIM_ROD_RPC_URL or OSGSim/rod-rpc-url.txt carries the port and the login',async()=>{
 const {givenRodRpc,rodRpcUrl}=await import('../OSGSim/apps/metaverse-native/v26/single-address/local-runtime.mjs');
 const root='/install',written=[],noFile=async()=>{throw Object.assign(Error('ENOENT'),{code:'ENOENT'});};
 const viaEnv=await defaultRodRpc(root,{env:{OSGSIM_ROD_RPC_URL:'http://xuser1:xpass1@127.0.0.1:11999'},exists:async()=>false,read:noFile,write:async(f,t)=>written.push([f,t])});
 assert.equal(viaEnv.url,'http://127.0.0.1:11999');assert.match(viaEnv.cookie,/conf-rpc\.auth$/);assert.deepEqual(written,[[viaEnv.cookie,'xuser1:xpass1\n']]);
 assert.ok(!JSON.stringify(viaEnv).includes('xpass1'),'the password is not part of the returned settings');
 const viaFile=await defaultRodRpc(root,{env:{},exists:async()=>false,read:async f=>{assert.match(f,/rod-rpc-url\.txt$/);return'http://u%40x:p%3Aw@localhost:12000\r\nsecond line ignored\n';},write:async(f,t)=>written.push([f,t])});
 assert.equal(viaFile.url,'http://localhost:12000');assert.equal(written.at(-1)[1],'u@x:p:w\n','percent-encoding is decoded');
 assert.equal(await rodRpcUrl({env:{OSGSIM_ROD_RPC_URL:'http://a:b@127.0.0.1:12345'},root}),'http://127.0.0.1:12345');
 assert.equal((await givenRodRpc({env:{},root:null})),null);
 await assert.rejects(givenRodRpc({env:{OSGSIM_ROD_RPC_URL:'http://a:b@example.com:11999'}}),/MUST_REMAIN_LOOPBACK/);
 await assert.rejects(givenRodRpc({env:{OSGSIM_ROD_RPC_URL:'https://a:b@127.0.0.1:11999'}}),/MUST_REMAIN_LOOPBACK/);
 await assert.rejects(givenRodRpc({env:{OSGSIM_ROD_RPC_URL:'not a url'}}),/ROD_RPC_URL_INVALID/);
 await assert.rejects(givenRodRpc({env:{OSGSIM_ROD_RPC_URL:'http://a:b@127.0.0.1:99999'}}),/ROD_RPC_URL_INVALID/);
});

test('ROD RPC URL with /wallet/<name>: that wallet is used, replacing an earlier automatic pin; no wallet is created',async()=>{
 const {givenRodRpc,discoverLocalRpc}=await import('../OSGSim/apps/metaverse-native/v26/single-address/local-runtime.mjs');
 assert.equal((await givenRodRpc({env:{OSGSIM_ROD_RPC_URL:'http://xuser1:xpass1@127.0.0.1:11999/wallet/game1'}})).wallet,'game1');
 assert.equal((await givenRodRpc({env:{OSGSIM_ROD_RPC_URL:'http://xuser1:xpass1@127.0.0.1:11999'}})).wallet,null);
 await assert.rejects(givenRodRpc({env:{OSGSIM_ROD_RPC_URL:'http://a:b@127.0.0.1:11999/wallet/a%2Fb'}}),/INVALID_WALLET/);
 await assert.rejects(givenRodRpc({env:{OSGSIM_ROD_RPC_URL:'http://a:b@127.0.0.1:11999/other'}}),/ROD_RPC_URL_INVALID/);
 const root=await mkdtemp(join(tmpdir(),'rodwallet-'));
 try{
  await mkdir(join(root,'OSGSim','.data','spexgsp-single-address'),{recursive:true});
  await writeFile(join(root,'OSGSim','rod-rpc-url.txt'),'http://xuser1:xpass1@127.0.0.1:11999/wallet/game1\n');
  await writeFile(join(root,'OSGSim','.data','spexgsp-single-address','wallet-profile.json'),JSON.stringify({schema:1,wallet:'spex-auto-player'}));
  const calls=[];let loaded=['game1','spex-auto-player'];
  const rpcClient=({url})=>async method=>{
   calls.push([new URL(url).pathname,method]);
   if(method==='getblockchaininfo')return{chain:'main',blocks:100,headers:100,verificationprogress:1,mediantime:Math.floor(Date.now()/1000),initialblockdownload:false};
   if(method==='getnetworkinfo')return{connections:8,networkactive:true};
   if(method==='listwallets')return loaded;
   if(method==='getwalletinfo')return{walletname:'game1'};
   throw Error('unexpected '+method);};
  const found=await discoverLocalRpc(root,{rpcClient});
  assert.equal(found.wallet,'game1');assert.equal(new URL(found.config.url).pathname,'/wallet/game1');
  assert.ok(!calls.some(([,m])=>m==='createwallet'));
  const {readFile}=await import('node:fs/promises');
  assert.equal(JSON.parse(await readFile(join(root,'OSGSim','.data','spexgsp-single-address','wallet-profile.json'),'utf8')).wallet,'game1','the pin follows the URL');
  // a wallet that is not loaded is loaded; one that does not exist is an error, never created
  loaded=['spex-auto-player'];const loads=[];
  const loading=({url})=>async method=>{if(method==='loadwallet'){loads.push(1);return{name:'game1'};}return rpcClient({url})(method);};
  assert.equal((await discoverLocalRpc(root,{rpcClient:loading})).wallet,'game1');assert.equal(loads.length,1);
  const missing=({url})=>async(method,p)=>{if(method==='loadwallet')throw Error('Wallet file not found');if(method==='createwallet')throw Error('must not be called');return rpcClient({url})(method,p);};
  loaded=['spex-auto-player'];
  await assert.rejects(discoverLocalRpc(root,{rpcClient:missing}),/REQUESTED_ROD_WALLET_NOT_AVAILABLE: game1/);
 }finally{await rm(root,{recursive:true,force:true});}
});
