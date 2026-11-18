# OSGSim 0.3.0-dev — graph-backed observations and peer activities

> Historical 0.3.0 notes. For the current native DLL and fixes, follow [OSG_0.3.1.md](OSG_0.3.1.md). The earlier statement that no DLL rebuild is needed does not apply to 0.3.1.

## Source baseline and scope

Checked before development: OSG multi at d4ba8db2150afdb4b11382c9862e0a59305b374d,
OSG main unchanged at bb087f2e5c4e208b5a6cc3000af9b2fe554ecb26, and OSGSim main
at 95a186eda6b658c7ce3b4818cb2197d031326801. The latter's GPU evidence summary
correction and CSP worker-src blob: fix are preserved. Historical Windows/GPU
acceptance results are not promoted by portable tests.

This includes the previous graph-world integration plus the new participation
core. The separate multi-worktree future line is frozen. Runtime engine/command
is osg-multi. The simulation store remains separate from repository agent memory.

## Install and start (PowerShell)

Apply the matching OSG changed files to your separate OSG multi checkout first:

```powershell
npm ci --ignore-scripts --include=optional
npm run build
npm run typecheck
npm test
npm link --ignore-scripts --workspaces=false
osg-multi --help
```

In the OSGSim checkout after applying its changed files:

```powershell
$env:OSG_MULTI_SOURCE_DIR = 'C:\path\to\OmniSpatialGraph-multi'
$env:OSG_DATA_DIR = Join-Path (Get-Location).Path '.data-osg-030'
$env:OSG_BRIDGE_TOKEN = [Guid]::NewGuid().ToString('N')
$peerA = [Guid]::NewGuid().ToString('N')
$peerB = [Guid]::NewGuid().ToString('N')
$env:OSG_WORLD_CLIENTS = @{ browserA=$peerA; agentB=$peerB } | ConvertTo-Json -Compress
npm run verify:portable
npm run test:world
npm start
```

Normal native CLI startup now defaults to graph-world mode and fails clearly if
the matching built OSG checkout is missing. OSG_WORLD_MODE=1 is still accepted;
OSG_WORLD_MODE=0 explicitly selects the earlier event-only/legacy path. Recorder
replay remains available via npm run start:replay. Programmatic callers retain
the explicit osgWorldMode option, so existing portable/native harness modes are
not silently reclassified as graph acceptance.

Use a fresh data directory for the new acceptance run, or a valid existing
world-mode data directory. Never reuse the repository's .osg store or mix the
legacy event-only and graph-world adapter stores. Existing world history is
readable without a migration; new activity records are additive.

Start the already installed Metaverse executable with the same bridge-token
environment, after the service is listening; select the desired scenario. Keep
the existing OSGSimBridge module enabled. No DLL change or rebuild is required.
If rebuilding is needed for another reason, the existing command remains:

```powershell
powershell -ExecutionPolicy Bypass -File .\native\build-windows.ps1 -SdkDirectory "C:\Metaverse\SpaceXpansesdk"
```

Open http://127.0.0.1:4377/?observer=A and additional B/C tabs. The shared activity
panel lists peer work for the latest committed run. Expand its form, paste the
matching configured token, enter an observation and Start/Update/Finish. Tokens
remain in page memory. Camera and presentation controls stay local; the form
does not control physics. Participant claims remain hypotheses.

## Agent API

POST /api/world/activities requires a configured participant bearer token and
same-origin requests when Origin is supplied. Actor identity comes from that
token; body-supplied actor/status fields cannot impersonate another participant
or approve a result. osg-host is reserved for service lifecycle records.

```json
{
  "sessionId": "session-1", "requestId": "request-1",
  "runId": "actual-committed-run-id", "epoch": 0,
  "activityId": "contact-study", "action": "start",
  "text": "Investigating contact timing", "expectedVersion": null,
  "requires": []
}
```

Only existing committed run/epoch contexts are accepted. GET /api/world/entities
exposes elementId and version for optional requires guards. For note/finish,
use the previous response's version as expectedVersion and a fresh requestId.
Keep the same request exactly after a lost reply: retries are durable and
idempotent, including after restart. Changed payload under one ID is rejected.
409 means an activity/dependency conflict; 429 means bounded write pressure.
Refresh and reconsider dependencies instead of blindly replacing expectedVersion.

GET /api/world/activities supports contextId and head. All activities are readable
on this loopback service; tokens authorize writes and do not implement private
per-user read views. The result includes hypothesis/untrusted provenance and
truncated pagination status. Older strict /annotations behavior is retained.

## Stronger graph role

- Exact accepted telemetry is committed in bounded byte assets and reconstructed
  through OSG before browser publication. No direct ingress fallback is added.
- A native-ingestion activity records each committed run/epoch in the same graph,
  and closes on orderly host shutdown. A crash can leave it active; it is not a
  live-presence indicator, lease, ownership claim or simulator attestation.
- Browser/agent activities coexist with telemetry; unrelated graph races are
  retried while stream continuity and declared dependencies remain enforced.
- Observer causal evidence now reads committed graph contacts and origins. It
  excludes pending contacts and works after a cold restart, with the graph head
  included in the response. The stationary light-propagation model is unchanged.
- Recovered run IDs are taken from graph streams as well as the event journal.
  Native ingestion cannot silently reuse a graph-only recovered run.
- Native ingress counters in status remain ingress counters. The committed head,
  pending count and graph history identify what has actually been published.

## Acceptance

npm run test:world is an explicit gate: it fails without the built external OSG
checkout instead of silently skipping graph integration. Portable npm test still
allows clearly reported skips when no external OSG checkout is configured.
Exercise simultaneous participant writes, duplicate requests, stale dependencies,
uncommitted/cold observer evidence and graph-only run recovery on real LanceDB.
The wire test is a portable serializer check, not a new Windows DLL/GPU result.

No physics execution in OSG, native control channel, arbitrary query guards,
worktree indexing, multi-machine replication, blockchain anchoring or receipts
are introduced. Frozen future receipt/tampering rules are unchanged.
