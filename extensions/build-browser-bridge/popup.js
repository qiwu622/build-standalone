import {enableSillyTavernSite} from './sillytavern-sites.mjs';
const $=id=>document.getElementById(id);
const saved=await chrome.storage.local.get('base');if(saved.base)$('base').value=saved.base;
async function refresh(){const state=await chrome.runtime.sendMessage({action:'status'});$('connections').replaceChildren();if(state.error)$('status').textContent=state.error;for(const c of state.connections||[]){const row=document.createElement('div');row.className='connection';row.textContent=c.email+' · 已连接 ';const button=document.createElement('button');button.textContent='断开';button.onclick=async()=>{await chrome.runtime.sendMessage({action:'disconnect',tabId:c.tabId});await refresh();};row.append(button);$('connections').append(row);}}
$('connect').onsubmit=async event=>{event.preventDefault();$('submit').disabled=true;$('status').textContent='正在核对当前项目并连接…';try{const reply=await chrome.runtime.sendMessage({action:'connect',base:$('base').value.trim(),code:$('code').value.trim()});$('status').textContent=reply.ok?reply.message:reply.error;if(reply.ok)$('code').value='';await refresh();}catch{$('status').textContent='扩展连接失败，请检查本机服务和当前项目。';}finally{$('submit').disabled=false;}};
$('enable-st').onclick=async()=>{
 try{
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  const pattern=await enableSillyTavernSite(chrome,tab);
  $('st-status').textContent=`已启用 ${pattern}。酒馆加载完成后自动显示“Build 独立版 · 酒馆分流”；已有旧酒馆扩展请禁用并刷新。`;
 }catch(e){$('st-status').textContent=e.message;}
};
await refresh();
