# OSG as the live simulation data source

This experimental branch changes the optional OSG path from selected event storage
to committed temporal state for browser and agent clients. Metaverse remains the
physics authority. Its existing executable and installed bridge can be used without
rebuilding the native module.

## Setup on Windows

This build installs as package and command `osg-multi`. Keep it in a separate
checkout from the one backing your existing `osg` installation. OSGSim imports the
compiled API from OSG_MULTI_SOURCE_DIR; it does not spawn a CLI per sample or use
OSG_SOURCE_DIR as a fallback for world mode. /api/status identifies worldEngine
as osg-multi. OSG_SOURCE_DIR remains the legacy event-only adapter setting.


Use your separate OmniSpatialGraph `multi` checkout with the matching changed-file overlay applied.
Build that checkout first (Node 22/24 and the existing native dependency prerequisites):

```powershell
Set-Location C:\path\to\OmniSpatialGraph-multi
npm ci --ignore-scripts --include=optional
npm run build
npm run typecheck
node --test tests/world.test.mjs
npm link --ignore-scripts --workspaces=false
osg-multi --help
```

In your existing OSGSim repository, after applying the matching changed-file overlay:

```powershell
$env:OSG_MULTI_SOURCE_DIR = 'C:\path\to\OmniSpatialGraph-multi'
$env:OSG_WORLD_MODE = '1'
$env:OSG_WORLD_BATCH_MS = '250'
$env:OSG_DATA_DIR = Join-Path (Get-Location).Path '.data-world-test'
$env:OSG_BRIDGE_TOKEN = [Guid]::NewGuid().ToString('N')
npm run verify:portable
```

Use a fresh data directory for this experimental world schema. Do not open the OSG
repository's own memory store. Do not automatically migrate an existing event-only
simulation store. Without the new built world API, world mode fails at startup.

Launch the existing simulator from this same session so it inherits the bridge token,
then start the service and choose the test scenario after the service is listening:

```powershell
$Metaverse = 'C:\actual\Metaverse'
Start-Process -FilePath "$Metaverse\Modules\Server\SpaceXpanse.exe" -WorkingDirectory $Metaverse
npm start
```

Use the executable you already verified; installations may use another executable
location. Keep OSGSimBridge enabled. The native DLL does not need to know about OSG.

Open http://127.0.0.1:4377/?observer=A and B/C tabs. `/api/status` should show
osgWorldMode=true, osgHealthy=true and an advancing worldRevision after native samples
arrive. Native samples may be accepted but pending; worldPendingSamples distinguishes
ingress from published history. Browsers receive only graph-committed, reconstructed
updates, never the pending buffer. The graph reference is shown in the UI.

## Live history and concurrent agents

The browser pause control freezes its own view. Seeking reads exact historical states
from a pinned OSG revision. Play or reset returns to the live graph head. Other clients
continue independently. Native history is exact-sample reconstruction, not new physics
or a claim of native Hermite interpolation. Epoch/run selection is available through
the API; the current browser timeline selects its current run/epoch.

Read APIs are loopback-only and preserve existing Host checks:

- `GET /api/world/history` lists streams and simulation-time ranges.
- `GET /api/world/state` reconstructs the latest stream after restart as well as live.
- `GET /api/world/state?runId=RUN&epoch=0&timeMicros=TIME&head=COMMIT` pins a query.
- `GET /api/world/entities` exposes graph-native entity/frame references and lifecycle flags.
- `GET /api/world/annotations` returns explicitly untrusted client hypotheses.
- Existing `/api/state` and `/api/entities` read OSG in world mode.
- `/ws` sends OSG_WORLD_SNAPSHOT/UPDATE/REVISION with a committed graph reference.

Clients use immutable heads to avoid mixing revisions during multi-step reads. Slow
WebSocket clients are disconnected using the existing bounded transport; reconnect
rebuilds from OSG. Messages carry current-stream metadata and per-entity origins, and are split to
stay below the transport frame limit. History
is still available over HTTP if live messages coalesce or a client reconnects.

To allow agent/browser annotations, configure distinct private client tokens before
starting the server. These are separate from the simulator bridge token:

```powershell
$env:OSG_WORLD_CLIENTS = (@{
  'agent-A' = [Guid]::NewGuid().ToString('N')
  'browser-B' = [Guid]::NewGuid().ToString('N')
} | ConvertTo-Json -Compress)
```

Give each client only its own token. A client first reads a head, then submits:

```text
POST /api/world/annotations
Authorization: Bearer CLIENT_TOKEN
Content-Type: application/json

{"id":"landing-review","text":"Check the first rebound","expectedHead":"c..."}
```

HTTP 409 means the head changed: re-read, then retry only if the intended annotation
is still valid. HTTP 429 means that client already has a pending write or the bounded
write queue is full. Browser-origin writes must come from the service's own origin.
This endpoint cannot inject physics, execute commands, approve facts or overwrite
another client's namespace. Stored agent text is data, never an instruction.

## Durability and source ownership

Samples are grouped up to 128 records, normally flushed every 250 ms. A segment's
float64 payload is durably written to the existing immutable asset store before its
metadata is committed to OSG. The server reads that committed segment back through
OSG and verifies its hash before sending observations. Agent annotations share the
same serial writer and revision notifications, with physics and hypotheses separated.

The existing journal remains an ingress/contact audit. It is not the browser's world
state source in this mode. After restart, history is reconstructed from OSG descriptors
and their assets, even with no simulator connected. A crashed unpublished batch is
not a graph revision; the sparse legacy journal cannot reconstruct that missing tail.
Start a new native run after service restart. Clean shutdown flushes pending batches.

Publication failures are explicit; there is no fallback to direct telemetry. The
physics process is not blocked by a database operation inside its callback. Downstream
backpressure eventually reaches the existing bounded native queue; overload can
invalidate capture and must not be reported as complete evidence.

## Validation

```powershell
$env:OSG_MULTI_SOURCE_DIR = 'C:\path\to\OmniSpatialGraph-multi'
npm run verify:portable
node scripts/benchmark-world.mjs 200 13 1
node scripts/benchmark-world.mjs 200 125 10
```

The new integration tests exercise real OSG/LanceDB and three Node WebSocket clients,
using synthetic physics-shaped inputs. They verify commit-before-publication, exact
history, cold reconstruction, multi-client conflicts, origin/token checks and asset
corruption. They skip with an explicit reason if OSG_MULTI_SOURCE_DIR is absent;
set it to claim these integration checks ran. Baseline portable tests still work
without OSG dependencies.

For Windows acceptance, repeat the existing native capture with world mode enabled.
Verify graph revisions advance while Metaverse runs, then stop the simulator and
service. Restart only the service and reconnect a fresh browser: it must reconstruct
the last graph state and historical contacts. Three observers should seek/pause
independently while the live graph continues. Repeat native non-perturbation and
shutdown checks. These Windows/DOM/GPU tests have not been run for this branch here.

The supplied renderer still uses illustrative geometry; this feature does not import
the complete Metaverse world, assets or physical surface into the graph. It does not
add runtime command execution, embeddings on telemetry, chain replication or receipt
issuance. The future frozen receipt rule remains deferred until chain replication.
Large-history indexes, graph-native spatial asset catalogs and more precise buffered
rendering are follow-up work; they are not prerequisites for this live source path.
