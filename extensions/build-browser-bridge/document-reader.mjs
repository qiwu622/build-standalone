// Qiwu document-output transport. No signing, BotGuard, cookie export or VM.
// Uses only the current dedicated tab's already-observed generation response.
export const documentNamePattern=/^__bridge_reply_[a-f0-9]{24}\.txt$/;
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const digest=/^[a-f0-9]{64}$/;
const maxStreamBytes=32*1024*1024;
const fail=()=>new Error('抗截断文档未完成或无法核对，请检查专用 Build 项目；未自动重发');

// Google responses can contain omitted array elements. Parse data, never eval.
export function parseSparseJSON(text){
  if(typeof text!=='string'||text.length>maxStreamBytes)throw fail();
  const raw=text.replace(/^\)\]\}'\s*/,''),out=[];let quoted=false,escaped=false,previous='',depth=0;
  for(const ch of raw){
    if(quoted){out.push(ch);if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;}
    if(ch==='"'){quoted=true;previous='value';}
    else if(ch==='['||ch==='{'){if(++depth>64)throw fail();}
    else if(ch===']'||ch==='}'){if(--depth<0)throw fail();}
    if((ch===','&&(previous==='['||previous===','))||(ch===']'&&previous===','))out.push('null');
    out.push(ch);if(!/\s/.test(ch))previous=ch;
  }
  if(depth||quoted)throw fail();
  try{return JSON.parse(out.join(''));}catch{throw fail();}
}

export function documentHash(raw,{name,applet,generation}){
  if(!documentNamePattern.test(name)||!uuid.test(applet)||typeof generation!=='string'||!generation)throw fail();
  const root=parseSparseJSON(raw);
  if(!Array.isArray(root)||!Array.isArray(root[0]))throw fail();
  // Non-empty trailers may be upstream errors; do not return a stale snapshot.
  if(root.slice(1).some(x=>x!==null&&!(Array.isArray(x)&&!x.length)))throw fail();
  let latest=-1,hash='';
  for(const message of root[0]){
    if(!Array.isArray(message)||message[3]!==applet)throw fail();
    if(message[2]==null)continue;
    if(!Array.isArray(message[2]))throw fail();
    for(const step of message[2]){
      if(!Array.isArray(step)||step[5]!=null||step[12]===4)throw fail();
      if(step[16]!=null&&step[16]!==generation)throw fail();
      if(step[8]==null||step[12]!==1)continue;
      if(!Number.isSafeInteger(step[11])||step[10]?.[0]!==applet||!Array.isArray(step[8]?.[4]))throw fail();
      if(step[11]<latest)continue;
      const matches=step[8][4].filter(file=>Array.isArray(file)&&file[0]===name);
      if(matches.length>1||(matches.length&&!digest.test(matches[0][1])))throw fail();
      latest=step[11];hash=matches[0]?.[1]||'';
    }
  }
  if(!hash)throw fail();return hash;
}

export class DocumentCapture {
  constructor(target,name){
    const u=new URL(target),applet=u.pathname.split('/').at(-1);
    if(!uuid.test(applet)||!documentNamePattern.test(name))throw fail();
    this.name=name;this.applet=applet;this.authUser=u.searchParams.get('authuser')||'0';this.streams=new Map();
  }
  event(method,p){
    if(method==='Network.requestWillBeSent'){
      let u;try{u=new URL(p.request?.url);}catch{return;}
      if(u.protocol!=='https:'||!['alkalimakersuite-pa.clients6.google.com','alkalimakersuite-pa.googleapis.com','aistudio.google.com'].includes(u.hostname)||!u.pathname.endsWith('/StreamCodeAssistantOfflineGeneration')||p.request.method!=='POST')return;
      try{
        const body=JSON.parse(p.request.postData),headers=p.request.headers||{};
        const user=Object.entries(headers).find(([k])=>k.toLowerCase()==='x-goog-authuser')?.[1]??u.searchParams.get('authuser')??'0';
        if(body[3]!==this.applet||String(user)!==this.authUser||typeof body[0]!=='string'||!body[0]||body[0].length>256)throw fail();
        if(this.generation&&this.generation!==body[0])throw fail();
        this.generation=body[0];if(this.streams.size>=8)throw fail();
        this.streams.set(p.requestId,{done:false,status:0});
      }catch{this.error=true;}
    }
    const stream=this.streams.get(p.requestId);if(!stream)return;
    if(method==='Network.responseReceived')stream.status=p.response.status;
    if(method==='Network.loadingFailed')this.error=true;
    if(method==='Network.loadingFinished'){stream.done=true;if(p.encodedDataLength>maxStreamBytes)this.error=true;}
  }
  async read(send,name){
    if(name!==this.name||this.error)throw fail();
    const [id,state]=[...this.streams].at(-1)||[];
    if(!state)throw fail();
    if(!state.done)return {pending:true};
    if(state.status!==200)throw fail();
    const reply=await send('Network.getResponseBody',{requestId:id});
    const raw=reply.base64Encoded?atob(reply.body):reply.body;
    const hash=documentHash(raw,this);
    const result=await send('Runtime.evaluate',{expression:documentReadExpression(this,hash),awaitPromise:true,returnByValue:true});
    const value=result.result?.value;
    if(result.exceptionDetails||typeof value?.text!=='string'||value.hash!==hash||!value.text.trim())throw fail();
    // Bridge exchange has a 16 MiB body limit, including JSON escaping.
    if(new TextEncoder().encode(JSON.stringify(value)).length>12*1024*1024)throw fail();
    return value;
  }
}

export function documentReadExpression({applet,authUser},hash){
  if(!uuid.test(applet)||!/^\d{1,2}$/.test(authUser)||!digest.test(hash))throw fail();
  return `(${readDocumentInPage.toString()})(${JSON.stringify({applet,authUser,hash})})`;
}

// Serialized into the authenticated tab. Credentials never leave that tab.
export async function readDocumentInPage({applet,authUser,hash}){
  const current=new URL(location.href),index=/^\/u\/(\d+)\//.exec(current.pathname)?.[1]||current.searchParams.get('authuser')||'0';
  if(current.protocol!=='https:'||current.hostname!=='aistudio.google.com'||current.pathname.split('/').at(-1)!==applet||index!==authUser)throw new Error('Document project changed');
  const response=await fetch(`https://aistudio.google.com/_/upload/${applet}/file/${hash}`,{credentials:'include',redirect:'error',headers:{'x-goog-authuser':authUser}});
  if(!response.ok||!response.body)throw new Error('Document unavailable');
  const reader=response.body.getReader(),chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8*1024*1024)throw new Error('Document too large');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  const actual=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
  if(actual!==hash)throw new Error('Document integrity mismatch');
  return {text:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes),hash};
}
