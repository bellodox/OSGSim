// SPDX-License-Identifier: MIT
import {assert,finite,vec3,quat} from '../world-protocol/primitives.mjs';
const name=(v,label)=>assert(typeof v==='string'&&v.length>0&&v.length<=128&&!/[\u0000-\u001f]/.test(v),`invalid ${label}`);
export function validateTerrain(t){
  assert(t&&t.version===1,'unsupported terrain version');name(t.id,'terrain id');name(t.bodyName,'terrain body');
  finite(t.longitude,'terrain longitude');finite(t.latitude,'terrain latitude');finite(t.radius,'terrain radius');finite(t.spacing,'terrain spacing');
  assert(Math.abs(t.latitude)<=Math.PI/2&&Math.abs(t.longitude)<=Math.PI&&t.radius>0&&t.radius<=1e10,'invalid terrain coordinates');
  assert(Number.isInteger(t.size)&&t.size>=3&&t.size<=33&&t.size%2===1&&t.spacing>0&&t.spacing<=10000,'invalid terrain grid');
  assert(Array.isArray(t.heights)&&t.heights.length===t.size*t.size,'terrain grid length mismatch');
  for(const v of t.heights)assert(Number.isFinite(v)&&Math.abs(v)<t.radius/2,'invalid terrain height');
  assert(Number.isInteger(t.elevationLevel)&&t.elevationLevel>=0&&t.elevationLevel<=32,'invalid elevation level');
  if(t.albedo!=null){assert(Array.isArray(t.albedo)&&t.albedo.length===t.heights.length*3,'terrain albedo length mismatch');for(const v of t.albedo)assert(Number.isFinite(v)&&v>=0&&v<=1,'invalid terrain albedo');}
  return t;
}
export function validateVisual(v){
  assert(v&&v.version===1,'unsupported visual version');name(v.vesselClass,'vessel class');name(v.bodyName,'surface body');
  finite(v.bodyRadius,'body radius');assert(v.bodyRadius>0&&v.bodyRadius<=1e10,'invalid body radius');
  vec3(v.bodyPosition,'body position');quat(v.bodyOrientation,'body orientation');vec3(v.sunPosition,'sun position');
  for(const key of ['main','hover'])assert(Number.isFinite(v[key])&&v[key]>=0&&v[key]<=1,`invalid ${key} level`);
  assert(Array.isArray(v.animations)&&v.animations.length===3,'invalid wing animations');for(const x of v.animations)assert(Number.isFinite(x)&&x>=0&&x<=1,'invalid wing animation');
  if(v.exhausts!=null){
    assert(Array.isArray(v.exhausts)&&v.exhausts.length<=32,'invalid exhaust list');
    for(const e of v.exhausts){assert(e&&typeof e==='object','invalid exhaust');vec3(e.position,'exhaust position');vec3(e.direction,'exhaust direction');assert(Math.abs(Math.hypot(...e.direction)-1)<1e-3,'invalid exhaust direction');assert(Number.isFinite(e.length)&&e.length>0&&e.length<=10000&&Number.isFinite(e.width)&&e.width>0&&e.width<=1000&&Number.isFinite(e.level)&&e.level>=0&&e.level<=1,'invalid exhaust dimensions');}
  }
  if(v.terrainId!=null)name(v.terrainId,'terrain id');
  if(v.terrainHash!=null)assert(/^[a-f0-9]{64}$/.test(v.terrainHash),'invalid terrain hash');
  if(v.terrain){validateTerrain(v.terrain);assert(v.terrain.id===v.terrainId&&v.terrain.bodyName===v.bodyName&&v.terrain.radius===v.bodyRadius,'terrain identity mismatch');}
  return v;
}
