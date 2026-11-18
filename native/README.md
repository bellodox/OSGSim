# Metaverse bridge: unverified native source

This is source code for a Windows x64 SDK module following `Src/Plugin/FlightData/FlightData.cpp` in Metaverse commit `3264a944196c48a39d14beab7dafdd10c6918461` (release v0.1.6a). No upstream sources are modified.

The bridge reads `VESSEL::GroundContact()` strictly from `clbkPostStep`, after the simulator has accepted the physical step. It publishes physical samples over localhost TCP port 4378. The world-service detects false/true transitions and journals resulting contact events. Any bridge queue overflow or network send error invalidates the capture rather than silently dropping data.

The bridge is read-only. The separately supplied v0.2.1 DLL was compiled and
its imports inspected, but actual simulator loading and callbacks remain unverified.
The updated CMake build in this overlay has not been executed on Windows here.

For complete setup and operation, see [../docs/WINDOWS_SETUP.md](../docs/WINDOWS_SETUP.md).

## Build on Windows

Use Visual Studio 2022 C++ build tools, CMake 3.19 or newer, and the official
Metaverse v0.1.6a x64 SDK. From the repository root:

```powershell
powershell -ExecutionPolicy Bypass -File .\native\build-windows.ps1 -SdkDirectory "C:\Metaverse\SpaceXpansesdk"
```

Adjust the SDK path to your installation. It must contain include/SpaceXpansesdk.h
and lib/SpaceXpanse.lib. Output: native/build-windows-x64/Release/OSGSimBridge.dll.
For another Visual Studio version, pass -Generator with its installed CMake generator name.

CMake compiles the included, unchanged SpaceXpansesdk.cpp helper with the bridge
and links SpaceXpanse.lib plus ws2_32. Do not link the prebuilt SpaceXpansesdk.lib:
its debug iterator settings conflict with the Release plugin. Release uses /MT.
The helper is licensed under native/LICENSE-Metaverse.txt.

Copy the DLL to the simulator's Modules/Plugin directory and enable OSGSimBridge.
Start the Node world-service first, then the simulator. Capture actual DLL load,
contact and physics comparison logs before classifying R04–R06.

Known limitations: no network reconnect synchronization after server restart, no validated spacecraft control, no persistent native run across crashes, no native CI. There is an explicit native acceptance checklist in `docs/WINDOWS_TESTING.md`.
