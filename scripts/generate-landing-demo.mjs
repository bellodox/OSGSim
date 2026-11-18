#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Synthetic renderer fixture only. Never report these frames as SDK/contact evidence.
import {writeFile} from 'node:fs/promises';
import {sphere,tangent,transpose,mm,mv,add} from '../packages/landing-scene/math.mjs';
import {matrixToQuaternion} from '../packages/sg4d/index.mjs';
const radius=1737400,longitude=.1,latitude=.2,terrain={version:1,id:'demo-moon-reference',bodyName:'Moon',radius,longitude,latitude,spacing:24,size:9,elevationLevel:0,heights:Array(81).fill(0)};
const basis=tangent(longitude,latitude),origin=sphere(longitude,latitude,radius),bodyPosition=[1e11,2e10,-3e10],orientation=matrixToQuaternion(mm(transpose(basis),[[1,0,0],[0,1,0],[0,0,-1]]));
const frames=[];
for(let i=0;i<=160;i++){
 const t=i/10,u=t/16,h=38*(1-3*u*u+2*u*u*u)+1.5,vy=38*(-6*u+6*u*u)/16;
 const visual={version:1,vesselClass:'ShuttlePB',bodyName:'Moon',bodyRadius:radius,bodyPosition,bodyOrientation:[0,0,0,1],sunPosition:add(bodyPosition,mv(transpose(basis),[9e10,1.2e11,-4e10])),main:0,hover:t<15.5?.35:0,animations:[.5,.5,.5],terrainId:terrain.id};
 frames.push({version:1,type:'WORLD_INIT',source:'illustrative',runId:'synthetic-landing-demo',entityId:'demo-ShuttlePB',entityName:'ShuttlePB · synthetic renderer fixture',epoch:0,step:i+1,sequence:i+1,simTime:t,simDt:.1,frameId:'metaverse-global-ecliptic',position:add(bodyPosition,add(origin,mv(transpose(basis),[0,h,0]))),velocity:mv(transpose(basis),[0,vy,0]),orientation,contact:t===16,visual});
}
await writeFile('fixtures/landing/demo.json',JSON.stringify({version:1,provenance:'SYNTHETIC_RENDERER_FIXTURE_NOT_NATIVE_SIMULATION',description:'Actual pinned ShuttlePB geometry/textures; analytic descent and zero-elevation Moon reference for browser acceptance only.',terrain,frames})+'\n');
