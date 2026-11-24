# SPDX-License-Identifier: MIT
# Local, noninteractive check of the OSG Multi folder that belongs to this installation. Nothing is downloaded or
# cloned: the folder is the one prepared for this setup (OmniSpatialGraph-multi next to this script's root, or
# under OSGSim\, or the path in OSG_MULTI_SOURCE_DIR). The audited files in
# dependencies\OmniSpatialGraph-multi-Audit-Fixes.zip must be present in it; the script builds it when the
# compiled output is missing. It never edits ROD wallets.
param([Parameter(Mandatory=$true)][string]$MetaverseRoot)
$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath $MetaverseRoot).Path
$patch=Join-Path $root 'dependencies\OmniSpatialGraph-multi-Audit-Fixes.zip'
if(-not(Test-Path -LiteralPath $patch -PathType Leaf)){throw 'OSG Multi audited patch archive missing'}
$primary=Join-Path $root 'OmniSpatialGraph-multi'
$secondary=Join-Path $root 'OSGSim\OmniSpatialGraph-multi'
$dest=if($env:OSG_MULTI_SOURCE_DIR){$env:OSG_MULTI_SOURCE_DIR}elseif(Test-Path -LiteralPath $primary){$primary}elseif(Test-Path -LiteralPath $secondary){$secondary}else{''}
if(-not $dest -or -not(Test-Path -LiteralPath $dest -PathType Container)){throw ('OSG Multi folder not found. Put it at '+$primary+' (or '+$secondary+'), or set OSG_MULTI_SOURCE_DIR. Nothing is downloaded.')}
$hasGit=Test-Path -LiteralPath (Join-Path $dest '.git')
$git=(Get-Command git.exe -ErrorAction SilentlyContinue).Source
$np=(Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
$stage=Join-Path $env:TEMP ('spexgsp-osg-verify-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $stage | Out-Null
$updated=$false
try{
 Expand-Archive -LiteralPath $patch -DestinationPath $stage -Force
 $files=@(Get-ChildItem -LiteralPath $stage -File -Recurse)
 if($files.Count -ne 12){throw 'OSG Multi audit archive contains an unexpected number of files'}
 foreach($file in $files){
  $relative=$file.FullName.Substring($stage.Length+1)
  $target=Join-Path $dest $relative
  $want=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash
  $have=if(Test-Path -LiteralPath $target -PathType Leaf){(Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash}else{''}
  if($have -eq $want){continue}
  # A differing audited file is replaced only when git proves the folder holds no local change to it.
  if(-not $hasGit){throw ('OSG Multi is not the audited version: '+$relative+' differs from dependencies\OmniSpatialGraph-multi-Audit-Fixes.zip. Folder: '+$dest)}
  if(-not $git){throw 'git is required to check OSG Multi for local modifications (install Git for Windows)'}
  $status=@(& $git -C $dest status --porcelain -- $relative.Replace('\','/'))
  if($LASTEXITCODE -ne 0){throw 'Unable to verify OSG Multi source integrity'}
  if($status.Count -gt 0){throw ('OSG Multi has conflicting local modifications: '+$relative)}
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
  Copy-Item -LiteralPath $file.FullName -Destination $target -Force
  $updated=$true
 }
}finally{Remove-Item -LiteralPath $stage -Force -Recurse -ErrorAction SilentlyContinue}
$core=Join-Path $dest 'dist\core\src\index.js'
$lance=Join-Path $dest 'dist\storage-lance\src\index.js'
$audited=Join-Path $dest 'dist\core\src\participation.js'
if($updated -or -not(Test-Path -LiteralPath $core) -or -not(Test-Path -LiteralPath $lance) -or -not(Test-Path -LiteralPath $audited)){
 if(-not $np){throw 'npm is required to build OSG Multi (install Node.js with npm)'}
 Push-Location $dest
 try{
  & $np ci --no-audit --no-fund
  if($LASTEXITCODE -ne 0){throw 'OSG Multi dependency installation failed'}
  & $np run build
  if($LASTEXITCODE -ne 0){throw 'OSG Multi TypeScript build failed'}
  & $np run typecheck
  if($LASTEXITCODE -ne 0){throw 'OSG Multi typecheck failed'}
 }finally{Pop-Location}
}
foreach($file in @($core,$lance,$audited)){if(-not(Test-Path -LiteralPath $file -PathType Leaf)){throw ('OSG Multi compiled output unavailable: '+$file)}}
Write-Output ('SPEXGSP_OSG_MULTI_READY '+$dest)
