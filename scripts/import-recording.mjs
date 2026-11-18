// SPDX-License-Identifier: MIT
// Import immutable recorder observations. Recorded action is not a live SDK contact proof.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {parsePosition,parseEvents} from '../packages/recorder/index.mjs';
import {AssetStore,DurableJournal,encodeSample} from '../packages/osg-physical/journal.mjs';
import {OsgAdapter} from '../packages/osg-physical/osg-adapter.mjs';
import {makeEnvelope,eventIdentity,sha256} from '../packages/world-protocol/index.mjs';
const prefix=resolve(process.argv[2]??'fixtures/recordings/Atlantis');
const dataDir=resolve(process.argv[3]??'.data-import');
await mkdir(dataDir,{recursive:true});
const [raw,actions]=await Promise.all([readFile(prefix+'.pos','utf8'),readFile(prefix+'.atc','utf8')]);
const {samples,metadata}=parsePosition(raw),events=parseEvents(actions);
const journal=await new DurableJournal(join(dataDir,'events.journal')).open();
const assets=new AssetStore(join(dataDir,'assets'));
let osg=null;
try {
  if(process.env.OSG_SOURCE_DIR)osg=await new OsgAdapter({sourceDir:process.env.OSG_SOURCE_DIR,storeDir:join(dataDir,'osg-store')}).open();
  if(journal.head.sequence>0) throw new Error('Target journal is nonempty; refuse duplicate or mixed-history import');
  const sourceAssets={pos:await assets.put(Buffer.from(raw)),atc:await assets.put(Buffer.from(actions))};
  const runId='recorder-'+sha256(JSON.stringify(sourceAssets)).slice(0,24);
  let sequence=0;
  const records=samples.map((sample,i)=>({type:'CHECKPOINT',time:sample.time,sample,step:i+1}));
  for(const e of events.filter(e=>e.kind==='LANDED'))records.push({type:'CONTACT_BEGIN',time:e.time,event:e,step:samples.length+records.length+1});
  records.sort((a,b)=>a.time-b.time||a.step-b.step);
  const receipts=[];
  for(const [i,entry] of records.entries()) {
    const assetHash=entry.sample?await assets.put(encodeSample({
      simTime:entry.sample.time,simDt:i===0?0:Math.max(0,entry.time-records[i-1].time),
      position:entry.sample.position,velocity:entry.sample.velocity
    })):null;
    const event=makeEnvelope(entry.type,{runId,epoch:0,step:i+1,sequence:++sequence,
      simTime:entry.time,simDt:i===0?0:Math.max(0,entry.time-records[i-1].time),
      source:'recorded',frameId:'recorded-'+metadata.frame.toLowerCase(),entityId:'Atlantis',
      recordingSourceHashes:sourceAssets,
      ...(entry.event?{recordedAction:{kind:entry.event.kind,detail:entry.event.detail,line:entry.event.line}}:{}),
      eventId:eventIdentity({runId,epoch:0,step:i+1,type:entry.type,entityId:'Atlantis'}),
      ...(assetHash?{assetHash}:{})});
    const receipt=await journal.append(event);
    const graph=osg?await osg.appendObservedEvent(event,assetHash):null;
    receipts.push({time:entry.time,type:entry.type,eventId:event.eventId,assetHash,journalHash:receipt.hash,osgCommit:graph?.commitId??null});
  }
  const report={status:osg?'OSG_IMPORTED':'JOURNAL_ONLY',source:prefix,sourceHash:sha256(raw),sourceAssets,
    sampleCount:samples.length,eventCount:receipts.length,records:receipts,
    journalHead:journal.head,osgVerifier:osg?await osg.verify():null};
  await writeFile(join(dataDir,'import-report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(`Imported ${receipts.length} immutable recorder records; OSG ${osg?'enabled':'not configured'}; hash ${journal.head.hash}`);
}finally {await journal.close();await osg?.close();}
