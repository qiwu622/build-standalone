# Build Standalone 0.5.0

独立的 Google AI Studio **Build 代码助手**文本服务，提供 OpenAI 兼容接口、账号池、项目文件长历史、酒馆预设分流及模型思考档位。

Windows 源码项目解压后，双击 `install.cmd` 即可安装、自动启动服务并打开管理页。以后双击 `start.cmd` 启动，双击 `update.cmd` 从 GitHub 更新。安装脚本自动准备 Node.js；首次在常用浏览器安装连接器并接入账号后，后续启动自动恢复已配对的专用项目。旧连接器升级到 0.5.0 后，需要重新加载并接入一次，才能保存自动恢复授权。

现在只需一个浏览器扩展：`extensions/build-browser-bridge` 同时负责 Build 网页执行和酒馆预设分流。在同一浏览器打开酒馆，本机 localhost / 127.0.0.1 自动启用；其他地址在连接器弹窗点击“在当前酒馆站点启用”。旧酒馆适配扩展请禁用后刷新。高级安装可加 `-NoStart` 仅安装，或加 `-NoOpen` 启动但不打开管理页；安装器无法静默安装浏览器扩展或替用户完成 Google 登录。

更新先在临时目录安装依赖和执行离线测试，通过后才替换当前版本；账号、密钥、配置与连接授权保留。正在调用、排队、Git 工作区有未提交修改或分支不能快进时停止更新。新版启动失败会尝试回退。见 [自动更新说明](docs/update.md)。

默认 `requestTimeoutMs: 0`、`queueTimeoutMs: 0`，生成与排队不设时间上限；用户取消、连接断开、Google 返回错误仍会终止请求。设置正整数可自行启用毫秒时限。旧配置会保留原值，需要改为 `0` 才关闭限制。流式等待期间有保活注释，正文仍在完整答案结束后返回。

**0.4.0 支持登录后自动接入。** 扩展首次安装授权后，在常用 Chrome／Edge 的管理页点击“登录并自动接入”，选 Google 账号并正常登录，自动新建专用 Build 项目、连接扩展、登记账号；以后复用同账号已记住的项目。服务不会弹出自动化登录浏览器，不读取浏览器 Cookie 文件、不导出 Google 登录凭据、不开放远程调试端口。浏览器会显示扩展调试提示。

当前为实验版：离线回归与模拟扩展的本机 HTTP 链路已验证；真实浏览器扩展安装、Google 身份识别、项目文件保存和生成仍需要用户登录后验收。不能保证 Google 一定接受会话。SSE 仍为完整答案完成后返回，不是真正逐 token 流式。

## Windows 一键安装

打开普通 PowerShell，复制以下两行。**不需要提前安装 Git、Node.js，也不用手动下载项目包。**

```powershell
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/qiwu622/build-standalone/main/scripts/bootstrap.ps1 -OutFile "$env:TEMP\build-setup.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\build-setup.ps1"
```

脚本从本仓库下载当前 main 对应的固定版本，缺少运行环境时下载并校验官方 Node.js 24 LTS，安装依赖、初始化密钥、后台启动并打开管理页。默认安装到 `%LOCALAPPDATA%\BuildStandalone`，自动从 8787 起选择空闲端口，并创建桌面“Build Standalone”快捷方式。无需管理员权限，不会停止占用端口的其他程序。

首次仍需在常用 Chrome／Edge 安装本机连接器一次，然后点管理页“登录并自动接入”。网站不能静默安装浏览器扩展。详细步骤见 [电脑部署教程](docs/windows.md)。

再次执行上述命令可更新由该脚本管理的安装，保留配置、密钥和账号；升级前备份旧源码。存在进行中或排队请求时停止升级。浏览器扩展更新后需在扩展管理页点“重新加载”，再刷新管理页和 Build 标签页。

## 源码安装 / Linux

安装 Node.js 22+ 与 npm，克隆到独立可写目录：

```sh
git clone https://github.com/qiwu622/build-standalone.git
cd build-standalone
```

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
```

Linux 桌面（非 root 用户）：

```bash
bash scripts/install.sh
npm run start:background
```

默认管理页 `http://127.0.0.1:8787`，端口在 `config.json` 修改；以本机配置为准。安装会初始化独立密钥、安装依赖和执行离线测试，**不再下载 Chromium，也不调用 Google 模型**。`-SkipBrowserDownload` / `--skip-browser` 保留为兼容参数。旧浏览器模块及通用 Playwright 依赖保留用于历史回归，当前服务入口不调用它们。

`data/credentials.json` 中 `adminKey` 用于管理页，`apiKey` 用于 API。Windows 安装/启动窗口会直接显示管理密钥，服务日志不记录密钥。管理页默认在当前浏览器保存登录成功的管理密钥，刷新后自动填写，退出时清除；也可取消记住。安装器不覆盖配置、密钥或账号记录。Windows 限制数据目录到当前用户；Linux 使用 0700/0600 权限。

## 登录与扩展连接

1. 在常用 Chrome／Edge（118 或更新版本）进入扩展管理页，开启开发者模式，加载解压缩的扩展：`extensions/build-browser-bridge`。
2. 用同一常用浏览器打开管理页，输入管理密钥，点“登录并自动接入”。内置浏览器没有安装扩展时会提示换到常用浏览器。
3. 在 Google 官方账号选择页选择账号并完成正常登录/二步验证。登录阶段不挂接调试器，不操作密码或验证码。
4. 首次自动创建一个最小专用 Build 项目，**可能消耗一次模型额度**；创建只提交一次。之后自动复用保存的项目地址并接入账号池，无需手动复制配对码。
5. 等管理页显示“扩展在线”再调用。新版连接器会恢复已配对的账号；启动脚本会立即触发恢复，后台也会定期检查。账号授权失效时再手动接入。创建结果不确定时不会自动重复消耗额度。

详细步骤和权限说明见 [浏览器扩展接入](docs/browser-extension.md)。服务和浏览器当前必须在同一电脑上；没有图形环境的远端服务器不再使用旧版 X11 自动化登录流程，见 [Linux 范围](docs/linux.md)。

保持浏览器和专用标签页打开，调用期间不要手动编辑项目或打开该页的开发者工具。关闭浏览器、点击调试横幅的取消按钮、扩展重载或服务重启后再次自动接入；Google 登录仍保留在你的常用浏览器中。账号记录和配额冷却不会因接入而清空。添加多个账号时分别在官方选择页选择账号，连接时记录实际账号索引，每次生成核对邮箱、项目和实际 Google 请求的账号索引。高级用户仍可在折叠区生成手动配对码接入已有专用项目。

旧账号不会自动迁移 Cookie，需要在常用浏览器重新连接；相同邮箱会沿用已有账号 ID 和冷却。离线账号不参与调用选择。

## API 与酒馆

登录管理页后，在“API 接入”卡片复制 API 地址和 API 密钥。密钥默认隐藏，点击“显示”可查看；退出管理端后会清除页面中的 API 密钥。不要把管理密钥填到聊天客户端。

Base URL 默认 `http://127.0.0.1:8787/v1`，安装脚本可能使用其他空闲端口，以管理页显示的实际地址为准。Bearer 使用 `apiKey`。实现 `GET /v1/models` 与 `POST /v1/chat/completions`。示例：

```powershell
$Credentials = Get-Content -Raw .\data\credentials.json | ConvertFrom-Json
$Headers = @{ Authorization = 'Bearer ' + $Credentials.apiKey }
Invoke-RestMethod http://127.0.0.1:8787/v1/models -Headers $Headers
```

模型：`gemini-4-argon`、`gemini-3.8-flash` 及各自的 `-low`、`-medium`、`-high`；无后缀固定 high。兼容 `build/` 前缀。酒馆专用模型为 `build-st/` 前缀，例如 `build-st/gemini-4-argon-low`，使用浏览器连接器内置的酒馆分流，无需另装酒馆扩展。

模型和思考档位由 Google 网页原生设置切换，并核对实际请求元数据；不是靠提示词模拟。酒馆启用预设进入输入框，世界书、角色资料和历史进入项目文件，见 [酒馆适配](docs/sillytavern.md)。原有酒馆预设不会因本次升级改变。

旧酒馆扩展保留作为兼容入口；使用新版浏览器连接器时请禁用旧版并刷新。检测到仍在运行的旧版时，连接器不会重复包装请求。可直接复制发布的 [Discord 零基础教程](docs/windows-discord.txt)。

只接受文本；工具、图片和强制 JSON 等未实现能力明确拒绝。客户端附带的 `temperature`、`top_p`、`top_k`、惩罚系数、`stop`、`seed`、`logprobs`、`logit_bias`、`prediction` 等可选生成参数自动忽略，使用 Build 原生默认设置，无需在客户端逐项关闭。`reasoning_effort` 也忽略，思考强度仍由模型名后缀决定。该兼容处理同时适用于普通模型、`build/` 和 `build-st/` 模型，以及流式和非流式请求。每次 API 请求创建新聊天，仅使用本次传入的系统与历史。`max_tokens` / `max_completion_tokens` 是输出长度提示，不保证硬截断；token 用量未知，`usage: null`。

`stream: true` 等完整答案结束后发出正文事件、stop、`[DONE]`；响应头 `x-build-streaming: buffered`。等待期间每 15 秒发送 SSE 保活注释；若已经发送响应头后失败，通过包含 `error` 的 SSE 数据帧报告，日志保留真实错误状态。请求在有界串行队列执行，排队时限与执行时限独立，默认均关闭。取消、断连、账号/模型核对失败或清理失败都会报错，不能当作成功回复。

普通模型允许 `system/developer` 指令出现在历史中间或末尾，附件保留所有消息的角色、顺序和文本；最后一条非指令消息仍需为 `user`。每次将完整有序历史打包成一份请求专属 `.txt` 聊天附件，输入框只发送读取附件和回复的短指令；无需反复保存项目文件。酒馆专用模型保留预设进入输入框、历史和世界书进入项目 JSONL 文件的分流。两种方式的文件展开上限均为 8 MiB，通过浏览器中的 File 对象上传，不读取任意本机文件。每次请求新开聊天，发送前核对附件，清理本次遗留草稿；升级后若发现旧版上下文文件，先清理再继续。

Google 的完整正文直接返回，不再要求文件校验暗号。仅当开头确实存在本次请求的精确旧版暗号时移除它；无暗号、其他暗号、读取不完整说明或拒答文字均保留，不自动重试。Google 的限额、网络失败等实际错误仍正常报错。首次附件上传若出现 Google 确认提示，需要在 Build 页面确认一次。本方法不会扩大模型上下文上限，也不能保证模型完整读取或理解全部附件。Google 聊天历史中保存的附件仍需用户自行管理。

仅明确的额度、登录/订阅或模型权限故障触发轮换；内容安全拒绝不重试、不换号。Google 未提供订阅剩余次数，管理页展示观察到的成功次数和冷却，剩余额度保持未知。

## 运行与升级

```text
npm run start:background   后台启动
npm run status             鉴权并核对本实例
npm stop                   停止本实例，不按猜测 PID 强杀
npm test                   无 Google 调用的测试
npm run demo               独立 demo-data，不能连接真实扩展
```

未设置开机自动启动。默认仅监听回环地址。管理/API 密钥分离；配对码短期有效且一次使用。`/bridge/*` 只接受回环连接和本机 Host，拒绝普通网页 Origin。短期连接令牌断连即失效；新版另保存仅限指定账号与项目的自动恢复授权，服务端只保存其哈希，不授予管理/API 或创建项目权限。在管理页断开账号可撤销该授权。

Windows 一键安装的用户重新执行顶部命令即可更新和启动。手动源码安装仍可使用新发布包中的 `scripts/upgrade.ps1 -ReleaseDirectory ... -TargetDirectory ...` 或 `scripts/upgrade.sh ... --target ...`。升级停止本实例，备份允许的源码到 `work/upgrade-*`，保留配置与数据；手动升级默认执行离线测试，一键安装默认跳过，可传 `-RunTests` 开启。浏览器扩展更新后在扩展管理页点“重新加载”并重新配对。

私有备份：停止服务后使用 `scripts/backup.ps1` / `scripts/backup.sh`。旧账号资料、密钥和配置不能公开；当前扩展模式的 Google 登录属于常用浏览器，不包含在服务备份里。

源码发布：`scripts/package.ps1 -Destination 新文件.zip` 白名单打包并生成 SHA256，不包含 `config.json`、数据、浏览器资料、密钥或 `work/`。来源与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
