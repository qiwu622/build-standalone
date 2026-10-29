[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
$ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$DestinationPath = [IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $DestinationPath) { throw '发布文件已存在，请使用新文件名' }
$Allowed = @('src','public','scripts','tests','extensions','docs','licenses','package.json','package-lock.json','manifest.json','config.example.json','README.md','CHANGELOG.md','LICENSE','THIRD_PARTY_NOTICES.md','.gitignore')
$Items = foreach ($Name in $Allowed) {
  $Path = Join-Path $ProjectRoot $Name
  if (-not (Test-Path -LiteralPath $Path)) { throw ('缺少发布文件：' + $Name) }
  $Entry = Get-Item -LiteralPath $Path -Force
  if (($Entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '发布源不能包含链接' }
  if ($Entry.PSIsContainer) {
    foreach ($Child in (Get-ChildItem -LiteralPath $Path -Recurse -Force)) {
      if (($Child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw '发布源不能包含链接' }
    }
  }
  $Path
}
# Windows PowerShell 5.1 Compress-Archive uses backslashes in ZIP entries.
# Emit forward-slash names so Linux unzip creates the same directory tree.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Archive = [IO.Compression.ZipFile]::Open($DestinationPath,[IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($Item in $Items) {
    $Files = if (Test-Path -LiteralPath $Item -PathType Container) { @(Get-ChildItem -LiteralPath $Item -Recurse -Force -File) } else { @(Get-Item -LiteralPath $Item -Force) }
    foreach ($File in $Files) {
      $EntryName = $File.FullName.Substring($ProjectRoot.Length + 1).Replace('\','/')
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($Archive,$File.FullName,$EntryName,[IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
  }
} finally { $Archive.Dispose() }
$Hash = (Get-FileHash -LiteralPath $DestinationPath -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath ($DestinationPath + '.sha256') -Value ($Hash + '  ' + [IO.Path]::GetFileName($DestinationPath)) -Encoding ascii
Write-Host ('发布包：' + $DestinationPath)
Write-Host ('SHA256：' + $Hash)
