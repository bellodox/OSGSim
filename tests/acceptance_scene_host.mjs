// Synthetic acceptance host: real service/OSG transport, never native DLL evidence.
import {createWorldServer} from '../apps/world-service/server.mjs';
import {readFile} from 'node:fs/promises';
import {createInterface} from 'node:readline';
const demo=JSON.parse(await readFile('fixtures/landing/demo.json','utf8'));
const native=process.argv.includes('--native');
const world=process.argv.includes('--world')||native;
const app=await createWorldServer({httpPort:0,bridgePort:native?4378:0,dataDir:process.env.OSG_DATA_DIR,landingDemo:!world,osgWorldMode:world,osgMultiSourceDir:process.env.OSG_MULTI_SOURCE_DIR,worldBatchMs:250});
let index=0;
async function publish(end){
 for(;index<end;index++){
  const sample={...structuredClone(demo.frames[index]),type:'PHYSICS_SAMPLE',source:'native',capturedAtUnixMs:Date.now()};
  if(index===0)sample.visual.terrain=demo.terrain;
  await app.handleSample(sample);
 }
 await app.flushWorld();
}
if(world&&!native)await publish(100);
console.log(JSON.stringify({httpPort:app.httpPort,bridgePort:app.bridgePort}));
const lines=createInterface({input:process.stdin});
for await(const line of lines){
 if(line==='publish'){await publish(161);console.log('PUBLISHED');}
 if(line==='stop'){lines.close();break;}
}
await app.close();console.log('CLOSED');
