import {getContext} from '/scripts/extensions.js';
import {oai_settings,promptManager,setOpenAIMessages} from '/scripts/openai.js';
import {isBuildConnection,createSnapshotStore,createTagger,hookPromptManager,captureSegments,prepareOutgoing,applyOutgoing,errorEnvelope} from './transport.js?v=0.2.1';

const key='build_standalone_adapter';
// A UI token-count preparation or another request must not overwrite the
// pending chat. Keep a small, short-lived cache keyed by exact text fields.
const snapshots=createSnapshotStore();
const tagger=createTagger(Array.from(crypto.getRandomValues(new Uint8Array(12)),x=>x.toString(16).padStart(2,'0')).join(''));
let hooked=null,statusElement;
const context=()=>getContext();
const settings=()=>context().extensionSettings[key]??={enabled:true};
const active=()=>settings().enabled&&isBuildConnection({chat_completion_source:oai_settings.chat_completion_source,model:oai_settings.chat_completion_source==='openai'?oai_settings.openai_model:oai_settings.custom_model,reverse_proxy:oai_settings.reverse_proxy});
const messages={
 system_merge_enabled:'请关闭“合并系统消息（Squash system messages）”，重新生成后再试。',
 metadata_missing:'没有采集到与本次消息对应的来源记录。请先刷新酒馆后正常发送聊天；“测试连接”请使用普通 gemini 模型。',
 metadata_mismatch:'提示词来源与最终消息不一致，已阻止混合上传。请检查修改提示词的其他扩展。',
 metadata_changed:'本次发送的正文或消息顺序与来源记录不一致，已停止分流。请刷新酒馆后重试。',
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
  snapshots.put(event.chat,{segments});
 }catch(e){try{snapshots.put(event.chat,{error:messages[e.code]?e.code:'metadata_mismatch'});}catch{/* unsupported non-text request is rejected at send */}}
}
function captureFinal(data){
 // This event runs after ST has constructed the final request prompt, before
 // sendOpenAIRequest clones it. Recheck against Prompt Manager's source tree,
 // so only unchanged originals and identifiable inserted background survive.
 if(Array.isArray(data.prompt)&&active())capture({chat:data.prompt,dryRun:false});
}
async function send(data){
 if(!isBuildConnection(data)){
  // A user can switch connections during prompt preparation. Remove our own
  // transient boundaries if that happens, without changing ordinary requests.
  for(const message of data.messages||[])if(typeof message.content==='string'&&message.content.includes(tagger.prefix))message.content=tagger.strip(message.content);
  return;
 }
 let envelope;
 try{
  if(!settings().enabled)throw {code:'adapter_disabled'};
  const snapshot=snapshots.take(data.messages);
  if(!snapshot)throw {code:'metadata_missing'};
  if(snapshot.error)throw {code:snapshot.error};
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
 panel.innerHTML='<div class="inline-drawer-toggle inline-drawer-header"><b>Build 独立版 · 酒馆分流</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><label class="checkbox_label"><input type="checkbox" data-enable>启用预设 / 背景分流</label><p>版本 0.2.1。支持自定义 OpenAI 或 OpenAI＋反向代理连接中的 <code>build-st/</code> 模型。预设进输入框；历史、世界书和角色资料进项目文件。普通连接不变。</p><p>需关闭合并系统消息；使用自定义连接时需清空自定义正文与排除正文参数。输入框估算上限 45000 token；Build 不支持的温度、Top-P、stop 等采样参数不会转发。思考强度仍由模型后缀决定。</p><p data-status role="status">等待酒馆专用模型请求；此扩展不会自行调用模型。</p></div>';
 host.append(panel);statusElement=panel.querySelector('[data-status]');
 const enabled=panel.querySelector('[data-enable]');enabled.checked=settings().enabled;
 enabled.addEventListener('change',()=>{settings().enabled=enabled.checked;context().saveSettingsDebounced();status('设置已保存。');});
}
const ctx=context();
ctx.eventSource.on(ctx.eventTypes.GENERATION_STARTED,ensureHook);
ctx.eventSource.makeLast(ctx.eventTypes.CHAT_COMPLETION_PROMPT_READY,capture);
ctx.eventSource.makeLast(ctx.eventTypes.GENERATE_AFTER_DATA,captureFinal);
ctx.eventSource.makeLast(ctx.eventTypes.CHAT_COMPLETION_SETTINGS_READY,send);
ctx.eventSource.on(ctx.eventTypes.APP_READY,mount);
mount();
