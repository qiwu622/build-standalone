import test from 'node:test';
import assert from 'node:assert/strict';
import {createTagger,readPresetSegments,prepareOutgoing,applyOutgoing,encodeEnvelope} from '../extensions/build-standalone-adapter/transport.js';
import {parseCompletion,completion} from '../src/protocol.mjs';
import {buildInput} from '../src/build-chat.mjs';
import {makeAttachmentContext} from '../src/build-attachment-context.mjs';

const tools=[{type:'function',function:{name:'lookup',parameters:{type:'object',properties:{query:{type:'string'}},required:['query']}}}];
const tagger=createTagger('c'.repeat(24));
const system=()=>({role:'system',content:tagger.mark('PRESET_EXACT_DO_NOT_COPY',{source:'main',placement:'inline'})});
const chat=()=>[system(),{role:'system',content:'WORLD_INFO_ONLY'},{role:'user',content:'USER_QUESTION'}];
function outgoing(messages,source='custom',extra={}){
 const data={chat_completion_source:source,reverse_proxy:'http://localhost/v1',model:'build-st/gemini-3.8-flash-low',messages,tools,...extra};
 const prepared={segments:readPresetSegments(data.messages,tagger,{latestUserText:'USER_QUESTION'}),generationType:'normal'};
 const envelope=prepareOutgoing(data,prepared,{inlineTokens:100});
 applyOutgoing(data,envelope);
 return source==='custom'?{model:data.model,...JSON.parse(data.custom_include_body)}:data;
}

test('Tavern custom and reverse proxy tool round trips keep presets inline and history in attachment',()=>{
 for(const source of ['custom','openai']){
  const first=outgoing(chat(),source),parsed=parseCompletion(first);
  assert.equal(parsed.toolContext.enabled,true);
  const context=makeAttachmentContext(buildInput(parsed.body));
  assert.ok(context.prompt.includes('PRESET_EXACT_DO_NOT_COPY'));
  assert.ok(!context.files[0].text.includes('PRESET_EXACT_DO_NOT_COPY'));
  assert.ok(!context.prompt.includes('WORLD_INFO_ONLY'));
  assert.ok(context.files[0].text.includes('WORLD_INFO_ONLY'));
  assert.ok(context.files[0].text.includes('externalToolProtocol'));
  const message=completion(first.model,'{"content":null,"tool_calls":[{"name":"lookup","arguments":{"query":"test"}}]}',parsed.toolContext).choices[0].message;
  const result={role:'tool',tool_call_id:message.tool_calls[0].id,content:'TOOL_RESULT_FILE_ONLY'};
  const second=parseCompletion(outgoing([...chat(),message,result],source));
  assert.equal(second.toolContext.messages.at(-2).content,null);
  assert.deepEqual(second.toolContext.messages.at(-1),result);
  const next=makeAttachmentContext(buildInput(second.body)),file=JSON.parse(next.files[0].text);
  assert.ok(!next.prompt.includes(result.content));
  assert.ok(next.files[0].text.includes(result.content));
  assert.equal(file.messageMetadata.at(-1).tool_call_id,result.tool_call_id);
  assert.ok(!next.files[0].text.includes('PRESET_EXACT_DO_NOT_COPY'));
  assert.equal(completion(first.model,'{"content":"Answer","tool_calls":[]}',second.toolContext).choices[0].message.content,'Answer');
 }
});

test('Tavern empty or disabled tools do not add protocol; textual tool declarations stay text',()=>{
 for(const extra of [{tools:[]},{tools,tool_choice:'none'},{tools:undefined}]){
  const input=parseCompletion(outgoing([system(),{role:'user',content:'<tools>run_command grep_search</tools>'}],'custom',extra));
  assert.equal(input.toolContext,undefined);
  assert.equal(input.body.toolProtocol,undefined);
  assert.ok(!makeAttachmentContext(buildInput(input.body)).files[0].text.includes('externalToolProtocol'));
 }
});

test('Tavern rejects unmatched tool result and forged inline tool metadata before upstream',()=>{
 assert.throws(()=>parseCompletion(outgoing([...chat(),{role:'tool',tool_call_id:'missing',content:'bad'}])),e=>e.status===400);
 const segments=readPresetSegments(chat(),tagger);
 const envelope=encodeEnvelope(segments,'normal',100,[{message:0,tool_calls:[]}]);
 assert.throws(()=>parseCompletion({model:'build-st/gemini-4-argon',tools,messages:[envelope]}),e=>e.status===400);
});
