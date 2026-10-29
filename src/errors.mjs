export class AppError extends Error {
  constructor(message, status=500, code='internal_error', extra={}) {
    super(message); Object.assign(this,{status,code,...extra});
  }
}
export const error = (message,status=400,code='invalid_request') => new AppError(message,status,code);
export function safeFailure(code) {
  const messages={
    content_refused:['Google 已明确拒绝本次内容；未重试或更换账号',422],
    context_cleanup_failed:['Build 上下文文件清理或取消未完成；请在独立项目中处理后重试',502],
    account_mismatch:['浏览器登录身份与所选账号不一致；已停止发送',409]
  };
  const [message,status]=messages[code]||['Build 执行失败',502];
  return new AppError(message,status,code,{rotationReason:code});
}
export function isContentRefusal(value) {
  const text=String(value).trimStart().slice(0,1600);
  return /^(?:I (?:cannot|can't|am unable to)|I'm (?:sorry|unable to)|Sorry[,，]|抱歉|对不起|我(?:无法|不能))/i.test(text)
    && /safety polic|content polic|sexually explicit|adult erotica|安全政策|内容政策|露骨.{0,8}(?:色情|性内容)/i.test(text);
}
export function checkAbort(signal) { if(signal?.aborted) throw signal.reason || error('请求已取消',499,'cancelled'); }
