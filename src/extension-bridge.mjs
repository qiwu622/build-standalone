import {randomBytes,timingSafeEqual} from 'node:crypto';
import {buildAppForAccount} from './build-chat.mjs';
import {error,checkAbort,safeFailure} from './errors.mjs';
import {identityExpression} from '../extensions/build-browser-bridge/protocol.mjs';

const equal=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y);};
const lost=()=>error('浏览器扩展已断开；请在常用浏览器的专用 Build 标签页重新连接',503,'extension_disconnected');
const commands=new Set(['Runtime.evaluate','Input.insertText','Input.dispatchMouseEvent','Network.enable','Page.enable','Page.getFrameTree','Page.reload','Page.handleJavaScriptDialog']);
const eventNames=new Set(['Inspector.targetCrashed','Network.requestWillBeSent','Network.loadingFailed','Network.responseReceived','Page.javascriptDialogOpening']);

// Pairing and transport credentials exist only in memory, never in URLs or logs.
export class ExtensionBridge {
  constructor({store,pool,now=Date.now,commandTimeout=15000,pollTimeout=15000}) {
    Object.assign(this,{store,pool,now,commandTimeout,pollTimeout});this.sessions=new Map();this.pair=null;
    this.sweep=setInterval(()=>{for(const s of this.sessions.values())if(this.now()-s.lastSeen>65000)this.disconnect(s);},10000);this.sweep.unref?.();
  }
  pairing({automatic=false}={}){this.pair={code:randomBytes(24).toString('hex'),expiresAt:this.now()+(automatic?1200000:300000),automatic};return {...this.pair};}
  authorize(code){
    if(!this.pair||this.pair.expiresAt<this.now()||!equal(this.pair.code,code))throw error('配对码无效或已过期',401,'pairing_invalid');
    return {expiresAt:this.pair.expiresAt,allowCreate:this.pair.automatic===true,projects:this.store.accounts.map(a=>({email:a.email,url:a.appURL}))};
  }
  authenticate(token){const session=[...this.sessions.values()].find(s=>equal(s.token,token));if(!session)throw error('扩展连接已失效，请重新配对',401,'bridge_unauthorized');return session;}
  async connect({code,identity}){
    this.authorize(code);
    const authUser=String(identity?.authUser??'0');
    const appURL=/^\d{1,2}$/.test(authUser)&&buildAppForAccount(identity?.url,authUser);
    if(!identity?.ready||!appURL||typeof identity.email!=='string'||identity.email.length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(identity.email))throw error('请先登录 Google 并打开有聊天输入框的专用 Build 项目',409,'project_not_ready');
    this.pair=null; // Consume before any asynchronous work; concurrent replay is denied.
    const existing=this.store.accounts.find(a=>a.email.toLowerCase()===identity.email.toLowerCase());
    for(const s of this.sessions.values())if(s.accountId===existing?.id)this.disconnect(s);
    const account=await this.store.add({id:existing?.id,email:identity.email,appURL,authUser,transport:'extension'});
    if(existing?.enabled===false)await this.store.enabled(account.id,false);
    await this.pool.sync(this.store.accounts);await this.pool.imported(account.id);
    const token=randomBytes(32).toString('hex');
    this.sessions.set(account.id,{accountId:account.id,token,appURL,lastSeen:this.now(),pending:new Map(),queue:[],listeners:new Set(),waiter:null,busy:false});
    return {token,account:{id:account.id,email:account.email},message:'已连接当前专用 Build 项目；请保持浏览器和标签页打开。'};
  }
  online(id){const s=this.sessions.get(id);return !!s&&this.now()-s.lastSeen<65000;}
  snapshot(){return this.store.accounts.map(a=>({accountId:a.id,connected:this.online(a.id)}));}
  disconnect(session){if(!session)return;if(this.sessions.get(session.accountId)===session)this.sessions.delete(session.accountId);session.closed=true;session.waiter?.();for(const p of session.pending.values()){clearTimeout(p.timer);p.reject(lost());}session.pending.clear();session.queue=[];session.listeners.clear();}
  disconnectAccount(id){this.disconnect(this.sessions.get(id));}
  async exchange(session,{results=[],events=[]},signal){
    if(session.closed)throw lost();
    if(session.waiter)throw error('扩展存在重复连接，请重新配对',409,'duplicate_poll');
    if(!Array.isArray(results)||results.length>16||!Array.isArray(events)||events.length>100)throw error('扩展消息格式无效');
    session.lastSeen=this.now();
    // Events precede command results, so a completed DOM read cannot race the
    // actual Google model/thinking metadata that was emitted during that read.
    for(const event of events)if(eventNames.has(event?.method))for(const fn of session.listeners)fn({...event,sessionId:'page'});
    for(const result of results){const p=session.pending.get(result?.id);if(!p)continue;session.pending.delete(result.id);clearTimeout(p.timer);if(result.error)p.reject(error('浏览器扩展执行失败：'+String(result.error).slice(0,160),502,'extension_command_failed'));else p.resolve(result.value);}
    if(!session.queue.length&&!session.closed)await new Promise(resolve=>{
      const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);session.waiter=null;resolve();};
      const timer=setTimeout(done,this.pollTimeout);session.waiter=done;signal?.addEventListener('abort',done,{once:true});if(signal?.aborted)done();
    });
    if(session.closed)throw lost();
    return {commands:session.queue.splice(0,8)};
  }
  sender(session){
    const send=(method,params={})=>{
      if(session.closed||!this.online(session.accountId))return Promise.reject(lost());
      if(!commands.has(method))return Promise.reject(error('扩展不允许此浏览器命令',400,'command_denied'));
      if(session.pending.size>=8)return Promise.reject(error('扩展命令积压，请重新连接',503,'extension_busy'));
      const id=randomBytes(12).toString('hex');
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>this.disconnect(session),this.commandTimeout);
        session.pending.set(id,{resolve,reject,timer});session.queue.push({id,method,params,deadline:this.now()+this.commandTimeout});session.waiter?.();
      });
    };
    send.onEvent=fn=>{session.listeners.add(fn);return()=>session.listeners.delete(fn);};
    // Browser-owned File objects avoid file:// permissions and local path access.
    send.uploadFiles=files=>send('Runtime.evaluate',{expression:`(() => {const input=document.querySelector('ms-console-file-tree input[type="file"][multiple]');if(!input)throw new Error('Upload input unavailable');const transfer=new DataTransfer();for(const f of ${JSON.stringify(files)})transfer.items.add(new File([f.text],f.name,{type:'application/json'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));return true;})()`,returnByValue:true}).then(r=>{if(r.exceptionDetails)throw error('项目文件上传失败',502,'extension_upload_failed');});
    return send;
  }
  async withPage(account,signal,action){
    checkAbort(signal);const session=this.sessions.get(account.id);if(!session||!this.online(account.id))throw lost();
    if(session.busy)throw error('该浏览器标签页正在执行请求',409,'busy');session.busy=true;
    const send=this.sender(session);
    try{
      const r=await send('Runtime.evaluate',{expression:identityExpression,returnByValue:true});const identity=r.result?.value;
      if(!identity?.ready||identity.email?.toLowerCase()!==account.email.toLowerCase()||buildAppForAccount(identity.url,account.auth_user||'0')!==session.appURL)throw safeFailure('account_mismatch');
      checkAbort(signal);return await action(send);
    }finally{session.busy=false;session.listeners.clear();}
  }
  async close(){clearInterval(this.sweep);this.pair=null;for(const s of this.sessions.values())this.disconnect(s);}
}
