// Passive DOM observation only. Never runs on accounts.google.com, fills login
// forms, accepts consent dialogs, or interacts with projects outside a job.
if(window.top===window){
  let busy=false;
  const pulse=async()=>{
    if(busy)return;busy=true;
    try{
      const interested=await chrome.runtime.sendMessage({action:'onboarding-watch'});if(!interested?.watch)return;
      const identity=globalThis.buildStandaloneReadIdentity();
      const state={...identity,
        running:!!document.querySelector('button[aria-label="Send"].running'),
        creationReplyReady:[...(document.querySelectorAll('ms-console-assistant-response').length?document.querySelectorAll('ms-console-assistant-response')[document.querySelectorAll('ms-console-assistant-response').length-1].querySelectorAll('ms-console-turn > .bubble'):[])].some(e=>e.innerText.trim()),
        error:[...document.querySelectorAll('[role="alert"],.error-message,.error-container')].some(e=>e.checkVisibility()&&e.innerText.trim())};
      await chrome.runtime.sendMessage({action:'onboarding-pulse',state});
    }catch{
      // A fixed diagnostic only: do not forward DOM contents or error payloads.
      try{await chrome.runtime.sendMessage({action:'onboarding-pulse',state:{url:location.href,observerError:true}});}catch{/* extension reloaded; refresh required */}
    }finally{busy=false;}
  };
  void pulse();setInterval(pulse,3000);
}
