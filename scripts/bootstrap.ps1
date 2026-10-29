[CmdletBinding()]
param(
  [string]$InstallDirectory = (Join-Path $env:LOCALAPPDATA 'BuildStandalone'),
  [ValidateRange(0,65535)][int]$Port = 0,
  [ValidatePattern('^(main|[0-9a-f]{40})$')][string]$Ref = 'main',
  [switch]$RunTests,
  [switch]$NoOpen,
  [switch]$NoShortcut
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'
$Repository = 'qiwu622/build-standalone'
$InstallRoot = [IO.Path]::GetFullPath($InstallDirectory).TrimEnd('\','/')
$MarkerPath = Join-Path $InstallRoot 'work\bootstrap-install.json'
$StageRoot = Join-Path ([IO.Path]::GetTempPath()) ('BuildStandalone-setup-' + [guid]::NewGuid().ToString('N'))
$PreviousLocation = Get-Location
$PreviousPath = $env:PATH
$Utf8 = New-Object Text.UTF8Encoding $false

function Get-Download([string]$Url, [string]$Destination) {
  for ($Attempt = 1; $Attempt -le 3; $Attempt++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination -TimeoutSec 90 -Headers @{'User-Agent'='BuildStandalone-Setup'}
      return
    } catch {
      if ($Attempt -eq 3) { throw ('下载失败：' + $Url + '。请确认本机能访问 GitHub、nodejs.org 和 npm。') }
      Start-Sleep -Seconds $Attempt
    }
  }
}
function Expand-SafeZip([string]$ArchivePath, [string]$Destination) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $Archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    $Prefix = [IO.Path]::GetFullPath($Destination).TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
    foreach ($Entry in $Archive.Entries) {
      $Name = $Entry.FullName.Replace('/',[IO.Path]::DirectorySeparatorChar)
      $Resolved = [IO.Path]::GetFullPath((Join-Path $Destination $Name))
      if ($Name.Contains(':') -or [IO.Path]::IsPathRooted($Name) -or -not $Resolved.StartsWith($Prefix,[StringComparison]::OrdinalIgnoreCase)) { throw '压缩包包含越界路径' }
      if ((($Entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw '压缩包不能包含符号链接' }
    }
  } finally { $Archive.Dispose() }
  Expand-Archive -LiteralPath $ArchivePath -DestinationPath $Destination
}
function Find-Node {
  $Candidates = @()
  $Existing = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($Existing) { $Candidates += $Existing.Source }
  $RuntimeRoot = Join-Path $InstallRoot 'work\runtime'
  if (Test-Path -LiteralPath $RuntimeRoot) { $Candidates += @(Get-ChildItem -LiteralPath $RuntimeRoot -Directory | ForEach-Object { Join-Path $_.FullName 'node.exe' }) }
  foreach ($Candidate in $Candidates) {
    if ((Test-Path -LiteralPath $Candidate) -and (Test-Path -LiteralPath (Join-Path (Split-Path $Candidate) 'npm.cmd'))) {
      $Version = (& $Candidate --version | Select-Object -Last 1)
      if ($LASTEXITCODE -eq 0 -and $Version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 22) { return $Candidate }
    }
  }
  return $null
}
function Ensure-Node {
  $Found = Find-Node
  if ($Found) { return $Found }
  Write-Host '未找到 Node.js 22+，正在从 nodejs.org 安装便携版 Node.js 24 LTS…'
  $Architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  $NodeArch = switch ($Architecture) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { throw '仅支持 Windows x64 / ARM64' } }
  $IndexPath = Join-Path $StageRoot 'node-index.json'
  Get-Download 'https://nodejs.org/dist/index.json' $IndexPath
  $Releases = Get-Content -Raw -LiteralPath $IndexPath | ConvertFrom-Json
  $Release = $Releases | Where-Object { $_.version -match '^v24\.\d+\.\d+$' -and $_.lts -and $_.files -contains ('win-' + $NodeArch + '-zip') } | Select-Object -First 1
  if (-not $Release) { throw '官网没有返回匹配的 Node.js 24 LTS 版本' }
  $NodeName = 'node-' + $Release.version + '-win-' + $NodeArch
  $ArchiveName = $NodeName + '.zip'
  $NodeUrl = 'https://nodejs.org/dist/' + $Release.version + '/'
  $NodeZip = Join-Path $StageRoot $ArchiveName
  $Hashes = Join-Path $StageRoot 'SHASUMS256.txt'
  Get-Download ($NodeUrl + $ArchiveName) $NodeZip
  Get-Download ($NodeUrl + 'SHASUMS256.txt') $Hashes
  $HashLine = Get-Content -LiteralPath $Hashes | Where-Object { $_ -match ('^[0-9a-f]{64}\s+' + [regex]::Escape($ArchiveName) + '$') } | Select-Object -First 1
  if (-not $HashLine -or (Get-FileHash -LiteralPath $NodeZip -Algorithm SHA256).Hash -ine ($HashLine -split '\s+')[0]) { throw 'Node.js 下载校验失败，已停止' }
  $RuntimeStage = Join-Path $StageRoot 'node'
  Expand-SafeZip $NodeZip $RuntimeStage
  $RuntimeRoot = Join-Path $InstallRoot 'work\runtime'
  New-Item -ItemType Directory -Force -Path $RuntimeRoot | Out-Null
  Copy-Item -LiteralPath (Join-Path $RuntimeStage $NodeName) -Destination $RuntimeRoot -Recurse -Force
  return (Join-Path $RuntimeRoot ($NodeName + '\node.exe'))
}
function Find-FreePort([int]$Requested) {
  $Ports = if ($Requested) { @($Requested) } else { @(8787..8887) }
  foreach ($Candidate in $Ports) {
    $Listener = New-Object Net.Sockets.TcpListener ([Net.IPAddress]::Loopback),$Candidate
    try { $Listener.Start(); return $Candidate } catch { } finally { $Listener.Stop() }
  }
  throw '没有可用端口，请指定其他 -Port；不会关闭占用端口的程序'
}
try {
  if ($env:BUILD_CONFIG) { throw '当前终端设置了 BUILD_CONFIG。请使用未设置该变量的新终端安装，避免操作其他实例。' }
  if ($InstallRoot -eq [IO.Path]::GetPathRoot($InstallRoot).TrimEnd('\','/')) { throw '安装目录不能是磁盘根目录' }
  $OldMarker = $null
  if (Test-Path -LiteralPath $InstallRoot) {
    $Target = Get-Item -LiteralPath $InstallRoot -Force
    if (-not $Target.PSIsContainer -or ($Target.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '安装目录不能是文件或目录链接' }
    if (Test-Path -LiteralPath (Join-Path $InstallRoot '.git')) { throw '目标是 Git 工作区；请换一个空目录，避免覆盖源码修改' }
    if (Test-Path -LiteralPath $MarkerPath) {
      $OldMarker = Get-Content -Raw -LiteralPath $MarkerPath | ConvertFrom-Json
      if ($OldMarker.repository -ne $Repository -or $OldMarker.installRoot -ne $InstallRoot) { throw '安装目录标记不匹配，已停止' }
    } elseif (@(Get-ChildItem -LiteralPath $InstallRoot -Force).Count) { throw '目标目录已有其他文件。请指定空目录，或使用项目自带的升级脚本。' }
  }
  New-Item -ItemType Directory -Path $StageRoot | Out-Null
  Write-Host '正在从 GitHub 获取最新版 Build Standalone…'
  $CommitPath = Join-Path $StageRoot 'commit.json'
  Get-Download ('https://api.github.com/repos/' + $Repository + '/commits/' + $Ref) $CommitPath
  $Commit = (Get-Content -Raw -LiteralPath $CommitPath | ConvertFrom-Json).sha
  if ($Commit -notmatch '^[0-9a-f]{40}$') { throw 'GitHub 返回的版本编号无效' }
  $SourceZip = Join-Path $StageRoot 'source.zip'
  Get-Download ('https://codeload.github.com/' + $Repository + '/zip/' + $Commit) $SourceZip
  $Extracted = Join-Path $StageRoot 'source'
  Expand-SafeZip $SourceZip $Extracted
  $Folders = @(Get-ChildItem -LiteralPath $Extracted -Directory)
  if ($Folders.Count -ne 1) { throw 'GitHub 源码目录结构异常' }
  $SourceRoot = $Folders[0].FullName
  if ((Get-Content -Raw -LiteralPath (Join-Path $SourceRoot 'package.json') | ConvertFrom-Json).name -ne 'build-standalone') { throw '下载的项目身份不匹配' }
  if (-not (Test-Path -LiteralPath (Join-Path $SourceRoot 'scripts\start-windows.ps1'))) { throw '此 GitHub 版本尚不支持一键安装' }
  New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
  if (-not $OldMarker) {
    Get-ChildItem -LiteralPath $SourceRoot -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $InstallRoot -Recurse }
    New-Item -ItemType Directory -Force -Path (Split-Path $MarkerPath) | Out-Null
    [IO.File]::WriteAllText($MarkerPath,(@{repository=$Repository;installRoot=$InstallRoot;commit=$Commit;complete=$false} | ConvertTo-Json),$Utf8)
  }
  $Node = Ensure-Node
  $env:PATH = (Split-Path $Node) + [IO.Path]::PathSeparator + $env:PATH
  Set-Location -LiteralPath $InstallRoot
  $ExistingDataPath = $null
  if ($OldMarker -and (Test-Path -LiteralPath (Join-Path $InstallRoot 'config.json'))) {
    $ExistingDataPath = (& $Node scripts/config-path.mjs | Select-Object -Last 1)
    if ($LASTEXITCODE -ne 0) { throw '无法解析现有实例的数据目录，已停止更新' }
  }
  if ($ExistingDataPath -and (Test-Path -LiteralPath (Join-Path $ExistingDataPath 'service.lock'))) {
    $StatusOutput = & $Node scripts/control.mjs status
    if ($LASTEXITCODE -ne 0) { throw '无法确认现有实例身份，已停止更新' }
    $Status = $StatusOutput | ConvertFrom-Json
    if ($Status.busy -or $Status.queued) { throw '当前有调用执行或排队，请结束后再更新' }
  }
  if ($OldMarker -and $OldMarker.commit -ne $Commit) {
    Write-Host '正在备份旧源码并更新；保留账号、配置和密钥…'
    & (Join-Path $SourceRoot 'scripts\upgrade.ps1') -ReleaseDirectory $SourceRoot -TargetDirectory $InstallRoot -SkipTests:(!$RunTests)
  } elseif (-not $OldMarker -or -not $OldMarker.complete -or -not (Test-Path -LiteralPath (Join-Path $InstallRoot 'node_modules'))) {
    $ConfigPath = Join-Path $InstallRoot 'config.json'
    if (-not (Test-Path -LiteralPath $ConfigPath)) {
      $Config = Get-Content -Raw -LiteralPath (Join-Path $InstallRoot 'config.example.json') | ConvertFrom-Json
      $Config.port = Find-FreePort $Port
      $Config.publicOrigin = 'http://127.0.0.1:' + $Config.port
      [IO.File]::WriteAllText($ConfigPath,($Config | ConvertTo-Json -Depth 10),$Utf8)
    }
    & (Join-Path $InstallRoot 'scripts\install.ps1') -SkipTests:(!$RunTests)
  }
  [IO.File]::WriteAllText($MarkerPath,(@{repository=$Repository;installRoot=$InstallRoot;commit=$Commit;complete=$true} | ConvertTo-Json),$Utf8)
  if (-not $NoShortcut) {
    $ShortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Build Standalone.lnk'
    $Shell = New-Object -ComObject WScript.Shell
    $Shortcut = $Shell.CreateShortcut($ShortcutPath)
    $Launcher = Join-Path $InstallRoot 'scripts\start-windows.ps1'
    if ((Test-Path -LiteralPath $ShortcutPath) -and $Shortcut.Arguments -notlike ('*' + $Launcher + '*')) {
      Write-Host '桌面已有同名快捷方式，已保留；可直接运行 scripts\start-windows.ps1。'
    } else {
      $Shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      $Shortcut.Arguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $Launcher + '"'
      $Shortcut.WorkingDirectory = $InstallRoot
      $Shortcut.WindowStyle = 7
      $Shortcut.Save()
    }
  }
  & (Join-Path $InstallRoot 'scripts\start-windows.ps1') -NoOpen:$NoOpen
  Write-Host ('安装目录：' + $InstallRoot)
  Write-Host ('GitHub 版本：' + $Commit.Substring(0,12))
  Write-Host '接下来只需在常用浏览器安装一次本机连接器，再点击管理页的“登录并自动接入”。'
} finally {
  Set-Location -LiteralPath $PreviousLocation
  $env:PATH = $PreviousPath
  if (Test-Path -LiteralPath $StageRoot) {
    $ResolvedStage = (Get-Item -LiteralPath $StageRoot -Force).FullName
    $ExpectedParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
    if ((Split-Path $ResolvedStage) -eq $ExpectedParent -and (Split-Path $ResolvedStage -Leaf) -match '^BuildStandalone-setup-[0-9a-f]{32}$' -and -not ((Get-Item -LiteralPath $ResolvedStage).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      Remove-Item -LiteralPath $ResolvedStage -Recurse -Force
    }
  }
}
