# SPDX-License-Identifier: MIT
# ONE runtime: ROD mempool/ZMQ as the world-event path, Nostr (the built-in relay plus operator relays listed on
# ROD) for discovery, the live lane and slow recovery, a persistent local OSG, and the native Metaverse.
#   -CreateUniverse  owner only: register a new universe from OSGSim\realm-authority.json, then exit
#   -Relay <ip|name.rod|wss://host/>  join an operator relay; -RelayPort <n>; -NoRelay (do not run the built-in relay)
param(
 [switch]$CreateUniverse,
 [string]$Relay='',
 [int]$RelayPort=0,
 [switch]$NoRelay,
 [string]$Universe='',
 [switch]$ChooseUniverse,
 [switch]$ListUniverses,
 [switch]$Preflight,
 [switch]$BuildNative,
 [string]$SdkInclude='',
 [string]$CoreImportLib=''
)
$ErrorActionPreference='Stop'
$root=Split-Path -Parent $MyInvocation.MyCommand.Path
$node=(Get-Command node.exe -ErrorAction Stop).Source
# Node, pyzmq, release integrity, engine, runtime syntax and the ZMQ self-test run in one tested script.
& $node (Join-Path $root 'scripts/preflight.mjs') ('--root='+$root)
if($LASTEXITCODE -ne 0){throw 'SPEXGSP_PREFLIGHT_FAILED (see the FAIL line above)'}
$provision=Join-Path $root 'scripts/Ensure-OsgMulti-Local.ps1'
if(-not(Test-Path -LiteralPath $provision)){throw 'Pinned OSG Multi provisioner missing'}
& $provision -MetaverseRoot $root
$nativeDll=Join-Path $root 'Modules/Plugin/SpeXGSP.dll'
if($BuildNative){
 if(-not $SdkInclude -or -not $CoreImportLib){throw 'Matching Windows Metaverse SDK include and Core import library required for native build'}
 $build=Join-Path $root 'OSGSim/.data/spexgsp-rod-native-build'
 & cmake -S (Join-Path $root 'native/spexgsp-rod') -B $build -A x64 "-DSDK_INCLUDE=$SdkInclude" "-DCORE_IMPLIB=$CoreImportLib"
 if($LASTEXITCODE -ne 0){throw 'SpeXGSP CMake configuration failed'}
 & cmake --build $build --config Release
 if($LASTEXITCODE -ne 0){throw 'SpeXGSP native DLL compilation failed'}
 $compiled=Join-Path $build 'Release/SpeXGSP.dll'
 if(-not(Test-Path -LiteralPath $compiled)){throw 'Compiled SpeXGSP.dll not produced'}
 if(-not $Preflight){
  # Never overwrite the DLL of a running simulation.
  $inUse=Get-Process SpaceXpanse -ErrorAction SilentlyContinue
  if($inUse){throw 'Stop local Metaverse before installing a new native DLL'}
  Copy-Item -LiteralPath $compiled -Destination $nativeDll -Force
 }
}
if(-not(Test-Path -LiteralPath $nativeDll -PathType Leaf)){throw 'SpeXGSP.dll missing; compile the ROD-aware native DLL first'}
$entry=Join-Path $root 'OSGSim/scripts/spexgsp-rod-peer.mjs'
if($Preflight){Write-Host 'SPEXGSP_PREFLIGHT_OK (not a live DX9/ROD acceptance test)';exit 0}
# Starts spacexpansed from this folder when no ROD Core answers on the RPC port, and waits until its RPC is ready.
& $node (Join-Path $root 'scripts/start-rod-core.mjs') ('--root='+$root)
if($LASTEXITCODE -ne 0){throw 'SPEXGSP_ROD_CORE_NOT_READY (see the message above)'}
if($CreateUniverse){
 Push-Location $root
 try{& $node (Join-Path $root 'OSGSim/scripts/spexgsp-create-universe.mjs'); $exitCode=$LASTEXITCODE}
 finally{Pop-Location}
 if($exitCode -ne 0){throw ('SPEXGSP_CREATE_UNIVERSE_FAILED_'+$exitCode)}
 exit 0
}
$arguments=@()
if($Relay){$arguments+=('--relay='+$Relay)}
if($RelayPort -gt 0){$arguments+=('--relay-port='+$RelayPort)}
if($NoRelay){$arguments+='--no-relay'}
if($Universe){$arguments+=('--universe='+$Universe)}
if($ChooseUniverse){$arguments+='--choose'}
if($ListUniverses){$arguments+='--list-universes'}
Write-Host 'SPEXGSP: ROD P2P/ZMQ + built-in Nostr relay + persistent OSG + native Metaverse'
Push-Location $root
try{& $node $entry @arguments; $exitCode=$LASTEXITCODE}
finally{Pop-Location}
if($exitCode -ne 0){throw ('SPEXGSP_RUNTIME_FAILED_'+$exitCode)}
