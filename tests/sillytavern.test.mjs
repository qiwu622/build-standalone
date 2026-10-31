import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
import * as transport from '../extensions/build-standalone-adapter/transport.js';
import {createTagger,hookPromptManager,readPresetSegments,encodeEnvelope,errorEnvelope,prepareOutgoing,applyOutgoing} from '../extensions/build-standalone-adapter/transport.js';
import {parseCompletion} from '../src/protocol.mjs';
import {unwrapFileReply} from '../src/build-file-context.mjs';
import {makeAttachmentContext} from '../src/build-attachment-context.mjs';
import {buildInput} from '../src/build-chat.mjs';
import {fixture} from './helpers.mjs';

function sourceFixture(){
 const settings={prompts:[{identifier:'main'},{identifier:'preset-user',marker:false},{identifier:'worldInfoBefore',marker:true}],squash_system_messages:false};
 const manager={serviceSettings:settings,preparePrompt:p=>({...p})};
 const tagger=createTagger('a'.repeat(24));hookPromptManager(manager,tagger,()=>true);
 const preset='  PRESET_EXACT\n 😀\r\n';
 const p=manager.preparePrompt({identifier:'main',role:'system',content:preset});
 const world=manager.preparePrompt({identifier:'worldInfoBefore',role:'system',content:'WORLD_ONLY'});
 const injected=manager.preparePrompt({identifier:'preset-user',role:'user',content:'POST_PRESET'});
 // This models ST's actual in-chat grouping: source IDs become chatHistory-N,
 // but temporary preset/context boundaries survive the merge.
 const leaves=[p,world,{identifier:'chatHistory-1',role:'user',content:'PAST_ONLY'},
  {identifier:'chatHistory-2',role:'assistant',content:'PAST_REPLY'},
  {identifier:'chatHistory-3',role:'user',content:'CURRENT'},
  {identifier:'chatHistory-4',role:'user',content:injected.content+'\n'+world.content}];
 const chat=leaves.map(({role,content})=>({role,content}));
 const segments=readPresetSegments(chat,tagger,{latestUserText:'CURRENT'});
 return {settings,manager,tagger,preset,chat,leaves,segments};
}
const request=segments=>({model:'build-st/gemini-4-argon-low',messages:[encodeEnvelope(segments,'normal',50)]});
test('direct preset reader handles merged and rewritten final messages without an old source tree',()=>{
 const f=sourceFixture();
 const final=[{role:'system',content:f.chat[0].content.replace(f.preset,'EXPANDED_PRESET')+'\n'+f.chat[1].content+'\nLATE_BACKGROUND'},
  {role:'assistant',content:'<advice>LATE</advice> PAST_REPLY'},{role:'user',content:'CURRENT'},
  {role:'system',content:f.chat[5].content}];
 const segments=transport.readPresetSegments(final,f.tagger,{latestUserText:'CURRENT'});
 assert.equal(segments.find(s=>s.text==='EXPANDED_PRESET').placement,'inline');
 assert.equal(segments.find(s=>s.text==='WORLD_ONLY').placement,'file');
 assert.equal(segments.find(s=>s.text==='POST_PRESET').placement,'inline');
 assert.equal(segments.find(s=>s.text==='CURRENT').placement,'inline');
 assert.equal(segments.find(s=>s.text.includes('<advice>')).placement,'file');
 for(let i=0;i<final.length;i++)assert.equal(segments.filter(s=>s.message===i).map(s=>s.text).join(''),f.tagger.strip(final[i].content));
 assert.throws(()=>transport.readPresetSegments([{role:'user',content:'NO_PRESET_CAPTURE'}],f.tagger),/preset_not_ready/);
});
test('direct reader does not expand macros twice or copy disabled preset alternatives',()=>{
 let expansions=0;
 const manager={serviceSettings:{prompts:[{identifier:'main'},{identifier:'disabled-alternative',content:'DISABLED_PRESET'}]},preparePrompt:p=>({...p,content:p.content.replace('{{counter}}',String(++expansions))})};
 const tagger=createTagger('c'.repeat(24));hookPromptManager(manager,tagger,()=>true);
 const raw={identifier:'main',role:'system',content:'ACTIVE {{counter}}'};
 const prepared=manager.preparePrompt(raw);
 for(let i=0;i<2;i++){
  const segments=readPresetSegments([{role:'system',content:prepared.content},{role:'user',content:'CURRENT'}],tagger,{latestUserText:'CURRENT'});
  assert.equal(segments[0].text,'ACTIVE 1');assert.ok(!JSON.stringify(segments).includes('DISABLED_PRESET'));
 }
 assert.equal(expansions,1);assert.equal(raw.content,'ACTIVE {{counter}}');
});
test('ST preserves exact preset text inline while history, World Info and injected context stay in files',()=>{
 const f=sourceFixture(),input=parseCompletion(request(f.segments));
 const ctx=makeAttachmentContext(buildInput(input.body));
 assert.equal(input.resolved.thinkingLevel,'low');
 assert.ok(ctx.prompt.includes(f.preset));assert.ok(ctx.prompt.includes('POST_PRESET'));assert.ok(ctx.prompt.includes('CURRENT'));
 const stored=ctx.files.map(f=>f.text).join('\n');
 for(const text of ['PRESET_EXACT','POST_PRESET','CURRENT'])assert.ok(!stored.includes(text));
 for(const text of ['WORLD_ONLY','PAST_ONLY','PAST_REPLY'])assert.ok(!ctx.prompt.includes(text));
 assert.equal(ctx.files.length,1);const layout=JSON.parse(ctx.files[0].text).segments;
 f.segments.forEach((s,i)=>{if(s.placement==='file')assert.equal(layout[i].text,s.text);else assert.equal(Object.hasOwn(layout[i],'text'),false);});
 assert.deepEqual(layout.map(r=>[r.message,r.part,r.role]),f.segments.map(s=>[s.message,s.part,s.role]));
 assert.equal(ctx.marker,undefined);assert.equal(unwrapFileReply('ANSWER',ctx),'ANSWER');
});
test('ST markers never modify saved presets; missing boundaries and metadata fail closed',()=>{
 const f=sourceFixture(),raw={identifier:'main',role:'system',content:'ORIGINAL'};
 f.manager.preparePrompt(raw);assert.equal(raw.content,'ORIGINAL');
 const marked=f.manager.preparePrompt(raw).content;
 assert.throws(()=>f.tagger.split(marked.replace(':END]]',':BROKEN]]'),{}),/broken_boundary/);
 assert.throws(()=>readPresetSegments([{role:'user',content:marked.replace(':END]]',':BROKEN]]')}],f.tagger),/broken_boundary/);
 assert.throws(()=>readPresetSegments([{role:'user',content:'NO_PRESET'}],f.tagger),/preset_not_ready/);
});
test('ST long inline presets are never silently converted to attachment text',()=>{
 const preset='长预设😀\n'.repeat(10000),segments=[{message:0,part:0,role:'system',source:'main',placement:'inline',text:preset},{message:1,part:0,role:'user',source:'chatHistory-1',placement:'file',text:'CONTEXT'}];
 const ctx=makeAttachmentContext(buildInput(parseCompletion(request(segments)).body));
 assert.ok(ctx.prompt.includes(preset));assert.ok(!ctx.files.some(f=>f.text.includes('长预设')));
});
test('ST settings hook survives custom backend projection, rejects custom-body conflicts, and ignores other providers',()=>{
 const f=sourceFixture(),data={type:'normal',chat_completion_source:'custom',model:'build-st/gemini-4-argon-low',messages:f.chat,temperature:1,top_p:0.9,stop:[],seed:-1};
 const snapshot={original:JSON.stringify(f.chat),segments:f.segments};
 const wire=prepareOutgoing(data,snapshot,{inlineTokens:50});applyOutgoing(data,wire);
 // The actual ST backend adds custom_include_body after the OpenAI projection.
 const projected={messages:data.messages,model:data.model,temperature:data.temperature,top_p:data.top_p,seed:data.seed,...JSON.parse(data.custom_include_body)};
 for(const field of JSON.parse(data.custom_exclude_body))delete projected[field];
 assert.equal(parseCompletion(projected).body.sillytavern.segments.length,f.segments.length);
 assert.throws(()=>prepareOutgoing({...data,messages:[]},snapshot,{inlineTokens:50}),/custom_body_conflict/);
 assert.equal(prepareOutgoing({...data,chat_completion_source:'openai'},snapshot,{inlineTokens:50}),null);
 assert.throws(()=>prepareOutgoing({...data,custom_include_body:'',custom_exclude_body:'',messages:f.chat},snapshot,{inlineTokens:45001}),/inline_budget_exceeded/);
});

test('actual extension reads final presets despite late edits and an unrelated inspection tree',async()=>{
 for(const source of ['openai','custom']){
 const handlers=new Map(),errors=[];
 const model='build-st/gemini-4-argon-high';
 const oai={chat_completion_source:source,openai_model:model,reverse_proxy:'http://127.0.0.1:18787/v1',custom_model:model,squash_system_messages:false,prompts:[{identifier:'main'},{identifier:'worldInfoBefore',marker:true}]};
 const manager={serviceSettings:oai,preparePrompt:p=>({...p})};
 const context={extensionSettings:{build_standalone_adapter:{enabled:true}},chat:[{role:'user',content:'CURRENT'}],getTokenCountAsync:async()=>50,eventTypes:{GENERATION_STARTED:'start',CHAT_COMPLETION_PROMPT_READY:'prepared',GENERATE_AFTER_DATA:'final',CHAT_COMPLETION_SETTINGS_READY:'send',APP_READY:'ready'},eventSource:{on:(event,fn)=>handlers.set(event,fn),makeLast:(event,fn)=>handlers.set(event,fn)}};
 const code=(await readFile(new URL('../extensions/build-standalone-adapter/runtime.js',import.meta.url),'utf8')).replace(/^import .*;\r?\n/gm,'').replace('export function','function')+'\ninstallSillyTavern({getContext,openAI,owner:"browser"});';
 vm.runInNewContext(code,{...transport,getContext:()=>context,openAI:{oai_settings:oai,promptManager:manager,setOpenAIMessages:chat=>chat},crypto:webcrypto,document:{querySelector:()=>null},toastr:{error:message=>errors.push(message)}});
 handlers.get('start')();
 const leaves=[manager.preparePrompt({identifier:'main',role:'system',content:'EXACT_PRESET'}),manager.preparePrompt({identifier:'worldInfoBefore',role:'system',content:'WORLD_INFO'}),{identifier:'chatHistory-0',role:'user',content:'CURRENT'}];
 manager.messages={collection:leaves};
 const chat=leaves.map(({role,content})=>({role,content}));
 assert.equal(handlers.has('prepared'),false);assert.equal(handlers.has('final'),false);
 chat.splice(2,0,{role:'system',content:'LATE_BACKGROUND'});
 chat[0].content=chat[0].content.replace('EXACT_PRESET','EXPANDED_PRESET');
 // A different preparation may finish before this request's settings event.
 manager.messages={collection:[{identifier:'chatHistory-0',role:'user',content:'ANOTHER_REQUEST'}]};
 // The inspection tree above is deliberately unrelated to the outgoing request.
 const data={chat_completion_source:source,reverse_proxy:oai.reverse_proxy,proxy_password:'LOCAL_TEST_ONLY',model,messages:chat.map(m=>({content:m.content,role:m.role})),temperature:0.9};
 await handlers.get('send')(data);
 const normalized=parseCompletion(JSON.parse(JSON.stringify({model:data.model,messages:data.messages,temperature:data.temperature})));
 assert.equal(normalized.body.sillytavern.segments.find(s=>s.text==='EXPANDED_PRESET').placement,'inline');
 assert.equal(normalized.body.sillytavern.segments.find(s=>s.text==='WORLD_INFO').placement,'file');
 assert.equal(normalized.body.sillytavern.segments.find(s=>s.text==='CURRENT').placement,'inline');
 assert.equal(normalized.body.sillytavern.segments.find(s=>s.text==='LATE_BACKGROUND').placement,'file');
 assert.equal(data.reverse_proxy,oai.reverse_proxy);assert.equal(data.proxy_password,'LOCAL_TEST_ONLY');
 if(source==='openai'){assert.equal(data.custom_include_body,undefined);assert.equal(data.custom_exclude_body,undefined);}
 else assert.deepEqual(JSON.parse(data.custom_include_body).messages,JSON.parse(JSON.stringify(data.messages)));
 assert.deepEqual(errors,[]);
 // Added text outside a preset is preserved as context instead of causing a mismatch.
 const changed=structuredClone(chat);changed[0].content+='LATE_OUTSIDE_TEXT';
 const again={chat_completion_source:source,reverse_proxy:oai.reverse_proxy,model,messages:changed};await handlers.get('send')(again);
 const accepted=parseCompletion({model,messages:again.messages});assert.equal(accepted.body.sillytavern.segments.find(s=>s.text==='LATE_OUTSIDE_TEXT').placement,'file');
 handlers.get('start')('continue',{},false);handlers.get('start')('normal',{},true);
 const continued={chat_completion_source:source,reverse_proxy:oai.reverse_proxy,model,messages:structuredClone(chat)};await handlers.get('send')(continued);
 assert.equal(parseCompletion({model,messages:continued.messages}).body.sillytavern.generationType,'continue');
 oai.openai_model='gpt-example';const ordinary={chat_completion_source:'openai',reverse_proxy:oai.reverse_proxy,model:oai.openai_model,messages:[{role:'user',content:'KEEP'}],temperature:1};
 const before=structuredClone(ordinary);await handlers.get('send')(ordinary);assert.deepEqual(ordinary,before);
 }
});

test('ST malformed transport never reaches a browser executor; ordinary API remains separate',async t=>{
 let calls=0;const f=await fixture(t,{executor:{execute:async()=>{calls++;return {text:'OK'};}}});
 for(const messages of [[{role:'user',content:'plain'}],[errorEnvelope('metadata_missing')],[encodeEnvelope([{message:2,part:0,role:'system',source:'main',placement:'inline',text:'BAD'}])]]){
  const r=await f.call('/v1/chat/completions',{model:'build-st/gemini-4-argon-low',messages});assert.equal(r.status,400);await r.text();
 }
 assert.equal(calls,0);
 const good=await f.call('/v1/chat/completions',request(sourceFixture().segments));assert.equal(good.status,200);assert.equal(good.headers.get('x-build-context'),'sillytavern_split');assert.equal((await good.json()).model,'build-st/gemini-4-argon-low');assert.equal(calls,1);
});
test('ST continuation preserves final assistant and post-history system instructions',()=>{
 const segments=[{message:0,part:0,role:'assistant',source:'chatHistory-1',placement:'file',text:'UNFINISHED'}, {message:1,part:0,role:'system',source:'jailbreak',placement:'inline',text:'POST_INSTRUCTIONS'}];
 const input=parseCompletion({...request(segments),messages:[encodeEnvelope(segments,'continue',30)]});
 assert.ok(makeAttachmentContext(buildInput(input.body)).prompt.includes('Continue the final assistant message.'));
 assert.equal(input.body.sillytavern.segments.at(-1).role,'system');
});

test('ST source registry survives many dry runs and rejects inconsistent roles within one message',()=>{
 const tagger=createTagger('b'.repeat(24));let text;
 for(let i=0;i<51000;i++)text=tagger.mark('UNCHANGED',{source:'main',placement:'inline'});
 assert.equal(tagger.strip(text),'UNCHANGED');assert.equal(tagger.fault,null);
 const f=sourceFixture(),segments=[{message:0,part:0,role:'system',source:'main',placement:'inline',text:'A'}, {message:0,part:1,role:'user',source:'main',placement:'inline',text:'B'}];
 assert.throws(()=>parseCompletion(request(segments)),/角色不一致/);
 const data={chat_completion_source:'custom',model:'build-st/gemini-4-argon-low',messages:structuredClone(f.chat)};
 assert.ok(prepareOutgoing(data,{original:JSON.stringify(f.chat),segments:f.segments},{inlineTokens:20}));
});

test('ST context extensions may insert messages without changing original preset and history',()=>{
 const f=sourceFixture(),chat=structuredClone(f.chat);chat.splice(2,0,{role:'system',content:'TABLE_CONTEXT'});
 const segments=readPresetSegments(chat,f.tagger);
 assert.equal(segments.find(s=>s.text==='TABLE_CONTEXT').placement,'file');
 assert.equal(segments.find(s=>s.text===f.preset).placement,'inline');
 chat[3].content='CHANGED_HISTORY';
 assert.equal(readPresetSegments(chat,f.tagger).find(s=>s.text==='CHANGED_HISTORY').placement,'file');
});

test('late advice decorations on history remain verbatim in files, while preserving inline presets',()=>{
 const f=sourceFixture(),chat=structuredClone(f.chat);
 chat[3].content='<advice>RESOLVED_ADVICE</advice>\n\n'+chat[3].content;
 const segments=readPresetSegments(chat,f.tagger,{latestUserText:'CURRENT'});
 assert.equal(segments.find(s=>s.text===chat[3].content).placement,'file');
 assert.equal(segments.find(s=>s.text==='CURRENT').placement,'inline');
 assert.equal(segments.find(s=>s.text===f.preset).placement,'inline');

});

test('final role changes and outside additions preserve presets while malformed boundaries are rejected',()=>{
 const f=sourceFixture(),chat=structuredClone(f.chat);
 chat[0].content=chat[0].content.replace(f.preset,'RESOLVED_PRESET');
 chat[1].content=chat[1].content.replace('WORLD_ONLY','RESOLVED_WORLD');
 const segments=readPresetSegments(chat,f.tagger);
 assert.equal(segments.find(s=>s.text==='RESOLVED_PRESET').placement,'inline');
 assert.equal(segments.find(s=>s.text==='RESOLVED_WORLD').placement,'file');
 chat[0].role='user';chat[0].content+='OUTSIDE_TEXT';[chat[0],chat[1]]=[chat[1],chat[0]];
 assert.equal(readPresetSegments(chat,f.tagger).find(s=>s.text==='RESOLVED_PRESET').placement,'inline');
 assert.equal(readPresetSegments(chat,f.tagger).find(s=>s.text==='OUTSIDE_TEXT').placement,'file');
 chat[1].content=chat[1].content.replace(':END]]',':BROKEN]]');assert.throws(()=>readPresetSegments(chat,f.tagger),/broken_boundary/);
});
