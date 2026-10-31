import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tempDir,body} from './helpers.mjs';
import {initStorage,loadConfig,profilePath,AccountStore,acquireLock,recoverDeadServiceLock} from '../src/storage.mjs';
import {resolveBuildModel,readBuildThinking,configureBuildThinking} from '../src/build-thinking.mjs';
import {makeFileContext,unwrapFileReply,textChunks,BuildFileContext} from '../src/build-file-context.mjs';
import {BuildAccountPool} from '../src/build-pool.mjs';
import {parseCompletion} from '../src/protocol.mjs';
import {safeFailure} from '../src/errors.mjs';
import {Scheduler} from '../src/scheduler.mjs';

test('first initialization generates independent keys and rerun retains credentials and data',async t=>{
  const dataDir=await tempDir(t),config=await loadConfig({file:join(dataDir,'missing'),overrides:{dataDir}});
  const first=await initStorage(config);await writeFile(join(dataDir,'sentinel'),'KEEP');const second=await initStorage(config);
  assert.deepEqual(first,second);assert.notEqual(first.apiKey,first.adminKey);assert.equal(await readFile(join(dataDir,'sentinel'),'utf8'),'KEEP');
  const other=await tempDir(t);assert.notEqual((await initStorage({...config,dataDir:other})).apiKey,first.apiKey);
  const release=await acquireLock(dataDir);await assert.rejects(acquireLock(dataDir),/服务锁/);await release();
});

test('new installs default to unlimited execution and queue timeouts',async t=>{
  const dir=await tempDir(t),config=await loadConfig({file:join(dir,'missing')});
  assert.equal(config.requestTimeoutMs,0);assert.equal(config.queueTimeoutMs,0);
  await assert.rejects(loadConfig({file:join(dir,'missing'),overrides:{requestTimeoutMs:-1}}));
});

test('unlimited file cleanup still settles after a caller cancels mid-wait',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000});
  const worker={current:{deadline:Infinity,aborted:false},aborted:()=>{}},transport=new BuildFileContext(worker,{timeoutMs:10});let calls=0;
  await assert.rejects(transport.wait(null,'page',async()=>{calls++;if(calls>1)throw new Error('cleanup ignored cancellation');worker.current.aborted=true;t.mock.timers.tick(20);return false;},'CLEANUP_CANCELLED',{cancel:false}),/CLEANUP_CANCELLED/);
  assert.equal(calls,1);
});

test('failed-request cleanup honors its own deadline while generation remains unlimited',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000});
  const worker={current:{deadline:Infinity,cleanupDeadline:1010,aborted:false},aborted:()=>{}};
  const transport=new BuildFileContext(worker,{timeoutMs:10});let calls=0;
  await assert.rejects(transport.wait(null,'page',async()=>{if(++calls>1)throw new Error('unbounded_failure_cleanup');t.mock.timers.tick(20);return false;},'FAILED_CLEANUP',{cancel:false}),/FAILED_CLEANUP/);
  assert.equal(calls,1);assert.equal(worker.current.deadline,Infinity);
});

test('ordinary unlimited file preparation still waits without the cleanup deadline',async t=>{
  t.mock.timers.enable({apis:['Date'],now:1000});
  const worker={current:{deadline:Infinity,aborted:false},aborted:()=>{}};
  const transport=new BuildFileContext(worker,{timeoutMs:10});let calls=0;
  await transport.wait(null,'page',async()=>{calls++;t.mock.timers.tick(10000);return calls===2;},'NOT_TIMED_OUT');
  assert.equal(calls,2);assert.equal(worker.current.deadline,Infinity);
});

test('startup only recovers a dead service lock and never kills or replaces a live process',async t=>{
  const dataDir=await tempDir(t),file=join(dataDir,'service.lock');
  await writeFile(file,JSON.stringify({pid:12345,instanceId:'stale'}));
  assert.equal(await recoverDeadServiceLock(dataDir,{alive:()=>true}),false);
  assert.equal(await recoverDeadServiceLock(dataDir,{alive:()=>false}),true);
  const release=await acquireLock(dataDir);assert.equal(await recoverDeadServiceLock(dataDir),false);await release();
});
test('profile paths are per-account and cannot escape; duplicate Google identity rejected',async t=>{
  const dataDir=await tempDir(t),config={dataDir};await initStorage(config);
  const a=await profilePath(config,'acct_'+'a'.repeat(32)),b=await profilePath(config,'acct_'+'b'.repeat(32));assert.notEqual(a,b);
  for(const bad of ['../escape','C:\\Users\\user','default','acct_../../foo'])await assert.rejects(profilePath(config,bad));
  const store=await new AccountStore(config).load();await store.add({email:'one@example.invalid',appURL:'https://aistudio.google.com/apps/test'});
  await assert.rejects(store.add({email:'ONE@example.invalid',appURL:'https://aistudio.google.com/apps/test'}),/已导入/);
});
test('all model suffixes map to base; unsuffixed always high; no prompt-derived thinking',()=>{
  for(const base of ['gemini-4-argon','gemini-3.8-flash'])for(const level of ['low','medium','high']){
    const input=parseCompletion({...body,model:'build/'+base+'-'+level});assert.equal(input.resolved.model,base);assert.equal(input.resolved.thinkingLevel,level);
    const slots=Array(19).fill(null);slots[18]=[null,null,null,{low:1,medium:2,high:3}[level]];assert.equal(readBuildThinking(JSON.stringify(slots)),level);
  }
  assert.equal(resolveBuildModel('gemini-4-argon').thinkingLevel,'high');assert.equal(readBuildThinking('{"text":"low"}'),null);assert.throws(()=>resolveBuildModel('gemini-4-argon-max'));
});
test('native thinking selector applies requested level and fails if unavailable',async()=>{
  let selected='High (recommended)';const events=[];
  const worker={evaluate:async()=>({text:selected,disabled:false}),aborted:()=>{},click:async(_s,_id,label)=>{events.push(label);if(label==='Low')selected='Low';}};
  await configureBuildThinking(worker,()=>{},'page','low');assert.deepEqual(events,['Select a thinking level','Low']);
  await assert.rejects(configureBuildThinking({...worker,evaluate:async()=>({disabled:true})},()=>{},'page','low'),/未开放/);
});
test('quota failures rotate once, share base state, and persist cooldown through disable and import',async()=>{
  let now=100000;const pool=new BuildAccountPool({now:()=>now}),accounts=[{id:'a',email:'a@example.invalid',enabled:true},{id:'b',email:'b@example.invalid',enabled:true}];await pool.sync(accounts);
  const tried=[];const value=await pool.run(resolveBuildModel('gemini-4-argon-low').model,{},async account=>{tried.push(account.id);if(account.id==='a')throw Object.assign(new Error('quota exhausted'),{status:429,retryAfterSeconds:60});return 'OK';});
  assert.equal(value,'OK');assert.deepEqual(tried,['a','b']);assert.equal(pool.state.accounts.a.models['gemini-4-argon'].cooldownUntil,160000);
  accounts[0].enabled=false;await pool.sync(accounts);accounts[0].enabled=true;await pool.sync(accounts);await pool.imported('a');assert.equal(pool.eligible(accounts[0],'gemini-4-argon'),false);
  assert.equal(pool.eligible(accounts[0],'gemini-3.8-flash'),true);now=160001;assert.equal(pool.eligible(accounts[0],'gemini-4-argon'),true);
});
test('content refusal, configuration failures and cancellation never rotate',async()=>{
  for(const failure of [safeFailure('content_refused'),Object.assign(new Error('思考档位不符'),{status:502}),Object.assign(new Error('已取消'),{status:499})]){
    const pool=new BuildAccountPool();await pool.sync([{id:'a'},{id:'b'}]);let calls=0;
    await assert.rejects(pool.run('gemini-4-argon',{},async()=>{calls++;throw failure;}));assert.equal(calls,1);
  }
});
test('Unicode JSONL exact roundtrip and optional receipt forwarding',()=>{
  const content=('甲😀\r\n\t"\\  ').repeat(10000),input={system:content,messages:[{role:'user',content},{role:'model',content:' previous '},{role:'user',content:'last'}]};
  const ctx=makeFileContext(input),other=makeFileContext(input),[system,history]=ctx.files.map(f=>f.text.trim().split('\n').map(JSON.parse));
  assert.equal(system.filter(x=>'text'in x).map(x=>x.text).join(''),content);
  for(let i=0;i<input.messages.length;i++)assert.equal(history.filter(x=>x.turn===i+1).map(x=>x.text).join(''),input.messages[i].content);
  assert.ok(!ctx.prompt.includes(ctx.marker));assert.equal(unwrapFileReply(ctx.marker+'\n  answer ',ctx),'  answer ');
  assert.equal(unwrapFileReply(other.marker+'\nanswer',ctx),other.marker+'\nanswer');assert.equal(unwrapFileReply('CONTEXT_INCOMPLETE',ctx),'CONTEXT_INCOMPLETE');
  assert.equal(unwrapFileReply('I cannot comply with this content policy request.',ctx),'I cannot comply with this content policy request.');
  assert.equal(unwrapFileReply(ctx.marker+'\r\n  x\n',ctx),'  x\n');assert.equal(unwrapFileReply(ctx.marker,ctx),ctx.marker);assert.equal(unwrapFileReply('\n'+ctx.marker+'\nanswer',ctx),'\n'+ctx.marker+'\nanswer');
  assert.equal(textChunks('a😀b😀',2).join(''),'a😀b😀');assert.throws(()=>makeFileContext({system:'x'.repeat(9*1024*1024),messages:[]}),e=>e.status===413);
});
test('context upload removes local private text even when browser fails',async t=>{
  const root=await tempDir(t),worker={aborted:()=>{}},transport=new BuildFileContext(worker,{directory:root});
  transport.openCode=async()=>{};transport.state=async()=>({dirty:false,files:[]});
  const ctx=makeFileContext({system:'private',messages:[{role:'user',content:'secret'}]});let files;
  await assert.rejects(transport.upload(async(method,params)=>{if(method==='DOM.getDocument')return {root:{nodeId:1}};if(method==='DOM.querySelector')return {nodeId:2};if(method==='DOM.setFileInputFiles'){files=params.files;assert.equal(await readFile(files[0],'utf8'),ctx.files[0].text);throw new Error('upload failure');}},'page',ctx),/upload failure/);
  await assert.rejects(readFile(files[0]),e=>e.code==='ENOENT');await assert.rejects(transport.removeLocal(join(root,'..')),/Unsafe/);
});
test('scheduler serializes execution; cancelled queued work never runs',async()=>{
  const q=new Scheduler(1);let release;const first=q.run(()=>new Promise(r=>{release=r;}));const ctrl=new AbortController();let called=false;
  const second=q.run(()=>{called=true;},ctrl.signal);const rejected=assert.rejects(second,/cancel queue/);ctrl.abort(new Error('cancel queue'));await rejected;
  release('one');await first;await q.run(async()=>{});assert.equal(called,false);assert.equal(q.busy,false);
});
