import {randomBytes} from 'node:crypto';
import {AppError} from './errors.mjs';
import {maxFileContextBytes} from './build-file-context.mjs';

export const managedAttachmentName=/^__bridge_attachment_[a-f0-9]{24}\.txt$/;
const composer='ms-code-assistant-chat .bottom-container';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const fail=(message,code='attachment_upload_failed')=>new AppError(message,502,code);

export function makeAttachmentContext(input,{nonce=randomBytes(12).toString('hex')}={}){
 if(!/^[a-f0-9]{24}$/.test(nonce)||input.sillytavern)throw new Error('Invalid attachment context');
 const name=`__bridge_attachment_${nonce}.txt`;
 const text=JSON.stringify({system:input.system||'',messages:input.messages},null,2)+'\n';
 const bytes=Buffer.byteLength(text);
 if(bytes>maxFileContextBytes)throw new AppError('Build 聊天附件超过 8 MiB，请缩短历史',413,'context_too_large');
 const prompt=`Read the attached text file ${name}. It contains the system instructions and the complete ordered conversation as JSON. Preserve message roles, order, and exact content. Answer the final user request using this conversation. This is a text-only conversation, not an app development task. Do not edit project files. Use only this attachment and the current request as conversation context, not previous project chats or other project files. Return only your answer, without a receipt or verification code.`+(input.requestedMaxOutputTokens?` Requested output limit: ${input.requestedMaxOutputTokens} tokens.`:'');
 return {mode:'chat_attachment',nonce,files:[{name,text,type:'text/plain'}],bytes,prompt};
}

// The native composer exposes msfilecopypaste. Supplying browser-owned File
// objects to that same paste handler avoids local file access in the extension.
export function attachmentUploadExpression(files){
 return `(() => {const field=document.querySelector(${JSON.stringify(composer+' textarea[msfilecopypaste]')});if(!field)throw new Error('Attachment composer unavailable');const transfer=new DataTransfer();for(const f of ${JSON.stringify(files)})transfer.items.add(new File([f.text],f.name,{type:'text/plain'}));field.focus();field.dispatchEvent(new ClipboardEvent('paste',{clipboardData:transfer,bubbles:true,cancelable:true}));return true;})()`;
}

export const attachmentStateExpression=`(() => {const root=document.querySelector(${JSON.stringify(composer)});return {ready:!!root?.querySelector('textarea[msfilecopypaste]'),files:[...root?.querySelectorAll('ms-file-preview')||[]].map(el=>({name:el.querySelector('.file-name')?.textContent.trim(),pending:!!el.querySelector('mat-progress-spinner,mat-spinner,[role="progressbar"],[aria-busy="true"]'),error:el.querySelector('[class*="error"]')?.textContent.trim()||''})),acknowledgement:!!document.querySelector('button[aria-label="Agree to the copyright acknowledgement"]'),errors:[...document.querySelectorAll('[role="alert"], [role="alertdialog"]')].map(el=>el.innerText).filter(Boolean).join(' ').slice(0,1000)};})()`;

export class BuildAttachmentContext {
 constructor(worker,{timeoutMs=45000}={}){this.worker=worker;this.timeoutMs=timeoutMs;}
 state(send,sid){return this.worker.evaluate(send,sid,attachmentStateExpression);}
 async verify(send,sid,context){
  const state=await this.state(send,sid);
  if(state.errors||state.acknowledgement||state.files.length!==context.files.length||!context.files.every(f=>state.files.some(actual=>actual.name===f.name&&!actual.pending&&!actual.error)))throw fail('Build 聊天附件在发送前发生变化，未提交 Google','attachment_not_ready');
 }
 async clear(send,sid,{cancel=true}={}){
  if(cancel)this.worker.aborted(this.worker.current);
  const removed=await this.worker.evaluate(send,sid,`(() => {let count=0;const root=document.querySelector(${JSON.stringify(composer)});for(const el of [...root?.querySelectorAll('ms-file-preview')||[]]){if(!${managedAttachmentName}.test(el.querySelector('.file-name')?.textContent.trim()||''))continue;const b=el.querySelector('button[aria-label="Remove file"]');if(b&&!b.disabled){b.click();count++;}}return count;})()`);
  const started=Date.now(),request=this.worker.current,cleanupDeadline=!cancel?request?.cleanupDeadline:undefined;
  const until=cleanupDeadline??(request?.aborted?started+this.timeoutMs:request?.deadline??Infinity);
  do{
   if(cancel)this.worker.aborted(request);
   if(!(await this.state(send,sid)).files.some(f=>managedAttachmentName.test(f.name||'')))return removed;
   if(!cancel&&request?.aborted&&Date.now()-started>=this.timeoutMs)break;
   await pause(100);
  }while(Date.now()<until);
  throw fail('Build 聊天附件草稿未清理完成','attachment_cleanup_failed');
 }
 async upload(send,sid,context){
  this.worker.aborted(this.worker.current);
  const before=await this.state(send,sid);
  if(!before.ready)throw fail('Build 聊天附件上传控件未就绪');
  if(before.files.length)throw fail('Build 输入框仍有其他附件，已阻止混合发送','attachment_draft_not_empty');
  if(context.files.some(f=>!managedAttachmentName.test(f.name)))throw new Error('Invalid managed attachment filename');
  context.uploadStarted=true;
  await this.worker.evaluate(send,sid,attachmentUploadExpression(context.files));
  const until=this.worker.current?.deadline??Infinity;
  do{
   this.worker.aborted(this.worker.current);
   const state=await this.state(send,sid);
   if(state.acknowledgement)throw fail('请在 Build 页面确认一次首次附件上传提示，然后重新发送','attachment_acknowledgement_required');
   if(state.errors||state.files.some(f=>f.error))throw fail('Google 页面报告聊天附件上传失败');
   if(state.files.some(f=>!context.files.some(want=>want.name===f.name)))throw fail('Build 草稿附件与本次请求不一致','attachment_draft_not_empty');
   if(context.files.every(f=>state.files.some(actual=>actual.name===f.name&&!actual.pending)))return;
   await pause(150);
  }while(Date.now()<until);
  throw fail('Build 聊天附件上传达到配置的执行时限');
 }
}
