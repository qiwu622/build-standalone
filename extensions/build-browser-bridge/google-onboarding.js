// Passive DOM observation only. Never runs on accounts.google.com, fills login
// forms, accepts consent dialogs, or interacts with projects outside a job.
if(window.top===window){
  let busy=false;
  const pulse=async()=>{
    if(busy)return;busy=true;
    try{
      const interested=await chrome.runtime.sendMessage({action:'onboarding-watch'});if(!interested?.watch)return;
      const labels=[...document.querySelectorAll('button[aria-label]')].filter(e=>/Google (?:Account|账号|帐号)/i.test(e.getAttribute('aria-label')));
      const email=/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(labels.map(e=>e.getAttribute('aria-label')).join(' '))?.[0]||null;
      const field=p=>!!document.querySelector(`:is(textarea,[contenteditable="true"],[contenteditable="plaintext-only"])[placeholder="${p}"]`);
      const state={url:location.href,email,hasPlan:labels.some(e=>/\b(PRO|ULTRA)\b/i.test(e.innerText)),
        initializing:field('Describe an app and let Gemini do the rest'),ready:field('Make changes, add new features, ask for anything'),
        running:!!document.querySelector('button[aria-label="Send"].running'),
        creationReplyReady:[...(document.querySelectorAll('ms-console-assistant-response').length?document.querySelectorAll('ms-console-assistant-response')[document.querySelectorAll('ms-console-assistant-response').length-1].querySelectorAll('ms-console-turn > .bubble'):[])].some(e=>e.innerText.trim()),
        error:[...document.querySelectorAll('[role="alert"],.error-message,.error-container')].some(e=>e.checkVisibility()&&e.innerText.trim())};
      await chrome.runtime.sendMessage({action:'onboarding-pulse',state});
    }catch{/* extension reloaded; never fall back to page-controlled execution */}finally{busy=false;}
  };
  void pulse();setInterval(pulse,3000);
}
