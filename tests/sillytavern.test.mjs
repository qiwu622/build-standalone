import test from 'node:test';
import assert from 'node:assert/strict';
import {createTagger,hookPromptManager,captureSegments,encodeEnvelope,errorEnvelope,prepareOutgoing,applyOutgoing} from '../extensions/build-standalone-adapter/transport.js';
import {parseCompletion} from '../src/protocol.mjs';
import {makeFileContext,unwrapFileReply} from '../src/build-file-context.mjs';
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
 const segments=captureSegments(chat,{collection:leaves},settings,tagger,{latestUserText:'CURRENT'});
 return {settings,manager,tagger,preset,chat,leaves,segments};
}
const request=segments=>({model:'build-st/gemini-4-argon-low',messages:[encodeEnvelope(segments,'normal',50)]});
test('ST preserves exact preset text inline while history, World Info and injected context stay in files',()=>{
 const f=sourceFixture(),input=parseCompletion(request(f.segments));
 const ctx=makeFileContext(buildInput(input.body));
 assert.equal(input.resolved.thinkingLevel,'low');
 assert.ok(ctx.prompt.includes(f.preset));assert.ok(ctx.prompt.includes('POST_PRESET'));assert.ok(ctx.prompt.includes('CURRENT'));
 const stored=ctx.files.map(f=>f.text).join('\n');
 for(const text of ['PRESET_EXACT','POST_PRESET','CURRENT'])assert.ok(!stored.includes(text));
 for(const text of ['WORLD_ONLY','PAST_ONLY','PAST_REPLY'])assert.ok(!ctx.prompt.includes(text));
 const rows=ctx.files[1].text.trim().split('\n').map(JSON.parse),rebuilt=new Map();
 for(const row of rows)if(row.segment)rebuilt.set(row.segment,(rebuilt.get(row.segment)||'')+row.text);
 f.segments.forEach((s,i)=>{if(s.placement==='file')assert.equal(rebuilt.get(i+1),s.text);});
 const layout=ctx.files[0].text.trim().split('\n').map(JSON.parse).filter(r=>r.segment);
 assert.deepEqual(layout.map(r=>[r.message,r.part,r.role]),f.segments.map(s=>[s.message,s.part,s.role]));
 assert.equal(unwrapFileReply(ctx.marker+'\nANSWER',ctx),'ANSWER');
});
test('ST markers never modify saved presets; missing boundaries and metadata fail closed',()=>{
 const f=sourceFixture(),raw={identifier:'main',role:'system',content:'ORIGINAL'};
 f.manager.preparePrompt(raw);assert.equal(raw.content,'ORIGINAL');
 const marked=f.manager.preparePrompt(raw).content;
 assert.throws(()=>f.tagger.split(marked.replace(':END]]',':BROKEN]]'),{}),/broken_boundary/);
 assert.throws(()=>captureSegments(f.chat,{collection:f.leaves.slice(1)},f.settings,f.tagger),/metadata_mismatch/);
 assert.throws(()=>captureSegments(f.chat,{collection:f.leaves},{...f.settings,squash_system_messages:true},f.tagger),/system_merge_enabled/);
});
test('ST long inline presets are never silently converted to project-file text',()=>{
 const preset='长预设😀\n'.repeat(10000),segments=[{message:0,part:0,role:'system',source:'main',placement:'inline',text:preset},{message:1,part:0,role:'user',source:'chatHistory-1',placement:'file',text:'CONTEXT'}];
 const ctx=makeFileContext(buildInput(parseCompletion(request(segments)).body));
 assert.ok(ctx.prompt.includes(preset));assert.ok(!ctx.files.some(f=>f.text.includes('长预设')));
});
test('ST settings hook survives custom backend projection, rejects stale data, and ignores other providers',()=>{
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
 assert.ok(makeFileContext(buildInput(input.body)).prompt.includes('Continue the final assistant message.'));
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
 const segments=captureSegments(chat,{collection:f.leaves},f.settings,f.tagger);
 assert.equal(segments.find(s=>s.text==='TABLE_CONTEXT').placement,'file');
 assert.equal(segments.find(s=>s.text===f.preset).placement,'inline');
 chat[3].content='CHANGED_HISTORY';
 assert.throws(()=>captureSegments(chat,{collection:f.leaves},f.settings,f.tagger),/metadata_mismatch/);
});
