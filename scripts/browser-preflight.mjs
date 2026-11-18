import {spawnSync} from 'node:child_process';
const run=spawnSync(process.env.PYTHON??(process.platform==='win32'?'python':'python3'),['scripts/test_browser_live.py'],{stdio:'inherit'});
if(run.error){console.error(`BROWSER_NOT_VERIFIED: ${run.error.message}`);process.exitCode=2;}
else process.exitCode=run.status??1;
