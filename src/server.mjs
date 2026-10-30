import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {projectRoot} from './storage.mjs';
import {models,parseCompletion,completion,bufferedSSE} from './protocol.mjs';
import {Scheduler} from './scheduler.mjs';
import {AppError,error} from './errors.mjs';

function secureEqual(a,b){const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&timingSafeEqual(x,y);}
function json(res,status,value,headers={}){res.writeHead(status,{'content-type':'application/json; charset=utf-8',...headers});res.end(JSON.stringify(value));}
async function readBody(req,limit) {
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']||''))throw error('需要 application/json',415);
  if(Number(req.headers['content-length'])>limit)throw error('请求正文过大',413);
  const buffers=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>limit)throw error('请求正文过大',413);buffers.push(chunk);}
  try {return JSON.parse(Buffer.concat(buffers).toString('utf8'));}catch{throw error('JSON 格式无效');}
}
function waitResult(promise,signal) {
  if(signal.aborted)return Promise.reject(signal.reason);
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});
    promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}
export function createService({config,credentials,executor,store,pool,browsers,log,demo=false,instanceId=randomUUID(),onShutdown}) {
  const scheduler=new Scheduler(config.maxQueue),active=new Map();let closing=false,adminBusy=false;
  const adminOperation=async fn=>{
    if(adminBusy||scheduler.busy||scheduler.queue.length)throw error('请等待当前操作完成',409,'busy');
    adminBusy=true;try{return await fn();}finally{adminBusy=false;}
  };
  const server=http.createServer(async(req,res)=>{
    const requestId=randomUUID(),started=Date.now();let timer,heartbeat,controller,parsed,result,failureCode,failureStatus,failureMessage,failureStage,queueMs;
    res.setHeader('x-request-id',requestId);res.setHeader('cache-control','no-store');res.setHeader('x-content-type-options','nosniff');
    res.setHeader('referrer-policy','no-referrer');res.setHeader('x-frame-options','DENY');
    try {
      const path=new URL(req.url,'http://localhost').pathname;
      if(closing)throw error('服务正在关闭',503,'shutdown');
      if(req.method==='GET'&&path==='/health')return json(res,200,{ok:true,mode:demo?'demo':'live',upstreamVerified:false});
      if(req.method==='GET'&&['/','/admin.js','/style.css'].includes(path)) {
        res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
        res.setHeader('content-type',path==='/'?'text/html; charset=utf-8':path.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8');
        return res.end(await readFile(join(projectRoot,'public',path==='/'?'index.html':path.slice(1))));
      }
      if(path.startsWith('/bridge/')) {
        // This transport is intentionally local-only. The extension never gets
        // adminKey/apiKey, and a normal web origin cannot pair or send commands.
        const remote=req.socket.remoteAddress;
        const hosts=[`127.0.0.1:${req.socket.localPort}`,`localhost:${req.socket.localPort}`];
        if(!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(remote)||!hosts.includes(req.headers.host)||
          (req.headers.origin&&!/^chrome-extension:\/\/[a-p]{32}$/.test(req.headers.origin)))throw error('浏览器扩展仅允许本机连接',403,'bridge_origin_denied');
        if(demo||!browsers?.exchange)throw error('此实例不支持扩展连接',409,'bridge_unavailable');
        if(req.method!=='POST')throw error('扩展接口需要 POST',405);
        if(path==='/bridge/authorize') {const body=await readBody(req,1024);return json(res,200,browsers.authorize(body.code));}
        if(path==='/bridge/resume-check') {const body=await readBody(req,1024);return json(res,200,await browsers.resumeStatus(body.resumeKey,req.headers.origin||''));}
        if(path==='/bridge/connect') {
          const body=await readBody(req,4096);
          return json(res,200,await adminOperation(()=>browsers.connect(body,req.headers.origin||'')));
        }
        const session=browsers.authenticate((req.headers.authorization||'').replace(/^Bearer /,''));
        if(path==='/bridge/disconnect'){browsers.disconnect(session);return json(res,200,{ok:true});}
        if(path==='/bridge/exchange'){
          const body=await readBody(req,16*1024*1024),cancel=new AbortController();
          res.once('close',()=>cancel.abort());
          const value=await browsers.exchange(session,body,cancel.signal);
          if(!res.destroyed)return json(res,200,value);return;
        }
        throw error('扩展路由不存在',404);
      }
      const admin=path.startsWith('/admin/'),key=admin?credentials.adminKey:credentials.apiKey;
      if(!secureEqual(req.headers.authorization,'Bearer '+key))throw error('鉴权失败',401,'invalid_api_key');
      // Browser cross-site requests are denied; API clients without Origin still work.
      const localOrigin=`http://${req.headers.host}`;
      if(req.headers.origin&&req.headers.origin!==(config.publicOrigin||localOrigin))throw error('Origin 不匹配',403,'origin_denied');
      if(req.method==='GET'&&path==='/v1/models')return json(res,200,models());
      if(req.method==='POST'&&path==='/v1/chat/completions') {
        parsed=parseCompletion(await readBody(req,config.maxBodyBytes));
        if(browsers?.login||adminBusy)throw error('请先完成或取消账号管理操作',503,'login_busy');
        controller=new AbortController();active.set(requestId,controller);
        const cancel=()=>{if(!res.writableEnded)controller.abort(error('客户端已断开',499,'cancelled'));};
        res.on('close',cancel);req.on('aborted',cancel);
        res.setHeader('x-build-mode',demo?'demo':'live');res.setHeader('x-build-streaming','buffered');
        res.setHeader('x-build-upstream-model',parsed.resolved.model);res.setHeader('x-build-thinking-level',parsed.resolved.thinkingLevel);
        if(parsed.body.sillytavern)res.setHeader('x-build-context','sillytavern_split');
        if(parsed.stream)heartbeat=setInterval(()=>{
          if(res.destroyed||res.writableEnded)return;
          if(!res.headersSent)res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','x-accel-buffering':'no'});
          res.write(': keepalive\n\n');
        },config.streamHeartbeatMs||15000);
        if(config.queueTimeoutMs>0)timer=setTimeout(()=>controller.abort(error('等待空闲 Build 执行位置超时，尚未提交 Google',504,'queue_timeout')),config.queueTimeoutMs);
        const task=scheduler.run(()=>{
          clearTimeout(timer);queueMs=Date.now()-started;
          const deadline=config.requestTimeoutMs>0?Date.now()+config.requestTimeoutMs:Infinity;
          if(config.requestTimeoutMs>0)timer=setTimeout(()=>controller.abort(error('Build 执行达到配置时限',504,'request_timeout')),config.requestTimeoutMs);
          return executor.execute(parsed,{signal:controller.signal,requestId,deadline});
        },controller.signal);
        result=await waitResult(task,controller.signal);
        const output=completion(parsed.responseModel||parsed.alias,result.text);
        if(parsed.stream){if(!res.headersSent)res.writeHead(200,{'content-type':'text/event-stream; charset=utf-8'});res.end(bufferedSSE(output));}
        else json(res,200,output);
        return;
      }
      if(req.method==='GET'&&path==='/admin/state')return json(res,200,{instanceId,mode:demo?'demo':'live',busy:scheduler.busy||adminBusy,queued:scheduler.queue.length,accounts:store.accounts,pool:pool.snapshot(),login:browsers?.login?{id:browsers.login.id,startedAt:browsers.login.startedAt}:null,connectionMode:browsers?.pairing?'extension':'legacy',connections:browsers?.snapshot?.()||[],streaming:'buffered',upstreamVerified:false});
      if(req.method==='GET'&&path==='/admin/logs')return json(res,200,{records:await log.recent()});
      if(req.method==='GET'&&path==='/admin/client-config')return json(res,200,{apiKey:credentials.apiKey});
      if(req.method==='POST'&&path==='/admin/bridge/automatic') {
        await readBody(req,1024);if(demo||!browsers?.pairing)throw error('此实例不支持扩展接入',409);
        return json(res,200,await adminOperation(()=>browsers.pairing({automatic:true})));
      }
      if(req.method==='POST'&&path==='/admin/bridge/pairing') {
        await readBody(req,1024);if(demo||!browsers?.pairing)throw error('此实例不支持扩展配对',409);
        return json(res,200,await adminOperation(()=>browsers.pairing()));
      }
      if(req.method==='POST'&&path==='/admin/bridge/disconnect') {
        const body=await readBody(req,1024);await browsers?.disconnectAccount?.(body.id);return json(res,200,{ok:true});
      }
      if(req.method==='POST'&&path==='/admin/login/start') {
        if(browsers?.pairing)throw error('已改为常用浏览器扩展接入，请生成配对码后连接专用 Build 标签页',410,'extension_required');
        if(demo)throw error('演示模式不打开 Google 登录',409,'demo_mode');
        if(scheduler.busy||scheduler.queue.length)throw error('有请求在执行，请稍后接入账号',409,'busy');
        const body=await readBody(req,4096);return json(res,200,await adminOperation(()=>browsers.beginLogin(body.id)));
      }
      if(req.method==='POST'&&path==='/admin/login/finish') {
        if(browsers?.pairing)throw error('扩展连接成功后会自动导入账号',410,'extension_required');
        if(demo)throw error('演示模式不导入账号',409);
        const account=await adminOperation(async()=>{const account=await browsers.finishLogin();await pool.sync(store.accounts);await pool.imported(account.id);return account;});return json(res,200,{account});
      }
      if(req.method==='POST'&&path==='/admin/login/cancel'){await adminOperation(()=>browsers?.cancelLogin?.());return json(res,200,{ok:true});}
      if(req.method==='POST'&&path==='/admin/accounts/enabled') {
        if(scheduler.busy||browsers?.login)throw error('请等待当前操作完成',409,'busy');
        const body=await readBody(req,4096);if(typeof body.enabled!=='boolean')throw error('enabled 必须为布尔值');
        await adminOperation(async()=>{if(browsers?.login)throw error('请先完成登录',409);await store.enabled(body.id,body.enabled);await pool.sync(store.accounts);});return json(res,200,{ok:true});
      }
      if(req.method==='POST'&&path==='/admin/control/stop'){
        const body=await readBody(req,1024);if(body.instanceId!==instanceId)throw error('实例不匹配；拒绝停止其他服务',409,'instance_mismatch');
        if(body.onlyIfIdle&&(scheduler.busy||scheduler.queue.length||adminBusy))throw error('仍有请求或管理操作进行中，未停止服务',409,'busy');
        if(!onShutdown)throw error('此实例未配置进程管理',409);closing=true;json(res,200,{ok:true});setTimeout(()=>void onShutdown(),50);return;
      }
      throw error('路由不存在',404,'not_found');
    }catch(e) {
      failureCode=e.code||e.rotationReason||'build_error';
      const status=Number.isInteger(e.status)&&e.status>=400&&e.status<=599?e.status:500;
      failureStatus=status;failureStage=e.stage;
      if(!res.destroyed){
        // Raw Playwright/Google errors can contain paths or request text; expose only controlled messages.
        const message=e instanceof AppError?String(e.message).slice(0,800):({400:'Build 请求参数无效',401:'Google 登录已失效',403:'Google 订阅或模型权限不可用',404:'模型或资源不存在',413:'Build 上下文过大',422:'Google 已明确拒绝本次内容',429:'Build 账号池限额，请在冷却后重试',499:'请求已取消',503:'Build 没有可用账号或浏览器，请检查管理页',504:'Build 请求超时'}[status]||'Build 上游或浏览器执行失败，请检查管理页状态');
        failureMessage=message;
        const envelope={error:{message,type:status<500?'invalid_request_error':'server_error',code:failureCode,status,request_id:requestId,...(e.stage?{stage:e.stage}:{})}};
        if(res.headersSent)res.end('data: '+JSON.stringify(envelope)+'\n\ndata: [DONE]\n\n');
        else json(res,status,envelope,e.retryAfterSeconds?{'retry-after':String(e.retryAfterSeconds)}:{});
      }
    }finally {
      clearTimeout(timer);clearInterval(heartbeat);active.delete(requestId);
      if(parsed)await log.record({event:'completion',requestId,model:parsed.alias,status:res.destroyed&&!res.writableEnded?499:failureStatus||res.statusCode,durationMs:Date.now()-started,queueMs,code:failureCode,message:failureMessage,stage:failureStage,...result}).catch(()=>{});
    }
  });
  server.requestTimeout=30000;server.headersTimeout=15000;server.keepAliveTimeout=5000;
  return {server,scheduler,async close(){closing=true;scheduler.close();for(const ctrl of active.values())ctrl.abort(error('服务关闭',503,'shutdown'));await browsers?.close();server.closeAllConnections();await new Promise(r=>server.close(r));await log.chain;}};
}
