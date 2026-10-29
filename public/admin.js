let token='',poll=null,pairExpiry=0;
const $=id=>document.getElementById(id);
function message(text,bad=false){$('message').textContent=text;$('message').className=bad?'error':'';}
async function api(path,body){
  const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const value=await response.json();if(!response.ok)throw new Error(value.error?.message||'请求失败');return value;
}
function element(tag,text,className){const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;}
function action(label,fn){const b=element('button',label,'secondary');b.addEventListener('click',()=>perform(b,fn));return b;}
async function perform(button,fn){button.disabled=true;try{await fn();await refresh();}catch(e){message(e.message,true);}finally{button.disabled=false;}}
const statuses={available:'最近成功',unverified:'尚未验证',cooling:'冷却中',login_required:'需重新登录',subscription_required:'需订阅',permission_required:'模型权限不足',connection_required:'需连接',disabled:'已停用'};
async function refresh(){
  const [state,logs]=await Promise.all([api('/admin/state'),api('/admin/logs')]);
  $('mode').textContent=state.mode==='demo'?'DEMO · 未调用 Google':'LIVE';$('dashboard').hidden=false;$('auth').hidden=true;
  $('busy').textContent=state.busy?'执行中':'空闲';$('queued').textContent=state.queued;
  $('pair-browser').disabled=state.busy||state.mode==='demo';$('base-url').textContent=location.origin+'/v1';$('bridge-url').textContent=location.origin;
  if(pairExpiry&&Date.now()>pairExpiry){$('pairing').hidden=true;$('pair-code').textContent='';pairExpiry=0;}
  $('quota-note').textContent=state.pool.quotaNote;$('accounts').replaceChildren();
  if(!state.accounts.length)$('accounts').append(element('p','暂无账号。请在常用浏览器的专用 Build 项目中使用扩展连接。','hint'));
  for(const account of state.accounts){
    const connected=state.connections?.some(c=>c.accountId===account.id&&c.connected);
    const row=element('div',undefined,'account'),head=element('div',undefined,'account-head'),title=element('div');
    title.append(element('strong',account.email),element('small',(account.enabled?'已启用':'已停用')+' · '+(connected?'扩展在线':'扩展离线，请重新配对')));head.append(title);
    const controls=element('div',undefined,'row');
    controls.append(action(account.enabled?'停用':'启用',async()=>{await api('/admin/accounts/enabled',{id:account.id,enabled:!account.enabled});message('账号状态已更新');}));
    if(connected)controls.append(action('断开扩展',async()=>{await api('/admin/bridge/disconnect',{id:account.id});message('已断开扩展；Google 登录状态保留在浏览器。');}));
    if(state.busy)for(const b of controls.children)b.disabled=true;
    head.append(controls);row.append(head);
    const modelStatus=element('div',undefined,'model-status'),pool=state.pool.accounts.find(a=>a.id===account.id);
    for(const [model,value] of Object.entries(pool?.models||{}))modelStatus.append(element('span',`${model} · ${account.enabled?(statuses[value.status]||value.status):'已停用'} · 成功 ${value.successes}${value.retryAt?' · 可重试 '+new Date(value.retryAt).toLocaleTimeString():''}`));
    row.append(modelStatus);$('accounts').append(row);
  }
  $('logs').replaceChildren();for(const item of logs.records){const tr=element('tr');for(const cell of [new Date(item.at).toLocaleString(),item.model||'—',item.stage||item.event,item.status||'—',item.durationMs!==undefined?(item.durationMs/1000).toFixed(2)+' s':'—'])tr.append(element('td',String(cell)));$('logs').append(tr);}
}
$('login-form').addEventListener('submit',async event=>{event.preventDefault();token=$('key').value.trim();try{await refresh();$('key').value='';message('已连接。管理密钥仅保存在此页面内存中。');clearInterval(poll);poll=setInterval(()=>refresh().catch(e=>message(e.message,true)),5000);}catch(e){token='';message(e.message,true);}});
$('refresh').onclick=()=>perform($('refresh'),async()=>{});
$('pair-browser').onclick=()=>perform($('pair-browser'),async()=>{const pair=await api('/admin/bridge/pairing',{});pairExpiry=pair.expiresAt;$('pair-code').textContent=pair.code;$('pair-expiry').textContent='有效期至 '+new Date(pair.expiresAt).toLocaleTimeString();$('pairing').hidden=false;message('请把配对码填入常用浏览器的 Build 本机连接器。无需管理员密钥或 Cookie。');});
$('disconnect').onclick=()=>{token='';clearInterval(poll);pairExpiry=0;$('pair-code').textContent='';$('pairing').hidden=true;$('dashboard').hidden=true;$('auth').hidden=false;message('已退出');};
