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
  $Releases = Get-Content -Raw -Encoding UTF8 -LiteralPath $IndexPath | ConvertFrom-Json
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
function Initialize-BuildRuntime([string]$ProjectDirectory) {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $InstallRoot = [IO.Path]::GetFullPath($ProjectDirectory)
  $StageRoot = Join-Path $InstallRoot ('work\runtime-setup-' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force -Path $StageRoot | Out-Null
  return (Ensure-Node)
}