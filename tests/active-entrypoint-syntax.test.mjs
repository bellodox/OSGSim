// SPDX-License-Identifier: MIT
// Entry scripts are run, not imported, by most tests; a syntax error in one would otherwise ship unnoticed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const entrypoints=[
 'OSGSim/scripts/spexgsp-rod-peer.mjs',
 'OSGSim/scripts/spexgsp-rod-player.mjs',
 'OSGSim/scripts/spexgsp-create-universe.mjs',
 'scripts/verify-release.mjs',
 'scripts/make-manifest.mjs',
];
test('every launcher-run entrypoint parses as shipped',()=>{
 for(const relative of entrypoints){
  let result;
  try{result=execFileSync(process.execPath,['--check',resolve(root,relative)],{encoding:'utf8',timeout:6000});}
  catch(e){assert.fail(`${relative} is not executable: ${e.stderr??e.message}`)}
  assert.equal(result,'',`${relative} emitted unexpected syntax output`);
 }
});
