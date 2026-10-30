[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$ReleaseDirectory, [string]$TargetDirectory, [switch]$SkipBrowserDownload, [switch]$SkipTests)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
$TargetRoot = if ($TargetDirectory) { (Resolve-Path -LiteralPath $TargetDirectory).Path } else { [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')) }
$SourceRoot = (Resolve-Path -LiteralPath $ReleaseDirectory).Path
if ($SourceRoot -eq $TargetRoot) { throw '新版本必须先解压到另一个目录' }
if ($SourceRoot.StartsWith($TargetRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or $TargetRoot.StartsWith($SourceRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw '新旧安装目录不能相互嵌套' }
if ((Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $SourceRoot 'package.json') | ConvertFrom-Json).name -ne 'build-standalone') { throw '不是 Build 独立版发布目录' }
if ((Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $TargetRoot 'package.json') | ConvertFrom-Json).name -ne 'build-standalone') { throw '目标不是 Build 独立版安装目录' }
$PreviousLocation = Get-Location
try {
  Set-Location -LiteralPath $TargetRoot
  & node scripts/control.mjs stop
  if ($LASTEXITCODE -ne 0) { throw '无法确认旧实例停止，未更新文件' }
  # Back up source/config only. A consistent private data backup is a separate command.
  $BackupRoot = Join-Path $TargetRoot ('work\upgrade-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
  New-Item -ItemType Directory -Path $BackupRoot | Out-Null
  $Allowed = @('src','public','scripts','tests','extensions','docs','licenses','install.cmd','start.cmd','update.cmd','package.json','package-lock.json','manifest.json','config.example.json','README.md','CHANGELOG.md','LICENSE','THIRD_PARTY_NOTICES.md','.gitignore')
  foreach ($Name in $Allowed) {
    $Current = Join-Path $TargetRoot $Name
    if (Test-Path -LiteralPath $Current) { Copy-Item -LiteralPath $Current -Destination $BackupRoot -Recurse }
  }
  if (Test-Path -LiteralPath (Join-Path $TargetRoot 'config.json')) { Copy-Item -LiteralPath (Join-Path $TargetRoot 'config.json') -Destination $BackupRoot }
  foreach ($Name in $Allowed) {
    $New = Join-Path $SourceRoot $Name
    if (-not (Test-Path -LiteralPath $New)) { continue }
    $Destination = [IO.Path]::GetFullPath((Join-Path $TargetRoot $Name))
    if (-not $Destination.StartsWith($TargetRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw '更新路径越界' }
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
    Copy-Item -LiteralPath $New -Destination $Destination -Recurse
  }
  $InstallScript = Join-Path $TargetRoot 'scripts\install.ps1'
  $InstallOptions = @{ SkipBrowserDownload = $SkipBrowserDownload; SkipTests = $SkipTests }
  if ((Get-Command $InstallScript).Parameters.ContainsKey('NoStart')) { $InstallOptions.NoStart = $true }
  & $InstallScript @InstallOptions
  if (-not $?) { throw '新版本安装失败；旧源码备份保留在 work/upgrade-*，数据未删除' }
  Write-Host ('升级完成；config.json 与数据已保留。旧源码备份：' + $BackupRoot)
  Write-Host '运行 npm run start:background 启动新版本。'
} finally { Set-Location -LiteralPath $PreviousLocation.Path }
