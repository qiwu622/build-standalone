import test from 'node:test';
import assert from 'node:assert/strict';
import {BuildChatWorker} from '../src/build-chat.mjs';
import {body} from './helpers.mjs';
import {parseCompletion} from '../src/protocol.mjs';
import {encodeEnvelope} from '../extensions/build-standalone-adapter/transport.js';

function fixture({level='low',wireLevel=level,wireModel='gemini-4-argon',wireUser='0',wire=true,context=false,cleanupFails=false,text='VERIFIED',apiBody,threshold}={}) {
  const listeners=new Set(),events=[],request={};const input=parseCompletion(apiBody||{...body,model:'gemini-4-argon-'+level});
  const send=async()=>({});send.onEvent=fn=>{listeners.add(fn);return()=>listeners.delete(fn);};
  const worker=new BuildChatWorker({cdp:fn=>fn(send),responseSettleMs:1,pollInterval:2,contextThreshold:threshold??(context?1:96*1024)});
  worker.current=request;worker.context=async()=>{};worker.wait=async()=>({ready:true,count:0,running:false});
  worker.click=async(_send,_sid,label)=>events.push(label);worker.configureThinking=async(_send,_sid,value)=>events.push('thinking:'+value);
  let ctx,composer;
  worker.evaluate=async(_send,_sid,script)=>script.includes('using your Google AI subscription')?true:script.includes('const responses')?{ready:true,count:1,running:false,text:ctx?ctx.marker+'\n'+text:text,header:'Gemini 4 Argon'}:null;
  worker.fillAndSend=async(_send,_sid,prompt)=>{composer=prompt;events.push('Send');if(!wire)return;const data=Array(19).fill(null);data[7]='models/'+wireModel;data[18]=[null,null,null,{low:1,medium:2,high:3}[wireLevel]];
    for(const fn of listeners)fn({sessionId:'page',method:'Network.requestWillBeSent',params:{requestId:'fixture',request:{method:'POST',url:'https://alkalimakersuite-pa.clients6.google.com/CodeAssistantOffline',headers:{'x-goog-authuser':wireUser},postData:JSON.stringify(data)}}});
  };
  if(context)worker.contextTransport={clear:async(_s,_sid,options)=>{events.push('clear');if(options&&cleanupFails)throw new Error('cleanup failed');},upload:async(_s,_sid,value)=>{ctx=value;value.uploadStarted=true;events.push('upload');}};
  return {events,request,get context(){return ctx;},get composer(){return composer;},run:()=>worker.generateOne(input.alias,input.body,request)};
}
test('direct worker selects model then thinking, verifies actual RPC, and resets new chat',async()=>{
  for(const level of ['low','medium','high']){
    const f=fixture({level});assert.equal(await f.run(),'VERIFIED');assert.equal(f.request.googleThinkingLevel,level);
    assert.ok(f.events.indexOf('New chat')<f.events.indexOf('Gemini 4 Argon, Paid'));assert.ok(f.events.indexOf('Gemini 4 Argon, Paid')<f.events.indexOf('thinking:'+level));assert.ok(f.events.indexOf('thinking:'+level)<f.events.indexOf('Send'));
  }
});
test('actual model/level mismatch or absent metadata fail closed',async()=>{
  for(const options of [{wireLevel:'high'},{wireModel:'gemini-3.8-flash'},{wire:false}])await assert.rejects(fixture(options).run(),e=>e.status===502&&e.rotationReason==='thinking_configuration_failed');
});
test('long history uploads before fresh chat and cleans before successful return',async()=>{
  const f=fixture({context:true});assert.equal(await f.run(),'VERIFIED');assert.ok(f.events.indexOf('upload')<f.events.indexOf('New chat'));assert.equal(f.events.at(-1),'clear');
});
test('cleanup failure and explicit Google content refusal are never successful',async()=>{
  await assert.rejects(fixture({context:true,cleanupFails:true}).run(),e=>e.code==='context_cleanup_failed');
  await assert.rejects(fixture({text:'I cannot comply with this content policy request.'}).run(),e=>e.status===422);
});
test('actual Google RPC with a different account index is rejected',async()=>{
  await assert.rejects(fixture({wireUser:'1'}).run(),e=>e.code==='account_mismatch');
});

test('ST worker always uploads background and sends preset directly, even under ordinary file threshold',async()=>{
  const segments=[{message:0,part:0,role:'system',source:'main',placement:'inline',text:'PRESET_ONLY'}, {message:1,part:0,role:'user',source:'chatHistory-1',placement:'file',text:'HISTORY_ONLY'}];
  const f=fixture({context:true,threshold:1000000,apiBody:{model:'build-st/gemini-4-argon-low',messages:[encodeEnvelope(segments,'normal',30)]}});
  assert.equal(await f.run(),'VERIFIED');assert.equal(f.request.contextMode,'sillytavern_split');
  assert.ok(f.composer.includes('PRESET_ONLY'));assert.ok(!f.composer.includes('HISTORY_ONLY'));
  assert.ok(f.context.files[1].text.includes('HISTORY_ONLY'));assert.ok(!f.context.files.some(x=>x.text.includes('PRESET_ONLY')));
  assert.ok(f.events.indexOf('upload')<f.events.indexOf('Send'));assert.equal(f.events.at(-1),'clear');
});
