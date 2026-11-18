import {platform,arch} from 'node:process';
if(platform!=='win32'||arch!=='x64') {
  console.error('BLOCKED_ENVIRONMENT: actual Metaverse 0.1.6a Windows x64 DLL build/load and simulator physics comparison must be run by the user.');
  process.exitCode=2;
}else{
  console.error('NOT_VERIFIED: Windows detected, but real Metaverse native runtime evidence and DLL loading must still be supplied.');
  process.exitCode=2;
}
