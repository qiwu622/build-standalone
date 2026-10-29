[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$UserDirectory)
$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$UserRoot = (Resolve-Path -LiteralPath $UserDirectory).Path
if (-not (Test-Path -LiteralPath (Join-Path $UserRoot 'settings.json') -PathType Leaf)) { throw '请选择酒馆实际用户目录，例如 data\default-user；其中必须存在 settings.json' }
$Source = Join-Path $ProjectRoot 'extensions\build-standalone-adapter'
$ExtensionsRoot = Join-Path $UserRoot 'extensions'
$Target = [IO.Path]::GetFullPath((Join-Path $ExtensionsRoot 'build-standalone-adapter'))
if (-not $Target.StartsWith($UserRoot + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw '扩展安装路径越界' }
foreach ($Path in @($UserRoot,$ExtensionsRoot,$Target)) {
  if ((Test-Path -LiteralPath $Path) -and (((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw '扩展安装路径不能是链接' }
}
foreach ($Name in @('manifest.json','index.js','transport.js')) {
  if (-not (Test-Path -LiteralPath (Join-Path $Source $Name) -PathType Leaf)) { throw ('安装源缺少 ' + $Name) }
}
if (Test-Path -LiteralPath $Target) {
  if (Get-ChildItem -LiteralPath $Target -Recurse -Force | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }) { throw '现有扩展包含链接，未覆盖' }
  $Backup = Join-Path $UserRoot ('backups\build-adapter-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
  New-Item -ItemType Directory -Path $Backup -Force | Out-Null
  Copy-Item -LiteralPath $Target -Destination $Backup -Recurse
  Write-Host ('旧扩展备份：' + $Backup)
}
New-Item -ItemType Directory -Path $Target -Force | Out-Null
foreach ($Name in @('manifest.json','index.js','transport.js')) {
  Copy-Item -LiteralPath (Join-Path $Source $Name) -Destination (Join-Path $Target $Name) -Force
  if ((Get-FileHash -LiteralPath (Join-Path $Source $Name)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $Target $Name)).Hash) { throw '扩展复制校验失败' }
}
Write-Host ('已安装：' + $Target)
Write-Host '请刷新酒馆。支持自定义 OpenAI 或 OpenAI＋反向代理连接中的 build-st/ 模型；不修改当前连接、预设或聊天记录。'
