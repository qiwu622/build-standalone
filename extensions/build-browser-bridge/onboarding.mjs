import {localBase,project,identityExpression} from './protocol.mjs';

const home='https://aistudio.google.com/apps?hl=en';
const loginURL='https://accounts.google.com/AccountChooser?continue='+encodeURIComponent(home);
const googleURL=value=>{const u=new URL(value);if(u.protocol!=='https:'||!['aistudio.google.com','ai.studio'].includes(u.hostname)||u.username||u.password||u.port)throw new Error('页面不属于 Google Build');return u;};
const accountIndex=value=>{const u=googleURL(value);return /^\/u\/(\d+)\//.exec(u.pathname)?.[1]||u.searchParams.get('authuser')||'0';};
const atHome=value=>/^\/(?:u\/\d+\/)?apps\/?$/.test(googleURL(value).pathname);
export function forAccount(url,index){const u=new URL(project(url).url);u.pathname=u.pathname.replace(/^\/u\/\d+\//,'/');u.searchParams.set('authuser',index);u.searchParams.set('hl','en');return u.href;}
const message={login:'等待你在常用浏览器完成 Google 登录',initializing:'正在新建专用 Build 项目（仅提交一次）',creating:'等待 Google 完成专用项目初始化',reuse:'正在打开已记住的专用项目',connected:'账号、专用项目和扩展已自动接入',cancelled:'已取消接入'};

export class Onboarding {
  constructor({chrome,client,now=Date.now}){
    Object.assign(this,{chrome,client,now});this.jobs={};this.locks=new Set();this.starting=new Set();
    this.ready=chrome.storage.session.get('onboardingJobs').then(v=>{this.jobs=v.onboardingJobs||{};});
    this.write=Promise.resolve();
  }
  async save(){const value=structuredClone(this.jobs);this.write=this.write.catch(()=>{}).then(()=>this.chrome.storage.session.set({onboardingJobs:value}));await this.write;}
  async start({base,code,adminTabId}){
    await this.ready;base=localBase(base);
    if(this.starting.has(base))throw new Error('正在开始接入，请勿重复点击');
    this.starting.add(base);
    try{return await this.startAuthorized({base,code,adminTabId});}finally{this.starting.delete(base);}
  }
  async startAuthorized({base,code,adminTabId}){
    const active=Object.values(this.jobs).find(j=>j.base===base&&!['connected','error','cancelled'].includes(j.stage)&&j.expiresAt>this.now());
    if(active)throw new Error('已有接入流程，请先完成或取消');
    if(Object.values(this.jobs).some(j=>j.base===base&&j.created&&!j.projectURL))throw new Error('上次创建结果尚未确认，请先检查已打开的 Build 标签页；为避免重复消耗额度，不会再次自动新建');
    const capability=await this.client.post(base,'/bridge/authorize',{code});
    if(!capability.allowCreate)throw new Error('请使用管理页的“登录并自动接入”');
    for(const [id,j] of Object.entries(this.jobs))if(j.base===base||j.expiresAt<this.now())delete this.jobs[id];
    const tab=await this.chrome.tabs.create({url:loginURL,active:true});
    this.jobs[tab.id]={tabId:tab.id,adminTabId,base,code,startedAt:this.now(),expiresAt:capability.expiresAt,projects:capability.projects,stage:'login',created:false};
    await this.save();return this.status(base);
  }
  async status(base){
    await this.ready;const jobs=[];let changed=false;
    for(const job of Object.values(this.jobs).filter(j=>j.base===base)){
      let notice=job.notice;
      if(!['connected','error','cancelled'].includes(job.stage)){
        if(job.expiresAt<=this.now()){
          job.stage='error';job.error='接入凭据已过期，请重新开始；已创建的专用项目会保留';job.code='';changed=true;
        }else{
          try{
            const tab=await this.chrome.tabs.get(job.tabId);
            if(!tab)throw new Error('closed');
            const elapsed=this.now()-(job.lastSeenAt||job.startedAt||job.expiresAt-1200000);
            if(elapsed>15000&&!job.lastSeenAt){
              let inBuild=false;try{googleURL(tab.url);inBuild=true;}catch{}
              notice=inBuild?'已打开 Build，但尚未收到页面回报。重新加载扩展后，请刷新这个 Build 标签页；并确认扩展已获准在 AI Studio 运行。':'等待原接入标签页返回 Build。若你已在其他标签页登录，请回到自动打开的标签页刷新。';
            }else if(job.lastSeenAt&&elapsed>30000){
              notice='Build 页面回报已中断。请回到本次接入标签页并刷新；不要关闭它或取消扩展调试连接。';
            }
          }catch{job.stage='error';job.error='本次接入标签页已关闭，请重新开始';job.code='';changed=true;}
        }
      }
      jobs.push({tabId:job.tabId,stage:job.stage,email:job.email||null,message:job.error||notice||message[job.stage]||'等待 Build 页面就绪'});
    }
    if(changed)await this.save();return {jobs};
  }
  async cancel(base){await this.ready;for(const j of Object.values(this.jobs))if(j.base===base&&!['connected','error','cancelled'].includes(j.stage)){j.stage='cancelled';j.code='';}await this.save();}
  async remember(job,url){
    job.projectURL=project(url).url;
    const data=await this.chrome.storage.local.get('dedicatedProjects'),items=data.dedicatedProjects||[];
    const filtered=items.filter(p=>!(p.base===job.base&&p.email.toLowerCase()===job.email.toLowerCase()));
    filtered.push({base:job.base,email:job.email,url:job.projectURL});await this.chrome.storage.local.set({dedicatedProjects:filtered});await this.save();
  }
  async pulse(tabId,state){
    await this.ready;const job=this.jobs[tabId];if(!job||this.locks.has(tabId)||job.stage==='connected')return;
    this.locks.add(tabId);
    try{
      const tab=await this.chrome.tabs.get(tabId);if(tab.url!==state.url)return;googleURL(tab.url);
      job.lastSeenAt=this.now();
      // Google assigns the project URL before its editor renders an account
      // control (often it never does). Save this one creation result early.
      let assigned;try{assigned=project(state.url);}catch{}
      if(assigned&&job.email&&job.created&&['creating','error','cancelled'].includes(job.stage)){
        if(job.authUser!==undefined&&assigned.authUser!==job.authUser)throw new Error('专用项目的 Google 账号索引发生变化');
        if(!job.projectURL)await this.remember(job,assigned.url);
        else if(job.projectURL!==assigned.url)throw new Error('创建过程中项目发生变化，已停止');
      }
      if(['error','cancelled'].includes(job.stage))return;
      if(!['error','cancelled'].includes(job.stage)&&job.expiresAt<=this.now())throw new Error('登录接入已超时，请在管理页重新开始；不会重复自动创建项目');
      if(state.observerError){job.notice='Build 页面识别脚本发生错误，请重新加载本机连接器并刷新这个 Build 标签页';await this.save();return;}
      if(!state.email&&!state.accountAmbiguous&&assigned&&job.email&&['creating','reuse'].includes(job.stage)){
        if(assigned.url!==job.projectURL)throw new Error('打开的项目与已登记专用项目不一致');
        if(state.error&&!state.running)throw new Error('Google 项目初始化或加载报错，请查看当前标签页；已保留项目地址');
        if(!state.ready||state.running||(job.stage==='creating'&&!state.creationReplyReady)){
          job.readyObservations=0;job.notice='专用项目已保存，等待 Google 完成初始化';await this.save();return;
        }
        job.notice='专用项目已就绪，正在通过 Build 主页核对 Google 账号';await this.save();
        const proof=await this.client.probeAccount(assigned.authUser);
        if(['error','cancelled'].includes(job.stage))return;
        if((await this.chrome.tabs.get(tabId)).url!==state.url)throw new Error('核对账号时专用项目发生变化');
        state={...state,email:proof.email};
      }
      if(!state.email){
        job.notice=state.accountAmbiguous?'页面出现多个账号标识，无法确认当前账号，请关闭账号切换菜单后重试':state.accountControlFound?'已看到 Google 账号控件，但未读取到当前邮箱；请检查右上角账号菜单并刷新 Build 页面':'Build 页面已打开，但尚未识别到 Google 账号控件；请确认页面已加载并完成登录或官方验证';
        await this.save();return;
      }
      delete job.notice;
      if(job.email&&job.email.toLowerCase()!==state.email.toLowerCase())throw new Error('接入过程中 Google 账号发生变化，请重新开始');
      if(!job.email){job.email=state.email;job.authUser=accountIndex(state.url);await this.save();}
      if(job.stage==='login'){
        if(state.introNoticeVisible){job.notice='Google 的首次使用介绍仍遮住页面，请在 Build 页点击 Skip（跳过），接入会自动继续';await this.save();return;}
        // A local service restart invalidates its capability. Check again
        // before any provisioning inference, rather than failing after it.
        const capability=await this.client.post(job.base,'/bridge/authorize',{code:job.code});
        if(['error','cancelled'].includes(job.stage))return;
        if(!capability.allowCreate)throw new Error('自动接入凭据已失效，请重新开始');
        const local=await this.chrome.storage.local.get('dedicatedProjects');
        const saved=(local.dedicatedProjects||[]).find(p=>p.base===job.base&&p.email.toLowerCase()===job.email.toLowerCase())||job.projects.find(p=>p.email.toLowerCase()===job.email.toLowerCase());
        if(saved){job.projectURL=project(forAccount(saved.url,accountIndex(state.url))).url;job.stage='reuse';await this.save();await this.chrome.tabs.update(tabId,{url:forAccount(saved.url,accountIndex(state.url))});return;}
        if(state.initializing&&atHome(state.url)){
          if(!state.hasPlan){job.notice='等待 Google AI Pro／Ultra 订阅标识，请确认登录账号';await this.save();return;}
          delete job.notice;
          // Persist before any send. After uncertain interruption, never repeat
          // the provisioning inference automatically and consume more quota.
          job.stage='initializing';job.created=true;await this.save();
          await this.provision(job);if(job.stage==='cancelled')return;job.stage='creating';await this.save();return;
        }
        if(state.ready)throw new Error('当前不是本次新建的专用项目，已停止以保护原项目');
        job.notice='已识别 Google 账号，等待 Build 创建输入框。请保持当前标签页，检查是否有地区、验证或欢迎页面；界面需为英文。';await this.save();
        return;
      }
      if(job.stage==='initializing')throw new Error('项目创建步骤被中断，请检查刚才的 Build 标签页；不会自动重复提交');
      if(job.stage==='reuse'&&atHome(state.url))throw new Error('已登记项目未能打开，请检查访问权限；不会自动重复创建');
      let current;try{current=project(state.url).url;}catch{return;}
      if(job.stage==='creating'){
        // Remember as soon as Google assigns a project ID, even before it is
        // ready, so an interrupted initial inference cannot create duplicates.
        if(!job.projectURL)await this.remember(job,current);
        else if(job.projectURL!==current)throw new Error('创建过程中项目发生变化，已停止');
      }
      if(current!==job.projectURL)throw new Error('打开的项目与已登记专用项目不一致');
      if(state.error&&!state.running)throw new Error('Google 项目初始化或加载报错，请查看当前标签页；已保留项目地址');
      if(!state.ready||state.running){job.readyObservations=0;return;}
      if(job.stage==='creating'){
        if(!state.creationReplyReady){job.readyObservations=0;return;}
        job.readyObservations=(job.readyObservations||0)+1;if(job.readyObservations<2)return;
      }
      await this.client.connect({base:job.base,code:job.code,tabId});
      await this.remember(job,current);job.stage='connected';job.code='';await this.save();
    }catch(e){if(job.stage!=='cancelled'){job.stage='error';job.error=e.message;job.code='';await this.save();}}
    finally{this.locks.delete(tabId);}
  }
  async provision(job){
    const tabId=job.tabId;let attached=false;
    const send=async(method,params)=>{
      if(job.stage==='cancelled')throw new Error('已取消');
      const tab=await this.chrome.tabs.get(tabId);if(!atHome(tab.url))throw new Error('创建前页面已变化');
      return this.chrome.debugger.sendCommand({tabId},method,params);
    };
    try{
      await this.chrome.debugger.attach({tabId},'1.3');attached=true;
      const identity=await send('Runtime.evaluate',{expression:identityExpression,returnByValue:true});
      if(identity.result?.value?.email?.toLowerCase()!==job.email.toLowerCase())throw new Error('创建前账号发生变化，已停止');
      const filled=await send('Runtime.evaluate',{expression:`(() => {const f=document.querySelector(':is(textarea,[contenteditable="true"],[contenteditable="plaintext-only"])[placeholder="Describe an app and let Gemini do the rest"]');if(!f)return false;f.focus();if(f.tagName==='TEXTAREA')f.select();else{const r=document.createRange();r.selectNodeContents(f);const s=window.getSelection();s.removeAllRanges();s.addRange(r);}return true;})()`,returnByValue:true});
      if(!filled.result?.value)throw new Error('Build 创建输入框不可用');
      const title='Build Standalone '+crypto.randomUUID().slice(0,8);
      await send('Input.insertText',{text:`Create a minimal private project named "${title}" containing a static page with the text "Build Standalone Ready". No AI features, API keys, external services, billing setup or deployment. This project will only hold private text-chat context files.`});
      let point;
      for(let i=0;i<20;i++){
        const r=await send('Runtime.evaluate',{expression:`(() => {const b=document.querySelector('button[aria-label="Send"]');if(!b||b.disabled||b.getAttribute('aria-disabled')==='true')return null;const r=b.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null;})()`,returnByValue:true});
        point=r.result?.value;if(point)break;await new Promise(r=>setTimeout(r,150));
      }
      if(!point)throw new Error('Build 创建按钮未就绪');
      await send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',buttons:1,clickCount:1});
      await send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',buttons:0,clickCount:1});
    }finally{if(attached)await this.chrome.debugger.detach({tabId}).catch(()=>{});}
  }
}
