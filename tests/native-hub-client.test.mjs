// The sidecar's logic now lives in the DLL (native/spexgsp-rod/HubClient.hpp). These tests run that C++ code on Linux
// against the real hub, with the game side played by the test, and compare its helpers with the JavaScript they replace.
import test from 'node:test';import assert from 'node:assert/strict';import http from 'node:http';
import {spawn,spawnSync,execFileSync} from 'node:child_process';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {readFile,writeFile,mkdir,rm} from 'node:fs/promises';import {deflateSync,constants} from 'node:zlib';import {createInterface} from 'node:readline';
import {canonical,sha} from '../OSGSim/apps/metaverse-native/v26/ownership.mjs';
import {parseBrightonBase} from '../OSGSim/apps/metaverse-native/v26/spawn-ports.mjs';
import {TestWorld} from './support/test-world.mjs';
import {worldRoot} from '../OSGSim/apps/metaverse-native/v26/world.mjs';
import {createV26Hub} from '../OSGSim/apps/metaverse-native/v26/hub.mjs';
const root=new URL('..',import.meta.url).pathname;
const haveGpp=spawnSync('g++',['--version']).status===0;
const work=join(tmpdir(),'spex-hub-client-'+process.pid);await mkdir(work,{recursive:true});
const build=(src,out)=>{execFileSync('g++',['-std=c++17','-O1','-pthread','-o',join(work,out),join(root,'tests',src)]);return join(work,out);};
const sleep=ms=>new Promise(ok=>setTimeout(ok,ms));
async function until(fn,timeout=8000){const begin=Date.now();while(Date.now()-begin<timeout){if(fn())return;await sleep(30);}throw Error('acceptance_timeout');}
// ---- helper CLI: canonical JSON, SHA-256, PNG inspection
function helper(){const bin=build('native-json-cli.cpp','jsoncli');return lines=>spawnSync(bin,{input:lines.join('\n')+'\n',encoding:'utf8',maxBuffer:1<<26}).stdout.trim().split('\n');}
test('C++ canonical JSON and SHA-256 equal ownership.mjs canonical()/sha() for numbers, unicode and nesting',(t)=>{
 if(!haveGpp){t.skip('g++ not available');return;}
 const run=helper();let seed=7;const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed/0x7fffffff;};
 const numbers=[0,-0,1,-1,0.5,0.1+0.2,1e21,1e-7,123456789012345680000,5e-324,1.7976931348623157e308,9007199254740991,-9007199254740991,51982.1301160012,60000.000000001,1e20,1.5e-6,0.000001,0.0000001,100,1e5,12345.6789e-3];
 for(let i=0;i<200;i++)numbers.push((rnd()-0.5)*Math.pow(10,Math.floor(rnd()*40-15)));
 const strings=['','a','peer1','quote " back \\ slash','line\nbreak\ttab\r\b\f','ctl\u0001\u001f','é ü ß','日本語','emoji 😀 mix','</script>','  '];
 const cases=[];
 for(const n of numbers)cases.push(n);for(const s of strings)cases.push(s);
 cases.push(null,true,false,[],{},[1,[2,[3,{a:null}]]]);
 for(let i=0;i<60;i++){const o={};for(let k=0;k<6;k++)o[['zeta','alpha','p/spex1','Beta','a','10','9'][Math.floor(rnd()*7)]]=rnd()<0.5?numbers[Math.floor(rnd()*numbers.length)]:{x:[strings[Math.floor(rnd()*strings.length)],numbers[Math.floor(rnd()*numbers.length)]],y:rnd()<0.5};cases.push(o);}
 const out=run(cases.map(c=>'canon '+JSON.stringify(c)));assert.equal(out.length,cases.length);
 cases.forEach((c,i)=>{const [canon,hash]=out[i].split('\t');assert.equal(canon,canonical(c),'canonical case '+i+' '+JSON.stringify(c));assert.equal(hash,sha(canonical(c)),'sha case '+i);});
 const bad=run(['canon {"a":1,}','canon [1,2','canon {"a":01}','canon "\\ud800"','canon nul']);bad.forEach(x=>assert.match(x,/^ERR invalid_json/));
 assert.deepEqual(run(['sha abc','sha ']),[sha('abc'),sha('')]);
});
// ---- PNG
const crcTable=new Uint32Array(256).map((_,i)=>{let x=i;for(let j=0;j<8;j++)x=(x>>>1)^((x&1)?0xedb88320:0);return x>>>0;});
const crc=b=>{let c=0xffffffff;for(const x of b)c=crcTable[(c^x)&255]^(c>>>8);return(c^0xffffffff)>>>0;};
const chunk=(type,data)=>{const b=Buffer.alloc(12+data.length);b.writeUInt32BE(data.length,0);b.write(type,4,'ascii');data.copy(b,8);b.writeUInt32BE(crc(b.subarray(4,8+data.length)),8+data.length);return b;};
function png({width=400,height=300,colorType=2,raw=null,level=6,strategy=0,filters=true,idatSplit=1}={}){
 const channels=colorType===6?4:3,stride=width*channels;let seed=width*31+height;const rnd=()=>{seed=(seed*1103515245+12345)&0x7fffffff;return seed;};
 const data=raw??Buffer.alloc((stride+1)*height);if(!raw)for(let y=0;y<height;y++){data[y*(stride+1)]=filters?rnd()%5:0;for(let i=0;i<stride;i++)data[y*(stride+1)+1+i]=(rnd()>>8)&255;}
 const z=deflateSync(data,{level,strategy});const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width,0);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=colorType;
 const parts=[];const step=Math.ceil(z.length/idatSplit);for(let i=0;i<z.length;i+=step)parts.push(chunk('IDAT',z.subarray(i,i+step)));
 return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',ihdr),...parts,chunk('IEND',Buffer.alloc(0))]);
}
test('C++ PNG inspection (with its own inflate) gives the results recorded from the former png-verify.mjs (width height channels distinct nonUniform)',async(t)=>{
 if(!haveGpp){t.skip('g++ not available');return;}
 const run=helper();const files=[];const add=async(name,bytes)=>{const f=join(work,name);await writeFile(f,bytes);files.push({name,f,bytes});};
 await add('rgb-dynamic.png',png({}));await add('rgba.png',png({colorType:6,width:333,height:222}));await add('stored.png',png({level:0}));
 await add('fixed.png',png({strategy:constants.Z_FIXED}));await add('rle.png',png({strategy:constants.Z_RLE,filters:false}));await add('split-idat.png',png({idatSplit:5}));
 await add('huffman-only.png',png({strategy:constants.Z_HUFFMAN_ONLY}));await add('best.png',png({level:9,width:640,height:480}));
 await add('flat.png',png({raw:Buffer.alloc((400*3+1)*300)}));await add('small.png',png({width:100,height:100}));
 const good=png({});const mutate=(f)=>{const b=Buffer.from(good);f(b);return b;};
 await add('bad-signature.png',mutate(b=>{b[0]=0;}));await add('bad-crc.png',mutate(b=>{b[b.length-20]^=1;}));await add('truncated.png',good.subarray(0,good.length-30));
 await add('bad-filter.png',png({raw:(()=>{const r=Buffer.alloc((1200+1)*300,7);for(let y=0;y<300;y++)r[y*1201]=9;return r;})()}));
 await add('not-png.png',Buffer.alloc(400,1));
 const golden={"rgb-dynamic.png":"OK 400 300 3 1231 10677","rgba.png":"ERR png_capture_blank_or_flat","stored.png":"OK 400 300 3 1231 10677","fixed.png":"OK 400 300 3 1231 10677","rle.png":"OK 400 300 3 1035 22201","split-idat.png":"OK 400 300 3 1231 10677","huffman-only.png":"OK 400 300 3 1231 10677","best.png":"OK 640 480 3 1392 29690","flat.png":"ERR png_capture_blank_or_flat","small.png":"ERR png_dimensions_or_format_invalid","bad-signature.png":"ERR png_signature_invalid","bad-crc.png":"ERR png_crc_invalid","truncated.png":"ERR png_chunk_bounds","bad-filter.png":"ERR png_filter_invalid","not-png.png":"ERR png_signature_invalid"};
 const out=run(files.map(x=>'png '+x.f));
 files.forEach((x,i)=>assert.equal(out[i],golden[x.name],x.name));
 assert.ok(out.filter(x=>x.startsWith('OK')).length>=7,'the valid variants are accepted: '+out.join(' | '));
});
test('C++ pickMotionFrame: the newer live frame wins, a committed frame with a higher sequence wins, a new run wins, missing frames fall back',(t)=>{
 if(!haveGpp){t.skip('g++ not available');return;}
 const run=helper();const fr=(runId,sequence)=>({sample:{runId,sequence,position:[0,0,0]}});const live=(f)=>({frame:f,seq:1});
 const cases=[
  [fr('r1',1),live(fr('r1',2)),'live'],[fr('r1',5),live(fr('r1',2)),'committed'],[fr('r1',3),live(fr('r1',3)),'committed'],
  [fr('r1',9),live(fr('r2',1)),'live'],[{},live(fr('r1',1)),'live'],[fr('r1',1),live({}),'committed'],[fr('r1',1),{},'committed']];
 const out=run(cases.map(c=>'pick '+JSON.stringify(c[0])+'\t'+JSON.stringify(c[1])));
 cases.forEach((c,i)=>assert.equal(out[i],c[2],'case '+i));
});
// ---- the hub client against the real hub
const start=1700000000000,worldId='a'.repeat(64),clockPolicy={schema:1,utcOriginMs:start,simMjd0:51982.1301160012,rate:1,era:1};
const port={...parseBrightonBase(await readFile(new URL('../fixtures/Brighton.cfg',import.meta.url),'utf8')),portId:'moon:brighton-beach',allowedClasses:['ShuttlePB']};
const addrs=['rFJtzkbeQ3dxWQg9G82LHMsPvrhSLMarJU','rDU1rhqDwG2arMnnGdEobtpGr4aMASKfXw'];
const fakeRpc=async(method,args)=>{if(method==='signmessage')return Buffer.from(args[1]).toString('base64');if(method==='verifymessage')return args[1]===Buffer.from(args[2]).toString('base64');throw Error('unexpected_rpc')};
const newGraph=()=>({async witnessFor(){return{schema:1}},storage:new Map(),head:'a'.repeat(64),get(k){return this.storage.get(k)},async put(k,x){return this.putMany([{id:k,value:x}])},async putMany(items){for(const {id,value} of items)this.storage.set(id,structuredClone(value));this.head='b'.repeat(63)+String(this.storage.size)}});
// ROD Core stand-in: HTTP JSON-RPC with Basic auth
async function rodStandIn(){
 const calls=[];const server=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;
  const auth=req.headers.authorization??'';const reply=(status,obj)=>{const b=JSON.stringify(obj);res.writeHead(status,{'content-type':'application/json','content-length':Buffer.byteLength(b)});res.end(b);};
  if(auth!=='Basic '+Buffer.from('rpcuser:rpc pass/+=').toString('base64'))return reply(401,{});
  const x=JSON.parse(body);calls.push(x.method);try{reply(200,{result:await fakeRpc(x.method,x.params),error:null,id:x.id});}catch(e){reply(500,{result:null,error:{code:-1,message:e.message},id:x.id});}});
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));return{url:`http://127.0.0.1:${server.address().port}/wallet/main`,calls,close:()=>new Promise(ok=>server.close(ok))};
}
function client({bin,hub,rod,i,runNonce,metaverseRoot='',captureScript='',dataDir='',onLine,env={}}){
 const actor='peer'+i,runId=`native-${4000+i}-1000${i}`;
 const child=spawn(bin,[hub.url,actor,addrs[i],runNonce,runId,'Glider-Peer'+i,rod.url,'rpcuser','rpc pass/+=',metaverseRoot,captureScript,dataDir,String(start)],{stdio:['pipe','pipe','inherit'],env:{...process.env,...env}});
 const events=[],wire=[];const rl=createInterface({input:child.stdout});
 rl.on('line',line=>{if(line.startsWith('EVENT ')){events.push(JSON.parse(line.slice(6)));return;}wire.push(line);onLine?.(line.split('\t'),child);});
 return{child,actor,runId,events,wire,send:o=>child.stdin.write(JSON.stringify(o)+'\n'),stop:()=>new Promise(ok=>{child.on('close',ok);child.stdin.end();setTimeout(()=>child.kill(),3000);})};
}
// plays the game plugin: acknowledges clock and spawns like the plugin does
const gameAnswers=(i,seen=new Set())=>(f,child)=>{
 const w=o=>child.stdin.write(JSON.stringify(o)+'\n');
 if(f[0]==='OSGTIME1')w({type:'OSG_TIME_ACK',mjd:Number(f[1])});
 if(f[0]==='OSGSPAWN4'){const [_,eventId,actor,nativeName]=f;const key=eventId+actor;if(seen.has(key))return;seen.add(key);
  w({type:actor==='peer'+i?'OSG_LOCAL_PORT_ACK':'OSG_SPAWN_ACK',actor,eventId,nativeName,created:true,simMjd:Number(f[8]),verifiedPort:true});}
};
test('the DLL hub client (C++) enrolls through the real hub, signs with the ROD RPC login, verifies the world root and publishes',async(t)=>{
 if(!haveGpp){t.skip('g++ not available');return;}
 const bin=build('native-hub-cli.cpp','hubcli');
 const world=new TestWorld({graph:newGraph(),rpc:fakeRpc,worldId,clock:clockPolicy,port,now:()=>start});const hub=await createV26Hub({world,rpc:fakeRpc,runNonce:'client-run'});const rod=await rodStandIn();
 await world.enroll({address:addrs[0],portId:port.portId,slot:'pad-1'});await world.enroll({address:addrs[1],portId:port.portId,slot:'pad-2'});
 const dataDir=join(work,'data0');const clients=[];
 try{
  for(let i=0;i<2;i++)clients.push(client({bin,hub,rod,i,runNonce:'client-run',dataDir:i===0?dataDir:'',onLine:gameAnswers(i)}));
  const diag=e=>{console.error('DIAGNOSTICS',JSON.stringify({events:clients.map(c=>c.events),wire:clients.map(c=>c.wire.map(l=>l.split('\t')[0])),rpc:rod.calls},null,2));throw e;};
  await until(()=>Object.keys(world.state.proofs).length===4).catch(diag);
  assert.ok(rod.calls.includes('signmessage')&&rod.calls.includes('verifymessage'),'the session challenge was signed by the wallet RPC');
  assert.ok(clients.every(c=>c.events.some(e=>e.type==='session_authenticated'&&e.worldId===worldId)));
  for(let i=0;i<2;i++)clients[i].send({type:'PHYSICS_SAMPLE',source:'native',capturedAtUnixMs:Date.now(),frameId:'metaverse-moon-relative-v26',runId:clients[i].runId,entityName:'Glider-Peer'+i,sequence:1,simMjd:clockPolicy.simMjd0,position:[100*i,0,0],velocity:[10,0,0],orientation:[0,0,0,1],mode:'FREEFLIGHT',surface:[0,0,0,0],contact:false});
  await until(()=>Object.keys(world.state.frames).length===2).catch(diag);
  // the event reaches the test through the client's output a moment after the hub committed the frame
  await until(()=>clients.every(c=>c.events.some(e=>e.type==='native_sample'))).catch(diag);
  // the root each client verified is the hub's own root of that moment
  {const hubRoot=(await fetch(hub.url+'/world').then(x=>x.json())).root;await until(()=>clients.every(c=>c.events.some(e=>e.type==='world_verified'&&e.root===hubRoot))).catch(diag);}
  // each client gets the other's committed motion as OSGVESSEL6, with the numbers the JS sidecar sent
  await until(()=>clients[0].wire.some(l=>l.startsWith('OSGVESSEL6\tpeer1\tGlider-Peer1\t'))).catch(diag);
  const m=clients[0].wire.find(l=>l.startsWith('OSGVESSEL6\tpeer1')).split('\t');assert.deepEqual([m[1],m[2],m[3],m[4]],['peer1','Glider-Peer1',clients[1].runId,'1']);assert.deepEqual(m.slice(6,9).map(Number),[100,0,0]);assert.deepEqual(m.slice(9,12).map(Number),[10,0,0]);
  assert.ok(clients[0].wire.some(l=>l.startsWith('OSGREMOTES1\t1\tpeer1\t')),'the verified remote set is sent');
  const session=JSON.parse(await readFile(join(dataDir,'replica-session.json'),'utf8'));assert.equal(session.schema,1);assert.equal(session.actor,'peer0');assert.match(session.token,/^[0-9a-f]{64}$/);
  // a ship leaves the world: the game is told through the set, the event is reported
  const gone=world.state.ships.peer1.eventId;
  await world.queue(async()=>{const next=structuredClone(world.state);delete next.ships.peer1;next.sequence++;await world.commit(next,'VESSEL_RESERVATION_EXPIRED',{actor:'peer1',eventId:gone,slot:'pad-2'});});
  await until(()=>clients[0].wire.some(l=>l.startsWith('OSGREMOTES1\t0'))).catch(diag);
  await until(()=>clients[0].events.some(e=>e.type==='native_remote_revoked'&&e.actor==='peer1'&&e.eventId===gone)).catch(diag);
 }finally{for(const c of clients)await c.stop();await hub.close();await rod.close();}
 await sleep(100);await assert.rejects(readFile(join(dataDir,'replica-session.json')),'the replica session file is removed on close');
});
test('the DLL hub client refuses a wrong RPC login and keeps retrying the session',async(t)=>{
 if(!haveGpp){t.skip('g++ not available');return;}
 const bin=build('native-hub-cli.cpp','hubcli');
 const world=new TestWorld({graph:newGraph(),rpc:fakeRpc,worldId,clock:clockPolicy,port,now:()=>start});const hub=await createV26Hub({world,rpc:fakeRpc,runNonce:'bad-login'});const rod=await rodStandIn();
 await world.enroll({address:addrs[0],portId:port.portId,slot:'pad-1'});
 const c=client({bin,hub,rod:{...rod,url:rod.url},i:0,runNonce:'bad-login',onLine:gameAnswers(0)});c.child.kill();
 const wrong=spawn(bin,[hub.url,'peer0',addrs[0],'bad-login','native-1-2','Glider-Peer0',rod.url,'rpcuser','WRONG','','','',String(start)],{stdio:['pipe','pipe','inherit']});const events=[];createInterface({input:wrong.stdout}).on('line',l=>{if(l.startsWith('EVENT '))events.push(JSON.parse(l.slice(6)));});
 try{await until(()=>events.filter(e=>e.type==='session_error').length>=2);assert.match(events[0].error,/ROD RPC HTTP 401 - the RPC login was refused/);assert.ok(!events.some(e=>e.type==='session_authenticated'));}
 finally{wrong.kill();await hub.close();await rod.close();}
});
test('scene proof: the DLL reads the saved scenario, validates the capture and commits it',async(t)=>{
 if(!haveGpp){t.skip('g++ not available');return;}
 const bin=build('native-hub-cli.cpp','hubcli');
 const world=new TestWorld({graph:newGraph(),rpc:fakeRpc,worldId,clock:clockPolicy,port,now:()=>start});const hub=await createV26Hub({world,rpc:fakeRpc,runNonce:'scene-run'});const rod=await rodStandIn();
 await world.enroll({address:addrs[0],portId:port.portId,slot:'pad-1'});await world.enroll({address:addrs[1],portId:port.portId,slot:'pad-2'});
 const metaverse=join(work,'metaverse'),dataDir=join(work,'scene-data');await mkdir(join(metaverse,'Scenarios','OSGSim'),{recursive:true});await mkdir(dataDir,{recursive:true});
 const clients=[];
 try{
  clients.push(client({bin,hub,rod,i:0,runNonce:'scene-run',metaverseRoot:metaverse,captureScript:'Capture.ps1',dataDir,onLine:gameAnswers(0)}));clients.push(client({bin,hub,rod,i:1,runNonce:'scene-run',onLine:gameAnswers(1)}));
  const diag=e=>{console.error('DIAGNOSTICS',JSON.stringify({events:clients.map(c=>c.events)},null,2));throw e;};
  await until(()=>Object.keys(world.state.proofs).length===4).catch(diag);
  const local=world.state.ships.peer0.nativeName,remote=world.state.ships.peer1.nativeName;
  await writeFile(join(metaverse,'Scenarios','OSGSim','Proof-peer0-scene-run.scn'),`BEGIN_SHIPS\n${local}:ShuttlePB\nEND\n${remote}:ShuttlePB\n`);
  await writeFile(join(dataDir,'Camera-peer0-scene-run.png'),png({}));
  clients[0].send({type:'OSG_SCENE_PROOF',remoteActor:'peer1',remoteName:remote,sceneFile:'OSGSim/Proof-peer0-scene-run',cameraTarget:remote,simMjd:clockPolicy.simMjd0});
  await until(()=>clients[0].events.some(e=>e.type==='native_scene_committed')||clients[0].events.some(e=>e.type==='native_error')).catch(diag);
  assert.ok(clients[0].events.some(e=>e.type==='native_scene_committed'),JSON.stringify(clients[0].events.filter(e=>e.type==='native_error')));
  assert.ok(clients[0].wire.includes('OSG_SCENE_ACK\tpeer1'.replace('\t','\t')),'the game is told the scene was committed');
  // a scene that does not contain the remote vessel is refused
  await writeFile(join(metaverse,'Scenarios','OSGSim','Proof-peer0-scene-run.scn'),`${local}:ShuttlePB\n`);
  clients[0].send({type:'OSG_SCENE_PROOF',remoteActor:'peer1',remoteName:remote,sceneFile:'OSGSim/Proof-peer0-scene-run',cameraTarget:remote,simMjd:clockPolicy.simMjd0});
  await until(()=>clients[0].events.some(e=>e.type==='native_error'&&e.error==='scene_missing_remote_native_vessel')).catch(diag);
  // a flat capture is refused
  await writeFile(join(metaverse,'Scenarios','OSGSim','Proof-peer0-scene-run.scn'),`${local}:ShuttlePB\n${remote}:ShuttlePB\n`);await writeFile(join(dataDir,'Camera-peer0-scene-run.png'),png({raw:Buffer.alloc((400*3+1)*300)}));
  clients[0].send({type:'OSG_SCENE_PROOF',remoteActor:'peer1',remoteName:remote,sceneFile:'OSGSim/Proof-peer0-scene-run',cameraTarget:remote,simMjd:clockPolicy.simMjd0});
  await until(()=>clients[0].events.some(e=>e.type==='native_error'&&e.error==='png_capture_blank_or_flat')).catch(diag);
 }finally{for(const c of clients)await c.stop();await hub.close();await rod.close();}
});

test('event throttle: identical events are written once per window, with the number dropped',(t)=>{
 if(!haveGpp){t.skip('g++ not available');return;}
 const out=helper()(['throttle a 0','throttle a 100','throttle a 200','throttle b 300','throttle a 30001','throttle a 30002']);
 assert.deepEqual(out,['write 0','drop 0','drop 0','write 0','write 2','drop 0']);
});
test('a slow scene capture runs off the hub loop: the world keeps being verified meanwhile',async(t)=>{
 if(!haveGpp){t.skip('g++ not available');return;}
 const bin=build('native-hub-cli.cpp','hubcli');
 const world=new TestWorld({graph:newGraph(),rpc:fakeRpc,worldId,clock:clockPolicy,port,now:()=>start});const hub=await createV26Hub({world,rpc:fakeRpc,runNonce:'slow-run'});const rod=await rodStandIn();
 await world.enroll({address:addrs[0],portId:port.portId,slot:'pad-1'});await world.enroll({address:addrs[1],portId:port.portId,slot:'pad-2'});
 const metaverse=join(work,'metaverse-slow'),dataDir=join(work,'slow-data');await mkdir(join(metaverse,'Scenarios','OSGSim'),{recursive:true});await mkdir(dataDir,{recursive:true});
 const clients=[];
 try{
  clients.push(client({bin,hub,rod,i:0,runNonce:'slow-run',metaverseRoot:metaverse,captureScript:'Capture.ps1',dataDir,onLine:gameAnswers(0),env:{SPEX_TEST_CAPTURE_MS:'2500'}}));clients.push(client({bin,hub,rod,i:1,runNonce:'slow-run',onLine:gameAnswers(1)}));
  const diag=e=>{console.error('DIAGNOSTICS',JSON.stringify({events:clients.map(c=>c.events)},null,2));throw e;};
  await until(()=>Object.keys(world.state.proofs).length===4).catch(diag);
  const local=world.state.ships.peer0.nativeName,remote=world.state.ships.peer1.nativeName;
  await writeFile(join(metaverse,'Scenarios','OSGSim','Proof-peer0-slow-run.scn'),`${local}:ShuttlePB\n${remote}:ShuttlePB\n`);await writeFile(join(dataDir,'Camera-peer0-slow-run.png'),png({}));
  const before=clients[0].events.filter(e=>e.type==='world_verified').length;const asked=Date.now();
  clients[0].send({type:'OSG_SCENE_PROOF',remoteActor:'peer1',remoteName:remote,sceneFile:'OSGSim/Proof-peer0-slow-run',cameraTarget:remote,simMjd:clockPolicy.simMjd0});
  await sleep(1800);
  const during=clients[0].events.filter(e=>e.type==='world_verified').length-before;
  assert.ok(during>=5,'world polls during the capture: '+during);
  assert.ok(!clients[0].events.some(e=>e.type==='native_scene_committed'),'the capture is still running');
  await until(()=>clients[0].events.some(e=>e.type==='native_scene_committed')).catch(diag);
  assert.ok(Date.now()-asked>=2400);
 }finally{for(const c of clients)await c.stop();await hub.close();await rod.close();}
});
// A hub whose world the test controls completely: RETIRED ships, refused sessions, missing owner proof.
async function controlledHub({ships,proofs={}}){
 const state={schema:26,worldId,clock:clockPolicy,port,sequence:1,eventHead:'e'.repeat(64),events:[],authorityRevision:1,ships,frames:{},proofs,nextActorId:9};
 const log={sessions:0,views:0,proofs:[],samples:0};let tokens=new Set(),refuseNext=false;
 const server=http.createServer(async(req,res)=>{let body='';for await(const c of req)body+=c;const u=new URL(req.url,'http://x');
  const reply=(status,obj)=>{const b=JSON.stringify(obj);res.writeHead(status,{'content-type':'application/json','content-length':Buffer.byteLength(b)});res.end(b);};
  if(u.pathname==='/world')return reply(200,{...state,root:worldRoot(state)});
  if(u.pathname==='/session-challenge')return reply(200,{id:'c'+log.sessions,nonce:'n'.repeat(40),address:addrs[0],worldId,actor:'peer0',runId:u.searchParams.get('runId')});
  if(u.pathname==='/session'){log.sessions++;const token=String(log.sessions).padStart(64,'0');tokens.add(token);return reply(200,{token,expiresAt:Date.now()+900000,ship:ships.peer0,world:{worldId}});}
  const auth=(req.headers.authorization??'').replace('Bearer ','');
  if(!tokens.has(auth))return reply(401,{error:'session_expired'});
  if(u.pathname==='/view'){log.views++;if(refuseNext){refuseNext=false;tokens.clear();return reply(401,{error:'session_expired'});}return reply(200,{...state,root:worldRoot(state),liveFrames:{}});}
  if(u.pathname==='/native-proof'){log.proofs.push(JSON.parse(body));return reply(200,{ok:true,root:worldRoot(state)});}
  if(u.pathname==='/sample'){log.samples++;return reply(200,{accepted:true,root:worldRoot(state)});}
  reply(404,{error:'unknown_route'});});
 await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
 return{url:`http://127.0.0.1:${server.address().port}`,log,state,refuse:()=>{refuseNext=true;},close:()=>new Promise(ok=>server.close(ok))};
}
const shipFor=(i,phase,slot)=>({actor:'peer'+i,owner:addrs[i%2],eventId:String(i).repeat(64),nativeName:'Glider-Peer'+i,vesselClass:'ShuttlePB',referenceBody:'Moon',portId:port.portId,slot,phase,worldId,asset:'ShuttlePB'});
test('hub client: RETIRED ships are neither spawned nor kept, an expired session is renewed, a lost owner proof re-attests with RESUME, a drifting game clock is refused',async(t)=>{
 if(!haveGpp){t.skip('g++ not available');return;}
 const bin=build('native-hub-cli.cpp','hubcli');const rod=await rodStandIn();
 const hub=await controlledHub({ships:{peer0:shipFor(0,'ACTIVE','pad-1'),peer1:shipFor(1,'ACTIVE','pad-2'),peer2:shipFor(2,'RETIRED','pad-3'),peer3:shipFor(3,'RESERVED','pad-4')}});
 const c=client({bin,hub,rod,i:0,runNonce:'controlled-run',onLine:gameAnswers(0)});
 const diag=e=>{console.error('DIAGNOSTICS',JSON.stringify({events:c.events,wire:c.wire,log:hub.log},null,2));throw e;};
 try{
  await until(()=>c.wire.some(l=>l.startsWith('OSGSPAWN4\t'+'1'.repeat(64)))).catch(diag);
  await sleep(400);
  assert.ok(!c.wire.some(l=>l.startsWith('OSGSPAWN4\t'+'2'.repeat(64))),'a RETIRED ship is not spawned');
  assert.ok(!c.wire.some(l=>l.startsWith('OSGSPAWN4\t'+'3'.repeat(64))),'a RESERVED remote ship is not spawned');
  assert.ok(c.wire.filter(l=>l.startsWith('OSGREMOTES1')).every(l=>l==='OSGREMOTES1\t1\tpeer1\t'+'1'.repeat(64)),'the set holds only the active remote ship');
  // own owner proof missing from the verified world: the running ship is re-attested without moving it
  await until(()=>c.wire.filter(l=>l.startsWith('OSGSPAWN4\t'+'0'.repeat(64))).length>=2).catch(diag);
  const resent=c.wire.filter(l=>l.startsWith('OSGSPAWN4\t'+'0'.repeat(64)))[1].split('\t');assert.equal(resent.at(-1),'RESUME');
  // the hub forgets the session: the next /view is refused with 401 and the client signs a new session
  const sessions=hub.log.sessions;hub.refuse();
  await until(()=>hub.log.sessions>sessions).catch(diag);
  const views=hub.log.views;await until(()=>hub.log.views>views+2).catch(diag);
  assert.equal(c.events.filter(e=>e.type==='session_authenticated').length,hub.log.sessions);
  // a game clock 2 s away from the world clock is refused
  c.send({type:'OSG_TIME_ACK',mjd:clockPolicy.simMjd0+2/86400});
  await until(()=>c.events.some(e=>e.type==='native_error'&&e.error==='native_clock_drift')).catch(diag);
 }finally{await c.stop();await hub.close();await rod.close();}
});
test('cleanup',async()=>{await rm(work,{recursive:true,force:true});});
