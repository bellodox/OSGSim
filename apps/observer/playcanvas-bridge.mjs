// SPDX-License-Identifier: MIT
// Optional PlayCanvas renderer. Network or a locally provisioned engine asset is required.
// Do not claim a GPU test passed merely because this module exists.
export async function createPlayCanvasScene(canvas, status) {
  const moduleUrl = '/apps/observer/playcanvas.mjs';
  let pc;
  try {pc = await import(moduleUrl);} catch {
    pc = await import('https://cdn.jsdelivr.net/npm/playcanvas@2.24.0/build/playcanvas.mjs');
  }
  if(!pc.Application || !pc.GSplatContainer || !pc.GSplatFormat) throw new Error('PlayCanvas Engine missing required GSplat API');
  const app=new pc.Application(canvas, {graphicsDeviceOptions:{antialias:true}});
  app.setCanvasFillMode(pc.FILLMODE_NONE);app.setCanvasResolution(pc.RESOLUTION_AUTO);
  const camera=new pc.Entity('Observer Camera');
  camera.addComponent('camera',{clearColor:new pc.Color(0.035,0.063,0.082),fov:58,nearClip:.03,farClip:200});
  app.root.addChild(camera);
  const sun=new pc.Entity('Physical Study Light');
  sun.addComponent('light',{type:'directional',color:new pc.Color(.7,.86,.85),intensity:1.3,castShadows:false});
  sun.setEulerAngles(45,-30,0);app.root.addChild(sun);
  const terrain=new pc.Entity('Reference Surface');
  terrain.addComponent('render',{type:'box'});terrain.setLocalScale(35,.12,35);terrain.setPosition(0,-.09,0);app.root.addChild(terrain);
  const probe=new pc.Entity('Reconstructed Vessel Proxy');
  probe.addComponent('render',{type:'capsule'});probe.setLocalScale(.7,1.2,.7);
  app.root.addChild(probe);
  const format=pc.GSplatFormat.createSimpleFormat(app.graphicsDevice);
  const splats=new pc.GSplatContainer(app.graphicsDevice,64,format);
  const visual=new pc.Entity('4D Contact Event Field');
  visual.addComponent('gsplat',{resource:splats});app.root.addChild(visual);
  const centerTexture=splats.getTexture('dataCenter');
  const colorTexture=splats.getTexture('dataColor');
  // Deterministic time slicing: never derive physical event appearance from wall-clock time.
  const math=(i,t)=>{const a=i*2.399963229728653,rad=.11+.75*Math.sqrt((i+.5)/40);return [Math.cos(a)*rad,Math.sin(a*2+t*.25)*.09,Math.sin(a)*rad];};
  function update({height=0,azimuth=36,zoom=1,contact=0,simTime=0,available=true}) {
    probe.enabled=available;contact=available?contact:0;
    const y=.35+Math.min(12,Math.max(0,height/1400));
    probe.setPosition(0,y,0);
    camera.setPosition(Math.sin(azimuth*Math.PI/180)*12/zoom,8/zoom,Math.cos(azimuth*Math.PI/180)*12/zoom);
    camera.lookAt(0,3,0);
    const n=contact>0?40:0;
    if(n>0) {
      const centers=centerTexture.lock(), colors=colorTexture.lock();
      for(let i=0;i<n;i++) {
        const [x,dy,z]=math(i,simTime);const scale=contact;
        centers[4*i]=x*scale;centers[4*i+1]=dy;centers[4*i+2]=z*scale;centers[4*i+3]=.12+scale*.08;
        splats.centers[3*i]=centers[4*i];splats.centers[3*i+1]=centers[4*i+1];splats.centers[3*i+2]=centers[4*i+2];
        colors[4*i]=pc.FloatPacking.float2Half(.93);
        colors[4*i+1]=pc.FloatPacking.float2Half(.57);
        colors[4*i+2]=pc.FloatPacking.float2Half(.22);
        colors[4*i+3]=pc.FloatPacking.float2Half(.35*contact);
      }
      centerTexture.unlock();colorTexture.unlock();
    }
    splats.aabb=new pc.BoundingBox(new pc.Vec3(0,0,0),new pc.Vec3(2,2,2));
    splats.update(n,true); // CPU centers used for sorting and culling
  }
  app.start();update({});
  status?.('PLAYCANVAS WEBGL · EXPERIMENTAL');
  return {update,destroy(){app.destroy();}};
}
