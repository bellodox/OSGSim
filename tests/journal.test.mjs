import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {DurableJournal,AssetStore,encodeSample,decodeSample} from '../packages/osg-physical/journal.mjs';
import {makeEnvelope} from '../packages/world-protocol/index.mjs';
const contact=(step=1)=>makeEnvelope('CONTACT_BEGIN',{runId:'native-1',epoch:0,step,sequence:step,
  simTime:step/60,entityId:'vessel-A',source:'native',eventId:`begin-${step}`});
test('journal is hash chained, durable, idempotent and restart stable',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'osg-journal-'));const file=join(dir,'events.journal');
  try{
    const j=await new DurableJournal(file).open();await j.append(contact(1));await j.append(contact(2));
    assert.equal((await j.append(contact(1))).duplicate,true);
    await assert.rejects(j.append({...contact(1),simTime:999}),/different payload/);
    const head=j.head;await j.close();
    const replay=await new DurableJournal(file).open();assert.deepEqual(replay.head,head);
    assert.equal((await replay.entries()).length,2);await replay.close();
    const tampered=(await readFile(file,'utf8')).replace('CONTACT_BEGIN','CONTACT_END');
    await writeFile(file,tampered);await assert.rejects(new DurableJournal(file).open(),/checksum/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('asset store validates content hashes, stores precise IEEE-754 values',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'osg-asset-'));
  try{const store=new AssetStore(dir);const sample={simTime:1.125,simDt:.0625,position:[1e12+1.5,3,4],velocity:[5,6,7],orientation:[0,0,0,1]};
    const original=encodeSample(sample);const hash=await store.put(original);
    const decoded=decodeSample(await store.get(hash));assert.deepEqual(decoded.position,sample.position);
    assert.equal(await store.put(original),hash);
  }finally{await rm(dir,{recursive:true,force:true});}
});
