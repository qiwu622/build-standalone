[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$PreviousLocation = Get-Location
try {
  Set-Location -LiteralPath $ProjectRoot
  & node scripts/control.mjs stop
  if ($LASTEXITCODE -ne 0) { throw '未确认停止，拒绝备份浏览器运行资料' }
  $DataPath = (& node scripts/config-path.mjs | Select-Object -Last 1)
  if ($LASTEXITCODE -ne 0) { throw '无法读取配置' }
  $DestinationPath = [IO.Path]::GetFullPath($Destination)
  if ($DestinationPath.StartsWith([IO.Path]::GetFullPath($DataPath)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw '备份目标不能放在数据目录内部' }
  if (Test-Path -LiteralPath $DestinationPath) { throw '备份目标已存在，不覆盖' }
  New-Item -ItemType Directory -Path $DestinationPath | Out-Null
  $CurrentUserSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $DestinationPath '/inheritance:r' '/grant:r' ('*' + $CurrentUserSid + ':(OI)(CI)F') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw '设置备份目录权限失败' }
  Copy-Item -LiteralPath $DataPath -Destination (Join-Path $DestinationPath 'data') -Recurse
  if (Test-Path -LiteralPath (Join-Path $ProjectRoot 'config.json')) { Copy-Item -LiteralPath (Join-Path $ProjectRoot 'config.json') -Destination $DestinationPath }
  Write-Host ('私有备份完成：' + $DestinationPath + '。包含密钥和登录资料，请勿放进发布包。')
} finally { Set-Location -LiteralPath $PreviousLocation.Path }
