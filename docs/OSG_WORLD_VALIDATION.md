# Experimental world mode: validation and handoff

Date: 2026-11-18. Status: PARTIAL native/browser acceptance; implemented and tested
portable OSG-backed data path. No production deployment, receipt issuance or main
branch merge is part of this work.

## Source branches

- OSGSim: `feature/osg-world-state`, based on 2599d8fd3f613795cef33b71355a5408ba1d9a5a.
- OmniSpatialGraph: `feature/live-simulation-world`, based on bb087f2e5c4e208b5a6cc3000af9b2fe554ecb26.
- No simulator source, native DLL, frozen OSG specification, source pins, dependency
  versions or existing main-branch behavior was modified. World mode is explicit opt-in.
- The GPU summary correction is a separate user-run task and is not changed here.

## Tests actually run

OSG baseline: `npm ci --ignore-scripts --include=optional`, `npm run build`,
`npm test`: 131 passed, zero failed, one Windows-specific skip.

OSG feature full suite: 136 passed, zero failed, one Windows-specific skip. Typecheck
and build passed. The dedicated world and graph tests were rerun after the final feature
changes, including ten CAS races, narrow metadata lookups and append-only guards. They use the real LanceDB store, not an API-shape fake.

OSGSim final verification:

```sh
OSG_MULTI_SOURCE_DIR=/absolute/path/to/OmniSpatialGraph npm run verify:portable
```

71 Node tests passed, zero failures/skips, including the real OSG integration cases.
C++17 serializer assertions and the JavaScript round-trip passed through the existing
direct compiler fallback. CMake/CTest and the native Windows DLL build were not run.

The integration cases establish:

- Pending ingress is absent from the observer API until graph publication.
- Three simultaneous WebSocket clients receive graph-referenced updates, with no
  direct uncommitted PHYSICS_SAMPLE messages in world mode.
- Scheduled batching works, including clean shutdown flush.
- Historical reads retain their selected commit and simulation time.
- Cold restart reconstructs physical state, original per-entity local origin and
  contact history from graph-referenced assets without native-ingestion memory.
- Separate client annotation namespaces, explicit stale-head conflict, bad-token and
  foreign-origin rejection. Caller attempts to supply approved status do not gain it.
- Missing world API fails startup; corrupted assets reject reads; a failed graph
  publication does not expose pending physical state.

These tests use synthetic physical inputs. They do not replace the prior Windows
evidence and do not establish the new mode's actual SDK, DOM or GPU acceptance.
The prior review's Chromium rerun was blocked by the Linux execution environment's
socket restriction. Native/browser acceptance of this feature must run on Windows.

## Measured performance

Raw numerical results and source hashes are in OSG_WORLD_BENCHMARKS.json. In the final
25,000-sample, ten-vessel synthetic test, throughput was about 1,593 samples/second,
median complete batch latency 68.6 ms, p95 138.6 ms, max 286.9 ms; cold reopen plus
query took about 351 ms. Periodic hypothesis writes share the graph with the samples.

A longer development test retained 125,000 samples: after the sparse event index,
about 1,260 samples/second and 458 ms cold reopen/query, versus 5.91 seconds before
the index. That comparison predates the final graph-native entity/frame registry and
origin-query/validation additions and
is a development measurement, not an exact final-branch acceptance result. Finite
tests do not establish unbounded scaling, fixed latency or power-loss guarantees.

Narrow storage lookups preserved the same deterministic final graph head as the
before-optimization 25,000-sample run, while avoiding broad row-key and commit
metadata transfers. See the JSON cases for scope and timing differences.

## Required next acceptance

Follow OSG_WORLD_MODE.md on the existing Windows simulator installation. Capture live
graph revisions while the native bridge runs, three independently seeking browsers,
cold service-only reconstruction, client annotation conflicts, non-perturbation and
shutdown evidence. Preserve actual raw logs. Do not mark native/GPU gates PASS based
on portable tests or transfer older native acceptance automatically to this mode.

The current renderer remains illustrative. This branch does not import every mesh,
surface/configuration or simulator dependency into an OSG asset catalog, execute
agent commands in physics, implement multi-machine replication, add receipt formats,
or enable the future chain-replicated tampering policy. Those are separate extensions
to this active live-source foundation. Existing generic graph callers are trusted;
the service's scoped HTTP endpoint is the supported boundary for untrusted clients.

The generic core supports explicit deletion records, but the existing read-only native
bridge does not emit a deletion message. Entity descriptors therefore describe the
last observation, not a guaranteed inventory of currently living native vessels.
