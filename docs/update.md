# Windows 自动更新

双击项目目录里的 **`update.cmd`**，等待显示“更新完成”。无需重新下载项目、重填密钥或导入账号。

更新流程：检查当前没有执行或排队请求 → 下载 GitHub `qiwu622/build-standalone` 的 main 固定提交 → 在临时目录安装依赖、运行离线测试 → 再次检查空闲 → 停止本实例 → 备份旧源码与依赖 → 更新并启动。

- `config.json`、`data/`、自定义数据目录和 `work/` 保留；不读取或导出 Google Cookie。
- 备份放在 `work/update-backup-*`；最新更新记录在 `work/last-update.json`。
- 新版启动失败会尝试恢复旧源码与依赖。恢复不成功时显示备份路径，不强杀未知进程。
- Git 工作区只允许 main 分支快进；有未提交修改、未跟踪文件或本地提交分叉时停止，不执行强制覆盖。
- 连接器版本更新后，在 Chrome/Edge 扩展管理页点一次“重新加载”。已有新版自动恢复授权的账号会重新连接；旧版首次升级需要接入一次。
- 更新仅获取已经推送 GitHub 的代码，尚未发布的本地修改不会从 GitHub 下载到。

只检查 GitHub 最新版本，不替换或重启：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\update.ps1 -CheckOnly
```

更新但不打开浏览器：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\update.ps1 -NoOpen
```

默认执行自动测试。高级选项 `-SkipTests` 可以跳过；`-SourceDirectory 新版本目录` 可为非 Git 安装指定离线源码。普通用户双击 `update.cmd` 即可。

新装默认调用和排队时限均为 `0`（不限时）。更新保留原配置；旧安装若要取消以前的时限，将 `config.json` 的 `requestTimeoutMs` 和 `queueTimeoutMs` 都设为 `0`，在没有调用时重启服务。
