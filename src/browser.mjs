import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {profilePath,projectRoot} from './storage.mjs';
import {buildAppForAccount} from './build-chat.mjs';
import {checkAbort,error,safeFailure} from './errors.mjs';

export function identityScript() {
  const labels=[...document.querySelectorAll('button[aria-label]')].map(e=>e.getAttribute('aria-label')).filter(x=>/Google (?:Account|账号|帐号)/i.test(x)).join(' ');
  return {url:location.href,email:/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(labels)?.[0]||null,ready:!!document.querySelector(':is(textarea,[contenteditable="true"],[contenteditable="plaintext-only"])[placeholder="Make changes, add new features, ask for anything"]')};
}
// A CDP session scoped to ONE page we launched, never an external debugging port.
export function pageCDP(session,{commandTimeout=15000}={}) {
  const listeners=new Set(),bindings=new Map();
  const send=async(method,params={})=>{
    let timer;try{return await Promise.race([session.send(method,params),new Promise((_,reject)=>{timer=setTimeout(()=>reject(error('浏览器命令超时',504,'browser_timeout')),commandTimeout);})]);}
    finally{clearTimeout(timer);}
  };
  send.onEvent=fn=>{listeners.add(fn);return()=>listeners.delete(fn);};
  for(const method of ['Inspector.targetCrashed','Network.requestWillBeSent','Network.loadingFailed','Network.responseReceived','Network.loadingFinished','Page.javascriptDialogOpening']) {
    const listener=params=>{for(const fn of listeners)fn({method,params,sessionId:'page'});};bindings.set(method,listener);session.on(method,listener);
  }
  send.dispose=async()=>{listeners.clear();for(const [name,fn] of bindings)session.off(name,fn);await session.detach().catch(()=>{});};
  return send;
}
export class BrowserManager {
  constructor(config,store,{launch}={}){this.config=config;this.store=store;this.launchOverride=launch;this.contexts=new Set();this.login=null;}
  async launch(id,headless) {
    const directory=await profilePath(this.config,id);
    const temp=join(this.config.dataDir,'tmp');await mkdir(temp,{recursive:true,mode:0o700});
    process.env.PLAYWRIGHT_BROWSERS_PATH=join(projectRoot,'.browsers');
    const launch=this.launchOverride||((await import('playwright')).chromium.launchPersistentContext.bind((await import('playwright')).chromium));
    // Playwright uses its own pipe; no CDP/VNC port, no existing user context.
    const context=await launch(directory,{headless,locale:'en-US',chromiumSandbox:true,acceptDownloads:false,timeout:45000,
      ...(this.config.browserPath?{executablePath:this.config.browserPath}:{}),
      env:{...process.env,TEMP:temp,TMP:temp,TMPDIR:temp},args:['--no-first-run','--disable-sync']});
    this.contexts.add(context);context.on('close',()=>this.contexts.delete(context));return context;
  }
  async withPage(account,signal,action) {
    checkAbort(signal);
    if(this.login)throw error('正在接入账号，请完成或取消登录后调用',503,'login_busy');
    const app=buildAppForAccount(account.appURL,'0');if(!app)throw error('请先在管理页完成独立 Build 项目接入',503,'app_unavailable');
    const context=await this.launch(account.id,this.config.headless);let timer;
    const abort=()=>{timer=setTimeout(()=>void context.close().catch(()=>{}),20000);timer.unref?.();};
    signal?.addEventListener('abort',abort,{once:true});
    if(signal?.aborted)abort();
    let send;
    try {
      const page=context.pages()[0]||await context.newPage();
      for(const other of context.pages())if(other!==page)await other.close();
      checkAbort(signal);await page.goto(app,{waitUntil:'domcontentloaded',timeout:45000});
      if(!buildAppForAccount(page.url(),'0'))throw error('Google 登录失效或项目不可用，请重新登录',401,'login_required');
      // Hydration can lag navigation. Wait only for UI readiness, never send a probe.
      if(page.waitForFunction)await page.waitForFunction(()=>!!document.querySelector(':is(textarea,[contenteditable="true"],[contenteditable="plaintext-only"])[placeholder="Make changes, add new features, ask for anything"]'),undefined,{timeout:20000}).catch(()=>{});
      let identity=await page.evaluate(identityScript);
      if(!identity.email&&page.waitForFunction){
        await page.waitForFunction(()=>[...document.querySelectorAll('button[aria-label]')].some(e=>/Google (?:Account|账号|帐号)/i.test(e.getAttribute('aria-label'))&&/@/.test(e.getAttribute('aria-label'))),undefined,{timeout:10000}).catch(()=>{});
        identity=await page.evaluate(identityScript);
      }
      if(!identity.email||identity.email.toLowerCase()!==account.email?.toLowerCase()||!buildAppForAccount(identity.url,'0'))throw safeFailure('account_mismatch');
      const session=await context.newCDPSession(page);send=pageCDP(session);checkAbort(signal);
      return await action(send,page);
    } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);await send?.dispose();await context.close();}
  }
  async beginLogin(id) {
    if(this.login)throw error('已有登录窗口，请先完成或取消',409);
    if(process.platform==='linux'&&!process.env.DISPLAY&&!process.env.WAYLAND_DISPLAY&&!this.launchOverride)throw error('Linux 无图形会话：请通过 SSH X11 转发运行 npm run login，详情见 docs/linux.md',409,'display_required');
    if(id&&!this.store.accounts.some(a=>a.id===id))throw error('账号不存在',404);
    const login={id:id||'acct_'+randomBytes(16).toString('hex'),startedAt:new Date().toISOString(),context:null};this.login=login;
    try {
      login.context=await this.launch(login.id,false);
      const page=login.context.pages()[0]||await login.context.newPage();
      // Only visit the official Build entry. The user completes Google's login.
      await page.goto(this.store.accounts.find(a=>a.id===id)?.appURL||'https://aistudio.google.com/apps?authuser=0',{waitUntil:'domcontentloaded',timeout:45000});
      login.timer=setTimeout(()=>void this.cancelLogin(),10*60000);login.timer.unref?.();
      return {id:login.id,startedAt:login.startedAt,message:'在本服务主机的独立浏览器中完成 Google 登录，并打开一个仅用于此服务的 Build 项目，再点击完成导入。创建项目可能使用 Google 额度。'};
    }catch(e){await this.cancelLogin();throw e;}
  }
  async finishLogin() {
    const login=this.login;if(!login?.context)throw error('没有可完成的登录会话',409);
    if(login.completing)throw error('正在完成导入',409);login.completing=true;
    try {
      const candidates=[];
      for(const page of login.context.pages())if(buildAppForAccount(page.url(),'0'))candidates.push(await page.evaluate(identityScript));
      const valid=candidates.filter(s=>s.email&&s.ready);
      if(valid.length!==1)throw error('请只保留一个已登录的专用 Build 项目页面，等待聊天输入框出现',409);
      const current=valid[0],existing=this.store.accounts.find(a=>a.id===login.id);
      if(existing&&existing.email.toLowerCase()!==current.email.toLowerCase())throw safeFailure('account_mismatch');
      const account=await this.store.add({id:login.id,email:current.email,appURL:buildAppForAccount(current.url,'0')});
      await this.cancelLogin();return account;
    }finally{login.completing=false;}
  }
  async cancelLogin(){const login=this.login;this.login=null;if(login){clearTimeout(login.timer);await login.context?.close();}}
  async close(){await this.cancelLogin();await Promise.allSettled([...this.contexts].map(c=>c.close()));}
}
