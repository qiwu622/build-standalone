@echo off
setlocal
chcp 65001 >nul
title Build 安装或更新
echo 正在从 GitHub 下载并安装 Build，请等待，不要关闭窗口。
echo 已经安装过的会更新，保留账号、密钥和配置。
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; $buildSetupFile=Join-Path ([IO.Path]::GetTempPath()) ('BuildStandalone-bootstrap-'+[guid]::NewGuid().ToString('N')+'.ps1'); try { Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/qiwu622/build-standalone/main/scripts/bootstrap.ps1' -OutFile $buildSetupFile -TimeoutSec 90; & $buildSetupFile } catch { Write-Host ('Installation failed: '+$_.Exception.Message) -ForegroundColor Red; exit 1 } finally { if (Test-Path -LiteralPath $buildSetupFile) { Remove-Item -LiteralPath $buildSetupFile -Force -ErrorAction SilentlyContinue } }"
set "BUILD_SETUP_EXIT=%ERRORLEVEL%"
if not "%BUILD_SETUP_EXIT%"=="0" (
  echo.
  echo 安装未完成。请保留上面的报错，确认能访问 GitHub 后再试。
  pause
  exit /b %BUILD_SETUP_EXIT%
)
echo.
echo 安装并启动完成。以后双击桌面的 Build Standalone 即可。
echo.
echo 首次使用只需完成这三步：
echo 1. 浏览器扩展页打开开发者模式，加载下面的文件夹：
echo "%LOCALAPPDATA%\BuildStandalone\extensions\build-browser-bridge"
echo    Edge 地址栏输入 edge://extensions，Chrome 输入 chrome://extensions。
echo 2. 窗口上方已显示管理页密码，复制到管理页；登录成功后默认记住。
echo    酒馆使用另一个 apiKey，可从下面的文件获取：
echo "%LOCALAPPDATA%\BuildStandalone\data\credentials.json"
echo 3. 同一个浏览器刷新管理页，点击“登录并自动接入”。
echo    等账号显示“Build 执行连接在线”，再打开酒馆。
echo.
echo 只有一个浏览器扩展，已包含酒馆分流。更新后请给它点一次重新加载。
echo 密钥不要发给别人。使用时保留浏览器和专用 Build 标签页。
pause
exit /b 0
