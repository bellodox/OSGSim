import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {OsgAdapter} from '../packages/osg-physical/osg-adapter.mjs';
import {makeEnvelope} from '../packages/world-protocol/index.mjs';

test('OSG adapter recovery is idempotent against an API-shape test double (NOT real LanceDB proof)',async()=>{
 const root=await mkdtemp(join(tmpdir(),'osg-contract-'));
 try {
   await writeFile(join(root,'package.json'),'{"type":"module"}');
   for(const p of ['dist/core/src','dist/storage-lance/src'])await mkdir(join(root,p),{recursive:true});
   await writeFile(join(root,'dist/storage-lance/src/index.js'),`const DB=new Map();
export async function openStore(dir){if(!DB.has(dir))DB.set(dir,new Map());const elements=DB.get(dir);
return {elements,async rows(){return [...elements.values()]},async close(){}};}`);
   await writeFile(join(root,'dist/core/src/graph.js'),`export async function commit(store,proposals){
  const item=proposals[0],previous=store.elements.get(item.element_id);
  if(previous){if(JSON.stringify(previous.props)!==JSON.stringify(item.props))throw Error('mismatched duplicate');
    return {noop:true,idempotent:false,commitId:'existing'};}
  store.elements.set(item.element_id,item);
  return {noop:false,idempotent:false,commitId:'new-'+store.elements.size};}
export function verify(rows){return {elements:rows.length,commits:rows.length}}`);
   const e=(type,step)=>makeEnvelope(type,{runId:'run',epoch:0,step,sequence:step,
    simTime:step*.2,entityId:'lander',source:'recorded',eventId:`fixture-${type}-${step}`});
   const events=[e('CONTACT_BEGIN',1),e('CONTACT_END',2)];
   const adapter=new OsgAdapter({sourceDir:root,storeDir:join(root,'store')});
   await adapter.open();
   assert.deepEqual(await adapter.reconcile(events),{processed:2,changed:2});
   assert.deepEqual(await adapter.reconcile(events),{processed:2,changed:0});
   assert.deepEqual(await adapter.verify(),{elements:2,commits:2});
   await adapter.close();
   const reopened=new OsgAdapter({sourceDir:root,storeDir:join(root,'store')});
   await reopened.open();
   assert.deepEqual(await reopened.reconcile(events),{processed:2,changed:0});
   await reopened.close();
 }finally{await rm(root,{recursive:true,force:true});}
});
