// SPDX-License-Identifier: MIT
// Independent source process: service load cannot delay this sampling timer.
import net from 'node:net';
const [port,vessels,duration]=process.argv.slice(2).map(Number);
const socket=net.createConnection({port,host:'127.0.0.1'});socket.setNoDelay(true);
let sequence=0,step=0;
socket.once('connect',()=>{
 const timer=setInterval(()=>{step++;for(let entity=1;entity<=vessels;entity++){
  const capturedAtUnixMs=Date.now();sequence++;
  socket.write(JSON.stringify({version:1,wireFormat:2,type:'PHYSICS_SAMPLE',source:'native',runId:'load-run',epoch:0,step,sequence,simTime:step*.02,simDt:.02,frameId:'global',entityId:'vessel-'+entity,entityName:'Vessel '+entity,capturedAtUnixMs,position:[100+step/100,entity,0],velocity:[.5,0,0],contact:Math.floor(step/25)%2===1})+'\n');
 }},20);
 setTimeout(()=>{clearInterval(timer);process.send?.({finished:sequence});socket.end();},duration);
});
socket.on('error',error=>{console.error(error.message);process.exitCode=1;});socket.on('close',()=>process.disconnect?.());
