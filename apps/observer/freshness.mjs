// SPDX-License-Identifier: MIT
export function worldFeedFresh(info,{connected,live,runId,frameAgeMs,sourceAgeMs}){
  const budget=info?.freshness?.budgetMs??1000;
  return connected===true&&live===true&&info?.nativeConnected===true&&info?.osgHealthy===true&&
    runId===info.runId&&Number.isFinite(frameAgeMs)&&frameAgeMs>=0&&frameAgeMs<=budget&&
    Number.isFinite(sourceAgeMs)&&sourceAgeMs>=-250&&sourceAgeMs<=budget&&
    (info.freshness?.queues?.telemetry?.oldestAgeMs??0)<=budget;
}
