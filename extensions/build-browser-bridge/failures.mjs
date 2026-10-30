// Only fixed diagnostics cross the bridge. Never forward raw page errors or DOM.
export const bridgeFailures={
 identity_home_load_timeout:{status:504,message:'Google Build 账号核对主页加载超时；尚未发送生成请求，请检查浏览器网络'},
 identity_reader_unavailable:{status:503,message:'Google Build 账号核对页面未能运行读取器；请刷新页面或重新加载连接器'},
 identity_control_missing:{status:503,message:'Google Build 主页已响应，但未找到账号控件；请检查官方验证或页面提示'},
 identity_email_missing:{status:503,message:'Google Build 账号控件未提供邮箱；请确认登录和官方验证已完成'},
 identity_login_required:{status:401,message:'Google Build 账号核对跳转到登录页；请重新登录当前账号'},
 identity_page_changed:{status:409,message:'Google 账号核对页面发生变化；已停止发送'},
 identity_ambiguous:{status:409,message:'Google 账号标识不唯一；已停止发送'},
 project_not_ready:{status:503,message:'专用 Build 项目尚未就绪；尚未发送生成请求'}
};
export function bridgeFailure(code){return Object.hasOwn(bridgeFailures,code)?bridgeFailures[code]:null;}
export function identityFailure(code){return Object.assign(new Error(bridgeFailure(code)?.message||'Google 账号核对失败'),{code});}
