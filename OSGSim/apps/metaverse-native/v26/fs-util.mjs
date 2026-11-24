// SPDX-License-Identifier: MIT
// The two small helpers every module here needs: sleep and a crash-safe file replace.
import {mkdir,writeFile,rename,open,readdir,rm} from 'node:fs/promises';
import {dirname,basename} from 'node:path';

export const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

// A crash between the write and the rename leaves a temporary file of a process that no longer exists. Remove those
// (only those: a temporary file of a running process is never touched).
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code==='EPERM';}};
async function removeOrphans(file){
 const dir=dirname(file),prefix=basename(file)+'.';
 try{for(const name of await readdir(dir)){
  const m=name.startsWith(prefix)&&/^(\d+)\.(?:\d+\.)?tmp$/.exec(name.slice(prefix.length));
  if(m&&Number(m[1])!==process.pid&&!alive(Number(m[1])))await rm(dir+'/'+name,{force:true});
 }}catch{}
}

// Write to a temporary file of its own (process id + counter, so overlapping writes never share one), then rename it
// over the target. sync: fsync the file data first. syncDir: fsync the parent directory afterwards (unsupported
// directory handles, e.g. on Windows, are ignored; real file-data errors are not). A failed write removes its temporary file.
let counter=0;const swept=new Set();   // each file's orphans are removed on its first write in this process
export async function atomicWriteFile(file,text,{mode=0o600,sync=false,syncDir=false}={}){
 await mkdir(dirname(file),{recursive:true});
 if(!swept.has(file)){swept.add(file);await removeOrphans(file);}
 const temp=file+'.'+process.pid+'.'+(++counter)+'.tmp';
 try{
  if(sync){const handle=await open(temp,'w',mode);try{await handle.writeFile(text);await handle.sync();}finally{await handle.close();}}
  else await writeFile(temp,text,{mode});
  await rename(temp,file);
 }catch(e){await rm(temp,{force:true}).catch(()=>{});throw e;}
 if(syncDir){
  try{const dir=await open(dirname(file),'r');try{await dir.sync();}finally{await dir.close();}}
  catch(e){if(!['EINVAL','EPERM','EACCES','ENOTSUP','EISDIR'].includes(e.code))throw e;}
 }
}
