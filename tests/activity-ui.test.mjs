// SPDX-License-Identifier: MIT
// Exercises the production UI module, with a minimal DOM and deterministic HTTP replies.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mountActivities} from '../apps/observer/activities.mjs';

test('activity UI pins context, reviews conflicts, and pages a fixed committed list',async()=>{
  const previous={document:globalThis.document,fetch:globalThis.fetch,now:Date.now};
  const nodes=[];
  class Element{
    constructor(tag){this.tag=tag;this.children=[];this.handlers={};this.value='';nodes.push(this);}
    setAttribute(){} append(...items){this.children.push(...items);} replaceChildren(){this.children=[];}
    addEventListener(event,fn){this.handlers[event]=fn;}
  }
  let clock=10000,run='run-A',conflict=false,version='v1',cursor=true;
  const posts=[],gets=[];
  try{
    globalThis.document={createElement:tag=>new Element(tag)};Date.now=()=>clock;
    globalThis.fetch=async(url,options)=>{
      if(url==='/api/world/history')return{ok:true,json:async()=>({streams:[{runId:run,epoch:0,generation:1}]})};
      if(options?.method==='POST'){
        const input=JSON.parse(options.body);posts.push(input);
        if(input.action==='get')return{ok:true,json:async()=>({items:[{version:'v2',state:'active',text:'Other writer text'}]})};
        if(conflict){conflict=false;return{ok:false,status:409,json:async()=>({error:'Activity version changed'})};}
        return{ok:true,status:200,json:async()=>({version})};
      }
      gets.push(new URL(url,'http://localhost'));
      const paging=gets.at(-1).searchParams.has('after');
      return{ok:true,json:async()=>({head:'head-A',items:[{actor:'peer',state:'active',text:paging?'second-page':'first-page'}],nextAfter:!paging&&cursor?'shared:activity:'+'a'.repeat(64):null})};
    };
    const poll=mountActivities(new Element('parent'));
    const button=label=>nodes.find(n=>n.tag==='button'&&n.textContent===label);
    const click=async node=>{assert.equal(node.disabled,false);await node.handlers.click();};
    await poll({osgWorldMode:true});
    nodes.find(n=>n.tag==='input').value='participant-token';nodes.find(n=>n.tag==='textarea').value='Draft';
    await click(button('Start'));
    run='run-B';clock+=2000;await poll({osgWorldMode:true});
    assert.equal(gets.at(-1).searchParams.get('contextId'),'simulation/run-A/0');
    assert.ok(nodes.some(n=>n.textContent==='Activity and list context: run-A / epoch 0'));
    conflict=true;await click(button('Update'));
    assert.equal(posts.at(-1).runId,'run-A');assert.equal(button('Update').disabled,true);
    await click(button('Refresh my activity'));
    assert.equal(posts.at(-1).action,'get');assert.equal(posts.at(-1).runId,'run-A');
    assert.equal(nodes.find(n=>n.tag==='textarea').value,'Draft');
    version='v3';await click(button('Update'));assert.equal(posts.at(-1).expectedVersion,'v2');
    await click(button('Load more activities (pinned history)'));
    assert.equal(gets.at(-1).searchParams.get('head'),'head-A');assert.equal(gets.at(-1).searchParams.get('after'),'shared:activity:'+'a'.repeat(64));
    const count=gets.length;clock+=2000;await poll({osgWorldMode:true});assert.equal(gets.length,count);
    cursor=false;await click(button('New activity in current run'));
    assert.equal(gets.at(-1).searchParams.get('contextId'),'simulation/run-B/0');
    await click(button('Start'));assert.equal(posts.at(-1).runId,'run-B');assert.equal(posts.at(-1).expectedVersion,null);
  }finally{globalThis.document=previous.document;globalThis.fetch=previous.fetch;Date.now=previous.now;}
});
