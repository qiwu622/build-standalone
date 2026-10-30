import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,body} from './helpers.mjs';
import {parseCompletion} from '../src/protocol.mjs';
import {encodeEnvelope} from '../extensions/build-standalone-adapter/transport.js';
import {error} from '../src/errors.mjs';

test('zero timeouts allow waiting and executing until the caller cancels',async t=>{
  let entered=0,release;
  const f=await fixture(t,{requestTimeoutMs:0,queueTimeoutMs:0,executor:{execute(_input,{signal,deadline}){
    assert.equal(deadline,Infinity);entered++;
    return new Promise((resolve,reject)=>{release=()=>resolve({text:'COMPLETE'});signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});
  }}});
  const first=f.call('/v1/chat/completions',body);while(!entered)await new Promise(r=>setTimeout(r,2));
  const controller=new AbortController();const queued=fetch(f.url+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+f.credentials.apiKey,'content-type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
  const rejected=assert.rejects(queued,e=>e.name==='AbortError');
  await new Promise(r=>setTimeout(r,80));assert.equal(entered,1);assert.equal(f.service.scheduler.queue.length,1);
  controller.abort();await rejected;release();assert.equal((await first).status,200);
});

test('queue waiting does not subtract time from the next execution budget',async t=>{
  let started=0;
  const f=await fixture(t,{requestTimeoutMs:100,queueTimeoutMs:300,executor:{async execute(_input,{deadline}){started++;assert.ok(deadline>Date.now());await new Promise(r=>setTimeout(r,70));return {text:'DONE'};}}});
  const first=f.call('/v1/chat/completions',body);
  while(!started)await new Promise(r=>setTimeout(r,2));
  const second=f.call('/v1/chat/completions',body);
  for(const p of [first,second])assert.equal((await p).status,200);
});

test('delayed SSE sends keepalive comments and an explicit error frame on failure',async t=>{
  const f=await fixture(t,{streamHeartbeatMs:10,executor:{async execute(){await new Promise(r=>setTimeout(r,50));throw error('Google 生成超时',504,'google_response_timeout');}}});
  const response=await f.call('/v1/chat/completions',{...body,stream:true});const reader=response.body.getReader();
  const first=new TextDecoder().decode((await reader.read()).value);assert.match(first,/: keepalive/);
  let rest='';for(;;){const r=await reader.read();if(r.done)break;rest+=new TextDecoder().decode(r.value);}
  assert.match(rest,/google_response_timeout/);assert.ok(!rest.includes('"finish_reason":"stop"'));
  assert.equal((await f.log.recent()).find(x=>x.event==='completion').status,504);
});

test('HTTP API authenticates and runs direct executor end to end',async t=>{
  const seen=[];const f=await fixture(t,{executor:{async execute(input,ctx){seen.push({input,ctx});return {text:'DIRECT_OK'};}}});
  assert.equal((await f.call('/v1/models',undefined,{key:'wrong'})).status,401);
  assert.equal((await f.call('/v1/models',undefined,{key:f.credentials.adminKey})).status,401);
  const models=await (await f.call('/v1/models')).json();assert.equal(models.data.length,16);
  assert.equal(models.data.filter(m=>m.id.startsWith('build-st/')).length,8);
  const response=await f.call('/v1/chat/completions',body),value=await response.json();
  assert.equal(response.status,200);assert.equal(value.choices[0].message.content,'DIRECT_OK');assert.equal(value.usage,null);
  assert.equal(seen[0].input.resolved.model,'gemini-4-argon');assert.equal(seen[0].input.resolved.thinkingLevel,'low');
  assert.equal(seen[0].input.body.systemInstruction.parts[0].text,'system');assert.ok(seen[0].ctx.signal instanceof AbortSignal);
  assert.equal((await f.call('/admin/state')).status,401);assert.equal((await f.call('/admin/state',undefined,{key:f.credentials.adminKey})).status,200);
});
test('SSE is explicitly buffered, one full content event, stop and DONE',async t=>{
  const f=await fixture(t);const response=await f.call('/v1/chat/completions',{...body,stream:true});
  assert.equal(response.headers.get('x-build-streaming'),'buffered');
  const frames=(await response.text()).split('\n\n').filter(Boolean);assert.equal(frames.length,3);assert.equal(frames.at(-1),'data: [DONE]');
  assert.match(JSON.parse(frames[0].slice(6)).choices[0].delta.content,/DEMO/);assert.equal(JSON.parse(frames[1].slice(6)).choices[0].finish_reason,'stop');
});
test('invalid parameters fail before executor; body size and Origin enforced',async t=>{
  let calls=0;const f=await fixture(t,{maxBodyBytes:1024,executor:{async execute(){calls++;throw new Error('not called');}}});
  for(const invalid of [{...body,tools:[]},{...body,model:'no-model'}, {...body,messages:[{role:'user',content:[{type:'image_url',image_url:{url:'x'}}]}]}])assert.ok((await f.call('/v1/chat/completions',invalid)).status>=400);
  assert.equal((await f.call('/v1/chat/completions',{...body,messages:[{role:'user',content:'x'.repeat(2000)}]})).status,413);
  assert.equal((await f.call('/v1/models',undefined,{headers:{Origin:'https://example.invalid'}})).status,403);assert.equal(calls,0);
  const bad=await fetch(f.url+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+f.credentials.apiKey,'content-type':'application/json'},body:'{'});assert.equal(bad.status,400);
});

test('client sampling defaults are ignored for ordinary, build and tavern models in JSON and SSE',async t=>{
  const seen=[];const f=await fixture(t,{executor:{async execute(input){seen.push(input);return {text:'COMPAT_OK'};}}});
  const defaults={temperature:0.7,top_p:0.9,top_k:40,top_a:0,min_p:0.05,presence_penalty:0.5,frequency_penalty:0.2,repetition_penalty:1.1,stop:['END'],seed:42,logprobs:false,top_logprobs:0,logit_bias:{'123':5},reasoning_effort:'high',user:'CLIENT_METADATA_ONLY',verbosity:'low',prediction:{type:'content',content:'PREDICTION_ONLY'}};
  const tavern={model:'build-st/gemini-4-argon-low',messages:[encodeEnvelope([{message:0,part:0,role:'user',source:'chatHistory-0',placement:'file',text:'original history'}],'normal',0)]};
  for(const request of [body,{...body,model:'build/'+body.model},tavern])for(const stream of [false,true]){
    const original={...request,stream,max_tokens:1024},input={...original,...defaults},snapshot=structuredClone(input);
    const response=await f.call('/v1/chat/completions',input),text=await response.text();
    assert.equal(response.status,200,text);
    assert.deepEqual(seen.at(-1),parseCompletion(original));
    assert.equal(seen.at(-1).resolved.thinkingLevel,'low');
    assert.deepEqual(seen.at(-1).body.generationConfig,{maxOutputTokens:1024});
    assert.deepEqual(input,snapshot);
    if(stream){assert.match(text,/COMPAT_OK/);assert.ok(text.endsWith('data: [DONE]\n\n'));}
    else assert.equal(JSON.parse(text).choices[0].message.content,'COMPAT_OK');
  }
});
test('timeout aborts executor and releases the serialized queue',async t=>{
  let aborted=0;const f=await fixture(t,{requestTimeoutMs:80,executor:{execute(_input,{signal}){return new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted++;reject(signal.reason);},{once:true}));}}});
  const response=await f.call('/v1/chat/completions',body);assert.equal(response.status,504);
  await new Promise(r=>setTimeout(r,20));assert.equal(aborted,1);assert.equal(f.service.scheduler.busy,false);
});
test('disconnect cancels work; queued cancellation cannot dispatch',async t=>{
  let entered=0,aborted=0;const f=await fixture(t,{executor:{execute(_input,{signal}){entered++;return new Promise((_,reject)=>signal.addEventListener('abort',()=>{aborted++;reject(signal.reason);},{once:true}));}}});
  const ctrl=new AbortController();const pending=fetch(f.url+'/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer '+f.credentials.apiKey,'content-type':'application/json'},body:JSON.stringify(body),signal:ctrl.signal}).catch(e=>e);
  for(let i=0;i<100&&!entered;i++)await new Promise(r=>setTimeout(r,5));assert.equal(entered,1);ctrl.abort();await pending;
  for(let i=0;i<100&&!aborted;i++)await new Promise(r=>setTimeout(r,5));assert.equal(aborted,1);
});
test('upstream failures never become success and Retry-After survives',async t=>{
  const f=await fixture(t,{executor:{async execute(){throw Object.assign(new Error('池冷却'),{status:429,retryAfterSeconds:12});}}});
  const res=await f.call('/v1/chat/completions',{...body,stream:true});assert.equal(res.status,429);assert.equal(res.headers.get('retry-after'),'12');assert.match(res.headers.get('content-type'),/json/);
});
test('logs redact prompts, answers, auth and arbitrary diagnostic fields',async t=>{
  const f=await fixture(t);await f.call('/v1/chat/completions',body);
  await f.log.record({event:'test',reason:f.credentials.apiKey,error:'PROMPT_SECRET',text:'ANSWER_SECRET',headers:{cookie:'COOKIE_SECRET'}});
  const text=JSON.stringify(await f.log.recent());for(const secret of ['PROMPT_SECRET','ANSWER_SECRET','COOKIE_SECRET',f.credentials.apiKey,body.messages[1].content])assert.ok(!text.includes(secret));
  const admin=await (await f.call('/admin/state',undefined,{key:f.credentials.adminKey})).text();assert.ok(!admin.includes(f.credentials.apiKey));
});
test('API connection key is available only through authenticated admin access and is never cached or logged',async t=>{
  const f=await fixture(t);
  for(const key of ['',f.credentials.apiKey])assert.equal((await f.call('/admin/client-config',undefined,{key})).status,401);
  const response=await f.call('/admin/client-config',undefined,{key:f.credentials.adminKey});
  assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual(await response.json(),{apiKey:f.credentials.apiKey});
  for(const path of ['/','/admin.js'])assert.ok(!(await(await fetch(f.url+path)).text()).includes(f.credentials.apiKey));
  assert.ok(!JSON.stringify(await f.log.recent()).includes(f.credentials.apiKey));
});
