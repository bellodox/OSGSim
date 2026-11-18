import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {DurableJournal} from '../packages/osg-physical/journal.mjs';
test('recorder importer creates real immutable source hashes/checkpoints and rejects ambiguous reimport',async()=>{
  const dataDir=await mkdtemp(join(tmpdir(),'osg-import-'));
  try {
    const args=['scripts/import-recording.mjs','fixtures/recordings/Atlantis',dataDir];
    execFileSync(process.execPath,args,{stdio:'pipe'});
    const report=JSON.parse(await readFile(join(dataDir,'import-report.json'),'utf8'));
    assert.equal(report.status,'JOURNAL_ONLY');
    assert.ok(report.sampleCount>20);assert.equal(report.eventCount,report.sampleCount+1);
    assert.ok(report.records.some(r=>r.type==='CONTACT_BEGIN'));
    const j=await new DurableJournal(join(dataDir,'events.journal')).open();
    assert.equal((await j.entries()).length,report.eventCount);await j.close();
    assert.throws(()=>execFileSync(process.execPath,args,{stdio:'pipe'}),/Command failed/);
  } finally {await rm(dataDir,{recursive:true,force:true});}
});
