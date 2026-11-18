// SPDX-License-Identifier: MIT
// Explicit integration gate: unlike the portable suite, never silently skips missing OSG.
import {spawnSync} from 'node:child_process';
import {access} from 'node:fs/promises';
import {join,resolve} from 'node:path';
if(!process.env.OSG_MULTI_SOURCE_DIR)throw Error('Set OSG_MULTI_SOURCE_DIR to the built osg-multi checkout');
await access(join(resolve(process.env.OSG_MULTI_SOURCE_DIR),'dist/core/src/participation.js'));
const result=spawnSync(process.execPath,['--test','tests/world-integration.test.mjs','tests/world-activities.test.mjs','tests/audit-fixes.test.mjs'],{stdio:'inherit',env:process.env});
if(result.error)throw result.error;
process.exitCode=result.status??1;
