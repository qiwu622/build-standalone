import {checkAbort,error} from './errors.mjs';
export class Scheduler {
  constructor(maxQueue=8){this.maxQueue=maxQueue;this.busy=false;this.queue=[];this.closed=false;}
  run(fn,signal) {
    checkAbort(signal);
    if(this.closed)return Promise.reject(error('服务正在关闭',503,'shutdown'));
    if(this.busy&&this.queue.length>=this.maxQueue)return Promise.reject(error('请求队列已满',503,'queue_full'));
    return new Promise((resolve,reject)=>{
      const job={fn,signal,resolve,reject};
      job.abort=()=>{const i=this.queue.indexOf(job);if(i>=0){this.queue.splice(i,1);reject(signal.reason);}};
      signal?.addEventListener('abort',job.abort,{once:true});
      this.queue.push(job);void this.pump();
    });
  }
  async pump(){
    if(this.busy)return;const job=this.queue.shift();if(!job)return;
    this.busy=true;job.signal?.removeEventListener('abort',job.abort);
    try {checkAbort(job.signal);job.resolve(await job.fn());}catch(e){job.reject(e);}finally{this.busy=false;void this.pump();}
  }
  close(){this.closed=true;for(const job of this.queue.splice(0)){job.signal?.removeEventListener('abort',job.abort);job.reject(error('服务正在关闭',503,'shutdown'));}}
}
