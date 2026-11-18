// SPDX-License-Identifier: MIT
/** One storage publication at a time; bounded queues and weighted fairness for source traffic. */
export class ServiceScheduler {
  constructor(){this.queues={telemetry:[],background:[]};this.running=false;this.waiters=[];this.turns=0;}
  enqueue(fn,priority='telemetry'){
    const queue=this.queues[priority];
    if(!queue||queue.length>=(priority==='telemetry'?1024:128))return Promise.reject(Object.assign(Error('Service queue is full'),{code:'ACTIVITY_BUSY'}));
    const result=new Promise((resolve,reject)=>queue.push({fn,resolve,reject,enqueued:Date.now()}));
    if(!this.running){this.running=true;setImmediate(()=>this.pump());}return result;
  }
  async pump(){
    while(this.queues.telemetry.length||this.queues.background.length){
      const source=this.queues.telemetry.length&&(this.turns<64||!this.queues.background.length);
      const job=(source?this.queues.telemetry:this.queues.background).shift();this.turns=source?this.turns+1:0;
      try{job.resolve(await job.fn());}catch(error){job.reject(error);}
      // Let the TCP pump enqueue its next accepted frame before selecting another background job.
      await new Promise(resolve=>setImmediate(resolve));
    }
    this.running=false;for(const resolve of this.waiters.splice(0))resolve();
  }
  idle(){return this.running?new Promise(resolve=>this.waiters.push(resolve)):Promise.resolve();}
  get status(){return Object.fromEntries(Object.entries(this.queues).map(([key,queue])=>[key,{pending:queue.length,oldestAgeMs:queue.length?Date.now()-queue[0].enqueued:0}]));}
}
