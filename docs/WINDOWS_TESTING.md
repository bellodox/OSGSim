# Windows native acceptance — v0.2.1

These are **tests to be executed on the user's Windows x64 Metaverse machine**.
They have not been executed in the Linux authoring environment. Provide the
actual results; do not infer a successful simulator load from a portable C++ test.

For step-by-step installation and startup, first follow [WINDOWS_SETUP.md](WINDOWS_SETUP.md).

## 1. Check portable functionality (no native simulator required)

Unzip into a clean folder. Open PowerShell in the extracted project root. Make
sure Node 22/24, CMake, and MSVC C++ build tools are installed.

```powershell
npm run verify:portable
npm run start:replay
```

Open `http://127.0.0.1:4377/?observer=A`, plus B/C in separate windows.
At ~100 s expect `SOURCE GAP`. At 217.2886439 s expect `RECORDER LANDED`,
**not** confirmed native contact. Test independent yaw and timeline settings.
Close the replay server before live testing.

## 2. Build the x64 native bridge DLL

Use the official **SpaceXpanse Metaverse v0.1.6a x64 SDK**, pinned to commit
`3264a944196c48a39d14beab7dafdd10c6918461`, and Visual Studio C++ build tools.
The SDK must contain `include/SpaceXpansesdk.h` and `lib/SpaceXpanse.lib`.
From the repository root, adjusting the SDK path:

```powershell
powershell -ExecutionPolicy Bypass -File .\native\build-windows.ps1 -SdkDirectory "C:\Metaverse\SpaceXpansesdk"
```

The script defaults to Visual Studio 2022; pass `-Generator` for another installed
Visual Studio CMake generator. Output:
`native/build-windows-x64/Release/OSGSimBridge.dll`.
CMake compiles the included unchanged SDK helper with matching runtime settings
instead of linking the prebuilt `SpaceXpansesdk.lib` with debug iterator settings.
No separate helper `.lib` is required. The official simulator import library
`SpaceXpanse.lib` is still required and must match the x64 simulator version.
Preserve complete configure and compile/link output if the build fails.
This updated Windows CMake build has not been executed in the Linux packaging environment.

Copy the resulting `OSGSimBridge.dll` to the actual installation's
`Modules/Plugin` folder and enable it in Metaverse. Do not modify upstream
Metaverse physics or simulator clock. Confirm DLL load independently in the
native module configuration/debugger, not just by seeing a client UI message.

## 3. Run a real Moon-contact scenario

Copy `scenarios/OSG-Sim-Moon-Descent.scn` to the native simulator's scenario
folder. It is an **unvalidated** starting condition based on real Metaverse
scenario syntax, not a guaranteed lander. Use the existing `ShuttlePB` vessel,
then correct the scenario if it begins below terrain or its attitude/touchdown
points do not produce safe contact. Keep the working scenario copy and report
its exact parameters.

Set the *same* local bridge token in the environment of the server **and** the
simulator processes. For example, if both are launched from the same
PowerShell session, it can be inherited:

```powershell
$env:OSG_BRIDGE_TOKEN='osg_native_test_2026_example_secret'
$env:OSG_DATA_DIR=(Join-Path (Get-Location) '.data-native-test')
npm start
```

Launch Metaverse from a process that inherits this environment. If launched
separately through the desktop/Start menu, environment variables in this
PowerShell process may not be inherited. No credentials or production services
are needed. Change the example token for your own local test.

Before a landing, inspect `http://127.0.0.1:4377/api/status`: expect
`nativeConnected: true`, `nativeAuthenticated: true`, and increasing
`samplesAccepted`. If authentication fails, inspect `errors` and process
environment; do not silently disable it for an acceptance claim.

After the simulator genuinely reaches contact, check that a `CONTACT_BEGIN`
event is derived from the *accepted poststep GroundContact transition*, not a
UI heuristic. The contact event must carry a `position`, `assetHash`,
`transportAuthenticated: true`, exact `runId`, `epoch`, `step`, `simTime`,
and journal sequence. Check:

```powershell
node scripts/verify-native-journal.mjs .data-native-test
```

This verifies hash-chain integrity, sample assets, location, and the bridge
token flag. It deliberately reports only **LOCAL_AUTHENTICATED_STREAM_EVIDENCE**:
local token authentication alone **does not prove** the genuine DLL was loaded
or that Metaverse supplied the samples. Evidence of the actual simulator
process and module load is a separate acceptance condition.

## 4. Physics non-perturbation (R06)

Run the same *validated* scenario twice: once without `OSGSimBridge.dll`
enabled, and once with it enabled. Use the same physical inputs, clock settings
and independently recorded `.pos` trajectories. Then run:

```powershell
node scripts/compare-trajectories.mjs baseline.pos instrumented.pos
```

Predeclared initial tolerances: position ≤2 meters and velocity ≤0.25 m/s over
matched times, subject to source recorder precision and actual time stepping.
If runs are not reproducible, report **NOT_VERIFIED**, not a successful
non-perturbation test. Archive both unmodified `.pos` files and the result.

## 5. Actual OSG and PlayCanvas integration (separate gates)

OSG requires a separate, already-built pinned checkout. Never use the upstream
repository's own `.osg` memory store as the integration database. On the
Windows host:

```powershell
$env:OSG_SOURCE_DIR='C:/path/to/OmniSpatialGraph'
npm run test:osg
```

For PlayCanvas, use a compatible locally provisioned `playcanvas.mjs` under
`apps/observer/` or allow the experimental `2.24.0` CDN module. Click **ENABLE
PLAYCANVAS 3D**. Check actual WebGL2 drawing, GPU center updating,
sorting/culling, contact-field visibility and interpolation; a Canvas2D
screenshot does not meet R09. A browser console exception is a failed test.

## 6. Return evidence for the next source correction

Send a ZIP containing: actual DLL build logs; simulator version, configured
plugins and module-load proof; actual Moon scenario; `/api/status` and
`/api/journal` JSON; `.data-native-test/events.journal` and content-addressed
assets needed to replay the contact; native verification output; baseline and
instrumented `.pos` trajectories; and GPU/browser console logs if available.

Do **not** include private keys, passwords, API keys, bridge token, or user
profile data. Redact secrets before sharing. Do not send upstream OSG runtime
memory from unrelated repositories.

**Stop condition:** R04–R06, R07(real OSG), R09(GPU), R10(real-browser) remain
unverified until their real acceptance evidence is supplied. Portable test
success is a development checkpoint, not FULL_PASS.

## v0.2.1 recovery and additional checks

Use a new simulator session after restarting the Node service. The first accepted
sample is now a durable checkpoint, and the service refuses to replay an already
journaled run. If shutdown was interrupted, stop all owners of the data directory,
inspect `events.journal.lock`, and remove it only after independently confirming
that its owner is gone. A time limit alone is not evidence that a lock is stale.

Also test simulation time jumps, explicit vessel repositioning, multiple vessels
and destroying/recreating a vessel with the same name. Existing observers must
clear prior contact events and radial origins on the new epoch. Verify slow or
nonreading observers cannot grow the service's write buffers indefinitely.

Block the receiver from reading and stop the simulator: the changed native worker
uses nonblocking operations and a two-second shutdown drain deadline (plus scheduling
and processing overhead). This source change still requires a real Windows test.
Confirm the test does not freeze Metaverse. C++ wire checks do not exercise Winsock,
the native callbacks or the SDK ABI. The serializers reject overly long names
instead of silently truncating them; monitor native debug logs for capture invalidation.

New assets contain contact and angular velocity plus explicit unknown-orientation
flags; 96-byte legacy assets remain readable but lack contact proof. Do not reinterpret
an old asset as containing GroundContact evidence. For recorder imports, missing
orientation stays unknown. Native angular velocity is vessel-local. Global radial
offset is not terrain altitude.

Run `npm run test:e2e` after provisioning Python, Playwright and Chromium. This uses
real local HTTP/WebSocket transport and synthetic native-shaped samples to check
UI behavior. It is distinct from real SDK touchdown and actual PlayCanvas GPU tests.
