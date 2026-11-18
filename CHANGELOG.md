# v0.2.1-dev — 2026-11-18

- Fixed post-failure queued ingestion, unbounded ingress scheduling, forged or leaked sample metadata, and replay/live mixing.
- Added loopback Host checks, bounded WebSocket clients/backpressure, split ping/pong handling and the 64 KiB frame boundary.
- Added run/epoch/time/frame/vessel-step validation, durable initial checkpoints and reset notifications; recovered runs require a new simulator run.
- Added journal writer exclusion, immutable append snapshots, scoped identities, read-only verification and failure cleanup.
- Versioned physical assets preserve contact/angular velocity and unknown orientation; raw recorder actions and positions remain recoverable.
- Corrected Hermite derivatives, recorder frame/time-origin validation, rotation validation, small-unit covariance checks and strict signal-arrival comparison.
- Isolated observer vessels, events and reset origins, added reconnect/stale-state handling and hid 3D vessel proxies during source gaps.
- Corrected the one-sample trajectory PASS label and required matching recording time spans.
- Hardened native serializer identities, locale, integer limits, rotation checks and Release-mode assertions.
- Changed the native source to nonblocking socket deadlines, bounded shutdown, worker-side serialization and vessel-lifetime IDs. Actual Windows DLL build/load remains unverified.
- Added 31 Node tests (66 total), 24 independent SciPy/NumPy vector sets and a synthetic 1,000-sample/three-observer load check.
- Existing v0.2.0 acceptance evidence is preserved under reports/baseline-v0.2.0; it is not a v0.2.1 browser or native pass.

# OSG Sim development changes

## 0.2.0 — 2026-11-18

- Fixed late-join observer state transfer to include every vessel in the current simulation run rather than only the last received sample; older runs remain in durable history but cannot contaminate live observers.
- Recovered durable contact-event history from the journal after service restart; reconciles pending graph writes on OSG startup.
- Made journal appends single-writer/serialized with fsync; immutable asset publication is atomic and verifies preexisting content.
- Moved contact-event broadcast after durable journaling; graph publication failures are reported as degraded and journal-recoverable.
- Added optional bridge token + mandatory HELLO when configured, WebSocket Origin restrictions and asset/provenance validation.
- Split native bridge wire serializer into portable C++17 code with compiled test and JavaScript protocol round-trip.
- Added content-addressed physical sample assets for each accepted native contact boundary.
- Added a stationary/moving observer light-travel oracle with HTTP causal evidence for three explicitly hypothetical stations.
- Fixed cross-platform path containment check (including Windows backslashes); added native source CMake header inclusion.
- Made experimental PlayCanvas contact-field timing deterministic in simulation time.
- Added unvalidated Moon-descent `.scn` starting condition and step-by-step Windows acceptance instructions.
- Added live three-client WebSocket, restart recovery, authentication, durability and OSG adapter-shape tests.

Portable tests passed; genuine Windows native, OSG native dependencies and GPU acceptance remain outstanding.
