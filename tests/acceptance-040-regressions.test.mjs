// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {LandingTimeline} from '../packages/landing-scene/timeline.mjs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorldServer} from '../apps/world-service/server.mjs';

/** Run the production observer startup with inert rendering and controlled HTTP replies. */
async function startObserver({failFirstStatus=false,mode='recorded'}={}){
 const source=await readFile(new URL('../apps/observer/app.mjs',import.meta.url),'utf8');
 const nodes=new Map(),requests=[],intervals=[];
 const document={querySelector(selector){
  if(!nodes.has(selector))nodes.set(selector,{textContent:'',value:'0',classList:{add(){}},addEventListener(){},getContext(){return {};},replaceChildren(){}});
  return nodes.get(selector);
 }};
 let statusRequests=0;
 const context={document,URLSearchParams,location:{search:'?observer=A',protocol:'http:',host:'localhost'},
  LandingTimeline,mountActivities:()=>()=>{},requestAnimationFrame(){},setInterval(fn){intervals.push(fn);},
  WebSocket:class{addEventListener(){}},fetch:async path=>{
   requests.push(path);
   if(path==='/api/status'){
    if(failFirstStatus&&++statusRequests===1)throw new Error('Transient first status failure');
    return {ok:true,json:async()=>({mode,journalHead:{sequence:0,hash:'0'.repeat(64)}})};
   }
   if(path==='/api/recording')return mode==='native'?{ok:false,status:404}:{ok:true,json:async()=>({
    samples:[{time:0,position:[1000,0,0],velocity:[0,0,0]},{time:10,position:[1000,1,0],velocity:[0,0,0]}],
    metadata:{reference:'Earth',frame:'ECLIPTIC'},events:[]})};
   if(path.startsWith('/api/observer-evidence'))return {ok:false};
   throw new Error('Unexpected request: '+path);
  }};
 runInNewContext(source.replace(/^import .*;\r?\n/gm,'').replace(/init\(\);\s*$/,'globalThis.initialized=init();'),context);
 await context.initialized;
 return {nodes,requests,intervals};
}

test('observer recovers replay startup after a transient first status failure',async()=>{
 const {nodes,requests,intervals}=await startObserver({failFirstStatus:true});
 assert.deepEqual(requests,['/api/status','/api/recording']);
 assert.equal(nodes.get('#authority').textContent,'FLIGHT RECORDER');
 assert.equal(nodes.get('#source-label').textContent,'RECORDED / SOURCE EXCERPT');
 assert.equal(nodes.get('#timeline-range').textContent,'0.0 – 10.0 s');
 await intervals.at(-1)();
 assert.equal(nodes.get('#connection-status').textContent,'RECORDING REPLAY');
 assert.equal(nodes.get('#authority').textContent,'FLIGHT RECORDER');
});

test('known native observer startup never requests the unavailable recording endpoint',async()=>{
 const {nodes,requests}=await startObserver({mode:'native'});
 assert.equal(requests.filter(path=>path==='/api/recording').length,0);
 assert.equal(nodes.get('#authority').textContent,'METAVERSE SDK');
 assert.equal(nodes.get('#scene-message').textContent,'');
});

test('shutdown closes an idle HTTP transport without waiting for the header timeout', {timeout:8000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'osg-close-'));
 const app=await createWorldServer({httpPort:0,bridgePort:0,dataDir:dir});
 const socket=net.connect(app.httpPort,'127.0.0.1');
 await new Promise(resolve=>socket.once('connect',resolve));
 socket.write('GET /api/status HTTP/1.1\r\n');
 await new Promise(resolve=>setTimeout(resolve,30));
 const started=performance.now(),closing=app.close();
 let forced=false;
 const rescue=setTimeout(()=>{forced=true;socket.destroy();},1500);
 try{await closing;assert.equal(forced,false,'HTTP close waited for an incomplete request');assert.ok(performance.now()-started<1500);}
 finally{clearTimeout(rescue);socket.destroy();await rm(dir,{recursive:true,force:true});}
});
