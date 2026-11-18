# OSGSim 0.3.0-dev validation

See OSG_0.3.0_VALIDATION.json for exact source baselines and measurements.

- OSG build/typecheck: passed. Full suite: 140 passed, one existing Windows-only
  skip, zero failures (141 total).
- OSGSim: 74 passed with the built external OSG and real LanceDB, zero skips or
  failures; C++17 serializer/wire roundtrip passed through the direct compiler.
- Explicit test:world gate: seven passed. Missing configuration fails explicitly.
- Existing GPU-summary reconciliation regressions: four passed. Their source and
  the exact CSP regression are unchanged from upstream.
- Frozen multi-worktree checkout source matches its previously delivered ZIP.

A local benchmark completed 32 synthetic peers' 96 start/note/finish operations
alongside four committed physical samples. It took 9.05 seconds, about 10.6 peer
operations/second, median request latency 1.52 seconds and p95 2.79 seconds. This
is a bounded burst workload, not supported maximum capacity or a real-time
control claim. Reproduce with:

```powershell
node scripts/benchmark-participation.mjs
```

There is no new Windows DLL load, actual browser form interaction, native physics
non-perturbation, Gaussian sorting correctness, GPU/culling or chain acceptance
claim. Existing native binaries can be reused. Native module and wire sources
are unchanged. CMake/CTest was unavailable; the wire gate used a direct compiler.

The new tests cover independent peer writes, exact retry deduplication including
a forced inter-process late-duplicate race, stale dependency rejection,
revision-pinned activity history, actor isolation, cold reconstruction,
uncommitted/cold observer evidence, fixed observer origin across multiple
entities and recovery of run IDs absent from the legacy journal. Activity facts
remain hypotheses and do not control physics or issue receipts.
