param(
    [Parameter(Mandatory=$true)][string]$SdkDirectory,
    [string]$Generator = 'Visual Studio 17 2022'
)
$ErrorActionPreference = 'Stop'
if (!(Get-Command cmake.exe -ErrorAction SilentlyContinue)) {
    throw 'Install CMake 3.19 or newer and add it to PATH.'
}
$sdk = (Resolve-Path -LiteralPath $SdkDirectory).Path
$include = Join-Path $sdk 'include'
$coreLib = Join-Path $sdk 'lib\SpaceXpanse.lib'
if (!(Test-Path -LiteralPath (Join-Path $include 'SpaceXpansesdk.h')) -or
    !(Test-Path -LiteralPath $coreLib)) {
    throw 'Use the official Metaverse v0.1.6a x64 SpaceXpansesdk directory.'
}
$build = Join-Path $PSScriptRoot 'build-windows-x64'
& cmake.exe -S $PSScriptRoot -B $build -G $Generator -A x64 `
    "-DSPACEXPANSE_SDK_INCLUDE_DIR=$include" `
    "-DSPACEXPANSE_CORE_IMPLIB=$coreLib"
if ($LASTEXITCODE -ne 0) { throw "CMake configuration failed: $LASTEXITCODE" }
& cmake.exe --build $build --config Release
if ($LASTEXITCODE -ne 0) { throw "DLL build failed: $LASTEXITCODE" }
$dll = Join-Path $build 'Release\OSGSimBridge.dll'
if (!(Test-Path -LiteralPath $dll)) { throw "DLL not found: $dll" }
Get-FileHash -LiteralPath $dll -Algorithm SHA256
Write-Host "Built: $dll"
