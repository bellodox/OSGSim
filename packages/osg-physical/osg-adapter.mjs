// SPDX-License-Identifier: MIT
// Optional, genuine OmniSpatialGraph adapter. Does not copy or modify upstream code.
import { existsSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256,validateEnvelope,assert } from '../world-protocol/index.mjs';

export class OsgAdapter {
  constructor({sourceDir,storeDir}) {this.sourceDir=sourceDir;this.storeDir=storeDir;this.store=null;this._commit=null;this.commits=[];}
  async open() {
    if(!this.sourceDir)throw new Error('OSG_SOURCE_DIR is required for genuine OSG persistence');
    const core=join(resolve(this.sourceDir),'dist/core/src/graph.js');
    const storage=join(resolve(this.sourceDir),'dist/storage-lance/src/index.js');
    if(!existsSync(core)||!existsSync(storage))throw new Error('OSG source must be built separately; missing dist entry points');
    const [{commit},{openStore}]=await Promise.all([import(pathToFileURL(core).href),import(pathToFileURL(storage).href)]);
    this.store=await openStore(this.storeDir,true); this._commit=commit;
    return this;
  }
  async appendObservedEvent(event,assetHash) {
    if(!this.store)throw new Error('OSG adapter not open');
    validateEnvelope(event);
    assert(typeof event.eventId==='string','OSG physical event requires eventId');
    const micros=Math.round((event.simTime??0)*1e6);
    assert(Number.isSafeInteger(micros),'simulation microseconds exceed OSG safe integer range');
    const id=sha256(JSON.stringify([event.runId,event.epoch,event.eventId,event.type]));
    const props={
      runId:event.runId, epoch:event.epoch, step:event.step, sequence:event.sequence,
      kind:event.type, eventId:event.eventId, entityId:event.entityId??'',
      simTimeMicros:micros,
      source:event.source??'native', assetHash:assetHash??'', frameId:event.frameId??'',
      transportAuthenticated:event.transportAuthenticated===true
    };
    const proposal={element_id:`phys:event:${id}`,kind:'physical_event',op:'assert',status:'observed',
      src:null,dst:null,predicate:null,extent:null,props,source_hash:assetHash??null,
      valid_from:null,valid_to:null,observed_at:Date.now()*1000};
    const result=await this._commit(this.store,[proposal],'osg-sim-adapter','main');
    this.commits.push(result.commitId);if(this.commits.length>128)this.commits.shift();
    return result;
  }
  /** Replay every durable journal entry. OSG commits are idempotent by element identity
   *  and content, so this repairs a crash between journal fsync and graph publish.
   *  This is a single-writer operation; call before accepting any new native samples.
   */
  async reconcile(entries) {
    if(!Array.isArray(entries))throw new Error('journal entries required');
    let processed=0,changed=0;
    for(const entry of entries) {
      if(!entry?.eventId || !['CONTACT_BEGIN','CONTACT_END','CHECKPOINT','SIMULATION_RESET','ENTITY_REMOVED'].includes(entry.type))continue;
      const result=await this.appendObservedEvent(entry,entry.assetHash??null);
      processed++;
      if(!result.noop && !result.idempotent)changed++;
    }
    return {processed,changed};
  }
  async verify() {
    if(!this.store)throw new Error('OSG adapter not open');
    const {verify}=await import(pathToFileURL(join(resolve(this.sourceDir),'dist/core/src/graph.js')).href);
    return verify(await this.store.rows());
  }
  async close() {if(this.store)await this.store.close?.();this.store=null;}
}
