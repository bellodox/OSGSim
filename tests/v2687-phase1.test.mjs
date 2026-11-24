// SPDX-License-Identifier: MIT
// v26.8.7 phase 1: salted names, publisher refusal handling, plausibility, join depth data, history batching.
import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {createHash} from 'node:crypto';
import {ensureRodPlayerName,playerNameForWorld} from '../OSGSim/apps/metaverse-native/v26/rod-game/player-identity.mjs';
import {buildMove,assembleProjection,frameImplausible,PLAUSIBILITY_V1} from '../OSGSim/apps/metaverse-native/v26/rod-game/protocol.mjs';
import {isDefiniteRpcRefusal,retryDelayMs} from '../OSGSim/apps/metaverse-native/v26/rod-game/rpc-errors.mjs';
const W='a'.repeat(64),KEY='b'.repeat(64),GAME='osgsimv26',H='c'.repeat(64);
const ADDR_A='rFJtzkbeQ3dxWQg9G82LHMsPvrhSLMarJU',ADDR_B='rDU1rhqDwG2arMnnGdEobtpGr4aMASKfXw';
const clock={schema:1,utcOriginMs:1700000000000,simMjd0:51982.1301160012,rate:1,era:1};
const port={portId:'moon:brighton-beach',base:'Brighton Beach',configSha256:'1'.repeat(64),body:'Moon',allowedClasses:['ShuttlePB'],slots:[{slot:'pad-1',nativePadIndex:0,rotDegrees:90},{slot:'pad-2',nativePadIndex:1,rotDegrees:180}]};

// Minimal wallet: one anchor address per wallet, deterministic per-wallet signatures.
const wallet=(secret,address)=>{const st={labels:new Map(),calls:[],registered:null,pending:[]};
 const sign=(a,m)=>Buffer.from(secret+'|'+a+'|'+m).toString('base64');
 const rpc=async(method,args=[])=>{st.calls.push(method+(method==='getnewaddress'&&args[0]?':labelled':''));switch(method){
  case 'getaddressesbylabel':{if(!st.labels.has(args[0]))throw Object.assign(Error('no label'),{code:-11});return{[st.labels.get(args[0])]:{purpose:'receive'}}}
  case 'getnewaddress':{if(args[0])st.labels.set(args[0],address);return address}
  case 'getaddressinfo':return{ismine:args[0]===address};
  case 'signmessage':return sign(args[0],args[1]);
  case 'verifymessage':return args[1]===sign(args[0],args[2]);
  case 'name_show':if(!st.registered)throw Error('name not found');return st.registered;
  case 'name_pending':return st.pending;
  case 'getblockhash':return H;case 'getblock':return null;
  case 'name_register':st.pending=[{name:args[0],value:args[1],address,txid:H}];st.registered=null;st.registerCount=(st.registerCount??0)+1;return H;
  default:throw Error('unexpected '+method)}};
 return{st,rpc}};
const tmp=async()=>mkdtemp(join(tmpdir(),'v2687-'));

test('salted player names: same wallet is stable, other wallets and name-squatters cannot predict it',async()=>{
 const dir=await tmp();try{
  const a=wallet('walletA',ADDR_A),b=wallet('walletB',ADDR_B);
  const run=(w,d)=>ensureRodPlayerName({rpc:w.rpc,worldId:W,nostrPubkey:KEY,journalFile:join(d,'player.json'),allowRegistration:true,timeoutMs:30,pollMs:5}).catch(e=>e);
  const first=await run(a,dir);assert.match(String(first.message),/WAITING_FOR_CONFIRMATION/);
  const journal=JSON.parse(await readFile(join(dir,'player.json'),'utf8'));
  assert.notEqual(journal.name,playerNameForWorld(W,KEY),'the salted name must differ from the public unsalted name');
  assert.equal(journal.anchor,ADDR_A);
  const dir2=await tmp();const second=await run(b,dir2);assert.match(String(second.message),/WAITING_FOR_CONFIRMATION/);
  const journalB=JSON.parse(await readFile(join(dir2,'player.json'),'utf8'));
  assert.notEqual(journalB.name,journal.name,'a different wallet with the same Nostr key gets a different name');
  // Recovery after losing the journal: same wallet re-derives the same name.
  const dir3=await tmp();await run(a,dir3);
  assert.equal(JSON.parse(await readFile(join(dir3,'player.json'),'utf8')).name,journal.name);
  assert.equal(a.st.calls.filter(c=>c==='getnewaddress:labelled').length,1,'anchor address created once and then found by label');
  await rm(dir2,{recursive:true,force:true});await rm(dir3,{recursive:true,force:true});
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('RPC refusal classification and backoff schedule',()=>{
 for(const code of [-4,-6,-13,-26])assert.equal(isDefiniteRpcRefusal({code}),true);
 for(const code of [undefined,-28.5,-1,-9,0])assert.equal(isDefiniteRpcRefusal({code}),false);
 assert.equal(isDefiniteRpcRefusal(new Error('timeout')),false);
 assert.deepEqual([1,2,3,4,5,6,7].map(retryDelayMs),[2000,4000,8000,16000,32000,60000,60000]);
});

const joinMove=(player,owner,previous='0'.repeat(64),seq=1)=>buildMove({world:W,game:GAME,player,seq,previous,kind:'join',payload:{owner,asset:W,clockEra:1}});
const sampleOf=(entityName,sequence,simMjd,position,velocity,runId='native-1')=>({type:'PHYSICS_SAMPLE',source:'native',entityName,runId,sequence,simMjd,frameId:'metaverse-moon-relative-v26',mode:'FREEFLIGHT',surface:[0,0,0,0],position,velocity,orientation:[0,0,0,1],capturedAtUnixMs:clock.utcOriginMs});
const rows=(moves,heights=[])=>moves.map((move,i)=>({txid:createHash('sha256').update('tx'+i+move.digest).digest('hex'),height:heights[i]??10+i,blockTime:null,address:move.payload.owner??ADDR_A,move,confirmed:true}));
const setup=()=>{
 const j=joinMove('p/alice',ADDR_A);
 const projection=assembleProjection({world:W,game:GAME,confirmed:rows([j]),port,clock});
 const ship=projection.actors['p/alice'].ship;
 const proof={observer:ship.actor,actor:ship.actor,eventId:ship.eventId,kind:'owner',nativeName:ship.nativeName,runId:'native-1',runNonce:'n',created:true,simMjd:clock.simMjd0,verifiedPort:true};
 const proofMove=buildMove({world:W,game:GAME,player:'p/alice',seq:2,previous:j.digest,kind:'owner-proof',payload:{proof}});
 const frame=(seq,prev,sample)=>buildMove({world:W,game:GAME,player:'p/alice',seq,previous:prev,kind:'frame',payload:{frame:{actor:ship.actor,owner:ship.owner,eventId:ship.eventId,sample}}});
 return{j,ship,proofMove,frame};
};

test('plausibility: bounds are ignored (not rejected), advance the hash chain, and later honest frames apply',()=>{
 const {j,ship,proofMove,frame}=setup(),t=clock.simMjd0;
 const f1=frame(3,proofMove.digest,sampleOf(ship.nativeName,1,t,[10,0,0],[1,0,0]));
 const teleport=frame(4,f1.digest,sampleOf(ship.nativeName,2,t+1/86400,[9e8,0,0],[1,0,0]));
 const f3=frame(5,teleport.digest,sampleOf(ship.nativeName,3,t+2/86400,[12,0,0],[1,0,0]));
 const p=assembleProjection({world:W,game:GAME,confirmed:rows([j,proofMove,f1,teleport,f3]),port,clock});
 assert.equal(p.rejected.length,0,'a bad frame must not be a chain break');
 assert.equal(p.ignored.length,1);assert.match(p.ignored[0].why,/^frame_implausible_/);
 assert.deepEqual(p.actors['p/alice'].frame.sample.position,[12,0,0],'the later honest frame still applies');
 const off=assembleProjection({world:W,game:GAME,confirmed:rows([j,proofMove,f1,teleport,f3]),port,clock,limits:null});
 assert.equal(off.ignored.length,0,'limits:null disables the rules (tests only)');
});

test('frameImplausible unit rules',()=>{
 const t=clock.simMjd0,mk=(s,p,v,runId='r')=>({sample:{...sampleOf('x',s,t+s/86400,p,v,runId)}});
 const a=mk(0,[0,0,0],[0,0,0]);
 assert.equal(frameImplausible(mk(10,[0,0,0],[0,0,0]),a),null);
 assert.equal(frameImplausible(mk(10,[1e10,0,0],[0,0,0]),a),'position_bound');
 assert.equal(frameImplausible(mk(10,[0,0,0],[6e4,0,0]),a),'speed_bound');
 assert.equal(frameImplausible(mk(1,[0,0,0],[500,0,0]),a),'acceleration_bound');
 assert.equal(frameImplausible(mk(1,[5000,0,0],[0,0,0]),a),'displacement_bound');
 assert.equal(frameImplausible({sample:{...a.sample,simMjd:t-10/86400}},{sample:{...a.sample,simMjd:t}}),'time_reversal');
 assert.equal(frameImplausible(mk(1,[5000,0,0],[0,0,0],'other-run'),a),null,'a new run is not compared with the old run');
 // Block-time plausibility: confirmed frame whose simMjd is 1 day away from the block time.
 const blockSec=clock.utcOriginMs/1000;
 assert.equal(frameImplausible(mk(0,[0,0,0],[0,0,0]),null,{blockTimeSec:blockSec,clock}),null);
 assert.equal(frameImplausible({sample:{...a.sample,simMjd:t+1}},null,{blockTimeSec:blockSec,clock}),'time_vs_block');
 assert.equal(PLAUSIBILITY_V1.version,1);
});

test('join rows carry the confirming block height for join-depth gating, outside ship and root',()=>{
 const j=joinMove('p/alice',ADDR_A);
 const a=assembleProjection({world:W,game:GAME,confirmed:rows([j],[100]),port,clock});
 const b=assembleProjection({world:W,game:GAME,confirmed:rows([j],[107]),port,clock});
 assert.equal(a.actors['p/alice'].joinHeight,100);assert.equal(b.actors['p/alice'].joinHeight,107);
 assert.equal(a.confirmedRoot,b.confirmedRoot,'height is peer-local evidence and must not change the consensus root');
});

test('protocol id changes with the projection semantics, so peers of different consensus rules cannot share a world silently',async()=>{
 const {GAME_PROTOCOL,gameGenesis,verifyGameGenesis}=await import('../OSGSim/apps/metaverse-native/v26/rod-game/protocol.mjs');
 assert.equal(GAME_PROTOCOL,'osgsim-rod-primary-v3');
 const g=gameGenesis({world:W,assetRoot:'d'.repeat(64),rodGenesis:'b'.repeat(64),port,clock});
 assert.throws(()=>verifyGameGenesis({...g,protocol:'osgsim-rod-primary-v2'},g),/GENESIS_MISMATCH/);
});
