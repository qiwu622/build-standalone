[CmdletBinding()]
param([switch]$NoOpen, [ValidateSet('Default','Edge','Chrome')][string]$Browser = 'Default')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$PreviousLocation = Get-Location
$PreviousPath = $env:PATH
try {
  if ($env:BUILD_CONFIG) { throw '请在未设置 BUILD_CONFIG 的终端启动，以免操作其他实例。' }
  $Candidates = @()
  $Existing = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($Existing) { $Candidates += $Existing.Source }
  $Runtime = Join-Path $ProjectRoot 'work\runtime'
  if (Test-Path -LiteralPath $Runtime) { $Candidates += @(Get-ChildItem -LiteralPath $Runtime -Directory | ForEach-Object { Join-Path $_.FullName 'node.exe' }) }
  $Node = $null
  foreach ($Candidate in $Candidates) {
    if (Test-Path -LiteralPath $Candidate) {
      $Version = (& $Candidate --version | Select-Object -Last 1)
      if ($LASTEXITCODE -eq 0 -and $Version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) { $Node = $Candidate; break }
    }
  }
  if (-not $Node) { throw '未找到 Node.js 22+，请重新运行 GitHub 一键安装命令。' }
  $env:PATH = (Split-Path $Node) + [IO.Path]::PathSeparator + $env:PATH
  Set-Location -LiteralPath $ProjectRoot
  & $Node scripts/control.mjs start
  if ($LASTEXITCODE -ne 0) { throw '服务启动失败，请查看 data\logs\service.log' }
  $StatusOutput = & $Node scripts/control.mjs status
  if ($LASTEXITCODE -ne 0) { throw '服务启动后未通过本实例鉴权检查' }
  $Status = $StatusOutput | ConvertFrom-Json
  if (-not $Status.running -or $Status.url -notmatch '^http://(?:127\.0\.0\.1|localhost):\d+$') { throw '未取得本机管理页地址' }
  $DataPath = & $Node scripts/config-path.mjs
  if ($LASTEXITCODE -ne 0) { throw '无法读取凭据文件路径' }
  Write-Host ('管理页：' + $Status.url)
  Write-Host ('API 地址：' + $Status.url + '/v1')
  $CredentialPath = Join-Path ($DataPath | Select-Object -Last 1) 'credentials.json'
  $CredentialValues = Get-Content -Raw -Encoding UTF8 -LiteralPath $CredentialPath | ConvertFrom-Json
  if (-not $CredentialValues.adminKey) { throw '凭据文件缺少管理密钥' }
  Write-Host ('管理页密码（adminKey）：' + $CredentialValues.adminKey) -ForegroundColor Green
  Write-Host ('请只复制上面的密码内容。酒馆使用另一个 apiKey，保存在：' + $CredentialPath)
  Write-Host ('浏览器连接器目录：' + (Join-Path $ProjectRoot 'extensions\build-browser-bridge'))
  Write-Host '正在恢复已配对的 Build 项目。首次使用或更新旧连接器后，请在管理页接入一次。'
  if (-not $NoOpen) {
    $LaunchUrl = $Status.url + '/?reconnect=1'
    if ($Browser -eq 'Default') { Start-Process $LaunchUrl }
    else {
      $BrowserName = if ($Browser -eq 'Edge') { 'msedge.exe' } else { 'chrome.exe' }
      Start-Process $BrowserName -ArgumentList $LaunchUrl
    }
  }
} finally { Set-Location -LiteralPath $PreviousLocation; $env:PATH = $PreviousPath }
