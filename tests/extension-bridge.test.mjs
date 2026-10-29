import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tempDir,body} from './helpers.mjs';
import {AccountStore,initStorage,loadConfig} from '../src/storage.mjs';
import {ExtensionBridge} from '../src/extension-bridge.mjs';
import {BuildAccountPool} from '../src/build-pool.mjs';
import {BuildFileContext,makeFileContext} from '../src/build-file-context.mjs';
import {createService} from '../src/server.mjs';
import {BridgeClient} from '../extensions/build-browser-bridge/client.mjs';
import {localBase,project,filterEvent,identityExpression} from '../extensions/build-browser-bridge/protocol.mjs';

const identity=(n=0)=>({email:`test${n}@example.invalid`,url:`https://aistudio.google.com/apps/project-${n}?authuser=${n}`,authUser:String(n),ready:true});
async function setup(t,{now,commandTimeout=500,pollTimeout=15}={}){
  const dataDir=await tempDir(t),config=await loadConfig({file:join(dataDir,'missing'),overrides:{dataDir,port:0,requestTimeoutMs:1000}});
  const credentials=await initStorage(config),store=await new AccountStore(config).load(),pool=new BuildAccountPool();
  const bridge=new ExtensionBridge({store,pool,now,commandTimeout,pollTimeout});t.after(()=>bridge.close());return {config,credentials,store,pool,bridge};
}
async function register(bridge,n=0){return bridge.connect({code:bridge.pairing().code,identity:identity(n)});}

test('extension pairing is one-use, expires, validates the dedicated project, and preserves cooldown on reconnect',async t=>{
  let now=10000;const {bridge,pool,store}=await setup(t,{now:()=>now});
  const p=bridge.pairing();await assert.rejects(bridge.connect({code:p.code,identity:{...identity(),url:'https://accounts.google.com/login'}}));
  const first=await bridge.connect({code:p.code,identity:identity()});await assert.rejects(bridge.connect({code:p.code,identity:identity()}),e=>e.status===401);
  const id=first.account.id;pool.modelState(id,'gemini-4-argon').cooldownUntil=now+60000;await store.enabled(id,false);
  const second=await register(bridge);assert.equal(second.account.id,id);assert.notEqual(first.token,second.token);assert.throws(()=>bridge.authenticate(first.token));
  assert.equal(store.accounts[0].enabled,false);assert.equal(pool.modelState(id,'gemini-4-argon').cooldownUntil,now+60000);
  const expired=bridge.pairing();now+=300001;await assert.rejects(bridge.connect({code:expired.code,identity:identity(1)}),e=>e.code==='pairing_invalid');
  assert.equal(store.accounts.length,1);assert.equal(store.accounts[0].transport,'extension');
});

test('bridge isolates tabs, orders model events before results, and revokes delayed commands on timeout',async t=>{
  const {bridge}=await setup(t,{commandTimeout:200});const a=await register(bridge),b=await register(bridge,1);
  const sa=bridge.authenticate(a.token),sb=bridge.authenticate(b.token),send=bridge.sender(sa),observed=[];
  send.onEvent(e=>observed.push(e.method));const pending=send('Runtime.evaluate',{expression:'1'}).then(v=>{observed.push('result');return v;});
  assert.deepEqual((await bridge.exchange(sb,{})).commands,[]);
  const batch=await bridge.exchange(sa,{});assert.equal(batch.commands.length,1);
  await bridge.exchange(sa,{results:[{id:batch.commands[0].id,value:{ok:true}}],events:[{method:'Network.requestWillBeSent',params:{}}]});
  assert.deepEqual(await pending,{ok:true});assert.deepEqual(observed,['Network.requestWillBeSent','result']);
  await assert.rejects(send('Network.getAllCookies'),e=>e.code==='command_denied');
  await assert.rejects(send('Runtime.evaluate',{expression:'2'}),e=>e.code==='extension_disconnected');
  assert.equal(bridge.online(a.account.id),false);assert.throws(()=>bridge.authenticate(a.token));assert.equal(bridge.online(b.account.id),true);
});

test('extension never accepts remote services, login pages, conflicting account indices or unrelated network traffic',()=>{
  assert.equal(localBase('http://127.0.0.1:18787'),'http://127.0.0.1:18787');
  for(const bad of ['https://example.com','http://127.0.0.1.evil.invalid','http://name:pw@localhost/','http://localhost/path'])assert.throws(()=>localBase(bad));
  assert.equal(project(identity(1).url).authUser,'1');
  for(const bad of ['https://accounts.google.com/','https://aistudio.google.com/apps','https://aistudio.google.com/u/1/apps/test?authuser=0'])assert.throws(()=>project(bad));
  const tracked=new Set(),data=Array(19).fill(null);data[0]='PRIVATE_PROMPT';data[7]='models/gemini-4-argon';data[18]=[null,null,null,1];
  const event=filterEvent('Network.requestWillBeSent',{requestId:'r',request:{url:'https://google.test/CodeAssistantOffline',method:'POST',headers:{Cookie:'COOKIE_SECRET',Authorization:'AUTH_SECRET','x-goog-authuser':'1'},postData:JSON.stringify(data)}},tracked);
  for(const secret of ['PRIVATE_PROMPT','COOKIE_SECRET','AUTH_SECRET'])assert.ok(!JSON.stringify(event).includes(secret));assert.equal(JSON.parse(event.params.request.postData)[18][3],1);
  assert.equal(filterEvent('Network.requestWillBeSent',{request:{url:'https://unrelated.test'}},tracked),null);
  assert.equal(filterEvent('Page.javascriptDialogOpening',{type:'confirm'},tracked),null);
});

test('real local HTTP bridge pairs a simulated normal-browser tab and returns API output without starting a browser',async t=>{
  const f=await setup(t,{commandTimeout:2000}),commands=[],httpBodies=[];let client,sendHook;
  const log={record:async()=>{},recent:async()=>[],chain:Promise.resolve()};
  const executor={execute:async(_input,{signal})=>f.bridge.withPage(f.store.accounts[0],signal,async send=>{if(sendHook)return sendHook(send);const r=await send('Runtime.evaluate',{expression:'SYNTHETIC_REPLY'});return {text:r.result.value};})};
  const service=createService({...f,executor,browsers:f.bridge,log});await new Promise(r=>service.server.listen(0,'127.0.0.1',r));t.after(()=>service.close());
  const base='http://127.0.0.1:'+service.server.address().port;
  const post=(path,payload,key=f.credentials.apiKey,extra={})=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+key,...extra},body:JSON.stringify(payload)});
  assert.equal((await post('/admin/login/start',{},f.credentials.adminKey)).status,410);
  assert.equal((await post('/admin/bridge/pairing',{},f.credentials.apiKey)).status,401);
  assert.equal((await post('/admin/bridge/automatic',{},f.credentials.apiKey)).status,401);
  const automatic=await(await post('/admin/bridge/automatic',{},f.credentials.adminKey)).json();
  const authorized=await(await post('/bridge/authorize',{code:automatic.code},'')).json();assert.equal(authorized.allowCreate,true);
  assert.equal((await post('/bridge/authorize',{code:automatic.code},'',{Origin:'https://evil.invalid'})).status,403);
  const pair=await(await post('/admin/bridge/pairing',{},f.credentials.adminKey)).json();
  assert.equal((await post('/bridge/connect',{code:pair.code,identity:identity()},'',{Origin:'https://evil.invalid'})).status,403);
  const fakeChrome={tabs:{get:async()=>({url:identity(1).url})},debugger:{attach:async()=>commands.push('attach'),detach:async()=>commands.push('detach'),sendCommand:async(_target,method,params)=>{
    commands.push(method);
    if(params.expression===identityExpression)return {result:{value:identity(1)}};
    if(params.expression==='SYNTHETIC_REPLY')return {result:{value:'LOCAL_BRIDGE_OK'}};
    throw new Error('unexpected synthetic command');
  }}};
  client=new BridgeClient({chrome:fakeChrome,fetcher:async(url,options)=>{httpBodies.push(options.body);return fetch(url,options);}});t.after(()=>client.disconnect(21));
  await client.connect({base,code:pair.code,tabId:21});
  const response=await post('/v1/chat/completions',body);assert.equal(response.status,200);assert.equal((await response.json()).choices[0].message.content,'LOCAL_BRIDGE_OK');
  assert.ok(!httpBodies.join('').includes(f.credentials.adminKey));assert.ok(!httpBodies.join('').includes(f.credentials.apiKey));
  const state=await(await fetch(base+'/admin/state',{headers:{authorization:'Bearer '+f.credentials.adminKey}})).json();assert.equal(state.connectionMode,'extension');assert.equal(state.connections[0].connected,true);assert.equal(f.store.accounts[0].auth_user,'1');
  assert.ok(!JSON.stringify(state).includes(client.links.get(21).token));
  // The same transport uploads original Unicode text as browser File objects,
  // without exposing a local path or granting access to arbitrary files.
  const files=[],node={dispatchEvent:()=>{}};
  const context=makeFileContext({system:'系统😀',messages:[{role:'user',content:'长历史世界书😀'.repeat(9000)}]});
  fakeChrome.debugger.sendCommand=async(_target,method,params)=>{
    commands.push(method);
    if(params.expression===identityExpression)return {result:{value:identity(1)}};
    if(params.expression.includes('new DataTransfer')){
      const value=vm.runInNewContext(params.expression,{document:{querySelector:()=>node},File,Event,DataTransfer:class{constructor(){this.files=[];this.items={add:f=>{this.files.push(f);files.push(f);}};}}});return {result:{value}};
    }
    throw new Error('unexpected synthetic command');
  };
  sendHook=async send=>{await send.uploadFiles(context.files);return {text:'UPLOAD_OK'};};
  assert.equal((await post('/v1/chat/completions',body)).status,200);assert.equal(files.length,2);
  for(let i=0;i<2;i++){assert.equal(files[i].name,context.files[i].name);assert.equal(await files[i].text(),context.files[i].text);}
  assert.ok(!commands.some(x=>x==='DOM.setFileInputFiles'));
  await client.disconnect(21);assert.equal(f.bridge.online(f.store.accounts[0].id),false);
});

test('tab navigation and closed tabs stop commands before any new page operation',async()=>{
  let sends=0;const client=new BridgeClient({chrome:{tabs:{get:async()=>({url:'https://accounts.google.com/'})},debugger:{sendCommand:async()=>{sends++;}}}});
  await assert.rejects(client.command({tabId:2,target:project(identity().url).url},{id:'a',deadline:Date.now()+5000,method:'Input.insertText',params:{text:'secret'}}));assert.equal(sends,0);
  await assert.rejects(client.command({tabId:2,target:project(identity().url).url},{id:'b',deadline:0,method:'Runtime.evaluate',params:{}}));assert.equal(sends,0);
});

test('extension file upload retains cleanup and verification behavior',async t=>{
  const directory=await tempDir(t),context=makeFileContext({system:'精确保留',messages:[{role:'user',content:'hello😀'}]});
  let uploaded=false,verified=false,saved=false;
  const worker={aborted:()=>{}},transport=new BuildFileContext(worker,{directory});
  transport.openCode=async()=>{};transport.state=async()=>({dirty:uploaded,files:uploaded?context.files.map(f=>f.name):[]});
  transport.save=async()=>{saved=true;};transport.verifySavedFiles=async(_send,_sid,predicate)=>{verified=predicate(await transport.state());};
  const send=()=>assert.fail('legacy upload must not run');send.uploadFiles=async files=>{assert.deepEqual(files,context.files);uploaded=true;};
  await transport.upload(send,'page',context);assert.equal(saved,true);assert.equal(verified,true);assert.equal(context.uploadStarted,true);
});

test('manifest has no Cookie or external debugging-port permission',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../extensions/build-browser-bridge/manifest.json',import.meta.url)));
  assert.equal(manifest.manifest_version,3);assert.ok(!manifest.permissions.includes('cookies'));assert.ok(!manifest.host_permissions.includes('<all_urls>'));
  assert.equal(manifest.minimum_chrome_version,'118');
});

test('editor identity uses a verified background homepage and fresh per-request proof, with cleanup and account guards',async()=>{
  const target=identity(1);let email=target.email,created=0,removed=0,probeURL;
  const chrome={tabs:{get:async id=>({url:id===21?target.url:probeURL}),create:async({url,active})=>{assert.equal(active,false);probeURL=url;created++;return {id:90};},remove:async id=>{assert.equal(id,90);removed++;},sendMessage:async()=>({email,accountControlFound:true,authUser:'1',url:probeURL})},debugger:{sendCommand:async(_target,_method,params)=>{assert.equal(params.buildForceIdentity,undefined);return {result:{value:{...target,email:null}}};}}};
  const client=new BridgeClient({chrome});
  const first=await client.readIdentity(21);assert.equal(first.result.value.email,email);assert.equal(first.result.value.identitySource,'build-home');assert.match(probeURL,/authuser=1/);
  await client.readIdentity(21);assert.equal(created,1);assert.equal(removed,1);
  email='switched@example.invalid';
  await assert.rejects(client.command({tabId:21,target:project(target.url).url,email:target.email},{id:'proof',method:'Runtime.evaluate',params:{expression:identityExpression,buildForceIdentity:true},deadline:Date.now()+5000}),/账号发生变化/);
  assert.equal(created,2);assert.equal(removed,2);
  chrome.tabs.sendMessage=async()=>({email,accountControlFound:true,authUser:'0',url:probeURL});
  await assert.rejects(client.probeAccount('1',{force:true}),/核对页面发生变化/);assert.equal(removed,3);
  chrome.tabs.sendMessage=async()=>null;
  await assert.rejects(client.probeAccount('1',{force:true,deadline:Date.now()}),/超时/);assert.equal(removed,4);
});
