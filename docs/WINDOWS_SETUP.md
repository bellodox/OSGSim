# OSG Sim v0.2.1: Windows setup and operation

Run commands in PowerShell from the repository root (the directory containing
package.json). Replace example installation paths with your real paths.

## 1. Apply this overlay

Extract OSG-Sim-v0.2.1-CMake-Fix-Overlay.zip directly over the existing v0.2.1
repository root and allow file replacement. Do not extract it into native or
into a second nested repository directory. Preserve any local edits before
overwriting documentation or CMakeLists.txt.

The overlay supplies the CMake fix, SDK helper, helper license, build script
and these instructions. It requires the rest of the existing v0.2.1 repo.

## 2. Install prerequisites

- Windows 10/11 x64 and the SpaceXpanse Metaverse v0.1.6a x64 simulator.
- The matching official SpaceXpansesdk directory, containing
  include/SpaceXpansesdk.h and lib/SpaceXpanse.lib.
- Node.js 22 or 24, with npm on PATH.
- Visual Studio 2022 or Build Tools for Visual Studio 2022, with the
  Desktop development with C++ workload, MSVC x64 tools and Windows SDK.
- CMake 3.19 or newer, on PATH. Visual Studio's CMake component is suitable.

Open Developer PowerShell for VS 2022 after installation. Check:

```powershell
node --version
npm --version
cmake --version
```

The base Node service has no npm dependencies; npm install is not required.
The simulator, its SDK, Visual Studio and Node are not bundled in this overlay.

## 3. Check the portable code and recorded demonstration

```powershell
npm run verify:portable
npm run start:replay
```

Open http://127.0.0.1:4377/?observer=A and optionally change A to B or C in
separate browser tabs. This uses the bundled recorder excerpt. Recorded landing
labels do not establish live simulator GroundContact. Stop replay with Ctrl+C
before starting the live service; both modes use the same ports.

## 4. Build the native DLL

Run this exact command, changing the SDK directory if necessary:

```powershell
powershell -ExecutionPolicy Bypass -File .\native\build-windows.ps1 -SdkDirectory "C:\Metaverse\SpaceXpansesdk"
```

It configures a Visual Studio 2022 x64 build and compiles Release. Output:

```text
native\build-windows-x64\Release\OSGSimBridge.dll
```

The script prints its SHA256. It compiles SpaceXpansesdk.cpp with the bridge
using the same Release runtime settings (/MT), and links SpaceXpanse.lib and
ws2_32. Do not link the prebuilt SpaceXpansesdk.lib: its debug iterator settings
conflict with this Release build. Do not suppress the linker mismatch error.

For a different Visual Studio version, supply its installed CMake generator
name using -Generator. Use a fresh build directory when changing generators.
If your SDK import library is stored elsewhere, use explicit CMake paths:

```powershell
cmake -S .\native -B .\native\build-custom-x64 -G "Visual Studio 17 2022" -A x64 `
  "-DSPACEXPANSE_SDK_INCLUDE_DIR=C:\Metaverse\SpaceXpansesdk\include" `
  "-DSPACEXPANSE_CORE_IMPLIB=C:\actual\path\SpaceXpanse.lib"
cmake --build .\native\build-custom-x64 --config Release
```

For that command, the DLL is under native\build-custom-x64\Release instead.

## 5. Install the DLL and test scenario

Close Metaverse before replacing its DLL. Adjust this installation path:

```powershell
$Metaverse = "C:\Metaverse"
New-Item -ItemType Directory -Force "$Metaverse\Modules\Plugin" | Out-Null
Copy-Item .\native\build-windows-x64\Release\OSGSimBridge.dll "$Metaverse\Modules\Plugin\OSGSimBridge.dll" -Force
Copy-Item .\scenarios\OSG-Sim-Moon-Descent.scn "$Metaverse\Scenarios\OSG-Sim-Moon-Descent.scn" -Force
```

The scenario is a proposed test fixture, not a validated safe descent. It
requires the simulator's ShuttlePB vessel. Enable OSGSimBridge in Metaverse's
Modules list, then select a scenario only after the live service is running.

## 6. Start the live service and simulator with the same token

In the same PowerShell session, with Metaverse closed, run:

```powershell
$Metaverse = "C:\Metaverse"
$env:OSG_BRIDGE_TOKEN = [Guid]::NewGuid().ToString('N')
$env:OSG_DATA_DIR = Join-Path (Get-Location).Path '.data-native-test'
Start-Process -FilePath "$Metaverse\SpaceXpanse.exe" -WorkingDirectory $Metaverse
npm start
```

The launcher inherits the token and the Node service receives the same value.
Wait until the service is listening before starting the selected scenario in
Metaverse. Do not launch a second instance through an unrelated desktop shortcut:
it may not inherit the token. Keep this PowerShell window open while running.

Open http://127.0.0.1:4377/?observer=A for the observer and
http://127.0.0.1:4377/api/status for status. After the scenario starts, expect
nativeConnected and nativeAuthenticated to be true, and samplesAccepted to rise.
HTTP/WebSocket uses loopback port 4377; native telemetry uses loopback port 4378.
No public firewall rule or internet exposure is required.

## 7. Check contact, persistence and shutdown

Run a scenario that actually reaches physical contact. Inspect /api/journal
for CONTACT_BEGIN with the expected vessel, simulation time, epoch and step.
After capture, close the simulator and stop the Node service with Ctrl+C.
Verify the captured journal from the repository root:

```powershell
node .\scripts\verify-native-journal.mjs .\.data-native-test
```

This checks local authenticated stream evidence and stored assets; it does not
independently establish simulator module loading or physical correctness.
For DLL-load evidence, real contact, physics comparison, time jumps, vessel
lifecycle and shutdown tests, follow docs/WINDOWS_TESTING.md.

After restarting the Node service, start a new simulator session. Existing
journaled runs cannot resume across service restart. Keep the same data directory
to retain prior journals. Never run two writers against the same data directory.
After an interrupted shutdown, inspect a remaining events.journal.lock and remove
it only after confirming its owning process has stopped.

## 8. Optional genuine OSG persistence

The built-in journal works without an external OSG installation. Genuine OSG
integration requires a separate OmniSpatialGraph checkout, built using its own
instructions. The codebase pins research snapshot
bb087f2e5c4e208b5a6cc3000af9b2fe554ecb26. Before starting the live service:

```powershell
$env:OSG_SOURCE_DIR = 'C:\path\to\OmniSpatialGraph'
npm run test:osg
```

Then start the live service using section 6, in the same session. Use a dedicated
OSG Sim data directory; never use the upstream repository's own .osg memory store.
If you only want the journal-backed mode, leave OSG_SOURCE_DIR unset.

## 9. Optional browser and PlayCanvas checks

For automated browser checks, install Python with pip and then run:

```powershell
python -m pip install playwright
python -m playwright install chromium
npm run test:e2e
```

The default observer uses Canvas2D. Experimental PlayCanvas 3D requires either
the pinned PlayCanvas 2.24.0 module at apps/observer/playcanvas.mjs or access to
the configured CDN. Click ENABLE PLAYCANVAS 3D and check browser console errors.
Real GPU rendering remains a separate acceptance check.

## Troubleshooting and completion

- DLL missing or wrong architecture: rebuild Release with -A x64, then copy
  the DLL to the x64 simulator installation and enable the module.
- Native stream absent: confirm the DLL is loaded, a scenario is running,
  and no other service owns port 4378. Inspect simulator logs and /api/status.
- Authentication failure: close the simulator and relaunch it using section 6
  so both processes inherit the same token.
- Address already in use: stop the replay or previous live service first.
- Iterator/runtime mismatch: verify the overlay replaced native/CMakeLists.txt;
  the bridge must compile the helper source rather than link SpaceXpansesdk.lib.
- npm run verify stops at test:native: that script intentionally returns
  NOT_VERIFIED even on Windows until independent native evidence is supplied.
  It is not an automated simulator acceptance pass. Run the documented checks.

Basic live operation is demonstrated by a loaded DLL, an authenticated stream,
increasing accepted samples, observer updates and a verifiable capture.
Full acceptance additionally requires the tests in docs/WINDOWS_TESTING.md.
This overlay's Windows build and live simulator operation have not been executed
in the Linux packaging environment; the instructions are not a claim of a pass.
