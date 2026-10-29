# Build Standalone 0.2.0

独立的 Google AI Studio **Build 代码助手**文本服务。一个 Node 进程直接调度自己的 Build 执行器和浏览器，提供 OpenAI 兼容接口、Google 官方登录、独立账号资料、多账号额度轮换、管理页和元数据日志。

仅支持 Build；不依赖 AIS 或 AIStudioBuildProxy 服务。Playwright、Chromium、Node.js 是通用依赖，来源与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

**当前为实验预发布版本。** 安装、离线回归和酒馆本地链路已验证；本独立版的 Google 实际读取和生成仍待验收。SSE 目前等待完整答案后返回，不是真正的逐 token 流式。详见 [验证记录](docs/validation.md) 和 [真实验收步骤](docs/live-acceptance.md)。

## 快速安装

先安装 Node.js 22+ 与 npm（推荐 24 LTS）。从 [Releases](https://github.com/qiwu622/build-standalone/releases) 下载发布包并解压到独立可写目录，或克隆仓库：

```bash
git clone https://github.com/qiwu622/build-standalone.git
cd build-standalone
```

GitHub 提供源码和下载包；实际反代服务仍需运行在自己的电脑或服务器上。

Windows 10/11 x64，PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
npm run start:background
```

Ubuntu 22.04/24.04 x64，非 root 专用用户：

```bash
bash scripts/install.sh
npm run start:background
```

安装包含 `npm ci`、初始化、离线测试和独立 Chromium 下载；不登录 Google、不调用模型。系统 Chromium 已可用时可配置 `browserPath`，使用 Windows `-SkipBrowserDownload` / Linux `--skip-browser`。Linux 系统库、SSH X11 登录和服务器运行方式见 [Linux 部署说明](docs/linux.md)。

默认管理页：`http://127.0.0.1:8787`。首次初始化生成 **两个不同的随机密钥**，保存在 `data/credentials.json`：`adminKey` 用于管理页；`apiKey` 用于调用接口。不会把密钥印在服务日志里。请在自己的机器上打开此文件读取，不要放到公网或发给使用 API 的人。

Windows 安装器限制数据目录为当前用户访问；Linux 使用 0700/0600 权限。安装/运行请使用同一用户。安装器可重复运行，不覆盖 `config.json`、账号、资料、密钥或冷却状态。

## Google 账号接入

有桌面环境时，使用管理密钥连接管理页，点击添加账号。在服务主机打开的全新独立浏览器里完成 Google 官方登录，打开一个**专用于本服务**的 Build 项目，然后点击完成导入。每个账号一个资料目录，重新登录会核对原邮箱，不导出或共享 Cookie。

无桌面服务器通过 SSH X11 转发运行 `npm run login`；浏览器在服务器执行，窗口显示到管理员电脑，资料留在服务器。操作前停止服务，登录后启动 headless 服务；详见 [服务器接入步骤](docs/linux.md)。不需要公开 CDP/VNC 端口。管理页不会代替 Google 输入密码或处理二步验证。

导入过程不自动发送生成提示词；用户手动创建专用 Build 项目可能使用 Google 额度。每次生成前核对实际登录邮箱、authuser=0、网页订阅模式、实际模型及原生思考档位。任何核对失败都明确报错。Google 可能拒绝自动化浏览器登录；若发生，记录并停止，不绕过 Google 验证。

## API

Base URL：`http://127.0.0.1:8787/v1`。Bearer 鉴权。实现 `GET /v1/models` 和 `POST /v1/chat/completions`，只接受文本消息。

PowerShell 示例（从本机私有文件读取 API 密钥）：

```powershell
$Credentials = Get-Content -Raw .\data\credentials.json | ConvertFrom-Json
$Headers = @{ Authorization = 'Bearer ' + $Credentials.apiKey }
Invoke-RestMethod http://127.0.0.1:8787/v1/models -Headers $Headers
$Body = @{ model = 'gemini-4-argon-low'; messages = @(@{ role = 'user'; content = '你好' }) } | ConvertTo-Json -Depth 8
Invoke-RestMethod http://127.0.0.1:8787/v1/chat/completions -Method Post -Headers $Headers -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($Body))
```

普通模型 8 个：`gemini-4-argon`、`gemini-3.8-flash`，以及各自 `-low`、`-medium`、`-high`。兼容输入 `build/` 前缀。不带后缀固定 high。另提供 8 个 `build-st/` 前缀的酒馆专用模型，例如 `build-st/gemini-4-argon-low`；需要安装配套扩展。两组共 16 个模型名称，额度按基础模型共用。先选模型再设置网页原生 Thinking level，且核对实际 CodeAssistantOffline 请求的模型与档位；不以提示词模拟思考参数。

酒馆专用模式将启用预设放在输入框，将世界书、角色资料和历史放入项目文件，同时保留消息顺序与角色。安装、45000 token 估算阈值和兼容限制见 [酒馆适配说明](docs/sillytavern.md)。普通 API 的消息格式保持原样；未安装扩展却选择专用模型会在 Google 调用前报错。

支持 `system`/`developer` 开头指令和 `user`/`assistant` 历史，最后一条须是 user。每次请求新建聊天，系统和历史仅来自该请求。`max_tokens`/`max_completion_tokens` 作为输出长度提示，不保证硬 token 截断；token 使用量未知，`usage: null`。工具、图片、JSON schema、温度等未实现参数明确拒绝，不悄悄忽略。

`stream: true` 是**完整答案完成后的 SSE 兼容输出**：一次正文事件、stop、`[DONE]`，响应头 `x-build-streaming: buffered`。未实现逐 token 流式，期间不伪造正文。并发请求进入有界串行队列；客户端断开、超时或停止服务都会取消，队列等待计入总超时，浏览器清理期间不会启动下一条。

长历史序列化达到 96 KiB 时使用两个请求专属 JSONL 项目文件。Unicode 文本分片保持原文，末尾随机标记必须匹配，成功/失败后清理本地与项目文件；清理失败不返回成功，下一次调用会先恢复清理。此方法不会扩大 Google 模型的上下文上限；文件展开后上限 8 MiB，超限返回 413。文件会实际上传 Google 项目，使用完专用项目还应按自己的数据保留要求检查 Google 侧历史。

只在明确的额度、登录/订阅或模型权限故障下按状态轮换。Google 内容安全拒绝返回 422，不重试、不换号。剩余额度是未知值，管理页显示观察到的成功次数和冷却；冷却结束不表示 Google 已确认额度重置。停用/重新登录不清空配额冷却。

## 配置、启动与停止

复制的 `config.json` 包含 host、port、publicOrigin、dataDir、browserPath、headless、requestTimeoutMs、maxQueue、maxBodyBytes。相对数据目录基于安装目录；外部配置文件可用 `BUILD_CONFIG` 指定。域名配置到 `publicOrigin`，API 和管理页共用单进程。默认仅监听回环地址；公网接入自行使用 HTTPS 反向代理，代理超时应大于生成超时。

```text
npm start                   前台运行；Ctrl+C 停止
npm run start:background    后台启动
npm run status              鉴权后查看本实例
npm stop                    鉴权并核对实例 ID 后停止
npm test                    无 Google 调用的测试
npm run demo                演示服务，使用独立 demo-data，正文明确标记 DEMO
```

后台脚本不会按 PID 猜测或强杀其他服务。异常断电遗留 `service.lock` 时，确认该数据目录没有运行中的服务或登录命令，再手动移除锁；不要同时启动两个实例。演示后台管理追加 `-- --demo`，例如 `npm run start:background -- --demo`、`npm stop -- --demo`。演示和正式模式共用配置端口，不要同时在同一端口运行。

## 升级、备份与恢复

从 0.1.0 升至 0.2.0 时，使用**新发布包中的升级脚本**，它会同时安装新增的扩展目录：

```powershell
D:\new-build-release\scripts\upgrade.ps1 -ReleaseDirectory 'D:\new-build-release' -TargetDirectory 'D:\old-build-install'
```

```bash
bash /path/to/new-build-release/scripts/upgrade.sh /path/to/new-build-release --target /path/to/old-build-install --skip-browser
```

将新发布包解压到另一独立目录，再在旧安装目录运行：

```powershell
.\scripts\upgrade.ps1 -ReleaseDirectory 'D:\new-build-release'
```

```bash
bash scripts/upgrade.sh /path/to/new-build-release
```

升级先停止本实例，只替换允许的源码/文档/扩展/锁定依赖清单，旧源码备份到 `work/upgrade-*`，保留原 `config.json` 与数据目录；随后重新安装依赖并运行测试。失败时保持停止状态，按备份源码回滚并 `npm ci`；不自动启动失败版本。升级依赖后可能需要下载新版 Chromium。0.2.0 没有改变账号数据格式；未来数据格式迁移需由该版本明确提供。酒馆端扩展须另运行安装脚本更新。

私有备份（先停止服务）：Windows `scripts/backup.ps1 -Destination 'D:\private-backup\build-date'`；Linux `bash scripts/backup.sh /private/backup/build-date`。备份包括账号、Cookie/浏览器资料、密钥和配置，必须单独保护，**不属于源码发布包**。

恢复到同一操作系统和同一用户：停止服务，保留现有数据副本；将备份 `data/` 放回配置的 dataDir，恢复 config.json 并核对路径/端口，再安装与备份匹配的源码依赖后启动。跨用户/跨操作系统浏览器加密资料通常不能直接复用，应重新 Google 登录；不要承诺备份能恢复会话。恢复后使用 `npm run status` 和自己的独立账号验收。

## 发布与目录

`src/` 核心代码；`public/` 管理页；`scripts/` 安装、启停、升级、登录、备份及打包；`tests/` 离线/本地 HTTP 测试；`docs/` 验收、来源和平台说明。

运行 `scripts/package.ps1 -Destination 新文件.zip` 通过显式白名单打包源码，并生成 SHA256。不会打包 `config.json`、`data/`、`demo-data/`、`work/`、`.browsers/`、`node_modules/`、账号或密钥。发布者仍应检查包条目与扫描结果；安装包不随附任何 Google 会话。
