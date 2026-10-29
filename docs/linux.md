# Ubuntu / Linux 服务器

目标平台为 Ubuntu 22.04 / 24.04 x86_64，非 root 专用用户，Node.js 22+（推荐 24 LTS）、npm、Bash。Chromium 依赖系统图形库，即使运行 headless 也需要这些库。源码不包含 Node、浏览器或 Google 会话；没有固定用户 ID、域名、生产目录或远程端点。

## 安装

把发布包解压到此用户有写权限的独立目录：

```bash
bash scripts/install.sh
```

安装脚本只写项目和配置的数据目录，不自动使用 sudo 或修改系统服务。系统缺浏览器库时，由服务器管理员在本项目目录执行锁定版本的安装器：

```bash
sudo node node_modules/playwright/cli.js install-deps chromium
```

这一步会修改系统软件包，需要管理员自行执行。浏览器二进制由 `npm run install:browser` 放到项目 `.browsers/`。也可以把 `browserPath` 配成已安装的独立 Chromium/Chrome 可执行文件绝对路径后使用 `bash scripts/install.sh --skip-browser`；始终新建资料目录，不连接用户日常浏览器。

## 无桌面服务器的 Google 官方登录

本版使用 **SSH 鉴权的 X11 转发**显示独立浏览器，无需部署额外 VNC/WebSocket 服务。浏览器进程、Cookie 和用户资料始终在服务器，只有图形显示经过加密 SSH 通道。前提：管理员电脑运行 X server；服务器安装 `xauth` 并由管理员开启 sshd 的 `X11Forwarding yes`。Windows 可使用带 WSLg 的 WSL SSH 客户端；Linux 桌面可直接使用支持 X11 的 SSH 客户端。没有 X server 的普通 Windows PowerShell 不会显示窗口。

1. 本地连接自己的服务器，开启 X11 与管理页隧道；下列地址只是占位符：

   ```bash
   ssh -X -L 8787:127.0.0.1:8787 user@your-server
   ```

2. 在服务器的项目目录停止服务，执行 CLI 登录：

   ```bash
   npm stop
   npm run login
   ```

   `DISPLAY` 应由 SSH 自动设置，不要手填公开 X11 地址。若 Chromium 因 X11 安全扩展限制无法启动，可在自己信任的服务器上改用 `ssh -Y`（信任远程 X11 客户端，权限更高）。登录命令持有独立资料锁，禁止服务同时使用该资料。

3. 在显示到本地的浏览器中完成 Google 官方登录和二步验证。打开专用于此服务的 Build 项目，等待聊天输入框出现，回到终端按 Enter 保存账号。**导入不会自动发送提示词。手动创建 Google 项目可能使用额度。** 如需重新登录已有账号：`npm run login -- --account acct_...`。

4. 登录命令关闭浏览器并释放锁后，运行 `npm run start:background`。后续生成使用 headless 浏览器，不依赖 SSH X11 会话。管理页通过隧道访问 `http://127.0.0.1:8787`。添加更多账号时重复步骤，每个账号独立目录。

如果使用带桌面的服务器或本地 Linux，也可在有 DISPLAY 的前台服务管理页直接添加账号。无 DISPLAY 的后台服务会提示使用上述 CLI 流程，不尝试隐式登录。

## 常驻、域名与升级

`npm run start:background` / `npm stop` / `npm run status` 管理本实例。后台启动不会自动配置开机运行。需要自动恢复时使用 `docs/build-standalone.service.example` 作为 systemd 用户服务模板，替换绝对路径后由管理员安装；不要同时用后台脚本和 systemd 启动同一实例。

外部访问建议保留 `host=127.0.0.1`，通过自己的 HTTPS 反向代理接入；域名填入 `publicOrigin`。代理的响应超时应大于 `requestTimeoutMs` 加清理时间（例如 480 秒），禁用 SSE 缓冲并不让本服务变成逐 token 流式。可使用 SSH 隧道而不配置公网端口。

升级：`bash scripts/upgrade.sh /path/to/extracted-release`；备份：`bash scripts/backup.sh /private/backup/build-YYYYMMDD`。均先通过本实例鉴权确认停止，保留配置、账号、冷却状态和浏览器资料。恢复步骤见 README。

## 验收边界

Linux 的脚本/离线 API 测试、浏览器启动、SSH X11 窗口、真实 Google 登录与真实生成是不同层次。仅有代码测试不代表 SSH、Google 登录或模型调用通过。当前交付的实际平台结果以 `docs/validation.md` 为准；首次接入应按 `docs/live-acceptance.md` 单独验收。

参考：[OpenSSH X11 与端口转发](https://man.openbsd.org/ssh)、[Playwright 系统依赖](https://playwright.dev/docs/browsers#install-system-dependencies)。
