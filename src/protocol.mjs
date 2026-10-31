import {randomUUID} from 'node:crypto';
import {resolveBuildModel,buildModels} from './build-thinking.mjs';
import {error} from './errors.mjs';
import {parseSillyTavern} from './sillytavern.mjs';

export function models() {return {object:'list',data:buildModels.flatMap(([id])=>[id,'build-st/'+id].map(id=>({id,object:'model',created:0,owned_by:'google-build'})))};}
export function parseCompletion(body) {
  if(!body||typeof body!=='object'||Array.isArray(body))throw error('JSON body 必须为对象');
  if(typeof body.model!=='string')throw error('model 必填');
  const tavern=body.model.startsWith('build-st/');
  const alias=tavern?body.model.slice(9):body.model.startsWith('build/')?body.model.slice(6):body.model;
  const resolved=resolveBuildModel(alias);
  // Many OpenAI clients always send sampling defaults. Build exposes none of
  // those controls: omit them from the normalized request below, without
  // rejecting the call or copying them into the prompt. Thinking stays bound
  // to the model suffix. Unsupported input/output capabilities remain explicit.
  const unsupported=['tools','tool_choice','functions','function_call','response_format','modalities','audio'];
  for(const key of unsupported)if(body[key]!==undefined&&body[key]!==null)throw error('此接口不支持参数：'+key,400,'unsupported_parameter');
  if(body.n!==undefined&&body.n!==1)throw error('仅支持 n=1');
  if(body.stream!==undefined&&typeof body.stream!=='boolean')throw error('stream 必须为布尔值');
  if(body.stream_options&&Object.keys(body.stream_options).some(k=>k!=='include_usage'))throw error('不支持此 stream_options');
  if(tavern){
    const context=parseSillyTavern(body.messages),max=body.max_completion_tokens??body.max_tokens;
    if(max!==undefined&&(!Number.isSafeInteger(max)||max<1||max>1000000))throw error('输出 token 数必须为正整数');
    return {alias,responseModel:body.model,resolved,stream:body.stream===true,body:{sillytavern:context,contents:[{role:'user',parts:[{text:''}]}],...(max?{generationConfig:{maxOutputTokens:max}}:{})}};
  }
  if(!Array.isArray(body.messages)||!body.messages.length||body.messages.length>10000)throw error('messages 必须为非空数组，最多 10000 条');
  const contents=[];let lastConversationRole;
  for(const m of body.messages) {
    if(!m||!['system','developer','user','assistant'].includes(m.role)||m.tool_calls||m.function_call||m.name)throw error('仅支持 system/developer/user/assistant 文本消息');
    let content=m.content;
    if(Array.isArray(content))content=content.map(p=>{if(!p||p.type!=='text'||typeof p.text!=='string'||Object.keys(p).some(k=>!['type','text'].includes(k)))throw error('仅支持文本 content');return p.text;}).join('\n');
    if(typeof content!=='string')throw error('消息 content 必须为文本');
    // This transcript becomes a chat attachment, not a Gemini generateContent
    // request. Preserve every role and its position, including late instructions.
    contents.push({role:m.role,parts:[{text:content}]});
    if(m.role==='user'||m.role==='assistant')lastConversationRole=m.role;
  }
  if(lastConversationRole!=='user')throw error('最后一条会话消息必须为 user');
  const max=body.max_completion_tokens??body.max_tokens;
  if(max!==undefined&&(!Number.isSafeInteger(max)||max<1||max>1000000))throw error('输出 token 数必须为正整数');
  return {alias,resolved,stream:body.stream===true,body:{contents,...(max?{generationConfig:{maxOutputTokens:max}}:{})}};
}
export function completion(model,text) {return {id:'chatcmpl-'+randomUUID(),object:'chat.completion',created:Math.floor(Date.now()/1000),model,choices:[{index:0,message:{role:'assistant',content:text},finish_reason:'stop'}],usage:null};}
export function bufferedSSE(result) {
  const base={id:result.id,object:'chat.completion.chunk',created:result.created,model:result.model};
  const frames=[{...base,choices:[{index:0,delta:{role:'assistant',content:result.choices[0].message.content},finish_reason:null}]},{...base,choices:[{index:0,delta:{},finish_reason:'stop'}]}];
  return frames.map(v=>'data: '+JSON.stringify(v)+'\n\n').join('')+'data: [DONE]\n\n';
}
