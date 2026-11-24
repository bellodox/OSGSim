// 28.0.1: orphan temporary files, failed writes, and the bootstrap NTP path through queryNtp.
import test from 'node:test';import assert from 'node:assert/strict';import dgram from 'node:dgram';
import {mkdtemp,writeFile,readFile,readdir,mkdir} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';import {spawnSync} from 'node:child_process';
import {atomicWriteFile} from '../OSGSim/apps/metaverse-native/v26/fs-util.mjs';
import {readNtpOffset,disciplineBootstrapClock} from '../OSGSim/apps/metaverse-native/v26/single-address/bootstrap-clock.mjs';

test('atomicWriteFile removes temporary files of dead processes, keeps those of live ones, and cleans up after a failed write',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'spex-fsutil-'));const file=join(dir,'state.json');
 const dead=spawnSync(process.execPath,['-e','process.stdout.write(String(process.pid))']);const deadPid=Number(dead.stdout.toString());
 await writeFile(file+'.'+deadPid+'.tmp','x');await writeFile(file+'.'+deadPid+'.7.tmp','x');   // both naming schemes
 await writeFile(file+'.'+process.ppid+'.1.tmp','live');await writeFile(join(dir,'other.json.'+deadPid+'.tmp'),'other file');
 await atomicWriteFile(file,'{"a":1}\n');
 assert.equal(await readFile(file,'utf8'),'{"a":1}\n');
 assert.deepEqual((await readdir(dir)).sort(),['other.json.'+deadPid+'.tmp','state.json','state.json.'+process.ppid+'.1.tmp'].sort());
 const target=join(dir,'is-a-directory');await mkdir(target);
 await assert.rejects(()=>atomicWriteFile(target,'x'));
 assert.ok(!(await readdir(dir)).some(n=>n.startsWith('is-a-directory.')&&n.endsWith('.tmp')),'a failed write leaves no temporary file');
});

test('bootstrap NTP: a device clock far off is reported as out of bounds, not as unreachable servers',async()=>{
 const NTP=2208988800;let offsetMs=0;const s=dgram.createSocket('udp4');
 const put=(b,i,ms)=>{const t=ms/1000+NTP;b.writeUInt32BE(Math.floor(t),i);b.writeUInt32BE(Math.floor((t%1)*0x100000000),i+4);};
 s.on('message',(m,r)=>{const o=Buffer.alloc(48);o[0]=0x24;o[1]=2;m.copy(o,24,40,48);const now=Date.now()+offsetMs;put(o,32,now);put(o,40,now);s.send(o,r.port,r.address);});
 await new Promise((ok,bad)=>{s.once('error',bad);s.bind(0,'127.0.0.1',ok);});const port=s.address().port;
 const query=host=>readNtpOffset(host,{port});
 try{
  offsetMs=600000;const near=await disciplineBootstrapClock(['localhost','127.0.0.1'],{query});
  assert.ok(Math.abs(near.offsetMs-600000)<500,'ten minutes off is measured');
  offsetMs=7200000;const far=await readNtpOffset('127.0.0.1',{port});assert.ok(Math.abs(far.offsetMs-7200000)<500,'the query itself does not cap the offset');
  await assert.rejects(()=>disciplineBootstrapClock(['localhost','127.0.0.1'],{query}),/bootstrap_NTP_uncertainty_out_of_bounds/);
 }finally{s.close();}
});
