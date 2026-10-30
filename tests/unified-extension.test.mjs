import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import {extensionBundle} from '../scripts/build-extension.mjs';
import {enableSillyTavernSite,sitePattern} from '../extensions/build-browser-bridge/sillytavern-sites.mjs';
import {parseCompletion} from '../src/protocol.mjs';

async function pageFixture({legacy=false,loading=false,adapterSettings}={}){
 const handlers=new Map(),notices=[],panels=[];
 const oldPanel=legacy?{querySelector:()=>null,append:n=>notices.push(n)}:null;
 const doc={scripts:[],getElementById:()=>oldPanel,createElement:()=>({dataset:{}}),querySelector:s=>s==='#preloader, #loader'?loading:!s.startsWith('#extensions_')};
 const context={extensionSettings:{},chat:[{role:'user',content:'CURRENT'}],getTokenCountAsync:async()=>30,eventTypes:{GENERATION_STARTED:'start',CHAT_COMPLETION_SETTINGS_READY:'send',APP_READY:'ready'},eventSource:{on:(e,f)=>{const list=handlers.get(e)||[];list.push(f);handlers.set(e,list);},makeLast:(e,f)=>{const list=handlers.get(e)||[];list.push(f);handlers.set(e,list);}}};
 if(adapterSettings!==undefined)context.extensionSettings.build_standalone_adapter=structuredClone(adapterSettings);
 let saves=0;context.saveSettingsDebounced=()=>saves++;
 const settings={chat_completion_source:'custom',custom_model:'build-st/gemini-4-argon-low',prompts:[{identifier:'main'}]};
 const openAI={oai_settings:settings,promptManager:{serviceSettings:settings,preparePrompt:p=>({...p})},setOpenAIMessages:x=>x};
 const sandbox={document:doc,crypto:webcrypto,console,URL,SillyTavern:{getContext:()=>context}};
 const code=(await extensionBundle()).replace('watchSillyTavernPage();','globalThis.bridgeTest={connectSillyTavernPage,installSillyTavern};');
 vm.runInNewContext(code,sandbox);
 const connect=()=>sandbox.bridgeTest.connectSillyTavernPage({root:sandbox,doc,loadOpenAI:async()=>openAI});
 return {connect,sandbox,doc,context,handlers,notices,panels,openAI,get saves(){return saves;}};
}

test('browser splitter defaults on, migrates old disabled settings once and preserves a later opt-out',async()=>{
 for(const adapterSettings of [undefined,{}, {enabled:false}, {enabled:true}]){
  const p=await pageFixture({adapterSettings});await p.connect();
  const saved=p.context.extensionSettings.build_standalone_adapter;
  assert.equal(saved.enabled,true);assert.equal(saved.browserDefaultEnabled,1);assert.equal(p.saves,1);
  const prepared=p.openAI.promptManager.preparePrompt({identifier:'main',role:'system',content:'PRESET'});
  assert.match(prepared.content,/\[\[BST:/);
  await p.connect();assert.equal(p.saves,1);
  saved.enabled=false;
  assert.equal(p.openAI.promptManager.preparePrompt({identifier:'main',role:'system',content:'PRESET'}).content,'PRESET');
  const reloaded=await pageFixture({adapterSettings:saved});await reloaded.connect();
  assert.equal(reloaded.context.extensionSettings.build_standalone_adapter.enabled,false);assert.equal(reloaded.saves,0);
 }
});

test('shipped MAIN-world bundle equals source and is limited to local pages by default',async()=>{
 assert.equal((await readFile(new URL('../extensions/build-browser-bridge/sillytavern-main.js',import.meta.url),'utf8')).replace(/\r\n/g,'\n'),await extensionBundle());
 const manifest=JSON.parse(await readFile(new URL('../extensions/build-browser-bridge/manifest.json',import.meta.url),'utf8'));
 const st=manifest.content_scripts.find(s=>s.js.includes('sillytavern-main.js'));
 assert.equal(st.world,'MAIN');assert.deepEqual(st.matches,['http://127.0.0.1/*','http://localhost/*']);
 assert.ok(!manifest.host_permissions.includes('<all_urls>'));
});

test('browser bundle alone splits actual prepared presets and survives duplicate/legacy initialization',async()=>{
 const p=await pageFixture();assert.equal(await p.connect(),'connected');assert.equal(await p.connect(),'connected');
 p.sandbox.bridgeTest.installSillyTavern({getContext:()=>p.context,openAI:p.openAI,owner:'legacy'});
 for(const list of p.handlers.values())assert.equal(list.length,1);
 p.handlers.get('start')[0]('normal',{},false);
 const prepare=x=>p.openAI.promptManager.preparePrompt(x);
 const preset='EXACT {{expanded}} 😀\r\n';
 const messages=[prepare({identifier:'main',role:'system',content:preset}),prepare({identifier:'worldInfoBefore',role:'system',content:'WORLD'}),{role:'assistant',content:'HISTORY'},{role:'user',content:'CURRENT'}].map(({role,content})=>({role,content}));
 const data={chat_completion_source:'custom',model:'build-st/gemini-4-argon-low',messages};
 await p.handlers.get('send')[0](data);
 const input=parseCompletion(JSON.parse(JSON.stringify({model:data.model,messages:data.messages})));
 const segments=input.body.sillytavern.segments;
 assert.equal(segments.find(s=>s.text===preset).placement,'inline');
 for(const text of ['WORLD','HISTORY'])assert.equal(segments.find(s=>s.text===text).placement,'file');
 assert.equal(segments.find(s=>s.text==='CURRENT').placement,'inline');
 assert.ok(!JSON.stringify(segments).includes('[[BST:'));
});

test('old private adapter is sole owner; incomplete ST and unrelated pages are left alone',async()=>{
 const old=await pageFixture({legacy:true});assert.equal(await old.connect(),'legacy');assert.equal(old.handlers.size,0);assert.equal(old.notices.length,1);
 const loading=await pageFixture({loading:true});assert.equal(await loading.connect(),'waiting');assert.equal(loading.handlers.size,0);
 const unrelated=await pageFixture();delete unrelated.sandbox.SillyTavern;assert.equal(await unrelated.connect(),'waiting');assert.equal(unrelated.handlers.size,0);
 const scriptOnly=await pageFixture();scriptOnly.sandbox.location={href:'http://localhost:8000/'};scriptOnly.doc.scripts=[{src:'/scripts/extensions/third-party/repo/extensions/build-standalone-adapter/index.js'}];
 assert.equal(await scriptOnly.connect(),'legacy');assert.equal(scriptOnly.handlers.size,0);
});

test('extra sites require a per-host grant; denied grants never inject and repeat grants update',async()=>{
 const calls=[],chrome={permissions:{request:async x=>{calls.push(['grant',x]);return false;}},scripting:{}};
 const tab={id:42,url:'https://tavern.example:8443/?secret=unused'};
 assert.equal(sitePattern(tab.url),'https://tavern.example/*');assert.throws(()=>sitePattern('file:///C:/test'));
 await assert.rejects(enableSillyTavernSite(chrome,tab),/未授权/);assert.equal(calls.length,1);
 chrome.permissions.request=async()=>true;
 chrome.scripting={getRegisteredContentScripts:async()=>[],registerContentScripts:async x=>calls.push(['register',x]),executeScript:async x=>calls.push(['inject',x])};
 await enableSillyTavernSite(chrome,tab);assert.equal(calls.at(-1)[1].world,'MAIN');assert.deepEqual(calls.at(-2)[1][0].matches,['https://tavern.example/*']);
 chrome.scripting.getRegisteredContentScripts=async()=>[{id:'exists'}];chrome.scripting.updateContentScripts=async x=>calls.push(['update',x]);
 await enableSillyTavernSite(chrome,tab);assert.equal(calls.at(-2)[0],'update');
});
