let token='',poll=null,pairExpiry=0,extensionReady=false,autoDisabled=true;
const $=id=>document.getElementById(id);
const savedKeyName='build-standalone.adminKey';
function forgetKey(){try{localStorage.removeItem(savedKeyName);}catch{}}
try{$('key').value=localStorage.getItem(savedKeyName)||'';}catch{}
const extensionWaiters=new Map();
window.addEventListener('message',event=>{
  if(event.source!==window||event.origin!==location.origin||event.data?.channel!=='build-admin-response')return;
  const pending=extensionWaiters.get(event.data.id);if(!pending)return;extensionWaiters.delete(event.data.id);clearTimeout(pending.timer);
  if(event.data.ok)pending.resolve(event.data);else pending.reject(new Error(event.data.error||'扩展连接失败'));
});
function extension(action,data={}){
  return new Promise((resolve,reject)=>{const id=crypto.randomUUID();const timer=setTimeout(()=>{extensionWaiters.delete(id);reject(new Error('请在安装了 Build 本机连接器的常用 Chrome／Edge 中打开此管理页并刷新'));},action==='start'?10000:1500);
    extensionWaiters.set(id,{resolve,reject,timer});window.postMessage({channel:'build-admin-request',id,action,...data},location.origin);
  });
}
async function extensionState(){
  try{
    const probe=await extension('probe');extensionReady=true;$('extension-status').textContent='已检测到本机连接器 '+(probe.version||'')+'，登录后将自动创建或复用专用项目。';
    const value=await extension('status');$('onboarding-status').replaceChildren();let active=false;
    for(const job of value.jobs||[]){$('onboarding-status').append(element('p',(job.email?job.email+' · ':'')+job.message));if(!['connected','error','cancelled'].includes(job.stage))active=true;}
    if(value.connectionError)$('onboarding-status').append(element('p','连接器错误：'+value.connectionError,'error'));
    for(const item of value.reconnect||[])$('onboarding-status').append(element('p',(item.email?item.email+' · ':'')+item.message));
    $('cancel-onboarding').hidden=!active;return active;
  }catch(e){extensionReady=false;$('extension-status').textContent=e.message;$('cancel-onboarding').hidden=true;return false;}
}
function message(text,bad=false){$('message').textContent=text;$('message').className=bad?'error':'';}
async function api(path,body){
  const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const value=await response.json();if(!response.ok)throw new Error(value.error?.message||'请求失败');return value;
}
function element(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
function action(label,fn){const b=element('button',label,'secondary');b.addEventListener('click',()=>perform(b,fn));return b;}
async function perform(button,fn){button.disabled=true;try{await fn();await refresh();}catch(e){message(e.message,true);}finally{button.disabled=button.id==='auto-connect'?autoDisabled:false;}}
const statuses={available:'最近成功',unverified:'尚未验证',cooling:'冷却中',login_required:'需重新登录',subscription_required:'需订阅',permission_required:'模型权限不足',connection_required:'需连接',disabled:'已停用'};
async function refresh(){
  const [state,logs]=await Promise.all([api('/admin/state'),api('/admin/logs')]);
  $('mode').textContent=state.mode==='demo'?'DEMO · 未调用 Google':'LIVE';$('dashboard').hidden=false;$('auth').hidden=true;
  $('busy').textContent=state.busy?'执行中':'空闲';$('queued').textContent=state.queued;
  $('pair-browser').disabled=state.busy||state.mode==='demo';$('base-url').textContent=location.origin+'/v1';$('bridge-url').textContent=location.origin;
  const onboardingActive=await extensionState();autoDisabled=!extensionReady||state.busy||state.mode==='demo'||onboardingActive;$('auto-connect').disabled=autoDisabled;
  $('pair-browser').disabled=state.busy||state.mode==='demo'||onboardingActive;
  if(pairExpiry&&Date.now()>pairExpiry){$('pairing').hidden=true;$('pair-code').textContent='';pairExpiry=0;}
  $('quota-note').textContent=state.pool.quotaNote;$('accounts').replaceChildren();
  if(!state.accounts.length)$('accounts').append(element('p','暂无账号。安装本机连接器后，点击“登录并自动接入”。','hint'));
  for(const account of state.accounts){
    const connected=state.connections?.some(c=>c.accountId===account.id&&c.connected);
    const row=element('div',undefined,'account'),head=element('div',undefined,'account-head'),title=element('div');
    title.append(element('strong',account.email),element('small',(account.enabled?'已启用':'已停用')+' · '+(connected?'Build 执行连接在线':'Build 执行连接离线，当前无法调用；请查看上方连接器状态')));head.append(title);
    const controls=element('div',undefined,'row');
    controls.append(action(account.enabled?'停用':'启用',async()=>{await api('/admin/accounts/enabled',{id:account.id,enabled:!account.enabled});message('账号状态已更新');}));
    if(connected)controls.append(action('断开扩展',async()=>{await api('/admin/bridge/disconnect',{id:account.id});message('已断开扩展；Google 登录状态保留在浏览器。');}));
    if(state.busy)for(const b of controls.children)b.disabled=true;
    head.append(controls);row.append(head);
    const modelStatus=element('div',undefined,'model-status'),pool=state.pool.accounts.find(a=>a.id===account.id);
    for(const [model,value] of Object.entries(pool?.models||{}))modelStatus.append(element('span',`${model} · ${account.enabled?(statuses[value.status]||value.status):'已停用'} · 成功 ${value.successes}${value.retryAt?' · 可重试 '+new Date(value.retryAt).toLocaleTimeString():''}`));
    row.append(modelStatus);$('accounts').append(row);
  }
  $('logs').replaceChildren();for(const item of logs.records){const tr=element('tr');for(const cell of [new Date(item.at).toLocaleString(),item.model||'—',item.stage||item.event,item.status||'—',item.durationMs!==undefined?(item.durationMs/1000).toFixed(2)+' s':'—',[item.code,item.message,item.requestId].filter(Boolean).join(' · ')])tr.append(element('td',String(cell)));$('logs').append(tr);}
}
$('login-form').addEventListener('submit',async event=>{event.preventDefault();token=$('key').value.trim();try{await refresh();if($('remember-key').checked){try{localStorage.setItem(savedKeyName,token);}catch{}}else forgetKey();$('key').value='';message('管理端鉴权成功；能否调用请看账号的 Build 执行连接状态。');clearInterval(poll);poll=setInterval(()=>refresh().catch(e=>message(e.message,true)),5000);}catch(e){token='';message(e.message,true);}});
$('remember-key').addEventListener('change',()=>{if(!$('remember-key').checked)forgetKey();});
$('refresh').onclick=()=>perform($('refresh'),async()=>{});
$('auto-connect').onclick=()=>perform($('auto-connect'),async()=>{await extension('probe');const capability=await api('/admin/bridge/automatic',{});await extension('start',{code:capability.code});message('已打开常用浏览器中的 Build。请完成 Google 登录，项目创建和接入会自动继续。');});
$('cancel-onboarding').onclick=()=>perform($('cancel-onboarding'),async()=>{await extension('cancel');message('已取消后续接入步骤；已创建的项目保留。');});
$('pair-browser').onclick=()=>perform($('pair-browser'),async()=>{const pair=await api('/admin/bridge/pairing',{});pairExpiry=pair.expiresAt;$('pair-code').textContent=pair.code;$('pair-expiry').textContent='有效期至 '+new Date(pair.expiresAt).toLocaleTimeString();$('pairing').hidden=false;message('请把配对码填入常用浏览器的 Build 本机连接器。无需管理员密钥或 Cookie。');});
$('disconnect').onclick=()=>{token='';forgetKey();$('key').value='';clearInterval(poll);pairExpiry=0;$('pair-code').textContent='';$('pairing').hidden=true;$('dashboard').hidden=true;$('auth').hidden=false;message('已退出，已清除本浏览器保存的管理密钥');};
