@echo off
setlocal
chcp 65001 >nul
title 启动 Build
if not exist "%LOCALAPPDATA%\BuildStandalone\scripts\start-windows.ps1" (
  echo 还没有在默认位置安装 Build。请先运行“安装或更新Build.cmd”。
  echo 如果你装在其他位置，请使用那个安装目录里的 start.cmd。
  pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\BuildStandalone\scripts\start-windows.ps1"
set "BUILD_START_EXIT=%ERRORLEVEL%"
if not "%BUILD_START_EXIT%"=="0" (
  echo 启动失败，请保留上面的报错。
  pause
)
exit /b %BUILD_START_EXIT%
