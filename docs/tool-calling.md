# 按请求启用的函数工具适配

从 0.6.0 起，Chat Completions 请求携带非空 `tools`（或旧版 `functions`）且允许调用时，自动启用文本工具协议。模型名称和 API 地址不变。缺省工具、`tools: []`、无工具历史的 `tool_choice: "none"` 均保持原有输入，不注入工具定义或协议提示词。

这不是 Google 原生 function calling。模型按协议输出 JSON，服务校验函数名、参数与选择策略后，返回标准 `tool_calls`。**工具实际由客户端执行**，网关不会替客户端执行命令、联网搜索或访问文件。工具请求会增加工具定义、协议与历史结果的输入 token；没有工具的普通请求没有这些新增内容。

## 客户端请求与回传

```json
{
  "model": "gemini-3.8-flash-low",
  "messages": [{"role": "user", "content": "查询测试条目"}],
  "tools": [{"type": "function", "function": {
    "name": "lookup",
    "description": "查询客户端提供的测试数据",
    "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}
  }}],
  "tool_choice": "auto"
}
```

收到 `finish_reason: "tool_calls"` 后，客户端执行已注册的工具，将返回的 assistant 消息原样加入历史，再追加 `{"role":"tool","tool_call_id":"收到的调用ID","content":"工具结果"}`。并行工具必须返回全部结果，顺序可不同；下一轮保留完整调用 ID 与历史。

支持 `auto`、`none`、`required`、指定函数、`parallel_tool_calls: false`，也支持旧版 `functions/function_call`。工具历史存在、但本轮不再提供工具时，仍保留 ID/结果用于回答，不重新加入已移除的工具定义。

## 酒馆与预设

`build-st/` 同样可使用客户端实际提供的函数工具，需要更新 Build 连接器或兼容酒馆扩展并刷新酒馆。预设原文继续在输入框；历史、世界书、工具调用参数与结果在附件。带工具历史的封装使用版本 2，旧服务会明确拒绝，避免静默丢失调用信息。

像「昆仑 IDE」预设中写下的 `<tools>`、`run_command`、`grep_search` 属于提示词文本；仅开启 `function_calling` 也不会自动安装工具。只有酒馆/IDE 客户端注册实现并实际发送 `tools`，才会进入工具适配。不会从预设文字提取工具并赋予执行权限。

## 输出、限制与失败

- 工具信封须完整校验后返回；SSE 携带标准带 `index` 的 `delta.tool_calls` 和结束原因。它是缓冲式工具输出，不是逐 token 参数流。独立版原有正文也仍为缓冲输出。
- 公益站普通聊天继续原生正文流式；仅启用工具的请求缓冲校验，响应头标记 `x-build-streaming: buffered-tools`。
- 公益站内容拦截/长度截断后已有文本仍返回，但作为文本处理，不发布可执行工具调用。普通完整工具协议无效返回 `502 invalid_tool_response`，已发送 SSE 响应头时返回 error 帧；不自动修复、重试或换号生成。
- 支持文本结果、最多 128 个函数、定义总计不超过 256 KiB。JSON Schema 使用 Ajv draft-07、本地引用；不加载远程引用，不支持异步 schema，不检查 format。`strict` 不代表 Google 提供受约束解码保证。
- 不支持 Responses API、非函数工具、图片/音频工具结果、`response_format`。模型是否遵循工具协议仍依赖上游输出，不能保证每次生成合法。
- 公益站用上游报告的输入/输出记账，包括协议开销；解析失败但已有已知 usage 时也保留消耗记录。未知值不按字符伪造；站内扣费与 Google 账单不是同一口径。

## 验证与来源

贡献包基于 `ad9e8d6b8f4ef35a9257a6aed353385b1744cd02`，本次在其协议转换基础上增加零提示词原生分流、酒馆预设/工具历史保持、公益站流式和账本处理。署名及依赖许可见 `THIRD_PARTY_NOTICES.md`。

自动化测试使用模拟上游，包含实际本机 HTTP、客户端工具读取/写入临时测试文件、多个工具及回传、参数失败、取消、部分回复和用量记录。贡献方描述的真实 Google/OpenCode 成功属于第三方观察，本次没有将其当作维护者真实验收。没有为本次升级额外调用 Google 模型。
