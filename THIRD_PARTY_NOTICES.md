# 来源与许可

函数工具协议适配以用户提供的 `build-standalone-toolcalling-contribution-20261101.zip` 为基础修改，来源与校验摘要见 `docs/tool-contribution-source.md`；相关代码不宣称为本项目独立原创。保留贡献包随附的 MIT LICENSE，原文在 `licenses/tool-contribution-MIT.txt`。

- Ajv 8.20.0：Evgeny Poberezkin / contributors，MIT；用于本地 JSON Schema 校验。https://github.com/ajv-validator/ajv 。许可位于安装依赖目录，并在 `licenses/ajv-MIT.txt` 留存。间接依赖许可见各依赖 LICENSE，未将其代码宣称为自研。

本项目的服务、调度、账号存储、登录管理、安装/管理页面为独立实现。`src/build-chat.mjs`、`build-thinking.mjs`、`build-file-context.mjs`、`build-pool.mjs` 基于同一项目早期 gemini-aggregate 中自行开发的业务新增文件进行了裁剪和修改，源文件 SHA-256 见 `docs/source-manifest.json`。只选择这些源码作为起点，没有复制原项目运行数据、账号、压缩包或上游反代核心。

没有引入 AIS 或 AIStudioBuildProxy 服务、HTTP/WS 中转层、账号接口、浏览器安装目录。默认通过用户常用浏览器中的连接器调用 CDP；保留的旧 Playwright 路径不是低内存纯协议运行环境。未公开 Google WAA/BotGuard 或共享 VM 实验实现。

- Playwright / playwright-core 1.64.1：Microsoft Corporation，Apache-2.0。官方项目：https://github.com/microsoft/playwright 。许可与 NOTICE 保留在 `licenses/`，安装后原件位于依赖目录。
- Chromium：由 Playwright 安装，使用 Chromium 及其第三方组件各自许可。浏览器不随源码发布包分发；安装后浏览器的 `chrome://credits` 提供组件归属。https://www.chromium.org/Home/chromium-security/overview/ 和 https://chromium.googlesource.com/chromium/src/+/main/LICENSE 。
- Node.js：独立安装的运行时，不随发布包分发，Node.js 及所含第三方组件依各自许可；https://github.com/nodejs/node/blob/main/LICENSE 。
- Google AI Studio / Google 登录：Google 提供的服务与页面，非本项目实现或授权的官方 API。用户自行持有并登录有权使用的账户，遵守服务条款。

上述通用依赖和 Google 服务均不宣称为本项目自研。网页选择器和私有请求元数据字段来自既有功能观察，可能随 Google 更新而失效；无法核对模型/档位时会明确失败。

酒馆适配扩展为本项目实现，通过 SillyTavern 提供的前端模块与事件工作；未随包复制 SillyTavern 核心源码。SillyTavern 由其上游项目单独分发：https://github.com/SillyTavern/SillyTavern 。

0.7.0 新增自有内容采用非商用署名许可，基线及第三方部分的 MIT/Apache 权利不变；见 `docs/licensing.md`。新增文档输出传输由本项目实现，仅解析网页已生成的文件快照元数据；未复制服务端签名或低内存执行器。
