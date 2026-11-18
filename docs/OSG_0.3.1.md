# OSGSim 0.3.1-dev: matching OSG and native fixes

Apply the complete changed-file ZIPs over OSG `multi` and OSGSim, respectively.
They are cumulative relative to OSG multi d4ba8db2150afdb4b11382c9862e0a59305b374d
and OSGSim main 95a186eda6b658c7ce3b4818cb2197d031326801. They include the earlier
0.3.0 graph/participation integration. The command remains `osg-multi`.
The frozen `multi-worktree` development line is unchanged.

## Install the matching OSG source

In the separate OmniSpatialGraph `multi` checkout, extract its ZIP at the root:

```powershell
npm ci --ignore-scripts --include=optional
npm run build
npm run typecheck
npm test
npm link --ignore-scripts --workspaces=false
osg-multi --help
```

Do not install this over the separate standard `osg` checkout. No dependency or
storage-format migration is introduced. Preserve local changes before applying.

## Replace the native module

Close the simulator. The older DLL remains readable, but cannot report native
deletion or capture age. Install the matching DLL to enable the complete fixes.
Either extract OSGSim-v0.3.1-Windows-x64-DLL.zip over `C:\Metaverse` (the archive
contains `Modules/Plugin/OSGSimBridge.dll`), or rebuild from this OSGSim checkout:

```powershell
powershell -ExecutionPolicy Bypass -File .\native\build-windows.ps1 -SdkDirectory "C:\Metaverse\SpaceXpansesdk"
Copy-Item .\native\build-windows-x64\Release\OSGSimBridge.dll C:\Metaverse\Modules\Plugin\OSGSimBridge.dll -Force
```

Rebuilding needs Visual Studio C++ x64 tools, CMake and the official Metaverse
v0.1.6a x64 SDK. Enable OSGSimBridge in the installed simulator's module list.
The supplied binary was cross-compiled and inspected; actual simulator loading
and the Windows CMake/CTest path still require local validation.

## Start and verify OSGSim

Extract the OSGSim source ZIP at its repository root. In PowerShell:

```powershell
$env:OSG_MULTI_SOURCE_DIR = 'C:\path\to\OmniSpatialGraph-multi'
$env:OSG_DATA_DIR = Join-Path (Get-Location).Path '.data-osg-031'
$env:OSG_BRIDGE_TOKEN = [Guid]::NewGuid().ToString('N')
$peerA = [Guid]::NewGuid().ToString('N')
$peerB = [Guid]::NewGuid().ToString('N')
$env:OSG_WORLD_CLIENTS = @{ browserA=$peerA; agentB=$peerB } | ConvertTo-Json -Compress
npm run verify:portable
npm run test:world
node scripts/benchmark-live.mjs
Start-Process powershell.exe -WorkingDirectory (Get-Location).Path -ArgumentList '-NoExit', '-Command', 'npm start'
```

Wait for the new service window to report listening on 4377/4378. Then, in the
original PowerShell session:

```powershell
Invoke-RestMethod http://127.0.0.1:4377/api/status
Start-Process 'C:\Metaverse\SpaceXpanse.exe' -WorkingDirectory 'C:\Metaverse'
```

Select the native scenario after the service is listening. Start-Process inherits
the same bridge token; if the simulator is launched elsewhere, propagate that
environment value explicitly. Open http://127.0.0.1:4377/?observer=A plus B/C tabs.
Use a separate runtime directory, never repository agent memory. Existing valid
world-mode history remains readable; legacy event-only stores stay separate.
Restart the scenario with a new native run after restarting the service.

## Behavior and API changes

| Issue | Current behavior |
| --- | --- |
| Peer bursts delay physical updates | Bounded source/background queues; a waiting peer receives a turn after at most 64 source jobs. Source jobs also include publication. A peer runs immediately when no source work waits. Acknowledged graph views are shared within one storage handle; external writers still require verified reloads. |
| Connected feed labelled live despite delay | One-second freshness budget includes capture age, frame arrival age and queued source age. Paused, delayed and timestamp-less sources show the last committed sample without a live claim. Clock metadata is diagnostic, not simulator attestation. |
| Native removal absent | SDK deletion callbacks become ordered ENTITY_REMOVED records, durable events and graph tombstones. Current snapshots exclude deleted vessels, including the zero-vessel case; earlier pinned revisions remain readable. |
| Identity tied to display names | Stable run-local numeric vessel IDs survive renaming. Bounded UTF-8 display names are separate metadata. |
| Chunk-split UTF-8 corrupted | Bounded byte accumulation and fatal UTF-8 decoding preserve text or return HTTP 400; retries retain the same fingerprint. |
| Failed CAS head explicitly readable as accepted history | World/participation queries reject heads outside acknowledged main ancestry. Generic lower-level DAG inspection semantics are unchanged. |
| Lifetime event limit breaks snapshots | Snapshot history is a bounded recent window. Exact earlier events are available through head-pinned pages. Sparse entity lookup skips unrelated assets. |
| Activity context/conflict confusion | Existing activity and list stay pinned and labelled. Refresh my activity shows current shared text/version for review; a new activity explicitly selects the current run. Uncertain replies retain the exact request for retry. |
| Activity truncation | Stable head-pinned cursors and a visible Load more action enumerate the full list. |

`GET /api/world/activities` accepts `contextId`, `head`, `limit` (1–1,000),
`after`, `state`, `actor`, `activityId`. Continue with `after=nextAfter` and the
returned `head`; preserve filters. The browser uses 64 rows per page.

Authenticated `POST /api/world/activities` with
`{"action":"get","runId":"...","epoch":0,"activityId":"..."}` retrieves the
configured actor's current activity for conflict review. Existing start/note/finish
requests, dependency checks, durable idempotency and actor isolation remain.
Do not automatically overwrite changes after HTTP 409. HTTP 429 means backpressure.

`GET /api/world/events` accepts `runId`, `epoch`, `head`, `direction`
(`forward`/`backward`), `fromSequence`, `limit` and `timeMicros`. Follow the
returned `nextSequence` with the same head and filters until null. Snapshot
`eventHistory` exposes truncation/cursor information; the UI displays its bounded
recent events. A record can carry reset plus lifecycle events, so event count can
exceed record count. One page retains the 32 MiB asset-read budget.

`GET /api/status` reports queue age, ingress/publication ages, `nativeWireFormat`
and `nativeLifecycleSupported`. Health means publication has not faulted; it does
not guarantee a delivery deadline. Wire-format 1 remains readable. The new DLL
reports format 2 and `capturedAtUnixMs`; the loopback browser compares this with
its system clock. Future-dated samples are not taken as proof of freshness.

## Local native acceptance task

Tell the testing agent to use the installed simulator and actual module, then:

1. Run the commands above against the matching OSG checkout. Keep portable,
   graph integration, native and GPU results separate.
2. Confirm the new DLL loads and status reports format 2 and lifecycle support.
   Inspect committed samples for capture timestamps and stable IDs.
3. Use names containing spaces, quotes and non-ASCII characters. Rename a vessel;
   its ID must stay unchanged and the display name must update.
4. Delete a vessel while others continue, then delete the last vessel. The graph
   must record removals, current snapshots must exclude them, and older pinned
   heads must retain their previous states. Repeat after an epoch/time jump.
5. Run concurrent agent/browser activities while observing the native feed.
   Check freshness during activity bursts, pause/resume, disconnect and reconnect.
   Confirm activity conflict review, new-run context and paged history.
6. Stop the service cleanly, reopen the same runtime store without a simulator,
   and verify the final deletion and historical snapshots. Restart the simulator
   as a new run before feeding more telemetry.
7. Follow WINDOWS_TESTING.md for actual contact/orientation/physics comparisons
   and the existing GPU gates. Save measured logs; do not promote a portable
   serializer or a synthetic TCP benchmark into native/GPU acceptance.

The prior audit's specific claim that vessel spaces produce invalid DLL IDs is
withdrawn: cleanName already escaped them. The prior receiver probe bypassed
the native serializer. Rename/length coupling was real; stable opaque IDs remove
that coupling and the serializer tests now exercise actual output.

See AUDIT_FIXES_0.3.1.md for exact checks and measured scope. Receipt issuance,
chain replication, tampering rules and the frozen future branch remain unchanged.
