[CmdletBinding()]
param([switch]$SkipBrowserDownload, [switch]$SkipTests, [string]$SillyTavernUserDirectory, [switch]$NoStart, [switch]$NoOpen)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$PreviousLocation = Get-Location
$PreviousTemp = $env:TEMP
$PreviousTmp = $env:TMP
$PreviousCache = $env:npm_config_cache
$PreviousPath = $env:PATH
try {
  if ($env:BUILD_CONFIG) { throw '请在未设置 BUILD_CONFIG 的终端安装，避免改动其他实例。' }
  Set-Location -LiteralPath $ProjectRoot
  . (Join-Path $PSScriptRoot 'runtime-windows.ps1')
  $RuntimeNode = Initialize-BuildRuntime $ProjectRoot
  $env:PATH = (Split-Path $RuntimeNode) + [IO.Path]::PathSeparator + $env:PATH
  $NodeVersion = ((& $RuntimeNode --version) | Select-Object -Last 1)
  $NodeMajor = [int]$NodeVersion.TrimStart('v').Split('.')[0]
  if ($NodeMajor -lt 22) { throw '需要 Node.js 22 或更新版本；推荐 Node.js 24 LTS。' }
  New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot 'work\tmp') | Out-Null
  $env:TEMP = Join-Path $ProjectRoot 'work\tmp'
  $env:TMP = $env:TEMP
  $env:npm_config_cache = Join-Path $ProjectRoot 'work\npm-cache'
  if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'config.json'))) {
    $NewConfig = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $ProjectRoot 'config.example.json') | ConvertFrom-Json
    $NewConfig.port = Find-FreePort 0
    $NewConfig.publicOrigin = 'http://127.0.0.1:' + $NewConfig.port
    [IO.File]::WriteAllText((Join-Path $ProjectRoot 'config.json'),($NewConfig | ConvertTo-Json -Depth 8),(New-Object Text.UTF8Encoding $false))
  }
  & npm.cmd ci --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败' }
  & node src/main.mjs --init
  if ($LASTEXITCODE -ne 0) { throw '初始化失败' }
  # Restrict new account profiles and generated credentials to this Windows user.
  $DataPath = (& node scripts/config-path.mjs | Select-Object -Last 1)
  if ($LASTEXITCODE -ne 0) { throw '无法解析数据目录' }
  $CurrentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $DataPath '/inheritance:r' '/grant:r' ('*' + $CurrentUserSid + ':(OI)(CI)F') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw '设置数据目录访问权限失败' }
  if (-not $SkipTests) {
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw '自动化测试失败' }
  }
  if ($SillyTavernUserDirectory) { & (Join-Path $PSScriptRoot 'install-sillytavern.ps1') -UserDirectory $SillyTavernUserDirectory }
  Write-Host '使用常用 Chrome/Edge 扩展连接，不下载或启动独立 Chromium。'
  Write-Host '安装完成。以后双击项目目录中的 start.cmd 即可启动并自动恢复 Build 项目连接。'
  Write-Host '首次仍需在常用浏览器加载 extensions\build-browser-bridge，并在管理页接入账号一次。'
  Write-Host ('管理页地址见 config.json；独立密钥文件：' + (Join-Path $DataPath 'credentials.json'))
  if (-not $NoStart) {
    Write-Host '正在自动启动 Build Standalone…'
    & (Join-Path $PSScriptRoot 'start-windows.ps1') -NoOpen:$NoOpen
    if (-not $?) { throw '安装完成，但自动启动失败；请查看上方错误后运行 start.cmd。' }
  }
} finally {
  Set-Location -LiteralPath $PreviousLocation.Path
  $env:TEMP = $PreviousTemp
  $env:TMP = $PreviousTmp
  $env:npm_config_cache = $PreviousCache
  $env:PATH = $PreviousPath
}
