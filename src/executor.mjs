import {join} from 'node:path';
import {BuildChatWorker} from './build-chat.mjs';
import {BuildFileContext} from './build-file-context.mjs';
import {makeAttachmentContext} from './build-attachment-context.mjs';
import {AppError,checkAbort,error} from './errors.mjs';

export class BuildExecutor {
  constructor({config,browsers,pool,store,log}){Object.assign(this,{config,browsers,pool,store,log});}
  async execute(input,{signal,requestId,deadline}) {
    checkAbort(signal);
    const request={request_id:requestId,model:input.alias,thinkingLevel:input.resolved.thinkingLevel,deadline:deadline??(this.config.requestTimeoutMs>0?Date.now()+this.config.requestTimeoutMs:Infinity)};
    const abort=()=>{request.aborted=true;request.abortStatus=signal.reason?.status||499;request.abortReason=signal.reason?.message||'请求已取消';};
    signal.addEventListener('abort',abort,{once:true});
    try {
      // Validate file expansion before starting any browser or selecting an account.
      const {buildInput}=await import('./build-chat.mjs');
      makeAttachmentContext(buildInput(input.body));
      await this.pool.sync(this.store.accounts);
      if(this.browsers.online&&!this.store.accounts.some(a=>a.enabled!==false&&this.browsers.online(a.id)))throw error('没有在线的浏览器扩展；请先在常用浏览器连接专用 Build 项目',503,'extension_disconnected');
      request.accountAvailable=this.browsers.online?id=>this.browsers.online(id):undefined;
      const text=await this.pool.run(input.resolved.model,request,async account=>{
        checkAbort(signal);request.accountId=account.id;
        request.stage='account_verification';
        return this.browsers.withPage(account,signal,async send=>{
          const worker=new BuildChatWorker({cdp:action=>action(send),pool:this.pool,diagnostics:this.log});
          worker.current=request;worker.accountId=account.id;
          worker.contextTransport=new BuildFileContext(worker,{directory:join(this.config.dataDir,'context')});
          try{return await worker.generateOne(input.alias,input.body,request);}
          catch(e){if(signal.aborted)throw signal.reason;throw e;}
        });
      });
      checkAbort(signal);return {text,accountId:request.accountId,contextMode:request.contextMode,thinkingLevel:request.thinkingLevel,googleThinkingLevel:request.googleThinkingLevel,upstreamModel:request.upstreamModel};
    }catch(e){e.stage ||= request.stage;e.accountId ||= request.accountId;await this.log?.record({event:'execution_failed',requestId,model:input.alias,accountId:request.accountId,stage:request.stage,status:e.status,code:e.code,cleanupCode:e.cleanupCode,message:e instanceof AppError?e.message:undefined,submitted:request.submitted});throw e;}
    finally{signal.removeEventListener('abort',abort);}
  }
}
// Explicit demo only. No Google/browser calls or quota. Never used as live fallback.
export class DemoExecutor {
  async execute(input,{signal}) {
    checkAbort(signal);
    await new Promise((resolve,reject)=>{
      const done=()=>{signal.removeEventListener('abort',abort);resolve();};
      const timer=setTimeout(done,20),abort=()=>{clearTimeout(timer);reject(signal.reason||error('已取消',499));};
      signal.addEventListener('abort',abort,{once:true});
    });
    return {text:`[DEMO / 未调用 Google] ${input.resolved.model} · ${input.resolved.thinkingLevel}\n${input.body.contents.findLast(m=>m.role==='user').parts.map(p=>p.text).join('\n')}`,contextMode:'demo',thinkingLevel:input.resolved.thinkingLevel};
  }
}
