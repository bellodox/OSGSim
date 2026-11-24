// SPDX-License-Identifier: MIT
// OSG writes whose acknowledgement is lost are accepted only when every proposed value is durably visible.
import test from 'node:test';
import assert from 'node:assert/strict';
import {OsgGraph} from '../OSGSim/apps/metaverse-native/v26/graph-adapter.mjs';

function fixture({ambiguous=false,partial=false}={}){
 const graph=new OsgGraph();let view={head:'c'+'0'.repeat(64),state:new Map()};
 graph.view=view;graph.store={};graph.core={
  async commit(_store,proposals){const next=new Map(view.state);
   for(const [i,p] of proposals.entries())if(!(partial&&i>0))next.set(p.element_id,{props:p.props});
   view={head:'c'+String(next.size).padStart(64,'0'),state:next};
   if(ambiguous||partial)throw Error('lost_disk_ack');
  },
  async headView(){return view;}
 };
 return graph;
}
test('an acknowledged OSG write advances the head',async()=>{
 const g=fixture();await g.putMany([{id:'metaverse:x:a',value:{n:1}}]);assert.deepEqual(g.get('metaverse:x:a'),{n:1});
});
test('a durable write whose acknowledgement was lost is recognised as committed',async()=>{
 const g=fixture({ambiguous:true});await g.putMany([{id:'metaverse:x:a',value:{n:1}},{id:'metaverse:x:b',value:{n:2}}]);
 assert.deepEqual(g.get('metaverse:x:b'),{n:2});
});
test('a partially visible write with a lost acknowledgement is reported as failed',async()=>{
 const g=fixture({partial:true});
 await assert.rejects(g.putMany([{id:'metaverse:x:a',value:{n:1}},{id:'metaverse:x:b',value:{n:2}}]),/lost_disk_ack/);
});
test('unchanged values do not create a commit; duplicate ids in one batch are refused',async()=>{
 const g=fixture();await g.put('metaverse:x:a',{n:1});const head=g.head;await g.put('metaverse:x:a',{n:1});assert.equal(g.head,head);
 await assert.rejects(g.putMany([{id:'metaverse:x:a',value:{n:1}},{id:'metaverse:x:a',value:{n:2}}]),/invalid_osg_batch_id/);
});

test('a store write that never returns is abandoned after the limit and the queue goes on',async()=>{
 const g=new OsgGraph();g.writeTimeoutMs=60;g.refresh=async()=>{};
 let calls=0;g._putMany=async()=>{calls++;if(calls===1)return new Promise(()=>{});return 'ok';};
 const errors=[];const original=console.error;console.error=m=>errors.push(String(m));
 try{
  await assert.rejects(g.putMany([{id:'a:b:c',value:{}}]),e=>e.code==='OSG_WRITE_STALLED');
  assert.equal(await g.putMany([{id:'a:b:d',value:{}}]),'ok');
 }finally{console.error=original;}
 assert.ok(errors.some(m=>m.startsWith('SPEXGSP_OSG_WRITE_STALLED')));
});
