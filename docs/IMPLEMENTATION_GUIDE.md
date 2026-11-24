# OSGSim and SpeXGSP implementation guide

## Scope and revision boundaries

This guide describes the native multiplayer implementation present in the working tree and distinguishes it from the earlier browser observer. It explains source behavior, not a deployment certification.

The comparison is two-part: committed changes from **95a186eda6b658c7ce3b4818cb2197d031326801** to **72ef81bdb5d37a8446ac96df69ce84a9c571c3e6** on branch **v28**, followed by changes from that HEAD to the working tree. The committed interval contains the landing renderer, temporal world readback and lifecycle corrections. The working tree contains the native ROD multiplayer runtime and marks the older observer, world service, package manifest, bridge and acceptance runbooks deleted. These are different implementation generations; the browser path must not be inferred to remain runnable.

The [overview](../README.md) identifies the current distribution as v28.0.1. The deleted manifest at HEAD identified 0.4.0-dev. These labels belong to different snapshots; neither has been normalized here. The retained v26 directory names and native ABI number do not mean the current launcher starts the former Node sidecar.

## Architecture and ownership

Each machine runs a local peer, a local ROD node and its own native Metaverse process. ROD provides the common authoritative transaction history; peers independently derive the world. Nostr provides discovery, signed recovery history and a separate low-latency motion lane. OSG Multi persists the local projection and replay cache. There is no remote hub coordinating native clients: the hub is a loopback interface within one installation.

| Component | Responsibility and boundary |
| --- | --- |
| [Windows launcher](../Start-SpeXGSP.ps1:23) | Runs preflight, provisions the prepared OSG Multi checkout, checks the plugin, prepares ROD and starts the peer. Optional native compilation is explicit. |
| [Peer coordinator](../OSGSim/scripts/spexgsp-rod-peer.mjs:69) | Discovers the universe, verifies assets and chain identity, opens storage, reconciles ROD, owns publishing and Nostr sessions, then admits the local player. |
| [ROD synchronizer](../OSGSim/apps/metaverse-native/v26/rod-game/sync.mjs:14) | Reads chain and mempool through RPC, processes ZMQ wakeups, handles reorganizations and materializes a verified projection. |
| [Graph adapter](../OSGSim/apps/metaverse-native/v26/graph-adapter.mjs:72) | Owns the dedicated single-writer store, serialized writes, committed readback and ambiguous-write checks. |
| [Local hub](../OSGSim/apps/metaverse-native/v26/hub.mjs:16) | Provides wallet-authenticated enrollment and run sessions, world views, samples and proof submission on loopback. |
| [Player launcher](../OSGSim/scripts/spexgsp-rod-player.mjs:18) | Checks the selected local world, stages a scenario, supplies DLL settings and reports native status. It does not start a Node sidecar. |
| [Native plugin](../native/spexgsp-rod/SpeXGSP.cpp:74) | Runs the built-in hub client and applies verified remote craft updates at simulator callback boundaries. |

The split keeps database/network work out of the placement callback while preserving the native simulator as the source of owned-vessel physics. It does **not** make the plugin non-perturbing: it aligns world time, constrains time acceleration and places remote vessels.

## Startup and control flow

Use the [requirements](../README.md#requirements-each-windows-x64-machine) and [join instructions](../README.md#join-a-universe) as the operational entrypoint. The command spelling and prerequisites are verified against source; no simulator or funded wallet operation was executed to validate them during documentation work.

1. The launcher runs release, engine, dependency and syntax preflight before starting the peer. OSG provisioning may build missing compiled output; launch is not a read-only inspection command. Preflight alone is explicitly not live DX9/ROD acceptance.
2. The ROD startup helper uses or starts the local node. The peer discovers the realm and wallet identity, checks the installed asset manifest and Brighton port definition, calibrates time and verifies the ROD genesis.
3. The peer opens its dedicated graph and performs the first ROD reconciliation **before** exposing a native endpoint. Dynamic game tracking and local ZMQ subscription are checked rather than assumed.
4. The publisher arranges a ROD join. The peer waits for a confirmed join and the configured confirmation depth (default six) before opening the player endpoint. A mempool-only join does not allocate an independently authoritative local actor.
5. The player verifies the local world, signs an enrollment challenge through ROD Core, stages the scenario and launches the configured native executable. The DLL then owns its authenticated session, calibrated clock, verified views and proof/sample exchange.
6. Shutdown stops producers before transports and storage, then releases the relay and installation lock. A ROD node started by the launcher has a separate lifetime; see the overview's shutdown guidance.

For universe ownership and public relay setup, use [create a universe](../README.md#create-a-universe-owner-once) and [public relay](../README.md#public-relay-owner-three-steps-no-certificate-to-buy). Creation can pay for on-chain registrations; ordinary documentation or preflight work is not a reason to execute it.

## Three different meanings of state

### Confirmed and provisional ROD state

The [synchronizer](../OSGSim/apps/metaverse-native/v26/rod-game/sync.mjs:151) independently reads RPC after a ZMQ notification. Notification payloads are wakeups, not authority. A poll also reconciles state. Canonical block transaction order is retained; pending moves are deterministically ordered separately. A second tip check detects a chain change during the snapshot.

The synchronizer maintains a confirmed root and a provisional projection root. Its name “liveRoot” refers to the ROD projection including pending moves, **not** to the ephemeral Nostr lane. Confirmation and local graph commitment are also distinct: writing a mempool-derived projection into OSG does not confirm its transactions on ROD.

Reorganization handling checks cached block hashes and searches for the fork point. [Replay persistence](../OSGSim/apps/metaverse-native/v26/rod-game/sync.mjs:107) saves segmented verified rows, then advances the cursor last. This supports restart without downloading the entire history again. Catch-up is bounded per batch, without exposing a partial catch-up as a complete world. Storage/materialization failures quarantine authority rather than silently continuing as healthy.

### Persisted local OSG view

The [graph adapter](../OSGSim/apps/metaverse-native/v26/graph-adapter.mjs:13) encodes physics properties as JSON bytes in base64url because the imported OSG validator hashes safe integers while positions and velocities require fractional values. This preserves the JSON representation without weakening that validator; it is encoding, not encryption.

Writes are serialized and unchanged values are skipped. If a write reports failure after a possible commit, the adapter rereads the head and accepts recovery only when every proposed value is visible. A timed-out write remains ambiguous; the timeout does not prove the underlying storage operation was cancelled.

The [world adapter](../OSGSim/apps/metaverse-native/v26/rod-game/world-adapter.mjs:40) limits local own-frame commitments to approximately one per second or a mode change. Capture, Nostr publication, ROD publication and OSG commitment therefore need not share a cadence.

### Ephemeral Nostr motion

The [live lane](../OSGSim/apps/metaverse-native/v26/rod-game/live-lane.mjs:2) carries signed motion for actors already bound to confirmed ROD joins. It verifies actor/key/run ownership, signatures, freshness, rate limits, plausibility and per-run digest continuity. Observed conflicting sequence digests, forks or inconsistent checkpoints disable that actor's lane until a new run. This is bounded observed-history checking, not proof that all possible equivocation was detected.

Live frames never enter the OSG state or root. The [hub view](../OSGSim/apps/metaverse-native/v26/hub.mjs:57) supplies them separately, and the [DLL frame selector](../native/spexgsp-rod/HubClient.hpp:100) chooses between committed and newer live motion. Root verification protects the committed view; it does not turn the overlay into chain-confirmed state. Relay signatures authenticate key possession and wallet-bound identity, not genuine simulator execution or honest physics.

## Native callback boundaries

The [pre-step callback](../native/spexgsp-rod/SpeXGSP.cpp:91) consumes queued clock, spawn and removal requests, reconciles the remote set and applies remote motion. Landed placement belongs here because the simulator forbids the corresponding landed initialization during its state-update phase. Stale queued spawns are removed when a newer verified remote set revokes them.

The [post-step callback](../native/spexgsp-rod/SpeXGSP.cpp:137) captures the owned craft at a bounded cadence: Moon-relative position/velocity, orientation, angular velocity, mode, surface data and actual contact flag. The worker handles hub communication, NTP and scene-proof processing. The shared client pointer is cleared under a mutex before client destruction, preventing game-thread calls into a destroyed hub client.

A local status file or scene-proof message is useful diagnostic evidence, not independent proof of DLL provenance, safe touchdown or physics equivalence.

## Storage, builds and deployment

[Automatic configuration](../OSGSim/apps/metaverse-native/v26/rod-game/auto-config.mjs:78) places per-world runtime data under the installation's OSGSim data tree. The peer opens a dedicated osg-graph directory there, and the adapter opens its graph subdirectory. Relay history, player outbox, registration state and native events have separate runtime roles. Preserve writer ownership; never point these stores at the repository's operational memory.

The repository-root OSG memory directory is exclusively agent operational memory. The OSG Multi **source checkout**, the **simulation graph**, and the **repository memory** are three separate resources. A graph head is not a Git revision.

Likewise, distinguish this OSGSim source checkout, the separately configured Metaverse source checkout, native compiler output and the actual deployed installation. A bundled plugin or successful build does not prove the deployed DLL matches it or loaded. The [optional build path](../Start-SpeXGSP.ps1:30) refuses replacement while the known simulator process is running. The [player executable path](../OSGSim/scripts/spexgsp-rod-player.mjs:56) is an implementation expectation, not verification that an arbitrary installation contains that executable.

## Historical observer and temporal rendering

In the committed baseline interval, the browser landing path added source-derived vessel splats, temporal translation/orientation, terrain references and simulation-time exhaust. World mode published reconstructed graph-committed samples rather than pending ingress. Pinned-head queries supported historical reconstruction and independent observer pause/seek. Lifecycle corrections addressed paused startup, render-resource handling and idle shutdown.

That implementation used bounded interpolation and explicit gaps rather than inventing unknown native attitude or contact. Synthetic landing demonstrations and approximate browser lighting/shadows were not native rendering parity.

Its source and runbooks are **deleted in the current working tree**. Consult Git revision **72ef81bdb5d37a8446ac96df69ce84a9c571c3e6** for the former observer, world adapter, landing guide, acceptance inventory and Windows setup/testing runbooks. Do not apply their old package commands or bridge-token protocol to the current native launcher. This guide does not restore or supersede their historical gates.

## Verification and security limits

The [current verification section](../README.md#verification) lists available checks and their intended coverage. Documentation work did not execute those application tests, native builds, wallet transactions or a simulator launch. Earlier reported results of 96 OSGSim passes, 144 reference passes and one skip belong to the historical landing snapshot, not the current native runtime.

Required evidence remains layer-specific: native DLL build/load and deployed hash; actual contact; controlled baseline/instrumented trajectories; real browser/GPU results for the historical renderer; synchronized live ROD operation; and two real Windows peers plus a relay reached from another network. Neither source inspection nor graph-integrity verification completes those gates.

RPC remains local, but credentials are supplied to the native process for wallet signing. Private wallet keys remain in ROD Core; this does not make the simulator process credential-free. Keep auth files, generated identity material, RPC URLs and capture diagnostics private. Never publish runtime directories or assume best-effort redaction removes every secret. Relay TLS pinning relies on the ROD directory's key binding and still requires real network reachability checks. No production security approval, gate acceptance or release certification is implied.
