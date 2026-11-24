// SPDX-License-Identifier: MIT
// The g/ game of a realm is found from canonical ROD name state only: held by the realm owner and with a genesis
// that binds the realm's world, assets, ROD chain and port.
import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveRegisteredRealmGame} from '../OSGSim/apps/metaverse-native/v26/rod-game/realm-game-index.mjs';
import {gameGenesis} from '../OSGSim/apps/metaverse-native/v26/rod-game/protocol.mjs';
const WORLD='a'.repeat(64),ASSET='b'.repeat(64),ROD='c'.repeat(64),PUBLISHER='d'.repeat(64);
const ADDRESS='rFJtzkbeQ3dxWQg9G82LHMsPvrhSLMarJU';
const directory={schema:'spexgsp/realm/1',worldId:WORLD,assetRoot:ASSET,rodGenesis:ROD,ownerAddress:ADDRESS,publisher:PUBLISHER,era:1};
const port={configSha256:'e'.repeat(64)};
const clock={schema:1,utcOriginMs:1790000000000,simMjd0:61000,rate:1,era:1};
const make=(id,patch={})=>({name:'g/'+id,address:ADDRESS,height:8,value:JSON.stringify({...gameGenesis({world:WORLD,assetRoot:ASSET,rodGenesis:ROD,port,clock}),...patch})});
function reader(rows){const indexed=new Map(rows.map(x=>[x.name,x]));const ordered=[...indexed.keys()].sort();let scans=0;
 const rpc=async(method,args=[])=>{
  if(method==='name_show'){const v=indexed.get(args[0]);if(!v)throw Error('not found');return v;}
  if(method==='name_scan'){
   scans++;const [from,limit]=args;
   return ordered.filter(x=>x>=from).slice(0,limit).map(name=>indexed.get(name));
  }
  throw Error('unexpected RPC '+method);
 };
 return{rpc,get scans(){return scans}};
}
const params={directory,port,rodGenesis:ROD};
test('a realm matches its verified ROD game across inclusive name_scan pages; its clock comes from the record',async()=>{
 const good=make('gameA');const r=reader([make('alien',{worldId:'f'.repeat(64)}),make('another',{portHash:'f'.repeat(64)}),good,
  {name:'h/unrelated',height:4,address:ADDRESS,value:'{}'},make('zOther',{rodGenesis:'f'.repeat(64)})]);
 assert.deepEqual(await resolveRegisteredRealmGame({...params,rpc:r.rpc,pageSize:2}),{gameId:'gameA',clock});
 assert.ok(r.scans>=2);
});
test('explicit untrusted game hint must match exact on-chain registration; no scan fallback',async()=>{
 const r=reader([make('correct'),make('wrong',{assetRoot:'f'.repeat(64)})]);
 assert.deepEqual(await resolveRegisteredRealmGame({...params,rpc:r.rpc,explicitGameId:'correct'}),{gameId:'correct',clock});
 await assert.rejects(resolveRegisteredRealmGame({...params,rpc:r.rpc,explicitGameId:'wrong'}),/NOT_CANONICAL/);
 assert.equal(r.scans,0);
});
test('equally plausible on-chain game registrations are ambiguous, never silently selected',async()=>{
 const r=reader([make('first'),make('second')]);
 await assert.rejects(resolveRegisteredRealmGame({...params,rpc:r.rpc,pageSize:2}),/AMBIGUOUS_DISTRIBUTED_GAME/);
});
test('a foreign registration, or one not held by the realm owner, is never adopted',async()=>{
 const r=reader([make('foreign',{assetRoot:'f'.repeat(64)}),{...make('stolen'),address:'rDU1rhqDwG2arMnnGdEobtpGr4aMASKfXw'}]);
 assert.equal(await resolveRegisteredRealmGame({...params,rpc:r.rpc,pageSize:2}),null);
});
test('a malicious or broken RPC scan cannot cause unbounded work or incomplete selection',async()=>{
 const bad=async(method)=>method==='name_scan'?[{name:'g/z',address:ADDRESS,height:1},{name:'g/z',address:ADDRESS,height:1}]:make('z');
 await assert.rejects(resolveRegisteredRealmGame({...params,rpc:bad,pageSize:2,maxPages:2}),/STALLED|LIMIT_EXCEEDED/);
});
