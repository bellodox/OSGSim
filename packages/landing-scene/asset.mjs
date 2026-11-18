// SPDX-License-Identifier: MIT
import {assert} from '../world-protocol/primitives.mjs';
export const STRIDE=18;
export function encodeSplats(splats){
  const buffer=new ArrayBuffer(16+splats.length*STRIDE*4),bytes=new Uint8Array(buffer);
  bytes.set(new TextEncoder().encode('OSGSPL1'));const view=new DataView(buffer);view.setUint32(8,splats.length,true);view.setUint32(12,STRIDE,true);
  let offset=16;for(const s of splats)for(const v of [...s.center,...s.scale,...s.rotation,...s.color,...s.normal,s.group??0]){assert(Number.isFinite(v),'nonfinite asset');view.setFloat32(offset,v,true);offset+=4;}
  return new Uint8Array(buffer);
}
export function decodeSplats(buffer){
  const bytes=buffer instanceof Uint8Array?buffer:new Uint8Array(buffer),view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  assert(bytes.length>=16&&new TextDecoder().decode(bytes.subarray(0,7))==='OSGSPL1','invalid splat asset');
  const count=view.getUint32(8,true);assert(count<=250000&&view.getUint32(12,true)===STRIDE&&bytes.length===16+count*STRIDE*4,'invalid splat asset size');
  const splats=[];for(let i=0;i<count;i++){
    const a=Array.from({length:STRIDE},(_,j)=>view.getFloat32(16+(i*STRIDE+j)*4,true));assert(a.every(Number.isFinite),'nonfinite asset');
    assert(a.slice(3,6).every(x=>x>0)&&Math.abs(Math.hypot(...a.slice(6,10))-1)<1e-3&&a.slice(10,14).every(x=>x>=0&&x<=1),'invalid splat attributes');
    splats.push({center:a.slice(0,3),scale:a.slice(3,6),rotation:a.slice(6,10),color:a.slice(10,14),normal:a.slice(14,17),group:a[17]});
  }return splats;
}
