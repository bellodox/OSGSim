// SPDX-License-Identifier: MIT
// Browser-independent reducer: one selected vessel, one physical run/epoch.
export function applyNativeFrame(state,data){
 if(!['PHYSICS_SAMPLE','WORLD_INIT','SIMULATION_RESET','CONTACT_BEGIN','CONTACT_END'].includes(data.type))return {};
 const key=`${data.runId}/${data.epoch}`;
 let reset=false;
 if(data.type==='SIMULATION_RESET'||(['PHYSICS_SAMPLE','WORLD_INIT'].includes(data.type)&&state.nativeRunKey!==key)){
  state.nativeRunKey=key;state.lastNative=null;state.nativeOrigin=null;
  state.selectedEntity=state.requestedEntity??null;state.heightReference=0;state.events=[];reset=true;
 }
 if(data.type==='SIMULATION_RESET')return {reset};
 if(state.nativeRunKey!==key)return {};
 if(['PHYSICS_SAMPLE','WORLD_INIT'].includes(data.type)){
  state.selectedEntity??=data.entityId;
  if(data.entityId!==state.selectedEntity)return {reset};
  state.lastNative=data;
  if(!state.nativeOrigin){state.nativeOrigin=data.position.slice();state.heightReference=Math.hypot(...data.position);}
  return {reset,sample:true};
 }
 return {reset,event:data.entityId===state.selectedEntity};
}
