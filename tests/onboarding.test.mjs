import test from 'node:test';
import assert from 'node:assert/strict';
import {Onboarding,forAccount} from '../extensions/build-browser-bridge/onboarding.mjs';
import {ExtensionBridge} from '../src/extension-bridge.mjs';
import {identityExpression} from '../extensions/build-browser-bridge/protocol.mjs';

const base='http://127.0.0.1:18787',code='a'.repeat(48),email='test@example.invalid';
const home='https://aistudio.google.com/apps?hl=en',app='https://aistudio.google.com/apps/dedicated-123?authuser=0';
function fixture({projects=[],persisted={},local={},authorize=true}={}){
  const sessionData=structuredClone(persisted),localData=structuredClone(local),tabs=new Map(),sent=[],connections=[];
  const area=data=>({get:async key=>({[key]:structuredClone(data[key])}),set:async value=>Object.assign(data,structuredClone(value))});
  let nextTab=10;
  const chrome={storage:{session:area(sessionData),local:area(localData)},tabs:{
    create:async({url})=>{const t={id:nextTab++,url};tabs.set(t.id,t);return t;},get:async id=>tabs.get(id),update:async(id,{url})=>{tabs.get(id).url=url;}
  },debugger:{attach:async()=>sent.push('attach'),detach:async()=>sent.push('detach'),sendCommand:async(_target,method,params)=>{
    sent.push({method,params});
    if(params.expression===identityExpression)return {result:{value:{email}}};
    if(method==='Runtime.evaluate')return {result:{value:params.expression.includes('const b=')?{x:5,y:5}:true}};
    return {};
  }}};
  const client={post:async()=>({allowCreate:authorize,expiresAt:Date.now()+1200000,projects}),connect:async value=>connections.push(value)};
  const flow=new Onboarding({chrome,client});
  const pulse=async(state={})=>{const tab=[...tabs.values()].at(-1);if(state.url)tab.url=state.url;else if(tab.url.startsWith('https://accounts.google.com/'))tab.url=home;await flow.pulse(tab.id,{url:tab.url,email,hasPlan:true,initializing:true,...state});};
  return {flow,chrome,client,tabs,sent,connections,pulse,sessionData,localData};
}
test('automatic enrollment waits for normal login, creates only once, remembers project before completion and connects',async()=>{
  const f=fixture();await f.flow.start({base,code,adminTabId:1});assert.match(f.tabs.get(10).url,/^https:\/\/accounts.google.com\/AccountChooser\?/);await f.pulse({email:null});assert.equal(f.sent.length,0);
  await f.pulse();assert.equal(f.sent.filter(x=>x.method==='Input.insertText').length,1);assert.equal(f.connections.length,0);
  await f.pulse();assert.equal(f.sent.filter(x=>x.method==='Input.insertText').length,1);
  await f.pulse({url:app,initializing:false,ready:true,running:true});assert.equal(f.connections.length,0);assert.equal(f.localData.dedicatedProjects[0].url,app);
  await f.pulse({url:app,initializing:false,ready:true,running:false,creationReplyReady:false});assert.equal(f.connections.length,0);
  await f.pulse({url:app,initializing:false,ready:true,running:false,creationReplyReady:true});assert.equal(f.connections.length,0);
  await f.pulse({url:app,initializing:false,ready:true,running:false,creationReplyReady:true});assert.equal(f.connections.length,1);
  const status=await f.flow.status(base);assert.equal(status.jobs[0].stage,'connected');assert.ok(!JSON.stringify(status).includes(code));
  assert.equal(f.sessionData.onboardingJobs[10].code,'');
});
test('subsequent enrollment reuses remembered project without another creation inference',async()=>{
  const f=fixture({local:{dedicatedProjects:[{base,email,url:app}]}});await f.flow.start({base,code,adminTabId:1});
  await f.pulse();assert.equal(f.sent.length,0);assert.match(f.tabs.get(10).url,/apps\/dedicated-123/);
  await f.pulse({url:f.tabs.get(10).url,ready:true,initializing:false});assert.equal(f.connections.length,1);assert.equal(f.sent.length,0);
});
test('service-known project can be reused on another extension installation and actual account index is retained',async()=>{
  const f=fixture({projects:[{email,url:app}]});await f.flow.start({base,code,adminTabId:1});
  await f.pulse({url:'https://aistudio.google.com/u/2/apps?hl=en'});
  assert.match(f.tabs.get(10).url,/authuser=2/);assert.equal(f.sent.length,0);
  assert.equal(forAccount('https://aistudio.google.com/u/0/apps/dedicated-123?authuser=0','2'),'https://aistudio.google.com/apps/dedicated-123?authuser=2&hl=en');
});
test('worker restart during login resumes from session storage; interrupted creation is never submitted again',async()=>{
  const first=fixture();await first.flow.start({base,code,adminTabId:1});
  first.tabs.get(10).url=home;
  let resumed=new Onboarding({chrome:first.chrome,client:first.client});
  await resumed.pulse(10,{url:home,email,hasPlan:true,initializing:true});assert.equal(first.sent.filter(x=>x.method==='Input.insertText').length,1);
  first.sessionData.onboardingJobs[10].stage='initializing';resumed=new Onboarding({chrome:first.chrome,client:first.client});
  await resumed.pulse(10,{url:home,email,hasPlan:true,initializing:true});assert.equal(first.sent.filter(x=>x.method==='Input.insertText').length,1);
  assert.equal((await resumed.status(base)).jobs[0].stage,'error');
});
test('unexpected project, switched account, cancelled flow and a manual capability cannot initialize a project',async()=>{
  const f=fixture();await f.flow.start({base,code,adminTabId:1});await f.pulse({url:app,ready:true,initializing:false});assert.equal(f.sent.length,0);assert.equal((await f.flow.status(base)).jobs[0].stage,'error');
  const g=fixture();await g.flow.start({base,code,adminTabId:1});await g.pulse({hasPlan:false});await g.pulse({email:'different@example.invalid'});assert.equal(g.sent.length,0);assert.equal((await g.flow.status(base)).jobs[0].stage,'error');
  const h=fixture();await h.flow.start({base,code,adminTabId:1});await h.flow.cancel(base);await h.pulse();assert.equal(h.sent.length,0);
  const denied=fixture({authorize:false});await assert.rejects(denied.flow.start({base,code,adminTabId:1}),/管理页/);assert.equal(denied.tabs.size,0);
});
test('automatic capability expires, requires admin-created scope and is not a persistent browser credential',async()=>{
  let now=10000;const bridge=new ExtensionBridge({store:{accounts:[{email,appURL:app}]},pool:{},now:()=>now});
  try{
    const manual=bridge.pairing();assert.equal(bridge.authorize(manual.code).allowCreate,false);
    const automatic=bridge.pairing({automatic:true});assert.equal(automatic.expiresAt,now+1200000);assert.equal(bridge.authorize(automatic.code).allowCreate,true);
    assert.throws(()=>bridge.authorize(manual.code));now+=1200001;assert.throws(()=>bridge.authorize(automatic.code));
  }finally{await bridge.close();}
});

test('uncertain provisioning cannot create duplicates, but late project assignment is remembered for a later retry',async()=>{
  const f=fixture();await f.flow.start({base,code,adminTabId:1});
  await f.pulse();f.flow.jobs[10].stage='error';f.flow.jobs[10].error='uncertain';await f.flow.save();
  await assert.rejects(f.flow.start({base,code,adminTabId:1}),/结果尚未确认/);
  await f.pulse({url:app,ready:true,initializing:false});assert.equal(f.localData.dedicatedProjects[0].url,app);
  await f.flow.start({base,code,adminTabId:1});await f.pulse();assert.match(f.tabs.get(11).url,/dedicated-123/);
  assert.equal(f.sent.filter(x=>x.method==='Input.insertText').length,1);
});

test('concurrent starts open only one login tab and failed authorization permits a later retry',async()=>{
  const f=fixture();let release;
  const original=f.client.post;
  f.client.post=async(...args)=>{await new Promise(resolve=>{release=resolve;});return original(...args);};
  const first=f.flow.start({base,code,adminTabId:1});
  await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(f.flow.start({base,code,adminTabId:2}),/重复点击/);
  release();await first;assert.equal(f.tabs.size,1);
  const denied=fixture({authorize:false});
  await assert.rejects(denied.flow.start({base,code,adminTabId:1}),/管理页/);
  denied.client.post=original;
  await denied.flow.start({base,code,adminTabId:1});assert.equal(denied.tabs.size,1);
});
