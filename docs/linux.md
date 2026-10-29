# Linux 范围（0.3.0）

此版本的默认执行器改成常用浏览器扩展，不再启动服务自带的自动化 Chromium。旧版 SSH X11 登录和 `npm run login` 打开浏览器的流程已停用。

Linux 桌面使用 Node.js 22+、npm 与 Chrome 118+，以非 root 用户运行 `bash scripts/install.sh`、`npm run start:background`，按 [扩展接入说明](browser-extension.md) 在同一电脑的浏览器中连接专用 Build 项目。安装脚本不再安装浏览器或系统图形库。

**无桌面远端服务器暂不属于本版扩展模式的已验证范围。** 浏览器关闭便无法生成，本地扩展的传输路由只接受回环地址；不要开放调试端口或把浏览器用户资料复制到服务器冒充正常登录。

API/管理端仍可由管理员配置自己的 HTTPS 反向代理，但这不会自动让远端浏览器扩展可用。日常启停用 `npm run status` / `npm stop`，数据备份与升级见主 README。未自动安装 systemd 服务。
