import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {makeAttachmentContext,BuildAttachmentContext,attachmentUploadExpression} from '../src/build-attachment-context.mjs';

test('ST attachment roundtrips mixed message parts without copying inline preset text',()=>{
 const segments=[
  {message:0,part:0,role:'system',source:'main',placement:'inline',text:'  PRESET😀\r\n'},
  {message:0,part:1,role:'system',source:'worldInfoBefore',placement:'file',text:'WORLD\n\t"\\😀 '.repeat(40000)},
  {message:0,part:2,role:'system',source:'jailbreak',placement:'inline',text:'POST_PRESET'},
  {message:1,part:0,role:'assistant',name:'角色😀',source:'chatHistory-1',placement:'file',text:'HISTORY  \r\n'},
  {message:2,part:0,role:'user',source:'currentUser',placement:'inline',text:'QUESTION'},
  {message:3,part:0,role:'developer',source:'context',placement:'file',text:''}
 ];
 const input={sillytavern:{segments,generationType:'normal'}},original=structuredClone(input),ctx=makeAttachmentContext(input),other=makeAttachmentContext(input),stored=JSON.parse(ctx.files[0].text);
 assert.equal(ctx.files.length,1);assert.notEqual(ctx.files[0].name,other.files[0].name);assert.equal(ctx.bytes,Buffer.byteLength(ctx.files[0].text));
 assert.deepEqual(stored.segments.map(({segment,...s})=>({...s,text:s.placement==='inline'?segments[segment-1].text:s.text})),segments);
 for(const s of segments){if(s.placement==='inline'){assert.ok(ctx.prompt.includes(s.text));assert.ok(!ctx.files[0].text.includes(s.text));}else if(s.text)assert.ok(!ctx.prompt.includes(s.text));}
 assert.ok(!ctx.prompt.includes(other.files[0].name));assert.equal(stored.request,ctx.nonce);assert.deepEqual(input,original);
 assert.ok(!ctx.prompt.includes('BUILD_CONTEXT'));assert.equal(ctx.marker,undefined);
});

test('ST attachment keeps generation actions and enforces separate preset and file size budgets',()=>{
 const preset={message:0,part:0,role:'system',source:'main',placement:'inline',text:'PRESET_ONLY'};
 for(const [generationType,action] of Object.entries({normal:'Answer the latest actual user',continue:'Continue the final assistant',impersonate:'Write the next user',quiet:'Answer the supplied quiet'})){
  const ctx=makeAttachmentContext({sillytavern:{generationType,segments:[preset]},requestedMaxOutputTokens:128});
  assert.ok(ctx.prompt.includes(action));assert.ok(ctx.prompt.includes('Requested output limit: 128 tokens.'));
  assert.ok(JSON.parse(ctx.files[0].text).segments.every(s=>!Object.hasOwn(s,'text')));
 }
 assert.throws(()=>makeAttachmentContext({sillytavern:{segments:[{...preset,text:'x'.repeat(1024*1024)}]}}),e=>e.code==='inline_too_large');
 assert.throws(()=>makeAttachmentContext({sillytavern:{segments:[{...preset,placement:'file',text:'x'.repeat(8*1024*1024)}]}}),e=>e.code==='context_too_large');
});

test('attachment serializes complete roles and Unicode verbatim without JSONL fragmentation or a receipt',()=>{
 const input={system:'系统\r\n 😀  ',messages:[{role:'user',content:'甲\n\t"\\😀 '.repeat(20000)},{role:'model',content:'old response'},{role:'user',content:'last request'}]};
 const a=makeAttachmentContext(input),b=makeAttachmentContext(input);
 assert.deepEqual(JSON.parse(a.files[0].text),input);assert.notEqual(a.files[0].name,b.files[0].name);assert.equal(a.files.length,1);
 assert.equal(a.bytes,Buffer.byteLength(a.files[0].text));assert.ok(!a.prompt.includes('BUILD_CONTEXT'));assert.ok(!a.prompt.includes(input.system));
 assert.throws(()=>makeAttachmentContext({system:'x'.repeat(9*1024*1024),messages:[]}),e=>e.status===413);
});

test('native paste supplies actual text File bytes, never inserts history into the composer',async()=>{
 const context=makeAttachmentContext({system:'SYSTEM',messages:[{role:'user',content:'😀\r\n END'}]});let paste,focused=false;
 const field={focus(){focused=true;},dispatchEvent(e){paste=e;}};
 vm.runInNewContext(attachmentUploadExpression(context.files),{document:{querySelector:selector=>{assert.match(selector,/textarea\[msfilecopypaste\]/);return field;}},File,DataTransfer:class{constructor(){this.files=[];this.items={add:f=>this.files.push(f)};}},ClipboardEvent:class{constructor(type,options){this.type=type;Object.assign(this,options);}}});
 assert.equal(focused,true);assert.equal(paste.type,'paste');assert.equal(paste.clipboardData.files.length,1);assert.equal(await paste.clipboardData.files[0].text(),context.files[0].text);assert.equal(paste.clipboardData.files[0].type,'text/plain');
});

test('upload refuses foreign drafts and marks only this request as started',async()=>{
 let pastes=0;const worker={current:{deadline:Date.now()+5000},aborted(){},evaluate:async()=>{pastes++;}};
 const transport=new BuildAttachmentContext(worker),ctx=makeAttachmentContext({messages:[{role:'user',content:'x'}]});
 transport.state=async()=>({ready:true,files:[{name:'personal.txt'}]});
 await assert.rejects(transport.upload(null,'page',ctx),e=>e.code==='attachment_draft_not_empty');assert.equal(pastes,0);assert.equal(ctx.uploadStarted,undefined);
 let reads=0;transport.state=async()=>({ready:true,files:reads++?[{name:ctx.files[0].name,pending:false}]:[]});
 await transport.upload(null,'page',ctx);assert.equal(pastes,1);assert.equal(ctx.uploadStarted,true);
});

test('first-use acknowledgement and upload failures are surfaced without sending',async()=>{
 for(const issue of [{acknowledgement:true},{errors:'Upload failed'}]){
  const worker={current:{deadline:Date.now()+5000},aborted(){},evaluate:async()=>true},transport=new BuildAttachmentContext(worker);let n=0;
  transport.state=async()=>({ready:true,files:[],...(n++?issue:{})});
  await assert.rejects(transport.upload(null,'page',makeAttachmentContext({messages:[{role:'user',content:'x'}]})),e=>e.status===502);
 }
});

test('send-time validation rejects disappeared, still processing, or extra attachments',async()=>{
 const ctx=makeAttachmentContext({messages:[{role:'user',content:'x'}]}),transport=new BuildAttachmentContext({});
 for(const files of [[],[{name:ctx.files[0].name,pending:true}],[{name:ctx.files[0].name},{name:'stale.txt'}]]){
  transport.state=async()=>({files});await assert.rejects(transport.verify(null,'page',ctx),e=>e.code==='attachment_not_ready');
 }
 transport.state=async()=>({files:[{name:ctx.files[0].name,pending:false}]});await transport.verify(null,'page',ctx);
});

test('attachment cleanup exits when a caller cancels during otherwise unlimited cleanup',async t=>{
 t.mock.timers.enable({apis:['Date'],now:1000});
 const current={deadline:Infinity},worker={current,evaluate:async()=>1,aborted(){}},transport=new BuildAttachmentContext(worker,{timeoutMs:10});let polls=0;
 transport.state=async()=>{polls++;current.aborted=true;t.mock.timers.tick(20);return {files:[{name:'__bridge_attachment_0123456789abcdef01234567.txt'}]};};
 await assert.rejects(transport.clear(null,'page',{cancel:false}),e=>e.code==='attachment_cleanup_failed');assert.equal(polls,1);
});
