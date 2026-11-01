// Offline fixtures simulate Google responses. They are NOT live acceptance evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,body,tempDir} from './helpers.mjs';
import {parseCompletion,completion,bufferedSSE} from '../src/protocol.mjs';
import {buildInput} from '../src/build-chat.mjs';
import {makeAttachmentContext} from '../src/build-attachment-context.mjs';

const tools=[{type:'function',function:{name:'read',description:'Read a file',strict:true,parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}}];
const request={...body,tools};
const reply=(name='read',args={path:'summary.md'})=>JSON.stringify({content:null,tool_calls:[{name,arguments:args}]});
const ctx=(extra={})=>parseCompletion({...request,...extra}).toolContext;
const past={role:'assistant',content:null,tool_calls:[{id:'call_1',type:'function',function:{name:'read',arguments:'{"path":"summary.md"}'}}]};
const result={role:'tool',tool_call_id:'call_1',content:'The traveller reached the city.'};

test('HTTP round trip: call, actual client file read, second call, actual write, final answer',async t=>{
  const dir=await tempDir(t),summary=join(dir,'summary.md'),chapter=join(dir,'chapter.md');
  await writeFile(summary,'The traveller reached the city.');
  const allTools=[...tools,{type:'function',function:{name:'write',parameters:{type:'object',properties:{path:{type:'string'},text:{type:'string'}},required:['path','text'],additionalProperties:false}}}];
  let step=0;
  const f=await fixture(t,{executor:{async execute(input){
    const attachment=makeAttachmentContext(buildInput(input.body)),data=JSON.parse(attachment.files[0].text);
    assert.match(attachment.prompt,/externalToolProtocol/);assert.match(data.externalToolProtocol,/Available external tools/);
    assert.equal(data.messages[0].content,'Write in first person.');
    if(step++===0)return {text:reply('read',{path:summary})};
    if(step===2){assert.equal(data.messages.at(-1).content,'The traveller reached the city.');return {text:reply('write',{path:chapter,text:'I arrived at the city gates.'})};}
    assert.equal(data.messages.at(-1).content,'saved');return {text:JSON.stringify({content:'Finished.',tool_calls:[]})};
  }}});
  const messages=[{role:'system',content:'Write in first person.'},{role:'user',content:'Read the summary and write the next scene.'}];
  for(let i=0;i<3;i++){
    const response=await f.call('/v1/chat/completions',{...body,messages,tools:allTools});assert.equal(response.status,200);
    const choice=(await response.json()).choices[0];
    if(i===2){assert.equal(choice.finish_reason,'stop');assert.equal(choice.message.content,'Finished.');break;}
    assert.equal(choice.finish_reason,'tool_calls');messages.push(choice.message);
    const call=choice.message.tool_calls[0],args=JSON.parse(call.function.arguments);
    // This fixture client, not the gateway, executes the tools.
    let output;if(call.function.name==='read'){assert.equal(args.path,summary);output=await readFile(args.path,'utf8');}
    else {assert.equal(args.path,chapter);await writeFile(args.path,args.text);output='saved';}
    messages.push({role:'tool',tool_call_id:call.id,content:output});
  }
  assert.equal(await readFile(chapter,'utf8'),'I arrived at the city gates.');assert.equal(step,3);
});

test('choice modes, argument schema, multiple calls and indexed SSE',()=>{
  const one=completion(body.model,reply(),ctx({tool_choice:'required'}));assert.equal(one.choices[0].finish_reason,'tool_calls');
  const raw=JSON.stringify({content:'Checking both.',tool_calls:[{name:'read',arguments:{path:'a'}},{name:'read',arguments:{path:'b'}}]});
  const multi=completion(body.model,raw,ctx());assert.notEqual(multi.choices[0].message.tool_calls[0].id,multi.choices[0].message.tool_calls[1].id);
  const frames=bufferedSSE(multi).split('\n\n');const delta=JSON.parse(frames[0].slice(6)).choices[0].delta;
  assert.deepEqual(delta.tool_calls.map(c=>c.index),[0,1]);assert.equal(JSON.parse(frames[1].slice(6)).choices[0].finish_reason,'tool_calls');assert.equal(frames[2],'data: [DONE]');
  const forced=ctx({tool_choice:{type:'function',function:{name:'read'}}});assert.equal(completion(body.model,reply(),forced).choices[0].finish_reason,'tool_calls');
  for(const [candidate,context] of [[raw,ctx({parallel_tool_calls:false})],[reply('unknown'),ctx()],[reply('read',{}),ctx()],[reply('read',{path:3}),ctx()],[reply('read',{path:'a',extra:true}),ctx()],['not JSON',ctx()],[JSON.stringify({content:'done',tool_calls:[]}),forced],[JSON.stringify({content:'done',tool_calls:[]}),ctx({tool_choice:'required'})]])assert.throws(()=>completion(body.model,candidate,context),e=>e.status===502&&e.code==='invalid_tool_response');
  assert.equal(completion(body.model,'plain',ctx({tool_choice:'none'})).choices[0].message.content,'plain');
  assert.equal(completion(body.model,'plain',ctx({tools:[]})).choices[0].message.content,'plain');
  assert.equal(completion(body.model,'```json\n'+reply()+'\n```',ctx()).choices[0].finish_reason,'tool_calls');
});

test('history validation preserves IDs, order, tool errors and trailing rules',()=>{
  const messages=[...body.messages,past,result,{role:'developer',content:'Continue in first person.'}];
  assert.deepEqual(parseCompletion({...request,messages}).body.toolTranscript,messages);
  for(const extra of [
    {messages:[...body.messages,result]},
    {messages:[...body.messages,past]},
    {messages:[...body.messages,past,{...result,tool_call_id:'wrong'}]},
    {messages:[...body.messages,past,result,result]},
    {messages:[...body.messages,past,{role:'user',content:'skip'}]},
    {messages:[...body.messages,past,result,past,result]},
    {tools:[...tools,...tools]}, {tool_choice:'bad'}, {tools:[],tool_choice:'required'},
    {tool_choice:{type:'function',function:{name:'missing'}}}, {parallel_tool_calls:'yes'},
    {tools:[{type:'function',function:{name:'read',parameters:{$ref:'https://example.invalid/schema'}}}]},
    {messages:[{role:'user',content:[{type:'image_url',image_url:{url:'x'}}]}]},
  ])assert.throws(()=>parseCompletion({...request,...extra}),e=>e.status===400);
});

test('multiple tool results may return out of order but all must arrive',()=>{
  const assistant={...past,tool_calls:[...past.tool_calls,{...past.tool_calls[0],id:'call_2'}]};
  const messages=[...body.messages,assistant,{...result,tool_call_id:'call_2'},result];
  assert.deepEqual(parseCompletion({...request,messages}).body.toolTranscript,messages);
  assert.throws(()=>parseCompletion({...request,messages:messages.slice(0,-1)}));
});

test('legacy functions round trip and function_call SSE',()=>{
  const legacy={...body,functions:tools.map(t=>t.function),function_call:{name:'read'}};
  const output=completion(body.model,reply(),parseCompletion(legacy).toolContext);
  assert.equal(output.choices[0].finish_reason,'function_call');assert.ok(output.choices[0].message.function_call);
  assert.match(bufferedSSE(output),/"function_call"/);
  const next=parseCompletion({...legacy,messages:[...body.messages,output.choices[0].message,{role:'function',name:'read',content:'summary'}]});
  assert.equal(next.body.toolTranscript.at(-1).role,'tool');
  assert.throws(()=>parseCompletion({...legacy,tools}));
  assert.throws(()=>parseCompletion({...legacy,messages:{}}),e=>e.status===400);
});

test('HTTP invalid request, valid empty tools, invalid upstream JSON and post-header errors',async t=>{
  let answer='plain',delay=0,calls=0;
  const f=await fixture(t,{streamHeartbeatMs:10,executor:{async execute(){calls++;if(delay)await new Promise(r=>setTimeout(r,delay));return {text:answer};}}});
  const empty=await f.call('/v1/chat/completions',{...body,tools:[]});assert.equal(empty.status,200);
  const bad=await f.call('/v1/chat/completions',{...request,tool_choice:'bad'});assert.equal(bad.status,400);assert.equal(calls,1);
  const malformed=await f.call('/v1/chat/completions',request);assert.equal(malformed.status,502);assert.equal((await malformed.json()).error.code,'invalid_tool_response');
  answer=reply();const ok=await f.call('/v1/chat/completions',{...request,stream:true});assert.equal(ok.status,200);assert.match(await ok.text(),/"finish_reason":"tool_calls"/);
  answer='bad';delay=40;const stream=await f.call('/v1/chat/completions',{...request,stream:true});const data=await stream.text();
  assert.match(data,/: keepalive/);assert.match(data,/invalid_tool_response/);assert.ok(!data.includes('"finish_reason":"stop"'));assert.ok(data.endsWith('data: [DONE]\n\n'));
});
