import test from 'node:test';import assert from 'node:assert/strict';
import net from 'node:net';import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';import {join,dirname} from 'node:path';
const base=dirname(fileURLToPath(import.meta.url));
async function port(){const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}
function child(path,args){const p=spawn(process.env.OSGSIM_TEST_PYTHON??'python3',[path,...args],{stdio:['pipe','pipe','pipe']});let lines=[],waiters=[];const rl=createInterface({input:p.stdout});rl.on('line',line=>{if(waiters.length)waiters.shift()(line);else lines.push(line)});let errors='';p.stderr.on('data',buf=>errors+=String(buf));return {p,async next(timeoutMs=5000){if(lines.length)return lines.shift();return Promise.race([new Promise(resolve=>waiters.push(resolve)),new Promise((_,reject)=>setTimeout(()=>reject(Error('NO_FRAME '+errors)),timeoutMs))])},stop(){p.kill();rl.close()}}}
test('REAL pyzmq PUB/SUB delivers ROD three-part game-event topic, JSON and little-endian sequence',async()=>{
 const n=await port();const publisher=child(join(base,'rod-zmq-publisher-fixture.py'),[String(n)]);
 let subscriber=null;
 try{
  assert.equal(await publisher.next(),'READY');
  subscriber=child(join(base,'../OSGSim/apps/metaverse-native/v26/rod-game/native-zmq.py'),[`tcp://127.0.0.1:${n}`,'osgsimv26']);
  assert.equal(JSON.parse(await subscriber.next()).ready,true);
  // PUB/SUB subscriptions require real transport handshake before first send.
  await new Promise(r=>setTimeout(r,300));
  const event={topic:'game-pending-move json osgsimv26',data:{txid:'a'.repeat(64),name:'alice',move:{v:1}},sequence:4294967294};
  publisher.p.stdin.write(JSON.stringify(event)+'\n');assert.equal(await publisher.next(),'SENT');
  const got=JSON.parse(await subscriber.next());assert.deepEqual(got,event);
  const block={topic:'game-block-attach json osgsimv26',data:{block:{hash:'b'.repeat(64),parent:'c'.repeat(64)},moves:[]},sequence:1};
  publisher.p.stdin.write(JSON.stringify(block)+'\n');assert.equal(await publisher.next(),'SENT');assert.deepEqual(JSON.parse(await subscriber.next()),block);
 }finally{publisher.stop();subscriber?.stop()}
});
