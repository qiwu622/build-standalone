import test from 'node:test';
import assert from 'node:assert/strict';
import {once,EventEmitter} from 'node:events';
import {request as httpRequest} from 'node:http';
import {mkdir,mkdtemp,rm,readFile} from 'node:fs/promises';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {createService} from '../src/server.mjs';
import {BrowserManager} from '../src/browser.mjs';
import {initStorage,profilePath,projectRoot} from '../src/storage.mjs';
import {CallLog} from '../src/log.mjs';
import {BuildAccountPool} from '../src/build-pool.mjs';

// All tests use ephemeral localhost listeners, synthetic identities and profiles
// below this independent checkout. No Google calls or production data are used.
const credentials={apiKey:'build_'+ 'a'.repeat(64),adminKey:'admin_'+ 'b'.repeat(64)};
const body={model:'gemini-4-argon-low',messages:[{role:'user',content:'SYNTHETIC_TEST_INPUT'}]};
const apiHeaders={authorization:'Bearer '+credentials.apiKey,'content-type':'application/json'};
const adminHeaders={authorization:'Bearer '+credentials.adminKey,'content-type':'application/json'};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(predicate){const end=Date.now()+2000;while(!predicate()){if(Date.now()>end)throw new Error('test state timed out');await pause(5);}}

async function fixture(t,{execute,config:override={},onShutdown}={}){
 const calls=[],logs=[];
 const config={host:'127.0.0.1',port:0,maxQueue:2,maxBodyBytes:4096,requestTimeoutMs:1000,publicOrigin:'https://test.example.invalid',...override};
 const store={accounts:[{id:'acct_'+'1'.repeat(32),email:'test@example.invalid',enabled:true}],enabled:async()=>{}};
 const pool={snapshot:()=>({accounts:[]}),sync:async()=>{},imported:async()=>{}};
 const browsers={login:null,close:async()=>{},cancelLogin:async()=>{},beginLogin:async()=>{throw new Error('browser must not be opened');}};
 const executor={execute:async(input,context)=>{calls.push(input);return execute?execute(input,context):{text:'SYNTHETIC_TEST_REPLY',thinkingLevel:input.resolved.thinkingLevel};}};
 const log={record:async row=>logs.push(row),recent:async()=>[],chain:Promise.resolve()};
 const service=createService({config,credentials,store,pool,browsers,executor,log,onShutdown});
 service.server.listen(0,'127.0.0.1');await once(service.server,'listening');
 t.after(()=>service.close());
 const url='http://127.0.0.1:'+service.server.address().port;
 const post=(payload=body,extra={})=>fetch(url+'/v1/chat/completions',{method:'POST',headers:apiHeaders,body:JSON.stringify(payload),...extra});
 return {service,url,calls,logs,post,store,browsers};
}

test('review: API and admin credentials cannot be used interchangeably',async t=>{
 const f=await fixture(t);
 for(const path of ['/admin/state','/admin/logs']){
  const denied=await fetch(f.url+path,{headers:apiHeaders});assert.equal(denied.status,401);await denied.text();
  const allowed=await fetch(f.url+path,{headers:adminHeaders});assert.equal(allowed.status,200);await allowed.text();
 }
 const denied=await fetch(f.url+'/v1/models',{headers:adminHeaders});assert.equal(denied.status,401);await denied.text();
 const missing=await f.post(body,{headers:{'content-type':'application/json'}});assert.equal(missing.status,401);await missing.text();
 assert.equal(f.calls.length,0);
});

test('review: authenticated cross-origin browser requests are rejected before execution',async t=>{
 const f=await fixture(t);
 const denied=await f.post(body,{headers:{...apiHeaders,origin:'https://evil.example.invalid'}});
 assert.equal(denied.status,403);assert.equal((await denied.json()).error.code,'origin_denied');assert.equal(f.calls.length,0);
 const allowed=await f.post(body,{headers:{...apiHeaders,origin:'https://test.example.invalid'}});
 assert.equal(allowed.status,200);await allowed.text();assert.equal(f.calls.length,1);
});

test('review: malformed and oversized bodies never start a model generation',async t=>{
 const f=await fixture(t);
 for(const [payload,status] of [[null,400],[{...body,messages:[]},400],[{...body,model:'gemini-4-argon-low-high'},404],[{...body,messages:[{role:'user',content:'x'.repeat(5000)}]},413]]){
  const r=await f.post(payload);assert.equal(r.status,status);await r.text();
 }
 const invalid=await f.post(body,{body:'{"messages":'});assert.equal(invalid.status,400);await invalid.text();
 assert.equal(f.calls.length,0);
});

test('review: buffered SSE declares its behavior and produces one clean final answer',async t=>{
 const f=await fixture(t);const r=await f.post({...body,stream:true});
 assert.equal(r.status,200);assert.equal(r.headers.get('x-build-streaming'),'buffered');assert.equal(r.headers.get('x-build-thinking-level'),'low');
 const raw=await r.text(),lines=raw.split('\n').filter(l=>l.startsWith('data: ')).map(l=>l.slice(6));
 assert.equal(lines.at(-1),'[DONE]');const frames=lines.slice(0,-1).map(JSON.parse);
 assert.equal(frames.flatMap(f=>f.choices).map(c=>c.delta.content||'').join(''),'SYNTHETIC_TEST_REPLY');
 assert.deepEqual(frames.flatMap(f=>f.choices).filter(c=>c.finish_reason).map(c=>c.finish_reason),['stop']);
 assert.equal(f.calls.length,1);
});

test('review: cancelling a queued HTTP request removes it without invoking the executor',async t=>{
 let release;const held=new Promise(r=>{release=r;});
 const f=await fixture(t,{execute:async()=>{await held;return {text:'FIRST_ONLY'};}});
 const first=f.post();await until(()=>f.calls.length===1);
 const controller=new AbortController();const queued=f.post(body,{signal:controller.signal});
 // Attach the rejection handler before abort so this cannot be an unhandled rejection.
 const rejected=assert.rejects(queued,e=>e.name==='AbortError');
 await until(()=>f.service.scheduler.queue.length===1);controller.abort();await rejected;
 await until(()=>f.service.scheduler.queue.length===0);release();
 const result=await first;assert.equal(result.status,200);await result.text();
 assert.equal(f.calls.length,1);
});

test('review: timeout aborts execution and releases the scheduler for the next request',async t=>{
 let block=true,aborted=false;
 const f=await fixture(t,{config:{requestTimeoutMs:80},execute:async(_input,{signal})=>{
  if(!block)return {text:'AFTER_TIMEOUT'};
  await new Promise((_,reject)=>{const stop=()=>{aborted=true;reject(signal.reason);};if(signal.aborted)stop();else signal.addEventListener('abort',stop,{once:true});});
 }});
 const timed=await f.post();assert.equal(timed.status,504);await timed.text();assert.equal(aborted,true);
 await until(()=>!f.service.scheduler.busy);block=false;
 const next=await f.post();assert.equal(next.status,200);assert.equal((await next.json()).choices[0].message.content,'AFTER_TIMEOUT');
});

async function isolatedData(t){
 const base=resolve(projectRoot,'tests','.review-tmp');await mkdir(base,{recursive:true});const dir=await mkdtemp(join(base,'review-'));
 t.after(async()=>{const rel=relative(base,resolve(dir));assert.ok(rel&&!rel.startsWith('..')&&!isAbsolute(rel));await rm(dir,{recursive:true,force:true});});
 return dir;
}

test('review: independent credentials persist and metadata logs exclude prompts, replies and secrets',async t=>{
 const config={dataDir:await isolatedData(t)};
 const first=await initStorage(config),second=await initStorage(config);
 assert.deepEqual(second,first);assert.notEqual(first.apiKey,first.adminKey);
 for(const id of ['../outside','acct_'+'x'.repeat(32),'/tmp/other'])await assert.rejects(profilePath(config,id));
 const log=new CallLog(config);await log.record({event:'completion',status:200,model:'gemini-4-argon-low',text:'PRIVATE_REPLY',prompt:'PRIVATE_PROMPT',authorization:first.apiKey,cookie:'PRIVATE_COOKIE'});
 const raw=await readFile(join(config.dataDir,'logs','calls.jsonl'),'utf8');
 for(const secret of ['PRIVATE_REPLY','PRIVATE_PROMPT',first.apiKey,'PRIVATE_COOKIE'])assert.ok(!raw.includes(secret));
 assert.equal((await log.recent())[0].status,200);
});

test('review: switched Google identity cannot consume the original account quota',async t=>{
 const config={dataDir:await isolatedData(t),headless:true},id='acct_'+'3'.repeat(32);
 const account={id,email:'original@example.invalid',appURL:'https://aistudio.google.com/apps/review-project?authuser=0'};
 let actualEmail='different@example.invalid',executed=false,closed=0;
 const page={goto:async()=>{},url:()=>account.appURL,evaluate:async()=>({url:account.appURL,email:actualEmail,ready:true})};
 const session=new EventEmitter();session.send=async()=>({});session.detach=async()=>{};
 const context={on:()=>{},pages:()=>[page],newCDPSession:async()=>session,close:async()=>{closed++;}};
 const manager=new BrowserManager(config,{accounts:[account]},{launch:async()=>context});
 await assert.rejects(manager.withPage(account,new AbortController().signal,async()=>{executed=true;}),e=>e.code==='account_mismatch'||e.rotationReason==='account_mismatch');
 assert.equal(executed,false);assert.equal(closed,1);
 actualEmail='Original@Example.Invalid';
 await manager.withPage(account,new AbortController().signal,async()=>{executed=true;});assert.equal(executed,true);
});

test('review: slow admin request body cannot race a newly started generation',async t=>{
 let release;const held=new Promise(r=>{release=r;});let changes=0;
 const f=await fixture(t,{execute:async()=>{await held;return {text:'COMPLETE'};}});
 f.store.enabled=async()=>{changes++;};
 const payload=JSON.stringify({id:f.store.accounts[0].id,enabled:false});
 const received=new Promise(resolve=>f.service.server.once('request',req=>req.once('data',resolve)));
 const admin=httpRequest(f.url+'/admin/accounts/enabled',{method:'POST',headers:adminHeaders});
 const response=new Promise((resolve,reject)=>{admin.on('response',res=>{res.resume();res.once('end',()=>resolve(res.statusCode));});admin.on('error',reject);});
 admin.write(payload.slice(0,12));await received;
 const generation=f.post();await until(()=>f.calls.length===1);
 admin.end(payload.slice(12));assert.equal(await response,409);assert.equal(changes,0);
 release();const r=await generation;assert.equal(r.status,200);await r.text();
});

test('review: account mutation holds a shared lock until persistence completes',async t=>{
 let entered=false,release;const held=new Promise(r=>{release=r;});
 const f=await fixture(t);f.store.enabled=async()=>{entered=true;await held;};
 const mutate=()=>fetch(f.url+'/admin/accounts/enabled',{method:'POST',headers:adminHeaders,body:JSON.stringify({id:f.store.accounts[0].id,enabled:false})});
 const mutation=mutate();await until(()=>entered);
 const generation=await f.post();assert.equal(generation.status,503);assert.equal((await generation.json()).error.code,'login_busy');
 const concurrent=await mutate();assert.equal(concurrent.status,409);await concurrent.text();assert.equal(f.calls.length,0);
 release();const result=await mutation;assert.equal(result.status,200);await result.text();
 const after=await f.post();assert.equal(after.status,200);await after.text();assert.equal(f.calls.length,1);
});

test('review: stop control requires admin credentials and the exact running instance',async t=>{
 let stops=0;const f=await fixture(t,{onShutdown:async()=>{stops++;}});
 const state=await (await fetch(f.url+'/admin/state',{headers:adminHeaders})).json();
 const stop=(id,headers=adminHeaders)=>fetch(f.url+'/admin/control/stop',{method:'POST',headers,body:JSON.stringify({instanceId:id})});
 const wrongKey=await stop(state.instanceId,apiHeaders);assert.equal(wrongKey.status,401);await wrongKey.text();
 const wrongInstance=await stop('different-instance');assert.equal(wrongInstance.status,409);assert.equal((await wrongInstance.json()).error.code,'instance_mismatch');assert.equal(stops,0);
 const accepted=await stop(state.instanceId);assert.equal(accepted.status,200);await accepted.text();await until(()=>stops===1);
});

test('updater idle-stop refuses active work and prevents new requests after acceptance',async t=>{
 let release,stops=0;const held=new Promise(r=>{release=r;});
 const f=await fixture(t,{execute:async()=>{await held;return {text:'OK'};},onShutdown:async()=>{stops++;}});
 const state=await(await fetch(f.url+'/admin/state',{headers:adminHeaders})).json();
 const stop=()=>fetch(f.url+'/admin/control/stop',{method:'POST',headers:adminHeaders,body:JSON.stringify({instanceId:state.instanceId,onlyIfIdle:true})});
 const pending=f.post();await until(()=>f.calls.length===1);
 const refused=await stop();assert.equal(refused.status,409);assert.equal(stops,0);await refused.text();
 release();assert.equal((await pending).status,200);const accepted=await stop();assert.equal(accepted.status,200);await accepted.text();
 const blocked=await f.post();assert.equal(blocked.status,503);await blocked.text();await until(()=>stops===1);
});

test('review: pool persistence and admin snapshot do not retain raw upstream error payloads',async()=>{
 const state={},saved=[];
 const pool=new BuildAccountPool({state,save:async()=>saved.push(JSON.stringify(state))});
 await pool.sync([{id:'acct_'+'5'.repeat(32),email:'synthetic@example.invalid',enabled:true}]);
 const sensitive='PRIVATE_PROMPT PRIVATE_REPLY Authorization: Bearer FAKE_PRIVATE_KEY Cookie=FAKE_PRIVATE_COOKIE';
 await assert.rejects(pool.run('gemini-4-argon',{},async()=>{throw Object.assign(new Error('quota exhausted '+sensitive),{status:429,retryAfterSeconds:60});}),e=>e.status===429);
 const persisted=saved.join('\n')+JSON.stringify(pool.snapshot());
 for(const marker of ['PRIVATE_PROMPT','PRIVATE_REPLY','FAKE_PRIVATE_KEY','FAKE_PRIVATE_COOKIE'])assert.ok(!persisted.includes(marker),'raw upstream error leaked into account state: '+marker);
 assert.equal(pool.snapshot().accounts[0].models['gemini-4-argon'].status,'cooling');
});
