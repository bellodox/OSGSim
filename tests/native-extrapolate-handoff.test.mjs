// The DLL's extrapolate() (native/spexgsp-rod/V26Wire.hpp) must give the numbers of the Node implementation it replaced.
// fixtures/extrapolate-golden.json holds the positions recorded from that implementation (405 cases: random free-flight and
// landed states from 7.5 s behind to 22.5 s ahead, plus the capped, behind and landed edge cases).
import test from 'node:test';import assert from 'node:assert/strict';
import {join} from 'node:path';import {tmpdir} from 'node:os';
import {readFile} from 'node:fs/promises';
import {execFileSync,spawnSync} from 'node:child_process';

test('DLL extrapolate() (C++) gives exactly the recorded numbers of the former Node implementation',async(t)=>{
 if(spawnSync('g++',['--version']).status!==0){t.skip('g++ not available');return;}
 const out=join(tmpdir(),'spex-native-extrapolate-'+process.pid);
 const root=new URL('..',import.meta.url).pathname;
 execFileSync('g++',['-std=c++17','-O1','-o',out,join(root,'tests','native-extrapolate-cli.cpp')]);
 const {cases}=JSON.parse(await readFile(join(root,'fixtures','extrapolate-golden.json'),'utf8'));
 assert.equal(cases.length,405);
 const input=cases.map(c=>[c.simMjd,...c.p,...c.v,c.landed?1:0,c.now].join(' ')).join('\n')+'\n';
 const result=spawnSync(out,{input,encoding:'utf8'});assert.equal(result.status,0);
 const lines=result.stdout.trim().split('\n');assert.equal(lines.length,cases.length);
 cases.forEach((c,i)=>assert.deepEqual(lines[i].split(' ').map(Number),c.expected,'case '+i));
 // The edge cases, as numbers: unchanged at the sample time, advanced 2 s, capped at 10 s, never backwards, landed stays.
 const edge=lines.slice(-5).map(l=>l.split(' ').map(Number));
 assert.deepEqual(edge[0],[1000,2000,3000]);
 assert.deepEqual(edge[1].map(x=>Math.round(x*1000)/1000),[1020,1960,3060]);
 assert.deepEqual(edge[2],[1100,1800,3300]);
 assert.deepEqual(edge[3],[1000,2000,3000]);
 assert.deepEqual(edge[4],[1000,2000,3000]);
});
