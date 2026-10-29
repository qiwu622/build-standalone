// Direct Build executor. Adapted from the user's Build business module.
import {makeFileContext,unwrapFileReply,fileContextThreshold} from './build-file-context.mjs';
import {buildModels,resolveBuildModel,configureBuildThinking,readBuildThinking} from './build-thinking.mjs';
import {AppError,isContentRefusal, safeFailure} from './errors.mjs';
import {identityExpression} from '../extensions/build-browser-bridge/protocol.mjs';
export {buildModels} from './build-thinking.mjs';

const failure = (message, status = 502) => new AppError(message,status,'build_execution_failed');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const composerSelector = placeholder => `:is(textarea,[contenteditable="true"],[contenteditable="plaintext-only"])[placeholder=${JSON.stringify(placeholder)}]`;
export function googleErrorSummary(raw) {
    const clean=String(raw).trim().replace(/^\)\]\}'\s*/,'');
    let value;try{value=JSON.parse(clean);}catch{
        value=clean.split('\n').map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(Boolean);
    }
    let error=value?.error;
    if(!error){
        const messages=[],codes=[];
        const walk=(v,depth=0)=>{if(depth>8)return;if(Array.isArray(v)){if(typeof v[0]==='number'&&typeof v[1]==='string'&&v[1].length<2000){codes.push(v[0]);messages.push(v[1]);}v.forEach(x=>walk(x,depth+1));}else if(typeof v==='string'&&/permission|denied|access|project|subscription|authentication|quota|service.disabled/i.test(v)&&v.length<2000)messages.push(v);};walk(value);
        if(!messages.length)return null;
        error={...(codes.length?{code:codes[0]}:{}),message:[...new Set(messages)].slice(0,4).join('; ')};
    }
    if(typeof error!=='object')return null;
    const pick=(object,keys)=>Object.fromEntries(keys.filter(k=>['string','number'].includes(typeof object?.[k])).map(k=>[k,typeof object[k]==='string'?object[k].slice(0,2000):object[k]]));
    return {...pick(error,['code','status','message']),details:(Array.isArray(error.details)?error.details:[]).slice(0,8).map(detail=>({...pick(detail,['reason','domain']),...pick(detail?.metadata,['service','consumer','permission'])}))};
}
export function isBuildURL(value) {
    try { const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&(!u.port||u.port==='443')&&['aistudio.google.com','ai.studio'].includes(u.hostname)&&/^\/(?:u\/\d+\/)?apps(?:\/|$)/.test(u.pathname); }catch{return false;}
}
export function buildAppForAccount(value,authUser='0') {
    if(!isBuildURL(value))return null;
    const url=new URL(value),pathUser=/^\/u\/(\d+)\//.exec(url.pathname)?.[1],queryUser=url.searchParams.get('authuser');
    if((pathUser!==undefined&&pathUser!==authUser)||(queryUser!==null&&queryUser!==authUser))return null;
    if(!/\/apps\/[a-z0-9-]+$/i.test(url.pathname))return null;
    url.search='';url.hash='';url.searchParams.set('authuser',authUser);return url.href;
}

export function buildInput(body) {
    if(body.sillytavern)return {system:'',messages:[],sillytavern:body.sillytavern,...(body.generationConfig?.maxOutputTokens?{requestedMaxOutputTokens:body.generationConfig.maxOutputTokens}:{})};
    if (!Array.isArray(body.contents) || !body.contents.length) throw failure('contents 不能为空', 400);
    if (body.tools?.length || body.toolConfig) throw failure('Build 订阅聊天暂不支持 API 工具调用', 400);
    const text = parts => (parts || []).map(p => {
        if (typeof p.text !== 'string' || Object.keys(p).some(k => !['text'].includes(k))) throw failure('Build 订阅聊天当前仅支持文本', 400);
        return p.text;
    }).join('\n');
    const transcript = body.contents.map(m => ({ role: m.role || 'user', content: text(m.parts) }));
    const system = text(body.systemInstruction?.parts);
    const config = body.generationConfig || {};
    if (config.responseMimeType || config.responseJsonSchema || config.responseSchema) throw failure('Build 订阅聊天暂不支持强制 JSON 输出格式', 400);
    return { system, messages: transcript, ...(config.maxOutputTokens ? { requestedMaxOutputTokens: config.maxOutputTokens } : {}) };
}
export function buildPrompt(body) {
    if(body.sillytavern)return body.sillytavern.segments.filter(s=>s.placement==='inline').map(s=>s.text).join('');
    return 'You are responding in a private text-only chat. Do not create, edit, delete, or deploy project files. Do not invoke tools. Answer the final user message using the conversation below. Output only the answer, without a wrapper or commentary about these instructions.\n'
        + JSON.stringify(buildInput(body));
}

// These selectors were inspected in the authenticated Build UI on 2026-10-28.
export const snapshotScript = `(() => {
    const responses = [...document.querySelectorAll('ms-console-assistant-response')];
    const response = responses.at(-1);
    const running = !!document.querySelector('button[aria-label="Send"].running');
    // Build renders the growing answer on the page's main thread. Read only
    // control state until generation stops; the existing settle check still
    // reads the complete Markdown before returning a successful response.
    const bubbles = response && !running ? [...response.querySelectorAll('ms-console-turn > .bubble')] : [];
    const md = node => {
        if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
        if (node.nodeType !== Node.ELEMENT_NODE || node.getAttribute('aria-hidden') === 'true') return '';
        const tag = node.tagName.toLowerCase();
        if (tag === 'pre') return '\\n\\n' + '\u0060\u0060\u0060' + '\\n' + node.textContent + '\\n' + '\u0060\u0060\u0060' + '\\n\\n';
        const value = [...node.childNodes].map(md).join('');
        if (tag === 'code') return '\u0060' + value + '\u0060';
        if (tag === 'br') return '\\n';
        if (/^h[1-6]$/.test(tag)) return '\\n\\n' + '#'.repeat(Number(tag[1])) + ' ' + value + '\\n\\n';
        if (tag === 'p' || tag === 'div') return value + '\\n\\n';
        if (tag === 'strong' || tag === 'b') return '**' + value + '**';
        if (tag === 'em' || tag === 'i') return '*' + value + '*';
        if (tag === 'li') return '- ' + value.trim() + '\\n';
        if (tag === 'a') return '[' + value + '](' + node.href + ')';
        return value;
    };
    const header = response?.parentElement?.querySelector('.turn-header')?.innerText || '';
    const send = document.querySelector('button[aria-label="Send"]');
    const error = [...document.querySelectorAll('[role="alert"], [role="alertdialog"], .error-message, .error-container, ms-console-assistant-response [class*="error"]')].map(e=>e.innerText).filter(Boolean).join(' ').slice(0,16000);
    return { count: responses.length, text: bubbles.map(md).join('\\n\\n').trim(), running, header, error,
        ready: !!document.querySelector(${JSON.stringify(composerSelector('Make changes, add new features, ask for anything'))}),
        initializing: !!document.querySelector(${JSON.stringify(composerSelector('Describe an app and let Gemini do the rest'))}),
        canSend: !!send && !send.disabled && send.getAttribute('aria-disabled') !== 'true',
        hasPlan: ${identityExpression}.hasPlan,
        url: location.href.split('?')[0] };
})()`;

export class BuildChatWorker {
    constructor({ cdp, diagnostics, pool, responseSettleMs=1500, pollInterval=1000, contextTransport, contextThreshold=fileContextThreshold }) {
        this.cdp = cdp; this.current = null;
        this.pool=pool;
        this.responseSettleMs=responseSettleMs;this.pollInterval=pollInterval;

        this.diagnostics=diagnostics;
        this.contextTransport=contextTransport||null;
        this.contextThreshold=contextThreshold;
    }
    async log(event,extra={},request=this.current){
        try{await this.diagnostics?.record({event,requestId:request?.headers?.['x-gemini-request-id']||request?.request_id,transportRequestId:request?.request_id,model:request?.model,accountId:this.accountId,stage:request?.stage,...extra});}catch{console.error('Build diagnostics write failed');}
    }
    aborted(request){if(request?.aborted)throw failure(request.abortReason||'客户端已断开',request.abortStatus||499);}
    async session() { return 'page'; }
    async evaluate(send, sessionId, expression) {
        const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
        if (r.exceptionDetails) throw failure('Build 页面操作失败');
        return r.result?.value;
    }
    async context(send,sid,phase,request) {
        const page=await this.evaluate(send,sid,identityExpression);
        const expected=this.pool?.roster.find(a=>a.id===this.accountId);
        if(!page?.email || !expected?.email || page.email.toLowerCase()!==expected.email.toLowerCase() || page.authUser!==(expected.auth_user||'0'))throw safeFailure('account_mismatch');
        await this.log('account_context',{reason:JSON.stringify({phase,path:page?.path,authUser:page?.authUser,expectedAuthUser:expected?.auth_user,identityMatches:page?.email&&expected?.email?page.email.toLowerCase()===expected.email.toLowerCase():null})},request);
    }
    async wait(send, sid, predicate, timeout = 12000) {
        const until = Date.now() + timeout;
        do {
            this.aborted(this.current);
            const state = await this.evaluate(send, sid, snapshotScript);
            if (predicate(state)) return state;
            await sleep(350);
        } while (Date.now() < until);
        throw failure('Build 页面操作超时', 504);
    }
    async click(send, sid, label) {
        if(label==='Send') {
            const point=await this.evaluate(send,sid,`(() => { const button=document.querySelector('button[aria-label="Send"]');if(!button||button.disabled||button.getAttribute('aria-disabled')==='true')return null;button.scrollIntoView({block:'nearest'});const r=button.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null; })()`);
            if(!point)throw failure('Build 发送按钮未就绪',503);
            await send('Input.dispatchMouseEvent',{type:'mousePressed',x:point.x,y:point.y,button:'left',buttons:1,clickCount:1},sid);
            await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:point.x,y:point.y,button:'left',buttons:0,clickCount:1},sid);
            return;
        }
        const labels=({'设置':['设置','Settings'],'关闭面板':['关闭面板','Close panel']})[label]||[label];
        for(let attempt=0;attempt<20;attempt++) {
            this.aborted(this.current);
            const ok = await this.evaluate(send, sid, `(() => { const labels=${JSON.stringify(labels)}; const el = [...document.querySelectorAll('button,[role="menuitem"],[role="option"],[role="combobox"]')].find(e => labels.includes(e.getAttribute('aria-label')) || labels.includes(e.innerText.trim())); if(!el || el.disabled || el.getAttribute('aria-disabled')==='true')return false;el.click();return true; })()`);
            if(ok)return;
            await sleep(200);
        }
        throw failure('Build 页面缺少操作控件：' + label);
    }
    async fillAndSend(send, sid, prompt, initialize = false, request) {
        const filled = await this.evaluate(send, sid, `(() => {
            const field = document.querySelector(${JSON.stringify(composerSelector(initialize ? 'Describe an app and let Gemini do the rest' : 'Make changes, add new features, ask for anything'))});
            if(!field)return false;
            field.focus();
            if(field.tagName==='TEXTAREA') {
                field.select();
            } else {
                const range=document.createRange();range.selectNodeContents(field);
                const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
            }
            return true;
        })()`);
        if (!filled) throw failure('Build 聊天输入框未就绪', 503);
        await send('Input.insertText',{text:prompt},sid);
        await this.wait(send, sid, s => s.canSend && !s.running);
        this.aborted(request);
        await this.click(send, sid, 'Send');
    }
    async generateOne(model, body, request, chunk) {
        const resolved=resolveBuildModel(model);
        request.thinkingLevel=resolved.thinkingLevel;
        request.upstreamModel=resolved.model;
        request.googleThinkingLevel=null;
        let prompt = buildPrompt(body);
        if(body.sillytavern&&!this.contextTransport)throw failure('酒馆分流需要项目文件传输器');
        const context=this.contextTransport&&(body.sillytavern||Buffer.byteLength(prompt)>=this.contextThreshold)?makeFileContext(buildInput(body)):null;
        if(context)prompt=context.prompt;
        request.contextMode=body.sillytavern?'sillytavern_split':context?'project_files':'inline';
        return this.cdp(async send => {
            request.stage='browser_session';this.aborted(request);
            const sid = await this.session(send);
            const faults=[],rpcIds=new Set();let thinkingMismatch=false,wireAccountMismatch=false;
            try {
            send.onEvent?.(event=>{
                if(event.sessionId!==sid)return;
                if(event.method==='Inspector.targetCrashed'){request.aborted=true;request.abortStatus=503;request.abortReason='Build 浏览器页面崩溃';void this.log('browser_target_crashed',{},request);}
                if(event.method==='Network.requestWillBeSent'&&/\/CodeAssistantOffline(?:[/?]|$)/.test(event.params.request?.url||'')){
                    rpcIds.add(event.params.requestId);
                    const rpc=event.params.request;const header=name=>Object.entries(rpc.headers||{}).find(([key])=>key.toLowerCase()===name.toLowerCase())?.[1];
                    const wireUser=header('x-goog-authuser')??new URL(rpc.url).searchParams.get('authuser');
                    if(wireUser!==null&&wireUser!==undefined&&String(wireUser)!==(this.pool?.roster.find(a=>a.id===this.accountId)?.auth_user||'0'))wireAccountMismatch=true;
                    let model=null,appId=null;try{const data=JSON.parse(rpc.postData);if(typeof data[7]==='string'&&/^models\/gemini-[\w.-]+$/.test(data[7]))model=data[7];if(typeof data[11]==='string'&&/^[a-f0-9-]{36}$/i.test(data[11]))appId=data[11];}catch{/* preflight or non-JSPB request */}
                    if(rpc.method==='POST'){
                        request.googleThinkingLevel=readBuildThinking(rpc.postData);
                        thinkingMismatch ||= request.googleThinkingLevel!==resolved.thinkingLevel || model!=='models/'+resolved.model;
                        request.googleModel=model;
                    }
                    void this.log('google_request_context',{reason:JSON.stringify({method:rpc.method,authUser:header('x-goog-authuser')??null,planTier:header('X-AIStudio-G1-Tier')??null,urlAuthUser:new URL(rpc.url).searchParams.get('authuser'),model,appId,requestedThinkingLevel:resolved.thinkingLevel,googleThinkingLevel:request.googleThinkingLevel})},request);
                }
                if(event.method==='Network.loadingFailed'&&rpcIds.has(event.params.requestId))void this.log('google_network_failed',{error:new Error(event.params.errorText||'Network loading failed')},request);
                if(event.method==='Network.responseReceived' && event.params.response.url.includes('/CodeAssistantOffline') && event.params.response.status>=400){
                    faults.push(event.params.response.status);
                    const retry=Object.entries(event.params.response.headers||{}).find(([k])=>k.toLowerCase()==='retry-after')?.[1];
                    if(retry){const seconds=Number(retry);request.retryAfterSeconds=Number.isFinite(seconds)?seconds:Math.max(1,Math.ceil((Date.parse(retry)-Date.now())/1000));}
                    void this.log('google_http_error',{status:event.params.response.status},request);
                }
            });
            await send('Network.enable',{},sid);
            request.stage='wait_ready';await this.log('request_stage',{},request);let state = await this.wait(send, sid, s=>s.ready,45000);
            // Offline Build tasks can outlive a browser restart. Cancel only the
            // dedicated proxy app's orphaned task before starting a fresh chat.
            if(state.running) {
                await this.evaluate(send,sid,`document.querySelector('button[aria-label="Send"].running')?.click()`);
                state=await this.wait(send,sid,s=>s.ready&&!s.running,15000);
            }
            await this.context(send,sid,'before_file_operations',request);
            if(this.contextTransport){
                request.stage='context_cleanup';
                const cleared=await this.contextTransport.clear(send,sid);
                if(cleared)await this.log('context_recovered',{reason:JSON.stringify({files:cleared})},request);
                if(context){
                    request.stage='context_upload';await this.log('request_stage',{},request);
                    const uploadStarted=Date.now();await this.contextTransport.upload(send,sid,context);
                    request.contextUploadMs=Date.now()-uploadStarted;
                    await this.log('context_uploaded',{durationMs:request.contextUploadMs,reason:JSON.stringify({mode:'project_files',bytes:context.bytes,lines:context.lines,files:context.files.map(f=>f.name)})},request);
                }
            }
            // Start AFTER saving the files so earlier requests and edit checkpoints
            // cannot become conversational history for this request.
            await this.context(send,sid,'before_new_chat',request);
            request.stage='new_chat';await this.click(send, sid, 'New chat');
            await this.click(send, sid, 'Start new chat');
            await this.wait(send, sid, s => s.ready && s.count === 0);
            await this.context(send,sid,'after_new_chat',request);
            // Select the real UI model and leave the Usage setting on the Google AI plan.
            request.stage='subscription_and_model';await this.click(send, sid, '设置');
            const usesPlan = await this.evaluate(send, sid, `/using your Google AI subscription for requests in chat/.test(document.body.innerText)`);
            if (!usesPlan) {
                await this.click(send, sid, '关闭面板');
                throw Object.assign(failure('Build 当前没有使用 Google AI 订阅，已阻止请求以避免转入 API 计费',403),{rotationReason:'subscription_required'});
            }
            await this.click(send, sid, 'Select the model for chat');
            await this.click(send, sid, resolved.displayName === 'Gemini 4 Argon' ? 'Gemini 4 Argon, Paid' : resolved.displayName);
            // Selecting a model resets Google's thinking setting to high, so
            // the requested level must be applied AFTER selecting the model.
            request.stage='thinking_level';
            await this.configureThinking(send,sid,resolved.thinkingLevel);
            await this.log('thinking_configured',{reason:JSON.stringify({model:resolved.model,thinkingLevel:resolved.thinkingLevel})},request);
            await this.click(send, sid, '关闭面板');
            request.stage='send_prompt';await this.log('request_stage',{},request);const responseStarted=Date.now();await this.fillAndSend(send, sid, prompt, false, request);
            request.stage='wait_response';await this.log('request_stage',{},request);
            let observed = false, settledText, settledHeader, settledAt=0;
            const until = Date.now() + (context?300000:150000);
                while (Date.now() < until) {
                    this.aborted(request);
                    if(wireAccountMismatch)throw safeFailure('account_mismatch');
                    if(thinkingMismatch)throw Object.assign(failure('Google 实际请求的思考档位与指定档位不符'),{rotationReason:'thinking_configuration_failed'});
                    if(faults.includes(429))throw Object.assign(failure('Google Build 额度或请求频率限制',429),{quotaExceeded:true,retryAfterSeconds:request.retryAfterSeconds});
                    if(faults.includes(401))throw Object.assign(failure('Google 登录已失效',401),{rotationReason:'login_required'});
                    const next = await this.evaluate(send, sid, snapshotScript);
                    if (next.count > 0 || next.running) observed = true;
                    if (next.error) {
                        const status=/quota|rate.limit|resource.exhausted|限额|配额|额度.{0,12}(?:耗尽|用尽|上限)/i.test(next.error)||faults.includes(429)?429:faults.at(-1)||502;
                        if(isContentRefusal(next.error))throw safeFailure('content_refused');
                        const error=failure('Google Build 返回调用错误',status);
                        error.quotaExceeded=status===429;
                        error.retryAfterSeconds=request.retryAfterSeconds;
                        if(status===403&&/permission denied|does not have permission|权限不足|没有权限|权限遭拒|权限被拒|无权访问/i.test(next.error))error.rotationReason='model_permission_denied';
                        throw error;
                    }
                    if (observed && !next.running && next.count > 0) {
                        // Google clears the running flag before the final Markdown
                        // render. Require a quiet DOM interval before reading the answer.
                        if(next.text!==settledText || next.header!==settledHeader || !settledAt) {
                            settledText=next.text;settledHeader=next.header;settledAt=Date.now();
                        } else if(Date.now()-settledAt>=this.responseSettleMs) {
                            if (!next.text) throw failure('Build 未返回文本；请检查 Google 登录或额度',faults.at(-1)||502);
                            if (!next.header.includes(resolved.displayName)) throw failure('Build 返回的模型与请求不符');
                            this.verifyThinking(request);
                            if(isContentRefusal(next.text))throw safeFailure('content_refused');
                            const answer=context?unwrapFileReply(next.text,context):next.text;
                            request.responseMs=Date.now()-responseStarted;
                            if(context)await this.log('context_reply_verified',{durationMs:request.responseMs,reason:'current_request_file_end_markers_matched'},request);
                            chunk?.(answer);
                            return answer;
                        }
                    } else {settledAt=0;settledText=undefined;settledHeader=undefined;}
                    await sleep(this.pollInterval);
                }
                throw failure('Build 订阅聊天响应超时', 504);
            } finally {
                let stoppedCleanly=true;
                try{await this.stopGeneration(send,sid);}catch(error){stoppedCleanly=false;await this.log('context_cancel_unsettled',{error},request);}
                if(!stoppedCleanly)throw safeFailure('context_cleanup_failed');
                if(context?.uploadStarted&&stoppedCleanly){
                    const cleanupStarted=Date.now();
                    try{
                        const removed=await this.contextTransport.clear(send,sid,{cancel:false,allowDirty:true});
                        request.contextCleanupMs=Date.now()-cleanupStarted;
                        await this.log('context_cleared',{durationMs:request.contextCleanupMs,reason:JSON.stringify({files:removed})},request);
                    }catch(error){await this.log('context_cleanup_failed',{error,durationMs:Date.now()-cleanupStarted},request);throw safeFailure('context_cleanup_failed');}
                }

            }
        });
    }
    configureThinking(send,sid,level){return configureBuildThinking(this,send,sid,level);}
    verifyThinking(request){
        if(request.googleThinkingLevel!==request.thinkingLevel || request.googleModel!=='models/'+request.upstreamModel)throw Object.assign(failure('未能核对 Google 实际收到的思考档位'),{rotationReason:'thinking_configuration_failed'});
    }
    async stopGeneration(send,sid) {
        const stopped=await this.evaluate(send,sid,`(() => {const b=document.querySelector('button[aria-label="Send"].running');if(!b)return false;b.click();return true;})()`);
        if(!stopped)return;
        // Cancel triggers an asynchronous snapshot restore, which can bring
        // deleted context files back. Wait for it before starting cleanup.
        let stableAt=0;const until=Date.now()+15000;
        while(Date.now()<until){
            const state=await this.evaluate(send,sid,snapshotScript);
            if(!state?.ready||state.running)stableAt=0;
            else {stableAt ||= Date.now();if(Date.now()-stableAt>=2000)return;}
            await sleep(250);
        }
        throw failure('Build 取消任务后页面仍未稳定',504);
    }
}
