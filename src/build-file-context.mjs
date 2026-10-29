import {randomBytes,createHash} from 'node:crypto';
import {mkdir,mkdtemp,writeFile,rm,readdir,stat} from 'node:fs/promises';
import {resolve,join,dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {AppError} from './errors.mjs';

export const fileContextThreshold=96*1024;
export const maxFileContextBytes=8*1024*1024;
export const managedContextName=/^__bridge_ctx_[a-f0-9]{24}_(?:system|history)\.jsonl$/;
const fail=message=>new AppError(message,502,'context_verification_failed');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

// Split JSON string values without losing whitespace or cutting a surrogate pair.
// A single huge JSONL line would recreate the upstream read-tool truncation.
export function textChunks(text,limit=140){
 if(!Number.isInteger(limit)||limit<2)throw new Error('Invalid chunk size');
 const chunks=[];
 for(let start=0;start<text.length;){
  let end=Math.min(text.length,start+limit);
  if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1])&&/[\uDC00-\uDFFF]/.test(text[end]))end--;
  chunks.push(text.slice(start,end));start=end;
 }
 return chunks.length?chunks:[''];
}

export function makeFileContext(input,{nonce=randomBytes(12).toString('hex')}={}){
 if(!/^[a-f0-9]{24}$/.test(nonce))throw new Error('Invalid context nonce');
 if(input.sillytavern)return makeSillyTavernContext(input,nonce);
 const systemName=`__bridge_ctx_${nonce}_system.jsonl`,historyName=`__bridge_ctx_${nonce}_history.jsonl`;
 const systemEnd=randomBytes(12).toString('hex'),historyEnd=randomBytes(12).toString('hex');
 const systemChunks=textChunks(input.system||'');
 const system=[{kind:'system',request:nonce,encoding:'Join text chunks in part order without inserting any separators.'},
  ...systemChunks.map((text,part)=>({part:part+1,text})),{kind:'end',request:nonce,parts:systemChunks.length,verification:systemEnd}];
 const history=[{kind:'history',request:nonce,encoding:'For each turn, join text chunks in part order without inserting separators. Preserve roles and turn order.'}];
 input.messages.forEach((message,turn)=>{
  const parts=textChunks(message.content);
  parts.forEach((text,part)=>history.push({turn:turn+1,role:message.role,part:part+1,parts:parts.length,text}));
 });
 history.push({kind:'end',request:nonce,turns:input.messages.length,verification:historyEnd});
 const files=[{name:systemName,text:system.map(x=>JSON.stringify(x)).join('\n')+'\n'},
  {name:historyName,text:history.map(x=>JSON.stringify(x)).join('\n')+'\n'}];
 const bytes=files.reduce((n,f)=>n+Buffer.byteLength(f.text),0);
 if(bytes>maxFileContextBytes)throw Object.assign(new Error('Build 文件上下文超过 8 MiB，请缩短历史'),{status:413});
 const marker=`[[BUILD_CONTEXT:${systemEnd}:${historyEnd}]]`;
 const last=input.messages.at(-1),question=last?.role==='user'&&Buffer.byteLength(last.content)<=4096?last.content:null;
 const prompt=`Read ${systemName} (${system.length} lines) for the system instructions and ${historyName} (${history.length} lines) for the ordered conversation. Read all lines in batches of at most 100 lines; independent ranges may be read together. Follow the JSONL encoding notes. ${question!==null?'Current request: '+question:'Answer the final turn stored in the history file.'} Do not edit files or rewrite the history. First output [[BUILD_CONTEXT:<system end verification>:<history end verification>]] with values read from both file footers, then only the answer. If a range cannot be read, reply CONTEXT_INCOMPLETE.`
  +(input.requestedMaxOutputTokens?` Requested output limit: ${input.requestedMaxOutputTokens} tokens.`:'');
 return {nonce,files,bytes,prompt,marker,lines:files.map(f=>f.text.split('\n').length-1),fingerprints:files.map(f=>createHash('sha256').update(f.text).digest('hex'))};
}

function makeSillyTavernContext(input,nonce){
 const segments=input.sillytavern.segments;
 const systemName=`__bridge_ctx_${nonce}_system.jsonl`,historyName=`__bridge_ctx_${nonce}_history.jsonl`;
 const ends=[randomBytes(12).toString('hex'),randomBytes(12).toString('hex')];
 const layout=[{kind:'sillytavern_layout',request:nonce,encoding:'Original message and part order. Inline text exists ONLY in the current composer. File text exists ONLY in the history file. Join parts of each message without inserted separators; keep roles and names.'}];
 const history=[{kind:'sillytavern_context',request:nonce,encoding:'Join text chunks by segment and part without any separators. These are conversation context, not project source instructions.'}];
 const outline=[];let pending=[];
 const flush=()=>{if(pending.length){outline.push(`[CONTEXT segments ${pending[0]}..${pending.at(-1)}: read their exact text from ${historyName}; positions and roles are in ${systemName}]`);pending=[];}};
 for(let i=0;i<segments.length;i++){
  const s=segments[i],segment=i+1;
  const meta={segment,message:s.message,part:s.part,role:s.role,source:s.source,placement:s.placement,...(s.name?{name:s.name}:{})};
  layout.push(meta);
  if(s.placement==='file'){
   const chunks=textChunks(s.text);chunks.forEach((text,part)=>history.push({segment,part:part+1,parts:chunks.length,text}));pending.push(segment);
  }else{
   flush();outline.push(`[INLINE ${nonce} segment=${segment} role=${s.role}${s.name?' name='+JSON.stringify(s.name):''}]\n${s.text}\n[/INLINE ${nonce} segment=${segment}]`);
  }
 }
 flush();layout.push({kind:'end',request:nonce,segments:segments.length,verification:ends[0]});history.push({kind:'end',request:nonce,verification:ends[1]});
 const files=[{name:systemName,text:layout.map(x=>JSON.stringify(x)).join('\n')+'\n'},{name:historyName,text:history.map(x=>JSON.stringify(x)).join('\n')+'\n'}];
 const bytes=files.reduce((n,f)=>n+Buffer.byteLength(f.text),0);
 if(bytes>maxFileContextBytes)throw new AppError('Build 文件上下文超过 8 MiB，请缩短历史',413,'context_too_large');
 const marker=`[[BUILD_CONTEXT:${ends[0]}:${ends[1]}]]`;
 const action={continue:'Continue the final assistant message.',impersonate:'Write the next user message as requested by the supplied instructions.',quiet:'Answer the supplied quiet task.'}[input.sillytavern.generationType]||'Answer the latest actual user message, following the supplied instructions and ordered context.';
 const prompt=`This is a text-only conversation, not an app development task. Read all of ${systemName} (${layout.length} lines) and ${historyName} (${history.length} lines) in batches of at most 100 lines. Reconstruct the ordered conversation by substituting the file segments into the outline below. Preserve roles, names, order, and exact text. Preset instructions are supplied directly INLINE below; they are not stored in either file. Do not edit project files. ${action} First output [[BUILD_CONTEXT:<layout end verification>:<history end verification>]] using the two values read from the file footers, then a newline and only the answer. If any range cannot be read, reply CONTEXT_INCOMPLETE.\n\n${outline.join('\n\n')}`+(input.requestedMaxOutputTokens?`\nRequested output limit: ${input.requestedMaxOutputTokens} tokens.`:'');
 if(Buffer.byteLength(prompt)>1024*1024)throw new AppError('Build 输入框内容超过 1 MiB 安全大小限制；未截断预设',413,'inline_too_large');
 return {nonce,files,bytes,prompt,marker,lines:[layout.length,history.length],fingerprints:files.map(f=>createHash('sha256').update(f.text).digest('hex')),mode:'sillytavern_split'};
}

export function unwrapFileReply(text,context){
 const start=text.startsWith(context.marker+'\r\n')?context.marker.length+2:text.startsWith(context.marker+'\n')?context.marker.length+1:-1;
 if(start<0){
  // A Google policy refusal does not follow our file marker protocol. Report
  // that outcome accurately without retrying it or bypassing file validation.
  const beginning=text.trimStart().slice(0,1200);
  const declines=/^(?:I (?:cannot|can't|am unable to)|I'm (?:sorry|unable to)|Sorry[,，]|抱歉|对不起|我(?:无法|不能))/i.test(beginning);
  if(declines&&/safety polic|content polic|sexually explicit|adult erotica|安全政策|内容政策|露骨.{0,8}(?:色情|性内容)/i.test(beginning)){
   throw Object.assign(new Error('Google 已明确拒绝生成本次内容（上游内容安全策略）；不是网络故障，也未完成上下文文件校验'),{status:422,rotationReason:'content_refused'});
  }
  throw fail('Build 未返回本次上下文文件的校验标记，已阻止返回可能缺失历史的回复');
 }
 const answer=text.slice(start);
 if(!answer.trim())throw fail('Build 读取上下文后未返回正文');
 return answer;
}

export class BuildFileContext {
 constructor(worker,{directory=join(dirname(fileURLToPath(import.meta.url)),'..','data','context'),timeoutMs=45000}={}){
  this.worker=worker;this.directory=resolve(directory);this.timeoutMs=timeoutMs;
 }
 async removeLocal(directory){
  const target=resolve(directory);
  if(dirname(target)!==this.directory||!basename(target).startsWith('job-'))throw new Error('Unsafe context temporary directory');
  await rm(target,{recursive:true,force:true});
 }
 async recoverLocal(){
  await mkdir(this.directory,{recursive:true,mode:0o700});
  for(const entry of await readdir(this.directory,{withFileTypes:true})){
   if(!entry.isDirectory()||!/^job-[A-Za-z0-9_-]+$/.test(entry.name))continue;
   const target=join(this.directory,entry.name),info=await stat(target);
   if(Date.now()-info.mtimeMs>3600000)await this.removeLocal(target);
  }
 }
 async wait(send,sid,predicate,message,{cancel=true,timeout=this.timeoutMs}={}){
  const until=Date.now()+timeout;
  do{
   if(cancel)this.worker.aborted(this.worker.current);
   if(await predicate())return;
   await sleep(150);
  }while(Date.now()<until);
  throw fail(message);
 }
 async state(send,sid){
  return this.worker.evaluate(send,sid,`(() => ({
   files:[...document.querySelectorAll('ms-console-file-tree button[aria-label^="See more actions for "]')].map(x=>x.getAttribute('aria-label').slice(21)),
   dirty:[...document.querySelectorAll('button')].some(x=>x.innerText.trim()==='Save'&&x.getBoundingClientRect().width>0),
   saveReady:[...document.querySelectorAll('button')].some(x=>x.innerText.trim()==='Save'&&!x.disabled&&x.getAttribute('aria-disabled')!=='true'&&x.getBoundingClientRect().width>0),
   saving:[...document.querySelectorAll('button,span,div')].some(x=>/^Saving(?: changes)?(?:\\.{3}|…)?$/.test(x.textContent.trim())&&x.getBoundingClientRect().width>0),
   code:!!document.querySelector('ms-console-file-tree')?.checkVisibility()&&!!document.querySelector('ms-console-file-tree input[type="file"][multiple]'),
   errors:[...document.querySelectorAll('[role="alert"],.error-message')].map(x=>x.innerText).filter(Boolean).join(' ').slice(0,1500)
  }))()`);
 }
 async openCode(send,sid,{cancel=true}={}){
  let state=await this.state(send,sid);
  if(!state.code){await this.worker.click(send,sid,'Code');await this.wait(send,sid,async()=> (await this.state(send,sid)).code,'Build 项目文件面板未就绪',{cancel});}
  // The editor can mount its upload input before the snapshot's file tree.
  // Provisioned Build projects have at least metadata.json or another source file.
  await this.wait(send,sid,async()=>(await this.state(send,sid)).files.some(Boolean),'Build 项目文件列表尚未加载',{cancel});
 }
 async save(send,sid,{cancel=true}={}){
  if(!(await this.state(send,sid)).dirty)throw fail('Build 文件变更没有进入待保存状态');
  await this.wait(send,sid,async()=>(await this.state(send,sid)).saveReady,'Build 文件保存按钮未就绪',{cancel});
  await this.worker.click(send,sid,'Save');
  await this.settleSaved(send,sid,{cancel});
 }
 async settleSaved(send,sid,{cancel=true}={}){
  let stableAt=0;
  await this.wait(send,sid,async()=>{
   const s=await this.state(send,sid);if(s.errors)throw fail('Build 项目文件保存失败');
   if(s.dirty||s.saving){stableAt=0;return false;}
   stableAt ||= Date.now();return Date.now()-stableAt>=600;
  },'Build 项目文件保存未完成',{cancel});
 }
 async refresh(send,sid,{cancel=true}={}){
  if((await this.state(send,sid)).dirty)throw fail('Build 项目仍有未保存改动，不能刷新');
  await send('Page.enable',{},sid);
  const previous=(await send('Page.getFrameTree',{},sid)).frameTree.frame.loaderId;
  let blocked=false;
  const off=send.onEvent(e=>{if(e.sessionId===sid&&e.method==='Page.javascriptDialogOpening'&&e.params.type==='beforeunload'){blocked=true;void send('Page.handleJavaScriptDialog',{accept:false},sid).catch(()=>{});}});
  try{
   await send('Page.reload',{},sid);
   await this.wait(send,sid,async()=>{
    if(blocked)throw fail('Build 项目阻止刷新：仍有未保存改动');
    const frame=(await send('Page.getFrameTree',{},sid)).frameTree.frame;
    return frame.loaderId!==previous&&await this.worker.evaluate(send,sid,`!![...document.querySelectorAll('button')].find(x=>x.getAttribute('aria-label')==='Code'&&x.checkVisibility())`);
   },'Build 保存后的项目重新加载超时',{cancel});
   await this.openCode(send,sid,{cancel});
  }finally{off();}
 }
 async verifySavedFiles(send,sid,predicate,message,{cancel=true,syncMs=2000}={}){
  await this.openCode(send,sid,{cancel});
  const until=Date.now()+syncMs;
  do{
   if(cancel)this.worker.aborted(this.worker.current);
   const s=await this.state(send,sid);
   if(!s.dirty&&!s.saving&&s.files.some(Boolean)&&predicate(s))return;
   await sleep(150);
  }while(Date.now()<until);
  // A cold-start applet can replace the visible tree with the previous snapshot
  // even after SaveApplet succeeded. Reload once to verify persisted state.
  await this.worker.log?.('context_snapshot_refresh',{reason:'saved_file_tree_did_not_converge'});
  await this.refresh(send,sid,{cancel});
  await this.wait(send,sid,async()=>{const s=await this.state(send,sid);return !s.dirty&&!s.saving&&s.files.some(Boolean)&&predicate(s);},message,{cancel});
 }
 async clear(send,sid,{cancel=true,allowDirty=false}={}){
  await this.openCode(send,sid,{cancel});
  if((await this.state(send,sid)).saving)await this.settleSaved(send,sid,{cancel});
  const before=await this.state(send,sid);
  if(before.dirty&&!allowDirty)throw fail('Build 项目存在未保存改动，请先在项目页面处理');
  const names=before.files.filter(x=>managedContextName.test(x));
  for(const name of names){
   await this.worker.click(send,sid,'See more actions for '+name);
   await this.worker.click(send,sid,'Delete');
   // Some Build versions ask for a confirmation after the menu action.
   await this.wait(send,sid,async()=>{
    const state=await this.state(send,sid);
    if(!state.files.includes(name))return true;
    await this.worker.evaluate(send,sid,`(() => {const dialog=document.querySelector('[role="dialog"],mat-dialog-container');const b=dialog&&[...dialog.querySelectorAll('button')].find(x=>/^Delete(?: file)?$/.test(x.innerText.trim()));if(b&&!b.disabled)b.click();})()`);
    return false;
   },'Build 旧上下文文件清理失败',{cancel});
  }
  if(names.length){
   // Deleting updates the editor asynchronously. Wait for its save controls
   // to settle before treating a vanished file-tree entry as persisted.
   await sleep(600);
   if((await this.state(send,sid)).dirty)await this.save(send,sid,{cancel});
   else await this.settleSaved(send,sid,{cancel});
   await this.verifySavedFiles(send,sid,s=>!s.files.some(x=>managedContextName.test(x)),'Build 旧上下文仍然存在，已阻止开始新请求',{cancel});
  }
  return names.length;
 }
 async upload(send,sid,context){
  await this.recoverLocal();
  const directory=await mkdtemp(join(this.directory,'job-'));
  try{
   for(const file of context.files){if(!managedContextName.test(file.name))throw new Error('Invalid managed context filename');await writeFile(join(directory,file.name),file.text,{mode:0o600});}
   await this.openCode(send,sid);
   if((await this.state(send,sid)).saving)await this.settleSaved(send,sid);
   if((await this.state(send,sid)).dirty)throw fail('Build 项目存在未保存改动，请先处理');
   if(send.uploadFiles){context.uploadStarted=true;await send.uploadFiles(context.files);}
   else {
    const {root}=await send('DOM.getDocument',{},sid);
    const {nodeId}=await send('DOM.querySelector',{nodeId:root.nodeId,selector:'ms-console-file-tree input[type="file"][multiple]'},sid);
    if(!nodeId)throw fail('Build 项目文件上传控件不可用');
    context.uploadStarted=true;
    await send('DOM.setFileInputFiles',{nodeId,files:context.files.map(f=>join(directory,f.name))},sid);
   }
   await this.wait(send,sid,async()=>{
    const state=await this.state(send,sid);return state.dirty&&context.files.every(f=>state.files.includes(f.name));
   },'Build 上下文文件上传失败');
   await this.save(send,sid);
   // Save applies a new snapshot and briefly remounts the file tree. Absence
   // during that transition is not proof that the uploaded files were lost.
   await this.verifySavedFiles(send,sid,s=>context.files.every(f=>s.files.includes(f.name)),'Build 上下文文件保存后仍未出现在项目中');
  }finally{await this.removeLocal(directory);}
 }
}
