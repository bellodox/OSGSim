# OSG Sim — development checkpoint v0.4.0-dev

The new [4D landing scene](docs/LANDING_SCENE_0.4.0.md) uses the actual ShuttlePB asset, committed motion, native visual descriptors and captured lunar elevations. Run `npm run start:landing` for its explicitly synthetic demo. Rebuild the bridge for native visual capture. GPU and new DLL acceptance are not claimed.

For v0.3.1 installation, the matching OSG update, native DLL replacement and validation, see [OSG_0.3.1.md](docs/OSG_0.3.1.md). This fixes the code-audit defects, peer-load telemetry delay, activity recovery and native deletion. The new DLL provides stable vessel IDs, display names, removal events and capture timestamps. Native `npm start` requires the matching built `osg-multi`; `OSG_WORLD_MODE=0` selects the earlier native path. Historical Windows/GPU acceptance evidence remains separate.

Experimental live OSG world mode and concurrent browser/agent clients: [setup and limits](docs/OSG_WORLD_MODE.md).

**Status: PARTIAL — executable integration source for independent native acceptance.**

This is a standalone, harness-independent integration for SpaceXpanse Metaverse,
OmniSpatialGraph (OSG), 4D Gaussian math, and multiple browser observers. It is
**not** a complete verified Moon-landing simulator. New integration code is MIT;
OSG and other upstream components retain their own license terms and are not
bundled or modified.

## Windows setup and native build

Follow [docs/WINDOWS_SETUP.md](docs/WINDOWS_SETUP.md) for prerequisites, the exact
build command, DLL installation, authenticated simulator startup, verification
and optional OSG/PlayCanvas setup. Apply the overlay at this repository root.

## Run the portable implementation

Prerequisites: Node.js 22 or 24. Base service and tests have **no npm dependencies**.

```bash
npm test
npm run start:replay
```

Open `http://127.0.0.1:4377/?observer=A` and the B/C links. This opens the
**actual published Metaverse Earth-flight-recorder excerpt**. Its deliberate
data gap is shown as missing; `LANDED Earth` is a recorded action, not
`GroundContact()` physics evidence. Independent observers have independent
camera/timeline controls. The pinned PlayCanvas module is now included locally; its actual Gaussian GPU path remains unverified here.

```bash
npm run test:wire          # build C++17 portable bridge serializer; C++ compiler required; CMake preferred, direct g++ fallback on Linux
npm run verify:portable   # Node tests plus C++/JS serializer round-trip
```

The older recorder still uses its Canvas2D reference projection. The landing demo and native visual captures automatically enable the 4D scene. `ENABLE 4D SCENE` can retry initialization; a loaded module is not an accepted GPU test. Gaussian centers/visibility depend
on **simulation** time, not wall-clock time.

## Live native development mode

```bash
npm start
```

The world-service binds *only* to `127.0.0.1`:

- HTTP/WebSocket `4377` — read-only browser and monitoring endpoints.
- TCP/NDJSON `4378` — poststep Metaverse SDK bridge input.

The SDK bridge lives under `native/`. It captures `VESSEL::GroundContact()`,
position/velocity/orientation and actual simulation timestamps using
`clbkPostStep()`. A bounded worker transmits events without network operations
inside the physics callback. C++ wire serialization is compiled and validated
here on Linux, and a separate Windows x64 DLL was compiled and its imports inspected.
The updated CMake build and actual simulator load remain unverified here. See `docs/WINDOWS_TESTING.md` and the proposed unvalidated scenario
`scenarios/OSG-Sim-Moon-Descent.scn`.

Optional local bridge authentication: set the same `OSG_BRIDGE_TOKEN` (16–128
ASCII alphanumeric/underscore/hyphen characters) for both the Node process
and the native simulator process. The native bridge sends `HELLO` before
telemetry. Invalid/missing HELLO is rejected. Token authentication does **not**
prove the sender is the genuine simulator; DLL load and real contact behavior
require the independent Windows test. With no token the service accepts
loopback-only traffic but marks it unauthenticated.

### Live HTTP endpoints

- `GET /api/status` — transport connectivity, journal head and OSG health.
- `GET /api/entities` — latest accepted state per vessel; no physical assumptions about unknown state.
- `GET /api/journal` — verified durable contact/checkpoint envelopes.
- `GET /api/state` — most recent native sample, or recorder state at `?time=t`.
- `GET /api/observer-evidence?observer=A&time=t` — *hypothetical* static observer light-travel time for contact events; A/B/C use explicit research offsets (0, 1,000 km, 384,400 km) relative to the first known source position. Not a sensor, occlusion model, or full relativistic simulation.

WebSocket `/ws` is read-only, restricted to the page's origin when an Origin
header is supplied, and sends `WORLD_INIT` for **all** currently known
vessels plus recent durable contact events. Runtime telemetry is never routed
to an AI model or an external service.

## Persistence and OSG

`packages/osg-physical/journal.mjs` implements a serialized, fsynced,
hash-chained ingress journal and content-addressed IEEE-754 physical assets.
Initial run/epoch samples, periodic checkpoints and contact transitions are journaled and their sample assets published **before**
the events are broadcast. Assets use atomic hard-link publication and checksum
verification; graph publication can be reconciled from the durable journal
following a crash.

The optional real OSG adapter imports only the published `openStore`, `commit`
and `verify` APIs from a **separately built**
`bellodox/OmniSpatialGraph` checkout. It uses its own store under `.data/`;
never point it at the upstream repository-memory database. OSG's formal human
gates and frozen files remain unchanged. To test the real adapter on your
machine:

```bash
# Build the pinned external OSG source using its own instructions first
OSG_SOURCE_DIR=/path/to/OmniSpatialGraph npm run test:osg
OSG_SOURCE_DIR=/path/to/OmniSpatialGraph npm start
```

The new adapter's recovery/idempotence is exercised locally against a strict
API-shape test double. **The actual LanceDB-backed adapter has not run here**,
because its dependencies are unavailable in this execution environment.

## Project layout

```text
apps/observer/                 Browser research interface and experimental PlayCanvas bridge
apps/world-service/            HTTP, read-only WebSocket, TCP native ingestion
packages/world-protocol/       Versioned envelopes and strict field validation
packages/recorder/             Real Metaverse .pos, .att and .atc parser
packages/sg4d/                 Hermite, SLERP, covariance and conditional 4D Gaussian slicing
packages/observer-model/       Bounded light-propagation causality oracle
packages/osg-physical/         Durable journal, sample assets and OSG adapter
native/                        Read-only x64 Metaverse SDK plugin and portable C++ wire unit test
scenarios/                     Proposed Moon descent acceptance fixture (not native tested)
fixtures/recordings/           Credited exact source excerpts, including a visible source gap
scripts/                       Source/import, C++ wire, graph and native verification tools
tests/                         Portable protocol, journal, multi-client and negative tests
docs/                          Acceptance matrix, original plan and Windows handoff
reports/                       Actual local test summaries and browser screenshots
```

## Pinned research references

- Metaverse `v0.1.6a` / `0.1.6`: `3264a944196c48a39d14beab7dafdd10c6918461`
- OSG research snapshot: `bb087f2e5c4e208b5a6cc3000af9b2fe554ecb26`
- PlayCanvas source reference: `1fdc13443dade9544a9414c34f9ecc91315dc417`
- Experimental browser module: PlayCanvas `2.24.0` (its `GSplatFormat.createSimpleFormat` exists in the upstream `v2.24.0` source).

## v0.2.1 review and compatibility

Read `reports/ISSUE_REVIEW.md` for the researched findings, changes, measured
results and remaining limits. `npm run verify:portable` passes 66 Node tests
and the C++ wire assertions. CMake is unavailable in the review environment;
the C++ check used direct g++ compilation, not CTest. Original screenshots and
reports are retained under `reports/baseline-v0.2.0/` as historical evidence.

The journal has an exclusive writer lock. After a crash, stop every process
using the data directory and confirm the PID in `events.journal.lock` is no
longer its owner before removing that stale lock. It is never deleted
on a timeout. `verify-native-journal.mjs` opens a read-only snapshot, does not
acquire a writer lock, and refuses an incomplete tail rather than repairing it.

After restarting the service, begin a **new simulator run** with a new runId.
Previously journaled runs cannot resume without an independently designed
acknowledged stream-recovery protocol. Every new run/epoch starts with a durable
checkpoint. A time jump or an explicit vessel reposition begins a new epoch.
Observers receive a reset, clear old events/origins, and keep one vessel selected.
Use `?observer=A&entity=YOUR_ENTITY_ID` for an explicit vessel; otherwise the
first received vessel is selected. Native IDs now distinguish vessel lifetimes
and encode special characters without collisions. The radial offset shown for
native samples is relative to the global-frame initial sample; it is not
terrain altitude. Angular velocity uses the native **vessel-local frame**, not
the global position frame; no native-to-renderer handedness conversion is claimed.

New physical assets are versioned (136 bytes), preserving contact and angular
velocity and marking unknown orientation explicitly. Legacy 96-byte assets
remain readable, but cannot independently prove contact. The stronger native
verifier reports that limitation. Recorder imports retain raw `.pos` and `.atc`
source assets and include both hashes in their run identity. Existing journals
remain hash-chain compatible. The full historical log is available via
`/api/journal`; causal evidence after a service restart stays unavailable until
a new live observer anchor exists.

The actual browser regression is available as `npm run test:e2e` (Python and
Playwright required; provision Chromium with `python -m playwright install chromium`).
The review environment blocks Chromium's startup socket, so no v0.2.1 DOM/GPU
pass is claimed. The native observer reducer and three Node WebSocket clients
are tested. `npm run verify` still stops at native acceptance when actual
Windows evidence is absent; it does not substitute a portable pass.

**Next independent acceptance:** Compile/load the actual `OSGSimBridge.dll` on
Windows x64, run the proposed Moon scenario, capture actual touchdown transitions
and baseline/instrumented Metaverse trajectories. Return failure logs or the
native evidence archive for further source fixes. See `docs/WINDOWS_TESTING.md`.
