import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,body} from './helpers.mjs';

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
