[CmdletBinding()]
param([switch]$SkipBrowserDownload, [switch]$SkipTests)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$PreviousLocation = Get-Location
$PreviousTemp = $env:TEMP
$PreviousTmp = $env:TMP
$PreviousCache = $env:npm_config_cache
try {
  Set-Location -LiteralPath $ProjectRoot
  $RuntimeNode = Get-Command node -ErrorAction Stop
  $NodeVersion = ((& $RuntimeNode.Source --version) | Select-Object -Last 1)
  $NodeMajor = [int]$NodeVersion.TrimStart('v').Split('.')[0]
  if ($NodeMajor -lt 22) { throw '需要 Node.js 22 或更新版本；推荐 Node.js 24 LTS。' }
  New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot 'work\tmp') | Out-Null
  $env:TEMP = Join-Path $ProjectRoot 'work\tmp'
  $env:TMP = $env:TEMP
  $env:npm_config_cache = Join-Path $ProjectRoot 'work\npm-cache'
  if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'config.json'))) {
    Copy-Item -LiteralPath (Join-Path $ProjectRoot 'config.example.json') -Destination (Join-Path $ProjectRoot 'config.json')
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
  Write-Host '使用常用 Chrome/Edge 扩展连接，不下载或启动独立 Chromium。'
  Write-Host '安装完成。前台：npm start；后台：npm run start:background；停止：npm stop。'
  Write-Host ('管理页地址见 config.json；独立密钥文件：' + (Join-Path $DataPath 'credentials.json'))
} finally {
  Set-Location -LiteralPath $PreviousLocation.Path
  $env:TEMP = $PreviousTemp
  $env:TMP = $PreviousTmp
  $env:npm_config_cache = $PreviousCache
}
