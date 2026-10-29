import {BridgeClient} from './client.mjs';
import {Onboarding} from './onboarding.mjs';
import {localBase} from './protocol.mjs';
const client=new BridgeClient({chrome});
const onboarding=new Onboarding({chrome,client});
void chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
void chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
chrome.debugger.onEvent.addListener((source,method,params)=>client.event(source,method,params));
chrome.debugger.onDetach.addListener(source=>{if(client.links.has(source.tabId)){client.lastError='浏览器调试连接已关闭，请重新连接';void client.disconnect(source.tabId);}});
chrome.tabs.onRemoved.addListener(tabId=>void client.disconnect(tabId));
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
  if(message.action?.startsWith('onboarding-')){
    if(sender.id!==chrome.runtime.id||!sender.tab||sender.frameId!==0)return;
    (async()=>{
      if(['onboarding-watch','onboarding-pulse'].includes(message.action)){
        const u=new URL(sender.url);if(u.protocol!=='https:'||!['aistudio.google.com','ai.studio'].includes(u.hostname))throw new Error('页面来源无效');
        if(message.action==='onboarding-watch'){await onboarding.ready;const job=onboarding.jobs[sender.tab.id];return {watch:!!job&&job.stage!=='connected'&&(!['error','cancelled'].includes(job.stage)||(job.created&&!job.projectURL))};}
        await onboarding.pulse(sender.tab.id,message.state);return {};
      }
      const u=new URL(sender.url);if(u.pathname!=='/')throw new Error('请使用本机管理页');const base=localBase(u.origin);
      if(message.action==='onboarding-probe')return {version:chrome.runtime.getManifest().version};
      if(message.action==='onboarding-start')return onboarding.start({base,code:message.code,adminTabId:sender.tab.id});
      if(message.action==='onboarding-status')return onboarding.status(base);
      if(message.action==='onboarding-cancel'){await onboarding.cancel(base);return {};}
      throw new Error('未知操作');
    })().then(value=>respond({ok:true,...value}),e=>respond({ok:false,error:e.message}));return true;
  }
  if(sender.id!==chrome.runtime.id||sender.tab||!sender.url?.startsWith(chrome.runtime.getURL('popup.html')))return;
  (async()=>{
    if(message.action==='status')return client.status();
    if(message.action==='connect'){
      const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
      if(!tab?.id)throw new Error('请选择专用 Build 标签页');
      const reply=await client.connect({...message,tabId:tab.id});await chrome.storage.local.set({base:message.base});return reply;
    }
    if(message.action==='disconnect'){await client.disconnect(message.tabId);return {message:'已断开'};}
    throw new Error('未知操作');
  })().then(value=>respond({ok:true,...value}),e=>respond({ok:false,error:e.message}));return true;
});
