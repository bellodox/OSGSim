# OSG Sim v0.2.1 Windows CMake fix

Extract this ZIP directly into your existing OSG Sim v0.2.1 repository root,
where package.json and the native directory are located. Allow replacement of
native/CMakeLists.txt, native/README.md and docs/WINDOWS_TESTING.md.
The ZIP has no enclosing directory. Keep your existing bridge source and wire header.

## Full setup and operation

Follow [docs/WINDOWS_SETUP.md](docs/WINDOWS_SETUP.md) for all prerequisites,
portable checks, the exact build command, DLL/scenario installation, live startup
with a shared token, verification, troubleshooting and optional OSG/browser setup.
The updated root README also links to that guide.

## Build

Install Visual Studio 2022 C++ build tools (Desktop development with C++, Windows
SDK) and CMake 3.19 or newer. Use the official Metaverse v0.1.6a x64 SDK.
From PowerShell in the repository root, adjusting the SDK path:

```powershell
powershell -ExecutionPolicy Bypass -File .\native\build-windows.ps1 -SdkDirectory "C:\Metaverse\SpaceXpansesdk"
```

The SDK directory must contain include/SpaceXpansesdk.h and lib/SpaceXpanse.lib.
The SDK and Visual Studio are external prerequisites, not included in this ZIP.
For another installed Visual Studio generator, pass -Generator with its exact
CMake name. Use a fresh native/build-windows-x64 directory when switching generators.

Output: native/build-windows-x64/Release/OSGSimBridge.dll.
Copy that DLL into your Metaverse installation's Modules/Plugin directory and
enable OSGSimBridge. Follow docs/WINDOWS_TESTING.md for live simulator checks.

## Change

The prebuilt SpaceXpansesdk.lib has debug iterator settings incompatible with
the Release bridge. CMake now compiles the unchanged pinned SpaceXpansesdk.cpp
helper alongside OSGSimBridge.cpp using the same runtime settings (/MT in Release).
It links only the official SpaceXpanse.lib and ws2_32. No linker mismatch
suppression is used. The obsolete SPACEXPANSE_SDK_IMPLIB setting is no longer needed.

The helper comes from Metaverse commit 3264a944196c48a39d14beab7dafdd10c6918461.
Its MIT license is included at native/LICENSE-Metaverse.txt.

This overlay contains build files, the SDK helper, its license, and updated
instructions. It contains no prebuilt DLL. Its Windows CMake build and simulator
load have not been executed in the Linux packaging environment.
