import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DurableJournal,AssetStore} from '../packages/osg-physical/journal.mjs';
import {makeEnvelope,sha256} from '../packages/world-protocol/index.mjs';
const event=i=>makeEnvelope('CHECKPOINT',{runId:'concurrency-fixture',epoch:0,step:i,sequence:i,
 simTime:i*.02,simDt:.02,entityId:'vessel-1',source:'recorded',eventId:`checkpoint-${i}`});
test('concurrent journal writers are serialized and every entry is valid after restart',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'osg-durable-'));const file=join(dir,'events.journal');
 try {
  const journal=await new DurableJournal(file).open();
  await Promise.all(Array.from({length:40},(_,i)=>journal.append(event(i+1))));
  assert.equal(journal.head.sequence,40);
  await journal.close();
  const restored=await new DurableJournal(file).open();
  assert.equal((await restored.entries()).length,40);
  assert.equal(restored.head.sequence,40);
  await restored.close();
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('assets cannot be overwritten by corrupt content with a forged content-hash filename',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'osg-assets-'));
 try {
   const assets=new AssetStore(dir),blob=Buffer.from('immutable-state');
   const hash=await assets.put(blob);assert.deepEqual(await assets.get(hash),blob);
   await writeFile(join(dir,hash.slice(0,2),hash),'tampered');
   await assert.rejects(assets.put(blob),/preexisting asset hash mismatch/);
   await assert.rejects(assets.get(hash),/asset hash mismatch/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
