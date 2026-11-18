import test from 'node:test';import assert from 'node:assert/strict';
import net from 'node:net';import http from 'node:http';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createWorldServer} from '../apps/world-service/server.mjs';
import {wsEncode,sendFrame} from '../apps/world-service/websocket.mjs';
import {applyNativeFrame} from '../apps/observer/native-state.mjs';
import {DurableJournal} from '../packages/osg-physical/journal.mjs';
import {makeEnvelope,validateEnvelope} from '../packages/world-protocol/index.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(f){for(let i=0;i<200;i++){if(await f())return;await pause(10);}throw Error('timeout');}
const frame=(type='PHYSICS_SAMPLE',entityId='one',fields={})=>makeEnvelope(type,{runId:'review',epoch:0,step:1,sequence:1,simTime:1,simDt:1,source:'native',entityId,frameId:'metaverse-global-ecliptic',position:[10,0,0],velocity:[0,0,0],orientation:[0,0,0,1],contact:false,...fields});
async function withApp(fn){const dir=await mkdtemp(join(tmpdir(),'osg-transport-review-'));const app=await createWorldServer({httpPort:0,bridgePort:0,dataDir:dir});try{await fn(app,dir);}finally{await app.close();await rm(dir,{recursive:true,force:true});}}
test('selected browser vessel ignores other vessels and old-epoch contacts',()=>{
 const s={events:[]};assert.equal(applyNativeFrame(s,frame()).sample,true);
 assert.equal(applyNativeFrame(s,frame('PHYSICS_SAMPLE','two')).sample,undefined);
 assert.equal(s.lastNative.entityId,'one');
 assert.equal(applyNativeFrame(s,frame('CONTACT_BEGIN','two',{eventId:'two'})).event,false);
 s.events.push({type:'CONTACT_BEGIN'});
 assert.equal(applyNativeFrame(s,frame('SIMULATION_RESET','one',{epoch:1})).reset,true);
 assert.equal(s.events.length,0);assert.equal(s.nativeOrigin,null);
 assert.equal(applyNativeFrame(s,frame('CONTACT_BEGIN','one',{eventId:'old'})).event,undefined);
 assert.equal(applyNativeFrame(s,frame('PHYSICS_SAMPLE','two',{epoch:1,position:[999,0,0]})).sample,true);
 assert.equal(s.heightReference,999);
});
test('WebSocket handles the exact 65536-byte envelope boundary',()=>{
 const b=wsEncode('a'.repeat(65536));assert.equal(b[1],127);assert.equal(b.readBigUInt64BE(2),65536n);
});
test('WebSocket stops buffering when a reader falls behind',()=>{
 let writes=0;const socket={destroyed:false,writableNeedDrain:true,write(){writes++;},destroy(){this.destroyed=true;}};
 assert.equal(sendFrame(socket,'x'),false);assert.equal(socket.destroyed,true);assert.equal(writes,0);
});
test('Host validation blocks rebinding-style requests',()=>withApp(async app=>{
 const status=await new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port:app.httpPort,path:'/api/status',headers:{Host:'attacker.invalid:'+app.httpPort}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});
 assert.equal(status,403);
 assert.equal((await fetch(`http://127.0.0.1:${app.httpPort}/api/observer-evidence`)).status,400);
}));
test('WebSocket reassembles a split masked ping and returns pong',()=>withApp(async app=>{
 const s=net.connect(app.httpPort,'127.0.0.1');s.on('error',()=>{});let bytes=Buffer.alloc(0);
 s.on('data',b=>bytes=Buffer.concat([bytes,b]));
 await new Promise(r=>s.once('connect',r));
 try{
  const host=`127.0.0.1:${app.httpPort}`;
  s.write(`GET /ws HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n\r\n`);
  await until(()=>bytes.includes(Buffer.from('\r\n\r\n')));bytes=Buffer.alloc(0);
  const ping=Buffer.from([0x89,0x81,1,2,3,4,0x78^1]);s.write(ping.subarray(0,1));await pause(10);s.write(ping.subarray(1));
  await until(()=>bytes.length>=3);assert.deepEqual(bytes,Buffer.from([0x8a,1,0x78]));
 }finally{s.destroy();}
}));
test('failed startup releases the journal writer lock',()=>withApp(async app=>{
 const dir=await mkdtemp(join(tmpdir(),'osg-failed-start-'));
 try{await assert.rejects(createWorldServer({httpPort:app.httpPort,bridgePort:0,dataDir:dir}),/EADDRINUSE/);
 const retry=await createWorldServer({httpPort:0,bridgePort:0,dataDir:dir});await retry.close();
 }finally{await rm(dir,{recursive:true,force:true});}
}));
test('read-only journal verification never truncates an incomplete tail',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'osg-readonly-'));const file=join(dir,'j');
 try{const bytes='partial interrupted record';await writeFile(file,bytes);
 await assert.rejects(new DurableJournal(file,{readOnly:true}).open(),/incomplete/);
 assert.equal(await readFile(file,'utf8'),bytes);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('simultaneous exported ingestion calls are serialized',()=>withApp(async app=>{
 await Promise.all(Array.from({length:5},(_,i)=>app.handleSample(frame('PHYSICS_SAMPLE','one',{step:i+1,sequence:i+1,simTime:i+1,contact:i%2===1}))));
 assert.equal(app.state.samplesAccepted,5);assert.equal(app.state.contacts.length,4);
}));
test('trajectory comparator cannot print PASS for one sample',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'osg-compare-'));
 try{const file=join(dir,'one.pos');await writeFile(file,'STARTMJD 1\nREF Earth\nFRM EQUATORIAL\nCRD CARTESIAN\n0 1 0 0 0 0 0\n');
 const p=spawnSync(process.execPath,['scripts/compare-trajectories.mjs',file,file],{encoding:'utf8'});
 assert.equal(p.status,1);assert.equal(JSON.parse(p.stdout).status,'FAIL');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('sparse coordinate arrays fail validation',()=>{
 assert.throws(()=>validateEnvelope({...frame(),position:Array(3)}),/position/);
});
