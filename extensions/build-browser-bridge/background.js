import {BridgeClient} from './client.mjs';
const client=new BridgeClient({chrome});
chrome.debugger.onEvent.addListener((source,method,params)=>client.event(source,method,params));
chrome.debugger.onDetach.addListener(source=>{if(client.links.has(source.tabId)){client.lastError='浏览器调试连接已关闭，请重新连接';void client.disconnect(source.tabId);}});
chrome.tabs.onRemoved.addListener(tabId=>void client.disconnect(tabId));
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
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
