// SPDX-License-Identifier: MIT
// Deterministic MSHX1 surface sampling; no reconstruction training or proprietary code.
import {assert} from '../world-protocol/primitives.mjs';
import {add,sub,mul,cross,unit,frameFromNormal} from './math.mjs';

export function parseMesh(text){
  const lines=text.split(/\r?\n/).map(l=>l.replace(/;.*/,'').trim()).filter(Boolean);assert(lines.shift()==='MSHX1','MSHX1 mesh required');
  const groups=[],materials=[],textures=[];let material=1,texture=0,i=0;
  while(i<lines.length){
    const line=lines[i++],parts=line.split(/\s+/),tag=parts[0];
    if(tag==='MATERIAL'&&/^\d+$/.test(parts[1]))material=Number(parts[1]);
    else if(tag==='TEXTURE')texture=Number(parts[1]);
    else if(tag==='GEOM'){
      const nv=Number(parts[1]),nt=Number(parts[2]);assert(nv>0&&nv<=200000&&nt>=0&&nt<=400000,'mesh geometry exceeds limit');
      const vertices=lines.slice(i,i+nv).map(l=>l.split(/\s+/).map(Number));i+=nv;
      const triangles=lines.slice(i,i+nt).map(l=>l.split(/\s+/).map(Number));i+=nt;
      assert(vertices.length===nv&&triangles.length===nt,'truncated mesh');
      vertices.forEach(v=>assert(v.length>=3&&v.every(Number.isFinite),'invalid mesh vertex'));
      triangles.forEach(t=>assert(t.length===3&&t.every(x=>Number.isInteger(x)&&x>=0&&x<nv),'invalid mesh index'));
      groups.push({vertices,triangles,material,texture});
    }else if(tag==='MATERIAL'&&!/^\d+$/.test(parts[1])){
      const values=lines.slice(i,i+4).map(l=>l.split(/\s+/).map(Number));i+=4;
      assert(values.every(v=>v.length>=4&&v.every(Number.isFinite)),'invalid mesh material');materials.push({name:parts.slice(1).join(' '),diffuse:values[0],emission:values[3]});
    }else if(tag==='TEXTURES'){
      const n=Number(parts[1]);for(let k=0;k<n;k++){const name=lines[i++].split(/\s+/)[0];assert(/^[A-Za-z0-9_.-]+\.dds$/i.test(name),'unsupported texture path');textures.push(name);}
    }
  }
  assert(groups.length>0,'empty mesh');return {groups,materials,textures};
}

/** Decode mip zero of DXT1/3/5 DDS textures, including DXT5 alpha. */
export function decodeDDS(input){
  const b=input instanceof Uint8Array?input:new Uint8Array(input),d=new DataView(b.buffer,b.byteOffset,b.byteLength);
  assert(b.length>=128&&d.getUint32(0,true)===0x20534444,'invalid DDS');
  const height=d.getUint32(12,true),width=d.getUint32(16,true),format=new TextDecoder().decode(b.subarray(84,88));
  assert(width>0&&height>0&&width<=8192&&height<=8192&&['DXT1','DXT3','DXT5'].includes(format),'unsupported DDS format');
  const blockBytes=format==='DXT1'?8:16,rgba=new Uint8Array(width*height*4);let offset=128;
  const rgb565=v=>[(v>>11&31)*255/31,(v>>5&63)*255/63,(v&31)*255/31];
  for(let by=0;by<height;by+=4)for(let bx=0;bx<width;bx+=4){
    assert(offset+blockBytes<=b.length,'truncated DDS');const colorOffset=offset+(blockBytes===16?8:0);
    const ca=d.getUint16(colorOffset,true),cb=d.getUint16(colorOffset+2,true),c0=rgb565(ca),c1=rgb565(cb);
    const opaque=ca>cb||format!=='DXT1',palette=[c0,c1,c0.map((v,i)=>(opaque?2*v+c1[i]:v+c1[i])/(opaque?3:2)),opaque?c0.map((v,i)=>(v+2*c1[i])/3):[0,0,0]];
    const indices=d.getUint32(colorOffset+4,true);let alphaBits=0n,alpha=[];
    if(format==='DXT5'){
      const a=b[offset],c=b[offset+1];alpha=[a,c];for(let k=1;k<=(a>c?6:4);k++)alpha.push(((a>c?7:5)-k)*a/(a>c?7:5)+k*c/(a>c?7:5));if(a<=c)alpha.push(0,255);
      for(let k=0;k<6;k++)alphaBits|=BigInt(b[offset+2+k])<<BigInt(k*8);
    }else if(format==='DXT3')for(let k=0;k<8;k++)alphaBits|=BigInt(b[offset+k])<<BigInt(k*8);
    for(let k=0;k<16;k++){
      const x=bx+k%4,y=by+Math.floor(k/4);if(x>=width||y>=height)continue;const index=indices>>>(2*k)&3,o=(y*width+x)*4;
      rgba.set(palette[index].map(Math.round),o);
      rgba[o+3]=format==='DXT5'?Math.round(alpha[Number(alphaBits>>BigInt(3*k)&7n)]):format==='DXT3'?Number(alphaBits>>BigInt(4*k)&15n)*17:(!opaque&&index===3?0:255);
    }offset+=blockBytes;
  }
  return {width,height,rgba,sample(u,v){const x=Math.min(width-1,Math.max(0,Math.floor(u*width))),y=Math.min(height-1,Math.max(0,Math.floor(v*height))),o=(y*width+x)*4;return Array.from(rgba.subarray(o,o+4),v=>v/255);}};
}

export function meshToSplats(mesh,textures,{spacing=.105,maxSplats=100000}={}){
  assert(Number.isFinite(spacing)&&spacing>=.01&&spacing<=2,'invalid splat spacing');
  const out=[];const linear=v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4;
  for(const [group,g] of mesh.groups.entries())for(const triangle of g.triangles){
    const v=triangle.map(i=>g.vertices[i]),p=v.map(x=>x.slice(0,3)),e1=sub(p[1],p[0]),e2=sub(p[2],p[0]);
    const n=cross(e1,e2),area=Math.hypot(...n)*.5;if(area<1e-9)continue;
    const normal=unit(n),longest=Math.max(Math.hypot(...e1),Math.hypot(...e2),Math.hypot(...sub(p[2],p[1]))),steps=Math.max(1,Math.ceil(longest/spacing));
    const diffuse=mesh.materials[g.material-1]?.diffuse??[1,1,1,1],tex=textures[g.texture-1];
    for(let a=0;a<steps;a++)for(let c=0;c<steps-a;c++){
      // Centroids of a deterministic barycentric triangular lattice.
      for(const w of [[(a+1/3)/steps,(c+1/3)/steps],...(a+c<steps-1?[[(a+2/3)/steps,(c+2/3)/steps]]:[])]){
        const weights=[1-w[0]-w[1],w[0],w[1]],center=[0,1,2].map(j=>v.reduce((s,x,i)=>s+x[j]*weights[i],0));
        const uv=[6,7].map(j=>v.reduce((s,x,i)=>s+(x[j]??0)*weights[i],0)),color=tex?tex.sample(...uv):[1,1,1,1];
        if(color[3]*diffuse[3]<.01)continue;
        const sigma=Math.max(.008,Math.sqrt(area/(steps*steps))*.72);
        out.push({center,normal,rotation:frameFromNormal(normal),scale:[sigma,sigma,.008],color:[...color.slice(0,3).map((x,i)=>linear(x)*diffuse[i]),color[3]*diffuse[3]*.97],group});
        assert(out.length<=maxSplats,'mesh splat budget exceeded');
      }
    }
  }return out;
}
