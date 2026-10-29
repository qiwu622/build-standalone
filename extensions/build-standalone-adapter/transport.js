// Original adapter code. No SillyTavern implementation is bundled here.
export const WIRE_PREFIX='BUILD_ST_CONTEXT_V1\n';
export const MODEL_PREFIX='build-st/';
export const MAX_SEGMENTS=20000;
const background=new Set(['worldInfoBefore','worldInfoAfter','charDescription','charPersonality','scenario','personaDescription','dialogueExamples','summary','authorsNote','vectorsMemory','vectorsDataBank','smartContext']);
const controls=new Set(['main','nsfw','jailbreak','enhanceDefinitions','groupNudge','continueNudge','impersonate','quietPrompt','bias','newMainChat','newChat','emptyUserMessageReplacement']);
const fail=code=>{throw Object.assign(new Error(code),{code});};
export function presetSource(id,settings){
 if(background.has(id))return false;
 if(controls.has(id))return true;
 return !!settings?.prompts?.some(p=>p.identifier===id&&p.marker!==true&&!background.has(id));
}
export function flattenMessages(root){
 const result=[];
 const walk=(node,depth=0)=>{
  if(depth>20)fail('metadata_depth');
  if(Array.isArray(node?.collection)){node.collection.forEach(n=>walk(n,depth+1));return;}
  if(node&&(node.content||node.tool_calls))result.push(node);
 };
 walk(root);return result;
}

// Temporary boundaries survive ST's in-chat prompt grouping. They are added to
// prepared copies only, never to saved presets or chat messages.
export function createTagger(nonce){
 if(!/^[a-f0-9]{24}$/.test(nonce))fail('invalid_nonce');
 let sequence=0,fault=null;const entries=new Map(),bySource=new Map();
 const prefix=`[[BST:${nonce}:`;
 const expression=new RegExp(`\\[\\[BST:${nonce}:(\\d+):(BEGIN|END)\\]\\]`,'g');
 function split(text,fallback){
  const output=[];let offset=0,active=null,found=0;
  for(const match of text.matchAll(expression)){
   const meta=entries.get(match[1]);if(!meta)fail('unknown_boundary');
   if(match.index>offset)output.push({...active?.meta||fallback,text:text.slice(offset,match.index)});
   if(match[2]==='BEGIN'){if(active)fail('nested_boundary');active={id:match[1],meta};}
   else {if(active?.id!==match[1])fail('broken_boundary');active=null;}
   offset=match.index+match[0].length;found++;
  }
  if(active)fail('broken_boundary');
  if(offset<text.length)output.push({...fallback,text:text.slice(offset)});
  if(!found&&text.includes(prefix))fail('broken_boundary');
  return output.length?output:[{...fallback,text:''}];
 }
 function strip(text){return typeof text==='string'?split(text,{}).map(x=>x.text).join(''):text;}
 function mark(text,meta){
  if(!text)return text;
  const key=JSON.stringify(meta);let id=bySource.get(key);
  if(!id){
   if(entries.size>=MAX_SEGMENTS){fault='boundary_capacity';fail(fault);}
   id=String(++sequence);entries.set(id,meta);bySource.set(key,id);
  }
  return `${prefix}${id}:BEGIN]]${text}${prefix}${id}:END]]`;
 }
 return {split,strip,mark,prefix,get fault(){return fault;}};
}

export function hookPromptManager(manager,tagger,active){
 const original=manager.preparePrompt;
 if(typeof original!=='function')fail('prompt_api_missing');
 function prepared(prompt,originalText=null){
  if(!active())return original.call(this,prompt,originalText);
  const id=prompt?.identifier||'';
  const history=/^chatHistory-\d+$/.test(id);
  // Re-preparation of a history message must retain its inner source boundaries.
  const source=history?prompt:{...prompt,content:tagger.strip(prompt?.content)};
  const result=original.call(this,source,tagger.strip(originalText));
  if(result?.then)fail('prompt_api_async');
  if(history||typeof result?.content!=='string'||!result.content)return result;
  const placement=presetSource(id,this.serviceSettings)?'inline':'file';
  return Object.assign(Object.create(Object.getPrototypeOf(result)),result,{content:tagger.mark(result.content,{source:id||'context',placement})});
 }
 manager.preparePrompt=prepared;
 return ()=>{if(manager.preparePrompt===prepared)manager.preparePrompt=original;};
}

function textMessage(m){
 if(!m||!['system','developer','user','assistant'].includes(m.role)||typeof m.content!=='string'||m.tool_calls||m.function_call||m.reasoning||m.signature)fail('text_only');
 if(m.name!==undefined&&(typeof m.name!=='string'||m.name.length>128))fail('invalid_name');
 return {role:m.role,content:m.content,...(m.name?{name:m.name}:{})};
}
export function captureSegments(chat,root,settings,tagger,{latestUserText}={}){
 if(tagger.fault)fail(tagger.fault);
 if(!Array.isArray(chat)||!chat.length)fail('metadata_missing');
 if(settings.squash_system_messages)fail('system_merge_enabled');
 const leaves=flattenMessages(root);
 const leafMessages=leaves.map(m=>JSON.stringify(textMessage(m)));
 const pieces=[];let nextLeaf=0;
 for(let i=0;i<chat.length;i++){
  const sent=textMessage(chat[i]);
  const matches=nextLeaf<leaves.length&&JSON.stringify(sent)===leafMessages[nextLeaf];
  // Table/other context extensions can insert untagged messages after ST's
  // tree is built. Accept only insertions while preserving every tree leaf
  // unchanged and in order. Changed/deleted/merged originals still fail.
  if(!matches&&sent.content.includes(tagger.prefix))fail('metadata_mismatch');
  const source=matches?(leaves[nextLeaf++].identifier||'context'):'extension-context';
  const fallback={source,placement:presetSource(source,settings)?'inline':'file'};
  tagger.split(sent.content,fallback).forEach((piece,part)=>pieces.push({message:i,part,role:sent.role,...(sent.name?{name:sent.name}:{}),...piece}));
 }
 if(nextLeaf!==leaves.length)fail('metadata_mismatch');
 // Promote a current user message only on an exact match. A depth-0 World Info
 // user injection must never be mistaken for the actual user's latest message.
 if(typeof latestUserText==='string'&&latestUserText){
  for(let i=chat.length-1;i>=0;i--){
   const group=pieces.filter(p=>p.message===i);
   if(group.length===1&&group[0].role==='user'&&/^chatHistory-\d+$/.test(group[0].source)&&group[0].text===latestUserText){group[0].placement='inline';group[0].source='currentUser';break;}
  }
 }
 if(pieces.length>MAX_SEGMENTS)fail('too_many_segments');
 return pieces;
}

export function encodeEnvelope(segments,generationType='normal',inlineTokens=null){
 return {role:'user',content:WIRE_PREFIX+JSON.stringify({version:1,generationType:generationType||'normal',segments,inlineTokens})};
}
export function errorEnvelope(code){return {role:'user',content:WIRE_PREFIX+JSON.stringify({version:1,error:code})};}
export const excludedSampling=['temperature','top_p','top_k','top_a','min_p','presence_penalty','frequency_penalty','repetition_penalty','stop','seed','logprobs','top_logprobs','logit_bias','reasoning_effort','user','verbosity'];
export function prepareOutgoing(data,snapshot,{inlineTokens=null,tokenBudget=45000}={}){
 if(data.chat_completion_source!=='custom'||!data.model?.startsWith(MODEL_PREFIX))return null;
 if(data.tools?.length||data.functions?.length||data.json_schema||data.request_images||data.n>1)fail('text_only');
 if(String(data.custom_include_body||'').trim()||String(data.custom_exclude_body||'').trim())fail('custom_body_conflict');
 if(!snapshot||snapshot.original!==JSON.stringify(data.messages))fail('metadata_changed');
 if(snapshot.error)fail(snapshot.error);
 if(!Number.isFinite(inlineTokens)||inlineTokens<0)fail('token_count_unavailable');
 if(inlineTokens>tokenBudget)fail('inline_budget_exceeded');
 return encodeEnvelope(snapshot.segments,data.type,Math.ceil(inlineTokens));
}
export function applyOutgoing(data,envelope){
 // Custom-body JSON is also valid YAML, and ST applies it after constructing
 // the OpenAI body. No server plugin or modification of ST core is required.
 data.messages=[envelope];
 data.custom_include_body=JSON.stringify({messages:[envelope]});
 data.custom_exclude_body=JSON.stringify(excludedSampling);
 data.custom_prompt_post_processing='';
}
