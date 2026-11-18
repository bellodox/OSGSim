# Audit fixes and validation — 18 November 2026

This documents the matching OSG multi + OSGSim 0.3.1-dev source overlays and DLL.
The earlier 0.3.0 audit is historical; its vessel-space claim is withdrawn below.
Installation and the native testing task are in [OSG_0.3.1.md](OSG_0.3.1.md).

## Completed changes

| Finding | Implementation and regression evidence |
| --- | --- |
| Peer activity bursts starve physical feed | Bounded, fair source/background scheduler, plus acknowledged committed-view reuse between WorldGraph and ParticipationGraph on the same storage handle. Tests assert source priority, a peer turn under continuous source work, admission bounds, no repeated full-history reload on alternating writers and verified reload on an external writer. |
| Live badge ignores age | Native capture timestamp retained in exact graph metadata. Browser checks capture age, frame arrival age, connection, selected run, publication health and source-queue age against a one-second budget. Missing timestamps, delayed frames, mismatched runs and delayed queues do not qualify as live. |
| Native deletion missing | New SDK callback output, wire validation, journal/recovery support, graph delete operation and renderer cleanup. Tests cover current and earlier pinned states, last-vessel deletion, epoch-boundary deletion, stale-epoch rejection and actual cold reopen. |
| Identity tied to vessel names | Numeric run-local identity separate from UTF-8 display name. Actual C++ serializer output is checked by the JS protocol parser, including spaces, quotes, euro character, lifecycle message and capture timestamp. |
| Split UTF-8 corrupted text and retry identity | Shared HTTP body handler accumulates bounded bytes and decodes strictly once. Real HTTP chunk-split tests preserve Bulgarian, euro and emoji strings, preserve retry fingerprints and reject malformed UTF-8. |
| Rejected CAS head offered as accepted history | Explicit world/participation heads must be in accepted main ancestry. A real competing-writer test creates an orphan and confirms both query APIs reject it. Accepted older revisions remain usable. |
| Marked history limits break latest snapshots | Bounded recent event pages replace lifetime queries in snapshots. Core tests page 18 × 2 MiB of marked segments without exceeding the per-page budget. The full bounded marked() API remains available. |
| Sparse vessels require unrelated asset scans | Per-entity candidate segments and per-read decoded-asset reuse. Regression reconstructs one old static vessel and a moving vessel with exactly two asset reads. |
| Activity context changes while form edits old run | Existing form and list are pinned and visibly labelled. Explicit New activity selects the latest run. Production-module tests cover run A edits after run B appears. |
| Conflict cannot be recovered | Authenticated actor-scoped refresh endpoint and explicit review/reapply UI. The production UI module is tested through 409, refreshed version, retained draft and subsequent successful update. Uncertain requests retain the same ID/payload for retry. |
| Activity list silently ends at 256 | Core/API filters and head-pinned cursor; UI Load more and Refresh list actions. Core test enumerates 273 rows with no duplicates while main advances. Production UI test verifies the pinned continuation head and context. |

The UI tests exercise actual modules with deterministic DOM/HTTP doubles. They
are not rendered-browser acceptance. The workload uses real HTTP/TCP/WebSockets
and actual OSG/LanceDB, with synthetic physical packets from a separate process.

## Final measured checks

- OSG typecheck and build passed; 144 tests passed, zero failed, one Windows-only
  CocoaPods traversal test skipped on Linux (145 total).
- OSGSim portable suite: 80 passed, zero failed/skipped; C++17 serializer and JS
  wire round-trip passed. Direct C++ compiler fallback was used; CTest was not run.
- Explicit external-OSG integration gate: 12 passed, zero failed/skipped.
- Windows x64 DLL cross-compilation/linking succeeded. PE32+ AMD64, four required
  exports, all 22 simulator imports found in the pinned official executable.
  Runtime dependencies are SpaceXpanse.exe, WS2_32.dll and KERNEL32.dll.

| Final workload | Accepted / produced | Received by each persistent observer | p50 | p95 | Maximum |
| --- | --- | --- | --- | --- | --- |
| One vessel, no peer writes | 246 / 246 | 246, 246, 246 | 178 ms | 287 ms | 307 ms |
| One vessel, 32 peers / 96 activity operations | 246 / 246 | 246, 246, 246 | 239 ms | 378 ms | 486 ms |
| Four vessels, 32 peers / 96 operations, observer HTTP polling | 984 / 984 | 984, 984, 984 | 253 ms | 388 ms | 454 ms |

The fourth observer disconnected and reconnected in each run and received two
committed snapshots. Three persistent observers accounted for every source
sequence. Four-vessel polling completed 63 HTTP requests across status, snapshots
and observer evidence. No service errors were recorded. Earlier one-vessel
32-peer audit p95 was 6,380 ms. These are individual local measurements, not
maximum swarm capacity or a real-time scheduling guarantee.

Exploratory runs exposed why the initial scheduler change alone was insufficient:
four-vessel polling still reached 6,100 ms p95 before view sharing/fairness tuning;
view sharing with an eight-source-job quantum still reached 4,075 ms. The final
64-job quantum retained a bounded peer opportunity and removed that backlog in
the measured workload. An exploratory run overlapping the full OSG suite reached
46,640 ms p95. Raw outputs are retained: CPU/storage saturation can still delay
this single-host process. The UI's freshness budget detects delay; it does not
turn the service into a hard real-time system.

Structured results: AUDIT_FIXES_0.3.1_VALIDATION.json. Logs and raw workload
outputs: validation-0.3.1/. Reproduce with matching built OSG and
`node scripts/benchmark-live.mjs`; `OSG_BENCH_MULTI_ONLY=1` selects the larger case.

## Native and audit limits

The earlier claim that spaces in SDK vessel names cause invalid native IDs was
incorrect. Existing cleanName escaped spaces. The direct receiver probe bypassed
that serializer, so it could not establish a DLL failure. This finding is
withdrawn. Stable IDs address the actual rename/length coupling and avoid making
identity depend on display encoding.

The new DLL must still be loaded and exercised in the installed Windows
simulator, including deletion and epoch callbacks. Windows CMake/CTest, actual
SDK contact/orientation/physics comparison, rendered-browser behavior and GPU
acceptance were not executed here. Existing GPU summary/CSP corrections are
preserved; no historical result is promoted by these tests.

No change activates receipts, chain replication, tampering attestation or the
frozen multi-worktree future line. The source remains experimental and all
existing component licences remain applicable.
