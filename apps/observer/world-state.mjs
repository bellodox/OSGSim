// SPDX-License-Identifier: MIT
/** Expand only graph-committed observations; a snapshot replaces the selected epoch. */
export function worldFrames(message){
  if(!['OSG_WORLD_UPDATE','OSG_WORLD_SNAPSHOT'].includes(message.type))return [];
  const out=[];
  if(message.type==='OSG_WORLD_SNAPSHOT'&&message.runId!=null)out.push({type:'SIMULATION_RESET',runId:message.runId,epoch:message.epoch});
  for(const frame of message.frames??[]){
    const events=frame.events??[];
    out.push(...events.filter(e=>e.type==='SIMULATION_RESET'),frame.sample,...events.filter(e=>e.type!=='SIMULATION_RESET'));
  }
  // Reset already applied above. Historical contacts must not reset reconstructed state.
  out.push(...(message.events??[]).filter(e=>e.type!=='SIMULATION_RESET'));
  return out;
}
