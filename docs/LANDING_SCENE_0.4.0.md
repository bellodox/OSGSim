# OSGSim 0.4.0-dev: first 4D landing scene

This implements the Moon/ShuttlePB browser scene over the supplied 0.3.1 fixes.
GitHub `main` was checked at `95a186eda6b658c7ce3b4818cb2197d031326801`;
the supplied 0.3.1 OSGSim archive is cumulative against that exact commit.
The matching OSG Multi reference is `multi` at
`d4ba8db2150afdb4b11382c9862e0a59305b374d` plus the supplied active-graph and
audit-fix overlays. OSG itself is not changed or bundled by this feature.

The 4D mathematics and real OSG persistence tests pass. Actual browser/GPU
execution and the changed DLL's Windows build/load remain unverified. This is
an implementation checkpoint, not a claim of pixel-identical native rendering
or a completed native landing acceptance test.

## Run the browser scene without a simulator

```sh
npm run start:landing
```

Open `http://127.0.0.1:4377/`. The 4D scene enables automatically. Play, seek,
yaw, elevation and zoom are independent per browser window. The demo uses the
actual pinned ShuttlePB mesh/materials/textures, with a **synthetic trajectory
and zero-elevation lunar reference surface**. Its labels explicitly say demo;
it is not SDK/contact evidence. The service refuses native input in demo mode.

The pinned MIT PlayCanvas 2.24.0 module and splat asset are included locally;
no CDN, npm installation, training process or proprietary splat software is
needed to open the scene. A working WebGL2-capable browser is required.

## Run the native landing source through OSG

Use the matching built OSG Multi checkout from the 0.3.1 handoff. Close the old
simulator and service, rebuild this version of the bridge, and replace the DLL:

```powershell
powershell -ExecutionPolicy Bypass -File .\native\build-windows.ps1 -SdkDirectory "C:\Metaverse\SpaceXpansesdk"
Copy-Item .\native\build-windows-x64\Release\OSGSimBridge.dll C:\Metaverse\Modules\Plugin\OSGSimBridge.dll -Force
$env:OSG_MULTI_SOURCE_DIR = 'C:\path\to\OmniSpatialGraph-multi'
$env:OSG_DATA_DIR = Join-Path (Get-Location).Path '.data-landing-040'
$env:OSG_BRIDGE_TOKEN = [Guid]::NewGuid().ToString('N')
npm start
```

Launch Metaverse from a process inheriting the same bridge token. Enable the
new OSGSimBridge module and select the native Moon/ShuttlePB scenario. Use the
existing native runbook to validate the scenario and actual SDK contact; the
browser renderer does not correct an unsafe native starting attitude or invent
successful touchdown. Old DLLs still supply telemetry but lack the visual
capture needed for this scene. No Metaverse core/physics change is required.

The observer enables the 4D scene on receipt of a visual descriptor. Until a
real descriptor, orientation and supported vessel asset exist, it reports the
missing information rather than replacing it with an upright capsule. Native
pose is rendered at true meter scale; height is not divided by 1,400 as in the
old illustrative bridge.

## What passes through the system

| Part | Representation and source |
| --- | --- |
| Vessel geometry | All seven groups of the pinned native ShuttlePB MSHX1 mesh, deterministically sampled into 45,387 oriented splats. |
| Vessel appearance | Both original DXT1/DXT5 DDS images, original material diffuse colours, source normals and explicit source hashes. |
| Motion | Committed float64 position/velocity samples, bounded 4D Gaussian translation segments and the existing Hermite acceleration residual. |
| Orientation | Recorded native quaternion, SLERP between known endpoints, explicit native-to-browser handedness conversion. Missing attitude stays unknown. |
| Wing state | Three actual ShuttlePB animation states, with the hinge axes/ranges from pinned `ShuttlePB.cpp`. |
| Exhaust | Actual SDK exhaust positions/directions, lengths, widths and levels. Finite-support 4D Gaussian emission is deterministic in simulation time. Demo fallback nozzle parameters are explicitly taken from the same pinned source. |
| Moon placement | Native body position, radius and rotation, with subtraction in float64 before GPU coordinates. |
| Surface shape | A bounded 9×9 native elevation grid, actual returned elevation level and spherical curvature. Resolution/extent follows altitude. |
| Lighting | Direction to the native Sun, applied to source surface normals. |
| Shadows | Projection of the vessel cloud along sunlight onto the sampled elevation grid; an approximation, not native depth-buffer replay. |
| History | Visual descriptors and terrain asset hashes in OSG's immutable sample payloads, including pinned-head queries and cold restart. |

The elevation cache makes at most four SDK queries per poststep callback and
uses the SDK tile cache. A patch is emitted only once when its 81 samples are
complete. The service validates it, fsyncs its content-addressed asset and
replaces the wire payload with its hash before committing the state. Later
samples carry the reference. A patch ID cannot silently acquire new bytes.
The renderer fetches and hash-checks the referenced asset. Reconnection and
historical queries use the same reference. These SDK queries can cause SDK tile
loads on a real host: callback timing and non-perturbation must be measured in
the native acceptance run.

## How the existing 4D slicer is used

The frame evaluates known state at a presentation time. It does not publish a
graph update. All visible entities use that same time. The native presentation
clock buffers interpolation and clamps at the last available sample; it does
not predict beyond known state. OSG pause/seek stays pinned to the selected
revision. No interpolation crosses a run/epoch, frame/body change or >2-second
gap. Removals hide entities at their recorded time.

For a rigid cloud, every local spatial splat shares the object's spacetime
translation. The 4×4 covariance uses the block form

`[[S + v*v^T*tau², v*tau²], [v^T*tau², tau²]]`.

Conditioning through the existing `slice4D()` gives the moving centre and
spatial covariance `S`. The shared translation is evaluated once per object;
the immutable local cloud retains its individual covariances. This is
algebraically equivalent to conditioning every translated splat, tested against
independent per-splat evaluation. A Hermite residual preserves known curved
motion. Rotation is evaluated separately from the recorded quaternion states.
This is a factored 4D representation, not a claim that one Gaussian can encode
arbitrary rotation/deformation over the entire flight.

Exhaust uses individual finite-support 4D Gaussians. Their sliced full
covariance is converted through a symmetric eigensolver into scale/quaternion
textures for PlayCanvas's **full** GSplat format. Physical uncertainty is not
used as vessel opacity; the persistent vessel does not fade because it is near
a motion-segment endpoint.

`packages/sg4d` now imports browser-safe numeric primitives. It no longer pulls
Node crypto into the browser through the protocol module. The HTTP server
exposes only the required presentation modules and assets, retaining its
loopback/Host/Origin controls and the GitHub CSP worker fix.

## Limits of this first scene

The native bridge does not export lunar albedo imagery, native particle-system
histories, cockpit/MFD graphics or other vessel classes. The captured terrain
schema accepts explicit linear RGB vertex albedo, but native SDK capture
currently supplies elevation only; the UI therefore identifies its neutral
surface material. Elevation level zero is the source's reference sphere, not
proof of detailed terrain. No random craters or contact dust are fabricated.
The only lunar texture in the pinned public repository is the navigation map
`MoonM.bmp`, which is not substituted for a surface tile.

Diffuse lighting, shadow projection and procedural exhaust are browser
presentation approximations. They do not establish native pixel parity, source
attestation or new physics. This source completes the scene-data-to-4D-to-GPU
path for the supported capture; claiming the simulator's entire visual output
would additionally require native surface imagery and particle/render-state
capture plus the real browser and Windows acceptance results.

The renderer bounds visible vessels at eight, cached terrain patches at eight
and temporal samples at 512 per entity. It releases old vessel GPU resources.
The native terrain grid is 81 samples; its emitted detail remains the captured
elevation level even though the renderer resamples it into denser splats.

## Reproduce and verify

```sh
npm run assets:landing
npm run verify:portable
npm run test:landing:gpu
```

`assets:landing` rebuilds the asset from the credited source mesh and DDS files
without training. For all real OSG tests, set `OSG_MULTI_SOURCE_DIR` to the built
matching reference before `verify:portable`. Without it the existing OSG tests
explicitly skip; those skips are not an integration pass.

The GPU test requires Python Playwright, Pillow and Chromium; it checks real
WebGL drawing, non-empty pixels, sliced motion, paused clock, camera changes,
independent observers, offline assets and console errors. Set `CHROMIUM_PATH`
for a nonstandard Chromium installation. `OSG_GPU_SOFTWARE=1` requests
SwiftShader; that is software GPU evidence, not hardware performance evidence.
A launch failure is a failed/unverified gate. No browser screenshot or GPU pass
was produced in this environment.

See `docs/landing/VALIDATION.json` for the measured checks. Native Windows
load/contact, callback cost, baseline/instrumented trajectory comparison,
actual Moon tile completeness and hardware/browser visual acceptance remain
separate gates. No existing formal OSG human gate is declared approved.
