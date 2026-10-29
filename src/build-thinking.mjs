// AI Studio Build's own Thinking level selector, inspected 2026-10-29.
// Default / Plan / Max is a different setting and must not be used here.
export const buildBaseModels = [
    ['gemini-4-argon', 'Gemini 4 Argon'],
    ['gemini-3.8-flash', 'Gemini 3.8 Flash'],
];
export const buildThinkingLevels = ['low', 'medium', 'high'];
export const buildModels = buildBaseModels.flatMap(([id, name]) => [
    [id, name], ...buildThinkingLevels.map(level => [`${id}-${level}`, `${name} (${level})`]),
]);
const failure = message => Object.assign(new Error(message), {status: 502, rotationReason: 'thinking_configuration_failed'});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function resolveBuildModel(id) {
    for (const [model, displayName] of buildBaseModels) {
        // Build's existing UI default is high. Reset it for every request so a
        // preceding -low request cannot silently change an unsuffixed request.
        if (id === model) return {model, displayName, thinkingLevel: 'high'};
        for (const thinkingLevel of buildThinkingLevels) {
            if (id === `${model}-${thinkingLevel}`) return {model, displayName, thinkingLevel};
        }
    }
    throw Object.assign(new Error('Build 订阅聊天未开放此模型或思考档位'), {status: 404});
}

export function readBuildThinking(postData) {
    // Observed CodeAssistantOffline request field 19 = ThinkingConfig;
    // ThinkingConfig field 4: low=1, medium=2, high=3, minimal=4.
    // Read only this known metadata field, never prompt/tool content.
    try {
        const data = JSON.parse(postData);
        if (!Array.isArray(data) || !Array.isArray(data[18])) return null;
        return ({1:'low', 2:'medium', 3:'high', 4:'minimal'})[data[18][3]] || null;
    } catch { return null; }
}

export const thinkingSelectorState = `(() => {
    const el = document.querySelector('[aria-label="Select a thinking level"]');
    return el && el.checkVisibility() ? {text:el.innerText.trim(), disabled:el.getAttribute('aria-disabled')==='true'} : null;
})()`;

export async function configureBuildThinking(worker, send, sid, level) {
    if (!buildThinkingLevels.includes(level)) throw failure('不支持此 Build 思考档位');
    let state = await worker.evaluate(send, sid, thinkingSelectorState);
    if (!state) {
        // This is Google's built-in, seven-click UI preference, not a paid
        // capability override. Do not inject flags, local storage, or RPCs.
        const opened = await worker.evaluate(send, sid, `(() => {
            const title = [...document.querySelectorAll('[msdevmodetrigger]')].find(e=>e.checkVisibility());
            if(!title)return false;
            for(let i=0;i<7;i++)title.click();
            return true;
        })()`);
        if (!opened) throw failure('Build 未找到原生思考设置入口，已停止发送');
        const until = Date.now()+5000;
        do {
            worker.aborted(worker.current);
            state = await worker.evaluate(send, sid, thinkingSelectorState);
            if(state)break;
            await sleep(100);
        } while(Date.now()<until);
    }
    if (!state || state.disabled) throw failure('此 Build 模型未开放原生思考档位，已停止发送');
    const label = level === 'high' ? 'High (recommended)' : level[0].toUpperCase()+level.slice(1);
    if (state.text !== label) {
        await worker.click(send, sid, 'Select a thinking level');
        await worker.click(send, sid, label);
    }
    const until = Date.now()+5000;
    do {
        worker.aborted(worker.current);
        state = await worker.evaluate(send, sid, thinkingSelectorState);
        if(state && !state.disabled && state.text === label)return;
        await sleep(100);
    } while(Date.now()<until);
    throw failure('Build 思考档位设置未生效，已停止发送');
}
