# 电脑部署：复制命令即可安装

适用于 Windows 10 / 11 的 x64 或 ARM64 电脑。电脑需要能访问 GitHub、nodejs.org、npm 和 Google AI Studio。使用常用 Chrome / Edge 登录 Google，无需独立的自动化浏览器。

## 1. 安装并启动

打开 PowerShell（普通权限即可），复制两行执行：

```powershell
Invoke-WebRequest -UseBasicParsing https://raw.githubusercontent.com/qiwu622/build-standalone/main/scripts/bootstrap.ps1 -OutFile "$env:TEMP\build-setup.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\build-setup.ps1"
```

脚本自动下载 GitHub 源码、准备 Node.js、安装依赖、生成独立密钥、启动服务并打开管理页。默认目录是 `%LOCALAPPDATA%\BuildStandalone`，无需手动下载压缩包或安装 Git。服务仅监听本机；没有设置开机自启。

管理页端口会避开已占用端口，请使用安装完成时显示的地址。桌面快捷方式“Build Standalone”可用于以后启动和打开管理页。

## 2. 填管理密钥

安装或启动完成时，窗口会直接显示“管理页密码（adminKey）”，复制到管理页即可。登录成功后默认在当前浏览器保存，下次打开自动填写；可以取消“记住管理密钥”，点击“退出管理端”也会清除保存。`apiKey` 留给酒馆，仍从安装目录的 `data\credentials.json` 获取，两者不可混用。

## 3. 第一次安装连接器

1. Chrome 地址栏输入 `chrome://extensions`；Edge 输入 `edge://extensions`。
2. 开启“开发者模式”，点“加载解压缩的扩展”。
3. 选择 `%LOCALAPPDATA%\BuildStandalone\extensions\build-browser-bridge`；自定义安装目录则选择该目录下的同名文件夹。
4. 在这个浏览器打开本机管理页并刷新，确认显示连接器版本。

浏览器要求用户授权扩展，安装脚本不能代替这一步。连接时出现调试横幅属于扩展的正常工作方式。

## 4. 登录并自动接入

点击管理页的“登录并自动接入”，在官方 Google 页面选择账号并完成登录和验证。

首次没有登记专用项目时，扩展自动创建一个最小私有项目，可能消耗一次 Build 模型额度；有登记项目时直接复用。创建结果不确定不会自动重复提交。项目编辑页没有账号按钮时，连接器会临时打开一个后台 Build 主页核对账号，完成后关闭这个核对页，不会再次创建项目。

管理页显示“扩展在线”才算接入完成。保持浏览器和专用项目标签页打开；调用期间不要编辑该项目。Google 验证、地区限制、订阅权限或协议提示仍需按官方流程处理。

## 5. 客户端填写

- Base URL：管理页显示的地址加 `/v1`。
- API Key：凭据文件的 `apiKey`。
- 模型：从客户端读取模型列表，例如 `gemini-4-argon-high`。

同一个浏览器扩展已内置酒馆预设分流，无需另装第二个扩展。旧酒馆扩展先禁用并刷新，详见 [酒馆适配教程](sillytavern.md)。本版本的 SSE 是完整答案完成后返回，尚不是真正逐 token 流式。

## 更新和自定义目录

更新时重新运行第 1 步的两行命令。账号、密钥和配置保留，旧源码备份到 `work\upgrade-*`。更新连接器后，在扩展管理页点“重新加载”，再刷新管理页和本次 Build 标签页；凭据过期就重新点自动接入，仍复用已记住的项目。

首次指定安装目录和端口，可把第二行换成：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:TEMP\build-setup.ps1" -InstallDirectory "D:\BuildStandalone" -Port 18787
```

以后更新须传入同一个自定义目录。已存在的 Git 工作区或非空未知目录不会被覆盖。可选参数：`-RunTests` 执行离线测试，`-NoOpen` 不自动打开管理页，`-NoShortcut` 不创建桌面快捷方式。

如果下载失败，先检查对 GitHub / nodejs.org / npm 的网络访问，再重跑同一命令。不需要关闭证书校验或全局修改 PowerShell 执行策略。
