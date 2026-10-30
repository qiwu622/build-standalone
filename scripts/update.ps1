[CmdletBinding()]
param(
  [string]$TargetDirectory,
  [string]$SourceDirectory,
  [switch]$CheckOnly,
  [switch]$SkipTests,
  [switch]$NoOpen
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
$OutputEncoding = [Console]::OutputEncoding
$PreviousPath = $env:PATH
$PreviousLocation = Get-Location
$Root = if ($TargetDirectory) { [IO.Path]::GetFullPath($TargetDirectory) } else { [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..')) }
$Root = $Root.TrimEnd('\','/')
$Repository = 'qiwu622/build-standalone'
$Utf8 = New-Object Text.UTF8Encoding $false
$Allowed = @('src','public','scripts','tests','extensions','docs','licenses','install.cmd','start.cmd','update.cmd','package.json','package-lock.json','manifest.json','config.example.json','README.md','CHANGELOG.md','LICENSE','THIRD_PARTY_NOTICES.md','.gitignore')
$Stage = Join-Path ([IO.Path]::GetTempPath()) ('BuildStandalone-update-' + [guid]::NewGuid().ToString('N'))
$Guard = $null
$Cutover = $false
$WasRunning = $false
$GitChanged = $false
$Backup = $null

function Assert-PlainTree([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $Item = Get-Item -LiteralPath $Path -Force
  if ($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('更新路径不能是目录链接：' + $Path) }
  if ($Item.PSIsContainer) {
    foreach ($Child in (Get-ChildItem -LiteralPath $Path -Force -Recurse)) {
      if ($Child.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('更新目录包含链接：' + $Child.FullName) }
    }
  }
}
function Get-State {
  if (-not (Test-Path -LiteralPath (Join-Path $Root 'config.json'))) { return $null }
  $Output = & $Node (Join-Path $Root 'scripts\control.mjs') status
  if ($LASTEXITCODE -ne 0) { throw '无法确认当前服务状态，未更新。请先运行 start.cmd 恢复服务状态。' }
  $Text = ($Output -join "`n").Trim()
  if ($Text.StartsWith('{')) { return ($Text | ConvertFrom-Json) }
  return $null
}
function Assert-Idle {
  $State = Get-State
  if ($State -and ($State.busy -or $State.queued)) { throw '有请求执行或排队，更新已停止。等调用结束后再次双击 update.cmd。' }
  return $State
}
function Assert-CleanGit {
  $Changes = & git -C $Root status --porcelain --untracked-files=normal
  if ($LASTEXITCODE -ne 0) { throw 'Git 状态检查失败' }
  if ($Changes) { throw '开发目录有未提交或未跟踪的修改，已停止自动更新以保护它们；请先提交或自行保存这些修改。' }
}
function Replace-Tree([string]$From,[string]$Name) {
  $Destination = [IO.Path]::GetFullPath((Join-Path $Root $Name))
  if (-not $Destination.StartsWith($Root + '\',[StringComparison]::OrdinalIgnoreCase) -or $Name -notin ($Allowed + @('node_modules'))) { throw '更新目标路径越界' }
  Assert-PlainTree $Destination
  if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Recurse -Force }
  $New = Join-Path $From $Name
  if (Test-Path -LiteralPath $New) { Copy-Item -LiteralPath $New -Destination $Destination -Recurse }
}
try {
  if ($env:BUILD_CONFIG) { throw '请在未设置 BUILD_CONFIG 的终端更新，避免操作其他实例。' }
  if ($Root -eq [IO.Path]::GetPathRoot($Root).TrimEnd('\','/')) { throw '更新目录不能是磁盘根目录' }
  if ((Get-Item -LiteralPath $Root -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw '项目目录不能是目录链接' }
  $CurrentPackage = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $Root 'package.json') | ConvertFrom-Json
  if ($CurrentPackage.name -ne 'build-standalone') { throw '目标不是 Build Standalone 项目' }
  $IsGit = Test-Path -LiteralPath (Join-Path $Root '.git')
  if ($IsGit -and -not $CheckOnly) { Assert-CleanGit }
  if ($IsGit -and $SourceDirectory) { throw 'Git 工作区不接受离线覆盖；请通过 GitHub 快进更新。' }
  . (Join-Path $PSScriptRoot 'runtime-windows.ps1')
  $InstallRoot = $Root
  $Node = Find-Node
  if (-not $Node) { throw '未找到 Node.js 22+，请先运行 install.cmd。' }
  $env:PATH = (Split-Path $Node) + [IO.Path]::PathSeparator + $env:PATH
  Set-Location -LiteralPath $Root
  $State = Assert-Idle
  $WasRunning = [bool]$State
  $Commit = $null
  if ($SourceDirectory) {
    $Source = (Resolve-Path -LiteralPath $SourceDirectory).Path.TrimEnd('\','/')
  } else {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Write-Host '正在检查 GitHub main 的最新版本…'
    $Remote = Invoke-RestMethod -UseBasicParsing -Uri ('https://api.github.com/repos/' + $Repository + '/commits/main') -TimeoutSec 45 -Headers @{'User-Agent'='BuildStandalone-Updater'}
    $Commit = $Remote.sha
    if ($Commit -notmatch '^[0-9a-f]{40}$') { throw 'GitHub 返回的版本号无效' }
    Write-Host ('GitHub 最新提交：' + $Commit.Substring(0,12))
    if ($CheckOnly) { Write-Host '检查完成，没有下载覆盖源码、停止服务或调用模型。'; return }
  }
  if ($CheckOnly) { Write-Host ('离线候选目录：' + $Source); return }
  $Work = Join-Path $Root 'work'
  if ((Test-Path -LiteralPath $Work) -and ((Get-Item -LiteralPath $Work -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'work 不能是目录链接' }
  New-Item -ItemType Directory -Force -Path $Work | Out-Null
  $GuardPath = Join-Path $Work 'update.lock'
  $Guard = [IO.File]::Open($GuardPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
  New-Item -ItemType Directory -Path $Stage | Out-Null
  if ($IsGit) {
    $Origin = (& git -C $Root remote get-url origin | Select-Object -Last 1)
    if ($LASTEXITCODE -ne 0 -or $Origin -notin @('https://github.com/qiwu622/build-standalone.git','https://github.com/qiwu622/build-standalone','git@github.com:qiwu622/build-standalone.git')) { throw 'Git origin 与本项目不匹配，未更新' }
    $Branch = (& git -C $Root branch --show-current | Select-Object -Last 1)
    if ($Branch -ne 'main') { throw '自动更新仅支持 main 分支；其他分支请自行合并。' }
    $OldCommit = (& git -C $Root rev-parse HEAD | Select-Object -Last 1)
    if ($OldCommit -eq $Commit) { Write-Host '已经是最新版，无需更新。'; return }
    & git -C $Root fetch --no-tags origin main
    if ($LASTEXITCODE -ne 0) { throw 'Git 下载失败，未改动运行版本' }
    & git -C $Root merge-base --is-ancestor $OldCommit $Commit
    if ($LASTEXITCODE -ne 0) { throw '本地提交领先或与 GitHub 分叉，不能自动快进；未覆盖本地提交。' }
    $Zip = Join-Path $Stage 'source.zip'
    & git -C $Root archive --format=zip ('--output=' + $Zip) $Commit
    if ($LASTEXITCODE -ne 0) { throw '候选源码导出失败' }
    $Source = Join-Path $Stage 'candidate'
    Expand-SafeZip $Zip $Source
  } elseif (-not $SourceDirectory) {
    $Zip = Join-Path $Stage 'source.zip'
    Get-Download ('https://codeload.github.com/' + $Repository + '/zip/' + $Commit) $Zip
    $Extracted = Join-Path $Stage 'extracted'
    Expand-SafeZip $Zip $Extracted
    $Folders = @(Get-ChildItem -LiteralPath $Extracted -Directory)
    if ($Folders.Count -ne 1) { throw '源码压缩包结构异常' }
    $Source = $Folders[0].FullName
  }
  if ($Source -eq $Root -or $Source.StartsWith($Root+'\',[StringComparison]::OrdinalIgnoreCase) -or $Root.StartsWith($Source+'\',[StringComparison]::OrdinalIgnoreCase)) { throw '候选目录与安装目录不能相同或相互嵌套' }
  Assert-PlainTree $Source
  $NextPackage = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $Source 'package.json') | ConvertFrom-Json
  if ($NextPackage.name -ne 'build-standalone') { throw '候选源码身份不匹配' }
  if ([version]$NextPackage.version -lt [version]$CurrentPackage.version) { throw 'GitHub 版本比本机旧，已阻止降级。' }
  foreach ($Required in @('src\main.mjs','scripts\control.mjs','scripts\start-windows.ps1','package-lock.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Source $Required) -PathType Leaf)) { throw ('候选源码缺少：' + $Required) }
  }
  # Keep caller-owned offline release files untouched during dependency checks.
  if ($SourceDirectory) {
    $Candidate = Join-Path $Stage 'candidate'
    New-Item -ItemType Directory -Path $Candidate | Out-Null
    foreach ($Name in $Allowed) { $Item=Join-Path $Source $Name; if(Test-Path -LiteralPath $Item){Copy-Item -LiteralPath $Item -Destination $Candidate -Recurse} }
    $Source = $Candidate
  }
  Write-Host '正在临时目录安装依赖并检查新版；当前服务继续运行…'
  Set-Location -LiteralPath $Source
  & npm.cmd ci --ignore-scripts --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw '新版依赖安装失败，当前版本未被替换' }
  if (-not $SkipTests) {
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw '新版自动测试失败，当前版本未被替换' }
  }
  Set-Location -LiteralPath $Root
  $State = Assert-Idle
  if ($IsGit) {
    Assert-CleanGit
    if ((& git -C $Root rev-parse HEAD | Select-Object -Last 1) -ne $OldCommit -or (& git -C $Root branch --show-current | Select-Object -Last 1) -ne $Branch) { throw '检查期间本地分支或提交发生变化，已停止更新' }
  }
  foreach ($Name in ($Allowed + @('node_modules'))) { Assert-PlainTree (Join-Path $Root $Name) }
  $DataPath = (& $Node scripts/config-path.mjs | Select-Object -Last 1)
  if ($LASTEXITCODE -ne 0) { throw '无法解析数据目录' }
  foreach ($Name in @('src','public','scripts','tests','extensions','docs','licenses','node_modules')) {
    $CodeRoot = Join-Path $Root $Name
    if ($DataPath -eq $CodeRoot -or $DataPath.StartsWith($CodeRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw '数据目录位于将被更新的源码目录中，已停止以保护数据' }
  }
  $WasRunning = [bool]$State
  if ($State) { & $Node scripts/control.mjs stop --if-idle; if ($LASTEXITCODE -ne 0) { throw '服务没有安全停止，未替换源码' } }
  $Backup = Join-Path $Work ('update-backup-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $Backup | Out-Null
  foreach ($Name in ($Allowed + @('node_modules'))) { $Item=Join-Path $Root $Name; if(Test-Path -LiteralPath $Item){Copy-Item -LiteralPath $Item -Destination $Backup -Recurse} }
  $Cutover = $true
  if ($IsGit) {
    & git -C $Root merge --ff-only $Commit
    if ($LASTEXITCODE -ne 0) { throw 'Git 快进失败' }
    $GitChanged = $true
  } else {
    foreach ($Name in $Allowed) { Replace-Tree $Source $Name }
  }
  Replace-Tree $Source 'node_modules'
  & $Node scripts/control.mjs start
  if ($LASTEXITCODE -ne 0) { throw '新版服务启动失败' }
  $Verified = Get-State
  if (-not $Verified.running) { throw '新版服务启动后未确认在线' }
  $Receipt = @{repository=$Repository;commit=$Commit;version=$NextPackage.version;updatedAt=(Get-Date).ToUniversalTime().ToString('o');backup=$Backup}
  [IO.File]::WriteAllText((Join-Path $Work 'last-update.json'),($Receipt | ConvertTo-Json),$Utf8)
  $Marker = Join-Path $Work 'bootstrap-install.json'
  if ($Commit -and (Test-Path -LiteralPath $Marker)) {
    $OldMarker = Get-Content -Raw -Encoding UTF8 -LiteralPath $Marker | ConvertFrom-Json
    if ($OldMarker.repository -eq $Repository -and $OldMarker.installRoot -eq $Root) { $OldMarker.commit=$Commit; $OldMarker.complete=$true; [IO.File]::WriteAllText($Marker,($OldMarker | ConvertTo-Json),$Utf8) }
  }
  $Cutover = $false
  Write-Host ('更新完成：' + $CurrentPackage.version + ' → ' + $NextPackage.version)
  Write-Host ('源码与依赖备份：' + $Backup)
  Write-Host '账号、密钥、配置和连接授权均保留。新版已启动。'
  Write-Host '若浏览器连接器版本改变，请在扩展管理页重新加载一次；之后恢复已配对项目。'
  if (-not $NoOpen) { Start-Process ($Verified.url + '/?reconnect=1') }
} catch {
  $Failure = $_
  if ($Cutover -and $Backup) {
    Write-Host '更新未通过，正在恢复旧源码与依赖…'
    try {
      Set-Location -LiteralPath $Root
      & $Node scripts/control.mjs stop --if-idle
      if ($LASTEXITCODE -ne 0) { throw '无法确认新版服务已经停止，未覆盖运行中的文件' }
      if ($GitChanged) {
        if ((& git -C $Root rev-parse HEAD | Select-Object -Last 1) -ne $Commit) { throw 'Git 提交发生额外变化，未自动回退' }
        & git -C $Root reset --keep $OldCommit
        if ($LASTEXITCODE -ne 0) { throw 'Git 保留修改回退失败' }
      } elseif (-not $IsGit) { foreach ($Name in $Allowed) { Replace-Tree $Backup $Name } }
      Replace-Tree $Backup 'node_modules'
      if ($WasRunning) { & $Node scripts/control.mjs start; if ($LASTEXITCODE -ne 0) { throw '旧版恢复后启动失败' } }
      Write-Host '旧版已恢复，账号与配置未改动。'
    } catch { Write-Host ('自动恢复未完成：' + $_.Exception.Message + '；备份位于 ' + $Backup) }
  } elseif ($WasRunning -and $Backup) {
    & $Node (Join-Path $Root 'scripts\control.mjs') start
  }
  throw $Failure
} finally {
  Set-Location -LiteralPath $PreviousLocation
  $env:PATH = $PreviousPath
  if ($Guard) { $Guard.Dispose(); Remove-Item -LiteralPath $GuardPath -Force }
  if (Test-Path -LiteralPath $Stage) {
    $ResolvedStage=(Get-Item -LiteralPath $Stage -Force).FullName
    $TempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
    if ((Split-Path $ResolvedStage) -eq $TempRoot -and (Split-Path $ResolvedStage -Leaf) -match '^BuildStandalone-update-[0-9a-f]{32}$') {
      Assert-PlainTree $ResolvedStage
      Remove-Item -LiteralPath $ResolvedStage -Recurse -Force
    }
  }
}
