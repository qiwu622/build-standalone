import {getContext} from '/scripts/extensions.js';
import {oai_settings,promptManager,setOpenAIMessages} from '/scripts/openai.js';
import {MODEL_PREFIX,createTagger,hookPromptManager,captureSegments,prepareOutgoing,applyOutgoing,errorEnvelope} from './transport.js';

const key='build_standalone_adapter';
// ST 1.13.2 clones the message array in sendOpenAIRequest. Match its exact
// serialized content, not array identity. Keep only the current generation.
let pendingSnapshot=null;
const tagger=createTagger(Array.from(crypto.getRandomValues(new Uint8Array(12)),x=>x.toString(16).padStart(2,'0')).join(''));
let hooked=null,statusElement;
const context=()=>getContext();
const settings=()=>context().extensionSettings[key]??={enabled:true};
const active=()=>settings().enabled&&oai_settings.chat_completion_source==='custom'&&String(oai_settings.custom_model||'').startsWith(MODEL_PREFIX);
const messages={
 system_merge_enabled:'请关闭“合并系统消息（Squash system messages）”，重新生成后再试。',
 metadata_missing:'没有可核对的提示词来源。请使用正常聊天生成，而不是连接测试或原始提示词调用。',
 metadata_mismatch:'提示词来源与最终消息不一致，已阻止混合上传。请检查修改提示词的其他扩展。',
 metadata_changed:'提示词在来源核对后被修改，已阻止请求。请检查其他提示词扩展。',
 text_only:'目前仅支持纯文本和单次生成；请关闭工具、图片、JSON schema 与多候选回复。',
 custom_body_conflict:'请清空此连接的“自定义请求正文”和“排除正文参数”；扩展需要按请求设置它们。',
 inline_budget_exceeded:'输入框内容估算超过 45000 token。预设没有被截断或移入文件，请缩短预设。',
 token_count_unavailable:'酒馆无法完成 token 估算，已阻止请求。',
 adapter_disabled:'Build 酒馆专用模型需要启用适配扩展。',
 prompt_api_missing:'当前酒馆缺少所需 Prompt Manager 接口。',
 broken_boundary:'内容边界被修改，已阻止请求。',
 unknown_boundary:'内容来源标记已失效，请重新生成。',
};
function status(text,bad=false){if(statusElement){statusElement.textContent=text;statusElement.dataset.error=String(bad);}}
function ensureHook(){
 if(promptManager&&hooked!==promptManager){hookPromptManager(promptManager,tagger,active);hooked=promptManager;}
}
function capture(event){
 if(event.dryRun||!active())return;
 try{
  ensureHook();
  const latest=setOpenAIMessages(context().chat||[]).find(m=>m.role==='user')?.content;
  const segments=captureSegments(event.chat,promptManager?.messages,oai_settings,tagger,{latestUserText:latest});
  pendingSnapshot={original:JSON.stringify(event.chat),segments};
 }catch(e){pendingSnapshot={original:JSON.stringify(event.chat),error:messages[e.code]?e.code:'metadata_mismatch'};}
}
async function send(data){
 if(data.chat_completion_source!=='custom'||!String(data.model).startsWith(MODEL_PREFIX)){
  // A user can switch connections during prompt preparation. Remove our own
  // transient boundaries if that happens, without changing ordinary requests.
  for(const message of data.messages||[])if(typeof message.content==='string'&&message.content.includes(tagger.prefix))message.content=tagger.strip(message.content);
  pendingSnapshot=null;return;
 }
 let envelope;
 try{
  if(!settings().enabled)throw {code:'adapter_disabled'};
  const snapshot=pendingSnapshot;pendingSnapshot=null;
  const inline=snapshot?.segments?.filter(s=>s.placement==='inline').map(s=>s.text).join('\n')||'';
  // ST's tokenizer is an estimate, not Google's authoritative token counter.
  const tokens=await context().getTokenCountAsync(inline);
  envelope=prepareOutgoing(data,snapshot,{inlineTokens:tokens,tokenBudget:45000});
  const files=snapshot.segments.filter(s=>s.placement==='file'),presets=snapshot.segments.filter(s=>s.placement==='inline');
  status(`分流已完成：输入框 ${presets.length} 段 / ${inline.length} 字符（估算 ${tokens} token）；文件 ${files.length} 段 / ${files.reduce((n,s)=>n+s.text.length,0)} 字符。`);
 }catch(e){
  const code=messages[e.code]?e.code:'metadata_mismatch';envelope=errorEnvelope(code);
  const message=messages[code];status(message,true);globalThis.toastr?.error(message,'Build 酒馆适配');
 }
 // ST's event emitter catches thrown errors, so a rejection envelope is sent
 // instead of relying on throw to stop generation. The gateway rejects it
 // before selecting an account. Old gateways reject the build-st/ namespace.
 applyOutgoing(data,envelope);
}
function mount(){
 ensureHook();
 const host=document.querySelector('#extensions_settings2')||document.querySelector('#extensions_settings');
 if(!host||document.getElementById('build-standalone-adapter-settings'))return;
 const panel=document.createElement('div');panel.id='build-standalone-adapter-settings';panel.className='inline-drawer';
 panel.innerHTML='<div class="inline-drawer-toggle inline-drawer-header"><b>Build 独立版 · 酒馆分流</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><label class="checkbox_label"><input type="checkbox" data-enable>启用预设 / 背景分流</label><p>仅作用于自定义 OpenAI 连接中的 <code>build-st/</code> 模型。预设进输入框；历史、世界书和角色资料进项目文件。普通连接不变。</p><p>需关闭合并系统消息，清空此连接的自定义正文与排除正文参数。输入框估算上限 45000 token；Build 不支持的温度、Top-P、stop 等采样参数不会转发。思考强度仍由模型后缀决定。</p><p data-status role="status">等待酒馆专用模型请求；此扩展不会自行调用模型。</p></div>';
 host.append(panel);statusElement=panel.querySelector('[data-status]');
 const enabled=panel.querySelector('[data-enable]');enabled.checked=settings().enabled;
 enabled.addEventListener('change',()=>{settings().enabled=enabled.checked;context().saveSettingsDebounced();status('设置已保存。');});
}
const ctx=context();
ctx.eventSource.on(ctx.eventTypes.GENERATION_STARTED,ensureHook);
ctx.eventSource.makeLast(ctx.eventTypes.CHAT_COMPLETION_PROMPT_READY,capture);
ctx.eventSource.makeLast(ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY,send);
ctx.eventSource.on(ctx.eventTypes.APP_READY,mount);
mount();
