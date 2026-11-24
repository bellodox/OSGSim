// SPDX-License-Identifier: MIT
import test from 'node:test';import assert from 'node:assert/strict';
import {RodGameSync} from '../OSGSim/apps/metaverse-native/v26/rod-game/sync.mjs';
import {gameGenesis} from '../OSGSim/apps/metaverse-native/v26/rod-game/protocol.mjs';
const world='a'.repeat(64),genesis='b'.repeat(64),assetRoot='c'.repeat(64),game='osgsimautojoin';
const port={portId:'moon:brighton-beach',configSha256:'d'.repeat(64),slots:[{slot:'pad-1'}]};
const clock={schema:1,rate:1,era:1,utcOriginMs:1790000000000,simMjd0:61000};
function fixture(){const games=[],calls=[];const rpc=async(method,args=[])=>{calls.push([method,args]);switch(method){
 case 'getblockchaininfo':return{chain:'regtest',blocks:1};
 case 'getblockhash':return args[0]===0?genesis:'e'.repeat(64);
 case 'name_show':return{height:1,value:JSON.stringify(gameGenesis({world,assetRoot,rodGenesis:genesis,port,clock}))};
 case 'getzmqnotifications':return[{type:'pubgamepending',address:'tcp://127.0.0.1:28332'},{type:'pubgameblocks',address:'tcp://127.0.0.1:28332'}];
 case 'trackedgames':if(args.length===0)return[...games];if(args[0]==='add'){games.push(args[1]);return null;}throw Error('bad command');
 default:throw Error('bad method '+method)}};
 const graph={async putMany(){},head:'z'};
 const sync=new RodGameSync({rpc,world,game,port,clock,assetRoot,graph,startHeight:1,zmqAddress:'tcp://127.0.0.1:28332'});
 sync.startZmq=async()=>{sync.zmqReady=true;};sync.reconcile=async()=>({confirmedRoot:'f'.repeat(64)});
 return{sync,calls,games};}
test('discovered game is dynamically tracked before ZMQ subscriber starts',async()=>{const f=fixture();
 await f.sync.start();assert.deepEqual(f.games,[game]);assert.ok(f.calls.some(([m,a])=>m==='trackedgames'&&a[0]==='add'&&a[1]===game));await f.sync.close();});
test('existing game subscription remains idempotent',async()=>{const f=fixture();f.games.push(game);
 await f.sync.start();assert.equal(f.calls.filter(([m,a])=>m==='trackedgames'&&a[0]==='add').length,0);await f.sync.close();});
