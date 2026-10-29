// Only a logged-in local admin page can mint the capability sent through this
// isolated-world relay. No admin/API key is read from the page or forwarded.
if(window.top===window&&location.pathname==='/'){
  window.addEventListener('message',async event=>{
    const m=event.data;if(event.source!==window||event.origin!==location.origin||m?.channel!=='build-admin-request'||typeof m.id!=='string'||!['probe','start','status','cancel'].includes(m.action))return;
    try{
      const result=await chrome.runtime.sendMessage({action:'onboarding-'+m.action,code:m.code});
      window.postMessage({channel:'build-admin-response',id:m.id,...result},location.origin);
    }catch{window.postMessage({channel:'build-admin-response',id:m.id,ok:false,error:'扩展已更新或不可用，请刷新管理页'},location.origin);}
  });
}
