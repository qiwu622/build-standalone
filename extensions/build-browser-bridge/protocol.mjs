import './page-reader.js';
export const readBuildIdentity=globalThis.buildStandaloneReadIdentity;
export function localBase(value){
  const u=new URL(value);
  if(u.protocol!=='http:'||!['127.0.0.1','localhost'].includes(u.hostname)||u.username||u.password||u.pathname!=='/'||u.search||u.hash)throw new Error('服务地址必须是本机 http://127.0.0.1:端口');
  return u.origin;
}
export function project(value){
  const u=new URL(value),pathUser=/^\/u\/(\d+)\//.exec(u.pathname)?.[1],queryUser=u.searchParams.get('authuser');
  if(u.protocol!=='https:'||u.username||u.password||(u.port&&u.port!=='443')||!['aistudio.google.com','ai.studio'].includes(u.hostname)||!/^\/(?:u\/\d+\/)?apps\/[a-z0-9-]+$/i.test(u.pathname))throw new Error('请在当前标签页打开一个已登录的专用 Build 项目');
  if(pathUser&&queryUser&&pathUser!==queryUser)throw new Error('账号索引不一致');
  const authUser=pathUser||queryUser||'0';if(!/^\d{1,2}$/.test(authUser))throw new Error('账号索引无效');
  u.search='';u.hash='';u.searchParams.set('authuser',authUser);return {url:u.href,authUser};
}
export const identityExpression=`(${readBuildIdentity.toString()})()`;
export const allowedCommands=new Set(['Runtime.evaluate','Input.insertText','Input.dispatchMouseEvent','Network.enable','Page.enable','Page.getFrameTree','Page.reload','Page.handleJavaScriptDialog']);
// Forward only the model/thinking/account metadata needed by the executor.
// Cookies, Authorization, prompt bodies and arbitrary browsing traffic stay out.
export function filterEvent(method,p,tracked){
  if(method==='Inspector.targetCrashed')return {method,params:{}};
  if(method==='Page.javascriptDialogOpening'&&p.type==='beforeunload')return {method,params:{type:p.type}};
  if(method==='Network.requestWillBeSent'){
    const r=p.request;if(!/\/CodeAssistantOffline(?:[/?]|$)/.test(r?.url||''))return null;tracked.add(p.requestId);
    let data;try{const original=JSON.parse(r.postData),slots=Array(19).fill(null);slots[7]=original[7];slots[11]=original[11];slots[18]=[null,null,null,original[18]?.[3]];data=JSON.stringify(slots);}catch{}
    return {method,params:{requestId:p.requestId,request:{url:r.url,method:r.method,headers:Object.fromEntries(Object.entries(r.headers||{}).filter(([key])=>['x-goog-authuser','x-aistudio-g1-tier'].includes(key.toLowerCase()))),postData:data}}};
  }
  if(method==='Network.responseReceived'&&tracked.has(p.requestId))return {method,params:{requestId:p.requestId,response:{url:p.response.url,status:p.response.status,headers:Object.fromEntries(Object.entries(p.response.headers||{}).filter(([key])=>key.toLowerCase()==='retry-after'))}}};
  if(method==='Network.loadingFailed'&&tracked.delete(p.requestId))return {method,params:{requestId:p.requestId,errorText:String(p.errorText||'').slice(0,120)}};
  if(method==='Network.loadingFinished')tracked.delete(p.requestId);
  return null;
}
