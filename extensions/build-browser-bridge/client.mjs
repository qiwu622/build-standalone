import {localBase,project,identityExpression,allowedCommands,filterEvent} from './protocol.mjs';

export class BridgeClient {
  constructor({chrome,fetcher=(...args)=>globalThis.fetch(...args)}){this.chrome=chrome;this.fetcher=fetcher;this.links=new Map();this.connecting=new Set();this.lastError='';}
  async post(base,path,body,token){
    const res=await this.fetcher(base+path,{method:'POST',credentials:'omit',redirect:'error',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body),signal:AbortSignal.timeout(25000)});
    const value=await res.json();if(!res.ok)throw new Error(value.error?.message||'本机连接失败');return value;
  }
  status(){return {connections:[...this.links.values()].map(s=>({tabId:s.tabId,email:s.email,base:s.base})),error:this.lastError};}
  async connect({base,code,tabId}){
    base=localBase(base);if(!/^[a-f0-9]{48}$/.test(code))throw new Error('请输入管理页生成的配对码，不是管理员密钥');
    if(this.links.has(tabId)||this.connecting.has(tabId))throw new Error('此标签页已连接或正在连接');
    const tab=await this.chrome.tabs.get(tabId),target=project(tab.url);this.connecting.add(tabId);let attached=false,session;
    try{
      await this.chrome.debugger.attach({tabId},'1.3');attached=true;
      const result=await this.chrome.debugger.sendCommand({tabId},'Runtime.evaluate',{expression:identityExpression,returnByValue:true});
      const identity=result.result?.value;
      if(!identity?.ready||!identity.email||project(identity.url).url!==target.url)throw new Error('请先正常登录 Google，打开专用 Build 项目并等待聊天输入框出现');
      const reply=await this.post(base,'/bridge/connect',{code,identity:{...identity,authUser:target.authUser}});
      session={tabId,base,token:reply.token,email:identity.email,target:target.url,events:[],tracked:new Set(),closed:false};
      this.links.set(tabId,session);this.lastError='';void this.loop(session);return {message:reply.message};
    }catch(e){if(attached)await this.chrome.debugger.detach({tabId}).catch(()=>{});throw e;}
    finally{this.connecting.delete(tabId);}
  }
  async disconnect(tabId,{notify=true}={}){
    const s=this.links.get(tabId);if(!s)return;this.links.delete(tabId);s.closed=true;
    if(notify)await this.post(s.base,'/bridge/disconnect',{},s.token).catch(()=>{});
    await this.chrome.debugger.detach({tabId}).catch(()=>{});s.token='';s.events=[];
  }
  event(source,method,params){
    const s=this.links.get(source.tabId);if(!s||source.sessionId)return;
    const event=filterEvent(method,params,s.tracked);if(event){s.events.push(event);if(s.events.length>100){this.lastError='扩展事件积压，已断开以避免返回不完整结果';void this.disconnect(s.tabId);}}
  }
  async command(s,command){
    if(s.closed||Date.now()>command.deadline||!allowedCommands.has(command.method))throw new Error('命令已失效或不受支持');
    const tab=await this.chrome.tabs.get(s.tabId);if(project(tab.url).url!==s.target)throw new Error('专用项目标签页已改变，已停止操作');
    // Never accept/dismiss security dialogs or navigate to other sites.
    if(command.method==='Page.handleJavaScriptDialog'&&command.params.accept!==false)throw new Error('不允许自动接受确认弹窗');
    const value=await this.chrome.debugger.sendCommand({tabId:s.tabId},command.method,command.params);
    return {id:command.id,value};
  }
  async loop(s){
    let results=[];
    try{while(!s.closed){
      const batch=await this.post(s.base,'/bridge/exchange',{results,events:s.events.splice(0)},s.token);results=[];
      for(const command of batch.commands||[]){if(s.closed)break;try{results.push(await this.command(s,command));}catch{throw new Error('专用标签页状态或浏览器命令异常；已断开，请检查页面后重新连接');}}
    }}catch(e){if(!s.closed){this.lastError=e.message;await this.disconnect(s.tabId);}}
  }
}
