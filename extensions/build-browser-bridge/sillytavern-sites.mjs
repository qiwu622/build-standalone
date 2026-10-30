export function sitePattern(url){
 const u=new URL(url);
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error('请先打开酒馆的 HTTP/HTTPS 页面');
 return `${u.protocol}//${u.hostname}/*`;
}
export async function enableSillyTavernSite(chrome,tab){
 if(!tab?.id)throw new Error('请先打开酒馆页面');
 const pattern=sitePattern(tab.url);
 // Called directly by the popup click: grant only the selected site, never all sites.
 if(!await chrome.permissions.request({origins:[pattern]}))throw new Error('未授权此站点，未启用酒馆分流');
 const id='build-st-site-'+Array.from(pattern,c=>c.charCodeAt(0).toString(16).padStart(2,'0')).join('');
 const definition={id,matches:[pattern],js:['sillytavern-main.js'],world:'MAIN',runAt:'document_idle',persistAcrossSessions:true};
 const existing=await chrome.scripting.getRegisteredContentScripts({ids:[id]});
 if(existing.length)await chrome.scripting.updateContentScripts([definition]);
 else await chrome.scripting.registerContentScripts([definition]);
 await chrome.scripting.executeScript({target:{tabId:tab.id},files:['sillytavern-main.js'],world:'MAIN'});
 return pattern;
}
