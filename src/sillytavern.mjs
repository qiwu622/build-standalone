import {WIRE_PREFIX,MAX_SEGMENTS} from '../extensions/build-standalone-adapter/transport.js';
import {error} from './errors.mjs';
const fail=message=>{throw error(message,400,'sillytavern_context_invalid');};
export function parseSillyTavern(messages){
 if(!Array.isArray(messages)||messages.length!==1||messages[0]?.role!=='user'||typeof messages[0]?.content!=='string'||!messages[0].content.startsWith(WIRE_PREFIX))fail('酒馆专用模型需要在安装了 Build 连接器的浏览器使用；请刷新酒馆，其他酒馆地址需在连接器中启用本站点');
 let value;try{value=JSON.parse(messages[0].content.slice(WIRE_PREFIX.length));}catch{fail('酒馆上下文封装损坏');}
 if(!value||value.version!==1)fail('不支持的酒馆适配版本');
 if(value.error)fail('酒馆适配器已阻止请求，请查看酒馆中的 Build 分流提示；未调用 Google');
 if(!['normal','regenerate','swipe','continue','quiet','impersonate'].includes(value.generationType))fail('不支持的酒馆生成类型');
 if(!Array.isArray(value.segments)||!value.segments.length||value.segments.length>MAX_SEGMENTS)fail('酒馆分段数量无效');
 let lastMessage=-1,lastPart=-1,lastRole,lastName,inlineBytes=0;
 const segments=value.segments.map(s=>{
  if(!s||!Number.isSafeInteger(s.message)||!Number.isSafeInteger(s.part)||s.message<0||s.part<0||!['system','developer','user','assistant'].includes(s.role)||!['inline','file'].includes(s.placement)||typeof s.text!=='string'||typeof s.source!=='string'||s.source.length>128)fail('酒馆分段结构无效');
  if(s.message===lastMessage){
   if(s.part!==lastPart+1)fail('酒馆分段顺序不连续');
   if(s.role!==lastRole||(s.name||'')!==lastName)fail('同一条酒馆消息的角色不一致');
  }
  else if(s.message!==lastMessage+1||s.part!==0)fail('酒馆消息顺序不连续');
  if(s.name!==undefined&&(typeof s.name!=='string'||s.name.length>128))fail('酒馆角色名称无效');
  lastMessage=s.message;lastPart=s.part;lastRole=s.role;lastName=s.name||'';
  if(s.placement==='inline')inlineBytes+=Buffer.byteLength(s.text);
  return {message:s.message,part:s.part,role:s.role,source:s.source,placement:s.placement,text:s.text,...(s.name?{name:s.name}:{})};
 });
 if(inlineBytes>1024*1024)throw error('输入框原文超过 1 MiB 安全大小限制；未移入文件或截断',413,'inline_too_large');
 if(value.inlineTokens!==null&&value.inlineTokens!==undefined&&(!Number.isSafeInteger(value.inlineTokens)||value.inlineTokens<0||value.inlineTokens>45000))throw error('酒馆估算的输入框内容超过 45000 token；未截断预设',413,'inline_too_large');
 return {segments,generationType:value.generationType,inlineTokens:value.inlineTokens??null};
}
