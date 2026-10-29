# Build Standalone 0.3.0

独立的 Google AI Studio **Build 代码助手**文本服务，提供 OpenAI 兼容接口、账号池、项目文件长历史、酒馆预设分流及模型思考档位。

**0.3.0 改用常用 Chrome／Edge 的浏览器扩展接入。** 先由用户正常登录 Google，再手动连接专用 Build 标签页。服务不会弹出自动化登录窗口，不读取浏览器 Cookie 文件、不导出 Google 登录凭据、不开放远程调试端口。浏览器会显示扩展调试提示。

当前为实验版：离线回归与模拟扩展的本机 HTTP 链路已验证；真实浏览器扩展安装、Google 身份识别、项目文件保存和生成仍需要用户登录后验收。不能保证 Google 一定接受会话。SSE 仍为完整答案完成后返回，不是真正逐 token 流式。

## 安装

安装 Node.js 22+ 与 npm，克隆到独立可写目录：

```sh
git clone https://github.com/qiwu622/build-standalone.git
cd build-standalone
```

Windows PowerShell：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\install.ps1
npm run start:background
```

Linux 桌面（非 root 用户）：

```bash
bash scripts/install.sh
npm run start:background
```

默认管理页 `http://127.0.0.1:8787`，端口在 `config.json` 修改；以本机配置为准。安装会初始化独立密钥、安装依赖和执行离线测试，**不再下载 Chromium，也不调用 Google 模型**。`-SkipBrowserDownload` / `--skip-browser` 保留为兼容参数。旧浏览器模块及通用 Playwright 依赖保留用于历史回归，当前服务入口不调用它们。

`data/credentials.json` 中 `adminKey` 用于管理页，`apiKey` 用于 API。密钥不打印到服务日志中。安装器不覆盖配置、密钥或账号记录。Windows 限制数据目录到当前用户；Linux 使用 0700/0600 权限。

## 登录与扩展连接

1. 在常用 Chrome／Edge（118 或更新版本）进入扩展管理页，开启开发者模式，加载解压缩的扩展：`extensions/build-browser-bridge`。
2. 正常登录 Google，打开一个**专用于本服务的 Build 项目**，等待英文聊天输入框出现。首次手动创建项目可能使用 Google 额度。
3. 管理页输入管理密钥，点“生成配对码”。
4. 在 Build 项目标签页打开“Build 本机连接器”，填入本机服务地址和一次性配对码，点击连接。无需填写管理员密钥、API Key 或 Cookie。
5. 管理页出现账号与“扩展在线”后才能调用。连接本身不发送模型生成请求。

详细步骤和权限说明见 [浏览器扩展接入](docs/browser-extension.md)。服务和浏览器当前必须在同一电脑上；没有图形环境的远端服务器不再使用旧版 X11 自动化登录流程，见 [Linux 范围](docs/linux.md)。

保持浏览器和专用标签页打开，调用期间不要手动编辑项目或打开该页的开发者工具。关闭浏览器、点击调试横幅的取消按钮、扩展重载或服务重启后需重新配对；Google 登录仍保留在你的常用浏览器中。账号记录和配额冷却不会因重新配对而清空。多账号可分别在项目标签页中配对；连接时会记录实际账号索引，每次生成核对邮箱、项目和实际 Google 请求的账号索引。

旧账号不会自动迁移 Cookie，需要在常用浏览器重新连接；相同邮箱会沿用已有账号 ID 和冷却。离线账号不参与调用选择。

## API 与酒馆

Base URL 默认 `http://127.0.0.1:8787/v1`，Bearer `apiKey`。实现 `GET /v1/models` 与 `POST /v1/chat/completions`。示例：

```powershell
$Credentials = Get-Content -Raw .\data\credentials.json | ConvertFrom-Json
$Headers = @{ Authorization = 'Bearer ' + $Credentials.apiKey }
Invoke-RestMethod http://127.0.0.1:8787/v1/models -Headers $Headers
```

模型：`gemini-4-argon`、`gemini-3.8-flash` 及各自的 `-low`、`-medium`、`-high`；无后缀固定 high。兼容 `build/` 前缀。酒馆专用模型为 `build-st/` 前缀，例如 `build-st/gemini-4-argon-low`，需要另装酒馆扩展 `extensions/build-standalone-adapter`。该扩展与浏览器连接器用途不同，两者可以同时使用。

模型和思考档位由 Google 网页原生设置切换，并核对实际请求元数据；不是靠提示词模拟。酒馆启用预设进入输入框，世界书、角色资料和历史进入项目文件，见 [酒馆适配](docs/sillytavern.md)。原有酒馆预设不会因本次升级改变。

只接受文本；工具、图片、温度和强制 JSON 等未实现参数明确拒绝。每次 API 请求创建新聊天，仅使用本次传入的系统与历史。`max_tokens` / `max_completion_tokens` 是输出长度提示，不保证硬截断；token 用量未知，`usage: null`。

`stream: true` 等完整答案结束后发出正文事件、stop、`[DONE]`；响应头 `x-build-streaming: buffered`。请求在有界串行队列执行，等待也计入超时。取消、断连、账号/模型核对失败或清理失败都会报错，不能当作成功回复。

普通长历史达到 96 KiB 时转为请求专属 JSONL 文件；酒馆分流始终使用文件。文件展开上限 8 MiB，通过浏览器中的 File 对象上传，不读取任意本机文件。需匹配两份文件末尾标记；生成后清理项目文件。本方法不会扩大 Google 的模型上下文上限，Google 项目历史中的保留状态仍需用户自行检查。

仅明确的额度、登录/订阅或模型权限故障触发轮换；内容安全拒绝不重试、不换号。Google 未提供订阅剩余次数，管理页展示观察到的成功次数和冷却，剩余额度保持未知。

## 运行与升级

```text
npm run start:background   后台启动
npm run status             鉴权并核对本实例
npm stop                   停止本实例，不按猜测 PID 强杀
npm test                   无 Google 调用的测试
npm run demo               独立 demo-data，不能连接真实扩展
```

未设置开机自动启动。默认仅监听回环地址。管理/API 密钥分离，扩展仅持有一次性配对产生的内存连接令牌；配对码 5 分钟有效且一次使用。`/bridge/*` 只接受回环连接和本机 Host，拒绝普通网页 Origin。令牌不授予管理/API 权限；断连或服务重启即失效。

新发布包解压到另一目录，使用新包中的 `scripts/upgrade.ps1 -ReleaseDirectory ... -TargetDirectory ...` 或 `scripts/upgrade.sh ... --target ...`。升级停止本实例，备份允许的源码到 `work/upgrade-*`，保留配置与数据，安装依赖并测试后再自行启动。浏览器扩展更新后在扩展管理页点“重新加载”并重新配对。

私有备份：停止服务后使用 `scripts/backup.ps1` / `scripts/backup.sh`。旧账号资料、密钥和配置不能公开；当前扩展模式的 Google 登录属于常用浏览器，不包含在服务备份里。

源码发布：`scripts/package.ps1 -Destination 新文件.zip` 白名单打包并生成 SHA256，不包含 `config.json`、数据、浏览器资料、密钥或 `work/`。来源与许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
