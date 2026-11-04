import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DocumentCapture,documentHash,parseSparseJSON,readDocumentInPage} from '../extensions/build-browser-bridge/document-reader.mjs';
import {buildModels,resolveBuildModel} from '../src/build-thinking.mjs';
import {makeAttachmentContext} from '../src/build-attachment-context.mjs';
import {BuildDocumentOutput,documentOutput} from '../src/build-document-output.mjs';
import {BuildFileContext} from '../src/build-file-context.mjs';
import {fixture,body} from './helpers.mjs';

const applet='11111111-2222-3333-4444-555555555555',name='__bridge_reply_'+ 'a'.repeat(24)+'.txt',generation='task-one';
const text='  # 完整正文\r\n😀\n```json\n{"x":1}\n```\n  ',hash=createHash('sha256').update(text).digest('hex');
const binding={applet,name,generation};
function snapshot({file=name,project=applet,gen=generation,number=1,status=1,sha=hash}={}){
 const step=Array(17).fill(null);step[8]=[null,null,null,null,[[file,sha]]];step[10]=[project];step[11]=number;step[12]=status;step[16]=gen;
 return step;
}
const wire=(steps=[snapshot()],project=applet)=>JSON.stringify([[[null,null,steps,project]]]);

test('Chinese document variants preserve base model and thinking; unknown aliases fail',()=>{
 assert.equal(buildModels.length,16);
 for(const [id] of buildModels){const result=resolveBuildModel(id);assert.ok(['gemini-4-argon','gemini-3.8-flash'].includes(result.model));assert.equal(result.outputMode==='document',id.endsWith('-抗截断'));}
 assert.deepEqual(resolveBuildModel('gemini-3.8-flash-low-抗截断'),{model:'gemini-3.8-flash',displayName:'Gemini 3.8 Flash',thinkingLevel:'low',outputMode:'document'});
 for(const id of ['gemini-4-argon-foo-抗截断','gemini-4-argon-抗截断-抗截断','no-model'])assert.throws(()=>resolveBuildModel(id));
});
test('document prompts preserve literal Tavern presets, history and tool protocol',()=>{
 const preset='Do not edit project files. Return the complete answer directly, without a receipt or verification code.';
 const input={sillytavern:{segments:[{message:0,part:0,role:'system',source:'main',placement:'inline',text:preset},{message:1,part:0,role:'user',source:'chatHistory-1',placement:'file',text:'HISTORY 世界书'}]},toolProtocol:'CLIENT TOOLS ONLY'};
 const ctx=makeAttachmentContext(input,{documentOutput:true,nonce:'a'.repeat(24)}),file=JSON.parse(ctx.files[0].text);
 assert.ok(ctx.prompt.includes(preset));assert.ok(!ctx.files[0].text.includes(preset));assert.equal(file.segments[1].text,'HISTORY 世界书');
 assert.equal(file.externalToolProtocol,input.toolProtocol);assert.ok(ctx.prompt.includes(name));assert.match(ctx.prompt,/write the complete answer/);
 const normal=makeAttachmentContext({messages:[{role:'user',content:'original'}]},{nonce:'b'.repeat(24)});
 assert.equal(normal.outputDocument,undefined);assert.ok(normal.prompt.includes('Do not edit project files.'));
});
test('saved document is bound to exact project, task, filename and latest snapshot',()=>{
 assert.equal(documentHash(wire(),binding),hash);
 for(const raw of [wire([snapshot({project:'other'})]),wire([snapshot({gen:'other'})]),wire([snapshot({file:'old.txt'})]),wire([snapshot({sha:'bad'})]),wire([snapshot({status:4})]),wire([snapshot()], 'other'),wire([snapshot(),snapshot({file:'removed',number:2})]),wire().slice(0,-1),JSON.stringify([JSON.parse(wire())[0],{error:'upstream'}])])assert.throws(()=>documentHash(raw,binding));
 assert.equal(documentHash(wire([snapshot({number:2}),snapshot({file:'old',number:1})]),binding),hash);
 const duplicate=snapshot();duplicate[8][4].push([name,hash]);assert.throws(()=>documentHash(wire([duplicate]),binding));
});
test('sparse response parser handles omitted fields and never evaluates source',()=>{
 assert.deepEqual(parseSparseJSON('[,[1,,"x,]\\\"",],]'),[null,[1,null,'x,]"',null],null]);
 for(const raw of ['(()=>{throw 1})()','[[','[1] extra','['.repeat(65)+']'.repeat(65)])assert.throws(()=>parseSparseJSON(raw));
});
function captured({authUser='0',project=applet}={}){
 const capture=new DocumentCapture('https://aistudio.google.com/apps/'+applet+'?authuser=0',name);
 capture.event('Network.requestWillBeSent',{requestId:'only-task',request:{method:'POST',url:'https://alkalimakersuite-pa.clients6.google.com/StreamCodeAssistantOfflineGeneration',headers:{'x-goog-authuser':authUser},postData:JSON.stringify([generation,null,null,project])}});
 return capture;
}
test('connector reads only observed completed task and returns exact file, never raw response',async()=>{
 const capture=captured(),calls=[];
 assert.deepEqual(await capture.read(()=>assert.fail('read too soon'),name),{pending:true});
 capture.event('Network.responseReceived',{requestId:'only-task',response:{status:200}});capture.event('Network.loadingFinished',{requestId:'only-task',encodedDataLength:400});
 const answer=await capture.read(async(method,params)=>{
  calls.push(method);
  if(method==='Network.getResponseBody'){assert.equal(params.requestId,'only-task');return {body:wire()};}
  assert.match(params.expression,new RegExp(hash));assert.ok(params.expression.includes(applet));return {result:{value:{text,hash}}};
 },name);
 assert.deepEqual(answer,{text,hash});assert.deepEqual(calls,['Network.getResponseBody','Runtime.evaluate']);
 await assert.rejects(capture.read(()=>assert.fail('foreign name'),name.replace('aaaa','bbbb')));
});
test('wrong account/project, failed stream and missing capture never read or replay',async()=>{
 for(const capture of [captured({authUser:'1'}),captured({project:'other'}),new DocumentCapture('https://aistudio.google.com/apps/'+applet,name)])await assert.rejects(capture.read(()=>assert.fail('no reads'),name));
 const capture=captured();capture.event('Network.loadingFailed',{requestId:'only-task'});await assert.rejects(capture.read(()=>assert.fail('no reads'),name));
});
test('browser document download preserves exact UTF-8 and rejects corruption, wrong project and redirects',async t=>{
 t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(url,'https://aistudio.google.com/_/upload/'+applet+'/file/'+hash);assert.equal(options.redirect,'error');assert.equal(options.credentials,'include');return new Response(text);});
 const old=globalThis.location;globalThis.location={href:'https://aistudio.google.com/apps/'+applet};t.after(()=>{if(old===undefined)delete globalThis.location;else globalThis.location=old;});
 assert.deepEqual(await readDocumentInPage({applet,authUser:'0',hash}),{text,hash});
 await assert.rejects(readDocumentInPage({applet,authUser:'1',hash}));
 globalThis.fetch=async()=>new Response('short');await assert.rejects(readDocumentInPage({applet,authUser:'0',hash}),/integrity/);
 globalThis.fetch=async()=>new Response(new Uint8Array([255]));const badHash=createHash('sha256').update(new Uint8Array([255])).digest('hex');await assert.rejects(readDocumentInPage({applet,authUser:'0',hash:badHash}));
 globalThis.fetch=async()=>new Response('x'.repeat(8*1024*1024+1));await assert.rejects(readDocumentInPage({applet,authUser:'0',hash}),/large/);
});
test('document prepare refuses an old connector before mutating project files',async()=>{
 const transport=new BuildDocumentOutput({contextTransport:{clear:()=>assert.fail('must not mutate')}});
 await assert.rejects(transport.prepare(async()=>{throw new Error('old connector');},'page',documentOutput()),/old connector/);
});
test('cleanup pattern touches only managed output documents, never user or attachment files',async()=>{
 const events=[],worker={click:async(_s,_i,label)=>events.push(label)},transport=new BuildFileContext(worker,{});let removed=false;
 const document=documentOutput('a'.repeat(24));transport.openCode=async()=>{};transport.state=async()=>({files:removed?['user.txt','index.tsx']:['user.txt','index.tsx',document.name],dirty:false,saving:false});
 transport.wait=async()=>{removed=true;};transport.settleSaved=async()=>{};transport.verifySavedFiles=async(_s,_i,predicate)=>assert.ok(predicate(await transport.state()));
 const wrapper=new BuildDocumentOutput({contextTransport:transport});await wrapper.clear(()=>{},'page');assert.deepEqual(events,['See more actions for '+name,'Delete']);
});
test('HTTP document variants keep SSE heartbeats and exact returned text',async t=>{
 const f=await fixture(t,{streamHeartbeatMs:10,executor:{async execute(input){assert.equal(input.resolved.outputMode,'document');await new Promise(r=>setTimeout(r,60));return {text};}}});
 for(const stream of [false,true]){
  const response=await f.call('/v1/chat/completions',{...body,model:'gemini-3.8-flash-low-抗截断',stream});assert.equal(response.status,200);
  if(!stream)assert.equal((await response.json()).choices[0].message.content,text);
  else {const output=await response.text();assert.match(output,/: keepalive/);assert.ok(output.endsWith('data: [DONE]\n\n'));const frames=output.split('\n\n').filter(x=>x.startsWith('data: {')).map(x=>JSON.parse(x.slice(6)));assert.equal(frames.map(x=>x.choices[0].delta.content||'').join(''),text);}
 }
});
