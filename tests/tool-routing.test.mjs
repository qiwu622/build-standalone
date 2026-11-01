import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCompletion,completion} from '../src/protocol.mjs';
import {buildInput} from '../src/build-chat.mjs';
import {makeAttachmentContext} from '../src/build-attachment-context.mjs';

const body={model:'gemini-3.8-flash-low',messages:[{role:'user',content:'plain conversation'}]};
const tools=[{type:'function',function:{name:'lookup',parameters:{type:'object',properties:{query:{type:'string'}},required:['query']}}}];
const attachment=parsed=>makeAttachmentContext(buildInput(parsed.body),{nonce:'012345678901234567890123'});

test('omitted, empty, auto-without-tools and explicitly disabled tools use identical native input',()=>{
  const native=parseCompletion(body);
  for(const extra of [{},{tools:[]},{tools:null},{tools:[],tool_choice:'auto'},{tool_choice:'none'},{tools,tool_choice:'none'},{functions:[],function_call:'auto'},{functions:tools.map(t=>t.function),function_call:'none'}]){
    const parsed=parseCompletion({...body,...extra});
    assert.equal(parsed.toolContext,undefined);
    assert.deepEqual(parsed.body,native.body);
    assert.deepEqual(attachment(parsed),attachment(native));
    assert.equal(completion(body.model,'unchanged <text>',parsed.toolContext).choices[0].message.content,'unchanged <text>');
  }
});

test('enabled tools add protocol only for this request and never mutate the native request',()=>{
  const before=JSON.stringify(body);
  const parsed=parseCompletion({...body,tools});
  assert.equal(parsed.toolContext.enabled,true);
  const data=JSON.parse(attachment(parsed).files[0].text);
  assert.match(data.externalToolProtocol,/Available external tools/);
  assert.equal(data.messages[0].content,'plain conversation');
  assert.equal(JSON.stringify(body),before);
  assert.equal(attachment(parseCompletion(body)).files[0].text.includes('externalToolProtocol'),false);
});

test('tool history without new tools preserves IDs without reinserting tool schemas',()=>{
  const messages=[...body.messages,{role:'assistant',content:null,tool_calls:[{id:'call_a',type:'function',function:{name:'lookup',arguments:'{"query":"weather"}'}}]},{role:'tool',tool_call_id:'call_a',content:'sunny'}];
  const parsed=parseCompletion({...body,messages});
  assert.equal(parsed.toolContext.enabled,false);
  assert.deepEqual(parsed.body.toolTranscript,messages);
  assert.ok(!parsed.body.toolProtocol.includes('Available external tools'));
  assert.equal(completion(body.model,'sunny',parsed.toolContext).choices[0].message.content,'sunny');
});

test('async schemas and excessive definitions are rejected before execution',()=>{
  for(const parameters of [{$async:true,type:'object'},{type:'object',description:'x'.repeat(256*1024)}]){
    assert.throws(()=>parseCompletion({...body,tools:[{type:'function',function:{name:'lookup',parameters}}]}),e=>e.status===400);
  }
});
