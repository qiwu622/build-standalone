import {localBase,project,identityExpression,allowedCommands,filterEvent} from './protocol.mjs';

export class BridgeClient {
  constructor({chrome,fetcher=(...args)=>globalThis.fetch(...args)}){this.chrome=chrome;this.fetcher=fetcher;this.links=new Map();this.connecting=new Set();this.accountProofs=new Map();this.lastError='';}
  async probeAccount(authUser,{force=false,deadline=Date.now()+20000}={}){
    authUser=String(authUser);if(!/^\d{1,2}$/.test(authUser))throw new Error('Google 账号索引无效');
    const cached=this.accountProofs.get(authUser);
    if(!force&&cached&&Date.now()-cached.at<30000)return cached.identity;
    this.accountProofs.delete(authUser);
    // The editor has no account button. Verify on a fresh, background Build
    // home tab in the same browser/account slot; never trust a remembered email.
    const tab=await this.chrome.tabs.create({url:'https://aistudio.google.com/apps?hl=en&authuser='+authUser,active:false});
    try{
      while(Date.now()<deadline-500){
        let identity;
        try{identity=await this.chrome.tabs.sendMessage(tab.id,{action:'build-read-identity'},{frameId:0});}catch{/* content script may still be loading */}
        if(identity){
          const actual=await this.chrome.tabs.get(tab.id),u=new URL(actual.url);
          const index=/^\/u\/(\d+)\//.exec(u.pathname)?.[1]||u.searchParams.get('authuser')||'0';
          if(u.protocol!=='https:'||u.hostname!=='aistudio.google.com'||u.port||u.username||u.password||!/^\/(?:u\/\d+\/)?apps\/?$/.test(u.pathname)||index!==authUser||identity.url!==actual.url||identity.authUser!==authUser)throw new Error('Google 账号核对页面发生变化');
          if(identity.accountAmbiguous)throw new Error('Google 账号标识不唯一，请关闭账号切换菜单');
          if(identity.accountControlFound&&identity.email){
            this.accountProofs.set(authUser,{at:Date.now(),identity});return identity;
          }
        }
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      throw new Error('Build 主页账号核对超时，请确认 Google 登录或官方验证已完成后重新接入');
    }finally{await this.chrome.tabs.remove(tab.id).catch(()=>{});}
  }
  async readIdentity(tabId,{force=false,deadline}={}){
    const target=project((await this.chrome.tabs.get(tabId)).url);
    const result=await this.chrome.debugger.sendCommand({tabId},'Runtime.evaluate',{expression:identityExpression,returnByValue:true});
    const identity=result.result?.value;
    if(identity?.accountAmbiguous)throw new Error('Google 账号标识不唯一');
    if(!identity?.ready||project(identity.url).url!==target.url)throw new Error('专用 Build 项目尚未就绪');
    if(!identity.email){
      const proof=await this.probeAccount(target.authUser,{force,deadline});
      Object.assign(identity,{email:proof.email,hasPlan:proof.hasPlan,identitySource:'build-home'});
    }
    if(project((await this.chrome.tabs.get(tabId)).url).url!==target.url)throw new Error('核对账号时专用项目发生变化');
    return result;
  }
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
      const result=await this.readIdentity(tabId,{force:true});
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
    const isIdentity=command.method==='Runtime.evaluate'&&command.params.expression===identityExpression;
    const value=isIdentity?await this.readIdentity(s.tabId,{force:command.params.buildForceIdentity===true,deadline:command.deadline}):await this.chrome.debugger.sendCommand({tabId:s.tabId},command.method,command.params);
    if(isIdentity&&value.result?.value?.email?.toLowerCase()!==s.email.toLowerCase())throw new Error('Google 登录账号发生变化，已停止操作');
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
