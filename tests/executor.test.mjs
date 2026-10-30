import test from 'node:test';
import assert from 'node:assert/strict';
import {BuildChatWorker} from '../src/build-chat.mjs';
import {body} from './helpers.mjs';
import {parseCompletion} from '../src/protocol.mjs';
import {encodeEnvelope} from '../extensions/build-standalone-adapter/transport.js';

function fixture({level='low',wireLevel=level,wireModel='gemini-4-argon',wireUser='0',wire=true,context=false,cleanupFails=false,text='VERIFIED',apiBody,threshold,initialState}={}) {
  const listeners=new Set(),events=[],request={};const input=parseCompletion(apiBody||{...body,model:'gemini-4-argon-'+level});
  const send=async()=>({});send.onEvent=fn=>{listeners.add(fn);return()=>listeners.delete(fn);};
  const worker=new BuildChatWorker({cdp:fn=>fn(send),responseSettleMs:1,pollInterval:2,contextThreshold:threshold??(context?1:96*1024)});
  worker.current=request;worker.context=async()=>{};if(!initialState)worker.wait=async()=>({ready:true,count:0,running:false});
  let page=initialState,submitted=false;
  worker.click=async(_send,_sid,label)=>{events.push(label);if(initialState&&label==='Start new chat')page={ready:true,count:0,running:false,error:'',pageError:'',responseError:''};};worker.configureThinking=async(_send,_sid,value)=>events.push('thinking:'+value);
  let ctx,composer;
  worker.evaluate=async(_send,_sid,script)=>script.includes('using your Google AI subscription')?true:script.includes('const responses')?(page&&!submitted?page:{ready:true,count:1,running:false,text:ctx?ctx.marker+'\n'+text:text,header:'Gemini 4 Argon'}):null;
  worker.fillAndSend=async(_send,_sid,prompt)=>{composer=prompt;events.push('Send');submitted=true;if(!wire)return;const data=Array(19).fill(null);data[7]='models/'+wireModel;data[18]=[null,null,null,{low:1,medium:2,high:3}[wireLevel]];
    for(const fn of listeners)fn({sessionId:'page',method:'Network.requestWillBeSent',params:{requestId:'fixture',request:{method:'POST',url:'https://alkalimakersuite-pa.clients6.google.com/CodeAssistantOffline',headers:{'x-goog-authuser':wireUser},postData:JSON.stringify(data)}}});
  };
  if(context)worker.contextTransport={clear:async(_s,_sid,options)=>{events.push('clear');if(options&&cleanupFails)throw new Error('cleanup failed');},upload:async(_s,_sid,value)=>{ctx=value;value.uploadStarted=true;events.push('upload');}};
  return {events,request,worker,get context(){return ctx;},get composer(){return composer;},run:()=>worker.generateOne(input.alias,input.body,request)};
}

const googlePolicyRefusal="error\nThe model output could not be generated. This output contains sensitive words that violate Google's [Generative AI Prohibited Use policy](https://policies.google.com/terms/generative-ai/use-policy).";
const previousRefusal={ready:true,count:1,running:false,error:googlePolicyRefusal,pageError:'',responseError:googlePolicyRefusal};
test('a previous chat policy error is cleared before a distinct new request uploads files',async()=>{
  const f=fixture({initialState:previousRefusal,context:true});
  assert.equal(await f.run(),'VERIFIED');
  assert.ok(f.events.indexOf('Start new chat')<f.events.indexOf('upload'));
  assert.equal(f.events.filter(x=>x==='Send').length,1);
});
test('preflight still blocks global page errors and previous quota errors without sending',async()=>{
  for(const state of [{...previousRefusal,pageError:'Sign in required'}, {...previousRefusal,error:'Quota exceeded',responseError:'Quota exceeded'}]){
    const f=fixture({initialState:state});await assert.rejects(f.run(),e=>e.code==='google_page_error');assert.ok(!f.events.includes('Send'));
  }
});
test('a Google policy error from the new request is classified and never automatically retried',async()=>{
  const f=fixture(),evaluate=f.worker.evaluate;
  f.worker.evaluate=async(...args)=>args[2].includes('const responses')?{ready:true,count:1,running:false,error:googlePolicyRefusal}:evaluate(...args);
  await assert.rejects(f.run(),e=>e.status===422&&e.code==='content_refused');
  assert.equal(f.events.filter(x=>x==='Send').length,1);
});

test('configured request deadline permits a slow reply past the old 150 second cutoff',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});
  const f=fixture();f.request.deadline=Date.now()+420000;const evaluate=f.worker.evaluate;let polls=0;
  f.worker.evaluate=async(...args)=>{
    if(args[2].includes('const responses')){polls++;t.mock.timers.tick(50000);if(polls<5)return {running:true,count:1};}
    return evaluate(...args);
  };
  assert.equal(await f.run(),'VERIFIED');assert.ok(polls>=6);
});

test('unlimited worker can keep waiting past all previous response deadlines',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000000});const f=fixture(),evaluate=f.worker.evaluate;let polls=0;
  f.request.deadline=Infinity;
  f.worker.evaluate=async(...args)=>{if(args[2].includes('const responses')){polls++;t.mock.timers.tick(3600000);if(polls<4)return {running:true,count:1};}return evaluate(...args);};
  assert.equal(await f.run(),'VERIFIED');assert.ok(polls>=5);
});

test('an upstream timeout remains the primary error when subsequent cleanup also fails',async()=>{
  const f=fixture({context:true,cleanupFails:true}),evaluate=f.worker.evaluate;
  f.worker.evaluate=async(...args)=>args[2].includes('const responses')?{running:false,count:1,error:'Request timed out'}:evaluate(...args);
  await assert.rejects(f.run(),e=>e.status===504&&e.code==='google_response_timeout'&&e.cleanupCode==='context_cleanup_failed');
});
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
