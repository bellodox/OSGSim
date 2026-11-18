// SPDX-License-Identifier: MIT
// Verify PINNED immutable upstream checkouts, never edit them.
import {execFileSync} from 'node:child_process';
const sources=[['Metaverse','3264a944196c48a39d14beab7dafdd10c6918461','METAVERSE_SOURCE_DIR'],
  ['OmniSpatialGraph','bb087f2e5c4e208b5a6cc3000af9b2fe554ecb26','OSG_SOURCE_DIR']];
let errors=0;
for(const [name,expected,env] of sources){
  const dir=process.env[env];
  if(!dir){console.error(`${name}: NOT_VERIFIED: set ${env}`);errors++;continue;}
  try{
    const sha=execFileSync('git',['-C',dir,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
    const changes=execFileSync('git',['-C',dir,'status','--porcelain'],{encoding:'utf8'}).trim();
    if(sha!==expected || changes){errors++;console.error(`${name}: MISMATCH sha=${sha} dirty=${!!changes}`);}
    else console.log(`${name}: PIN VERIFIED ${sha} CLEAN`);
  }catch(e){console.error(`${name}: ${e.message}`);errors++;}
}
if(errors)process.exitCode=2;
