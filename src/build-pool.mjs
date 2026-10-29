// Persistent, model-specific account failover. This records observed availability,
// not an invented Google subscription balance.
const fail = (message,status,extra={}) => Object.assign(new Error(message),{status,...extra});
const descriptions={permission_denied:'此模型权限被拒绝',app_unavailable:'Build 项目尚未就绪',login_required:'需要重新登录',subscription_required:'需要有效 Google AI 订阅',quota_exhausted:'观察到额度限制',rate_limited:'观察到请求频率限制'};
function safeErrorSummary(error,classification){
    const status=Number.isInteger(error.status)&&error.status>=400&&error.status<=599?error.status:502;
    const detail=descriptions[classification?.kind]||({422:'上游内容安全拒绝',499:'请求已取消',504:'请求超时',409:'账号或页面状态不匹配'}[status])||'Build 调用失败';
    return detail+' (HTTP '+status+')';
}
export function classifyBuildFailure(error, now=Date.now()) {
    if(['content_refused','account_mismatch','context_cleanup_failed'].includes(error.code)||error.rotationReason==='content_refused')return null;
    const message=String(error.message||'');
    if (error.rotationReason==='model_permission_denied') return {kind:'permission_denied',until:now+5*60000,resetKnown:false};
    if (error.rotationReason==='app_unavailable') return {kind:'app_unavailable',until:now+60000,resetKnown:false};
    if (error.rotationReason === 'login_required' || error.status===401) return {kind:'login_required'};
    if (error.rotationReason === 'subscription_required' || (error.status===403 && /subscription|订阅/i.test(message))) return {kind:'subscription_required'};
    if (error.status!==429 && !error.quotaExceeded) return null;
    const isQuota=error.quotaExceeded||/quota|resource.exhausted|daily|额度|配额|用尽|耗尽|每日/i.test(message);
    const retry=/retry (?:again )?(?:in|after)\s+([\d.]+)\s*(second|minute|hour|秒|分钟|小时)/i.exec(message);
    let delay=Number(error.retryAfterSeconds)*1000;
    if(!Number.isFinite(delay)||delay<=0) delay=retry?Number(retry[1])*({second:1000,minute:60000,hour:3600000,'秒':1000,'分钟':60000,'小时':3600000}[retry[2].toLowerCase()]):isQuota?3600000:60000;
    // Unknown limits are checked again after a conservative cooldown. This is not
    // presented as Google's actual daily reset time.
    const until=Number(error.retryAt)>now?Number(error.retryAt):now+Math.max(1000,Math.min(delay,7*86400000));
    return {kind:isQuota?'quota_exhausted':'rate_limited',until,resetKnown:Number(error.retryAt)>now || !!retry || Number(error.retryAfterSeconds)>0};
}

export class BuildAccountPool {
    constructor({state={},save=async()=>{},now=Date.now}={}) {
        this.state=state;this.save=save;this.now=now;this.roster=[];
        state.accounts ||= {};state.activeByModel ||= {};
    }
    async sync(accounts) {
        const seen=new Set();
        this.roster=accounts.filter(a=>{
            const identity=(a.email||a.id).toLowerCase();
            if(seen.has(identity))return false;seen.add(identity);return true;
        });
        for(const a of this.roster) {
            this.state.accounts[a.id] ||= {models:{}};
            Object.assign(this.state.accounts[a.id],{id:a.id,email:a.email||null,name:a.name,authUser:a.auth_user||'0'});
        }
        for(const id of Object.keys(this.state.accounts)) if(!this.roster.some(a=>a.id===id))delete this.state.accounts[id];
        await this.save();
    }
    async imported(id) {
        const a=this.state.accounts[id];
        if(a){delete a.blocked;delete a.blockedReason;}
        for(const model of Object.values(a?.models||{}))if(['permission_denied','app_unavailable'].includes(model.cooldownReason)){
            delete model.cooldownUntil;delete model.cooldownReason;delete model.resetKnown;
        }
        // Signing in again fixes authentication; it does not reset Google quota.
        await this.save();
    }
    modelState(id,model) {return this.state.accounts[id].models[model] ||= {successes:0,attempts:0,quotaFailures:0};}
    eligible(a,model) {const s=this.state.accounts[a.id];return a.enabled!==false && !s.blocked && !(s.models[model]?.cooldownUntil>this.now());}
    async prefer(id,model='gemini-4-argon') {
        if(!['gemini-4-argon','gemini-3.8-flash'].includes(model))throw fail('不支持的 Build 模型',400);
        const account=this.roster.find(a=>a.id===id);
        if(!account)throw fail('账号不在 Build 账号池中',404);
        if(!this.eligible(account,model))throw fail('该账号当前需重新登录或正在冷却，不能设为优先账号',409);
        const previous=this.state.activeByModel[model];this.state.activeByModel[model]=id;
        this.state.lastSwitch={from:previous||null,to:id,model,at:new Date(this.now()).toISOString(),reason:'manual_preference'};
        await this.save();return this.snapshot();
    }
    async run(model,request,attempt) {
        if(!this.roster.length)throw fail('Build 账号池为空，请在管理页导入 Google 账号',503);
        const tried=new Set(), failures=[];
        const deadline=this.now()+540000;
        while(tried.size<this.roster.length) {
            if(request.aborted)throw fail(request.abortReason||'客户端已断开',request.abortStatus||499);
            if(this.now()>deadline)throw fail('Build 账号轮换超时，请稍后重试',504);
            const active=this.state.activeByModel[model];
            const start=Math.max(0,this.roster.findIndex(a=>a.id===active));
            const ordered=[...this.roster.slice(start),...this.roster.slice(0,start)];
            const account=ordered.find(a=>!tried.has(a.id)&&this.eligible(a,model));
            if(!account)break;
            tried.add(account.id);
            const previous=this.state.activeByModel[model];
            this.state.activeByModel[model]=account.id;
            if(previous!==account.id)this.state.lastSwitch={from:previous||null,to:account.id,model,at:new Date(this.now()).toISOString(),reason:failures.at(-1)?.kind||'available_account'};
            const s=this.modelState(account.id,model);s.attempts++;s.lastAttemptAt=new Date(this.now()).toISOString();
            await this.save();
            try {
                const value=await attempt(account);
                s.successes++;s.lastSuccessAt=new Date(this.now()).toISOString();s.lastError=null;
                delete s.cooldownUntil;delete s.cooldownReason;delete s.resetKnown;
                await this.save();return value;
            }catch(error) {
                const classification=classifyBuildFailure(error,this.now());
                s.lastError=safeErrorSummary(error,classification);s.lastFailureAt=new Date(this.now()).toISOString();
                if(!classification){await this.save();throw error;}
                failures.push(classification);
                if(classification.until) {
                    if(['quota_exhausted','rate_limited'].includes(classification.kind))s.quotaFailures++;
                    s.cooldownUntil=classification.until;s.cooldownReason=classification.kind;s.resetKnown=classification.resetKnown;
                }else {this.state.accounts[account.id].blocked=classification.kind;this.state.accounts[account.id].blockedReason=s.lastError;}
                await this.save();
            }
        }
        const available=this.roster.filter(a=>a.enabled!==false&&!this.state.accounts[a.id].blocked);
        const next=available.map(a=>this.state.accounts[a.id].models[model]?.cooldownUntil).filter(t=>t>this.now());
        if(!available.length)throw fail('Build 账号池没有已登录且可用的订阅账号，请重新导入账号',503);
        if(available.every(a=>{const m=this.state.accounts[a.id].models[model];return m?.cooldownReason==='permission_denied'&&m.cooldownUntil>this.now();}))throw fail('Build 账号池当前账号均没有此模型的调用权限；请检查订阅、账号权限或重新导入账号',403);
        if(available.some(a=>{const m=this.state.accounts[a.id].models[model];return m?.cooldownReason==='app_unavailable'&&m.cooldownUntil>this.now();}))throw fail('Build 可用账号的应用尚未就绪或模型权限不足，请检查账号接入状态后重试',503);
        const retryAt=next.length?Math.min(...next):this.now()+60000;
        throw fail('Build 账号池的可用账号均已限额，冷却后自动重试；也可以继续导入账号',429,{retryAt,retryAfterSeconds:Math.max(1,Math.ceil((retryAt-this.now())/1000))});
    }
    snapshot() {
        return {mode:'quota_failover',activeByModel:{...this.state.activeByModel},lastSwitch:this.state.lastSwitch||null,
            quotaNote:'Google 未提供 Build 订阅剩余次数；显示实际调用状态、冷却及本地成功次数。冷却结束不是已确认的额度重置。',
            accounts:this.roster.map(a=>{
                const s=this.state.accounts[a.id];
                return {id:a.id,name:a.name,email:a.email,authUser:a.auth_user||'0',blocked:s.blocked||null,reason:s.blockedReason||null,
                    quotaCheckedAt:s.quota?.checkedAt||null,quotaSource:s.quota?.source||null,
                    models:Object.fromEntries(['gemini-4-argon','gemini-3.8-flash'].map(model=>{
                        const m=s.models[model]||{};
                        return [model,{status:s.blocked||(m.cooldownUntil>this.now()?({permission_denied:'permission_required',app_unavailable:'connection_required'}[m.cooldownReason]||'cooling'):m.lastSuccessAt?'available':'unverified'),remaining:null,limit:null,quotaNote:s.quota?.models?.[model]?.note||'剩余次数尚未获取',
                            successes:m.successes||0,quotaFailures:m.quotaFailures||0,lastSuccessAt:m.lastSuccessAt||null,lastError:m.lastError||null,
                            retryAt:m.cooldownUntil>this.now()?new Date(m.cooldownUntil).toISOString():null,resetKnown:m.resetKnown||false}];
                    }))};
            })};
    }
}
