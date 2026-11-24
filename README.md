# OSGSim / SpeXGSP v28.0.1

Multiplayer SpaceXpanse Metaverse on ROD mainnet, Nostr and OmniSpatialGraph (OSG Multi).
A player finds a universe published on ROD, authenticates with a ROD `p/` name, synchronizes
world time, spawns on a free Brighton Beach pad and appears as a native ship in every other
peer's running Metaverse.

See the [implementation guide](docs/IMPLEMENTATION_GUIDE.md) for component responsibilities,
startup and state flow, storage ownership, historical observer boundaries and acceptance limits.

## Requirements (each Windows x64 machine)

- SpaceXpanse Metaverse installed, with `Modules/Plugin/SpeXGSP.dll` from this release.
- Node.js 22+ (with npm) and Python 3 with `pyzmq` (`pip install pyzmq`).
- OSG Multi: the folder prepared for this setup (`OmniSpatialGraph-multi` in the installation root or under
  `OSGSim\`, or the path in `OSG_MULTI_SOURCE_DIR`). Nothing is cloned or downloaded. The 12 audited files in
  `dependencies/OmniSpatialGraph-multi-Audit-Fixes.zip` must match it byte for byte (a git checkout without
  local changes to those files is updated from the archive); otherwise the launch stops and names the file.
  It is built with `npm ci` / `npm run build` only when its compiled output is missing.
- ROD Core on **mainnet** (`spacexpansed.exe`, anywhere up to 4 folders below the installation folder, or the path
  in `OSGSIM_ROD_EXE`). If nothing answers on the RPC port, the launcher starts it hidden with `-server=1`,
  `-zmqpubgameblocks` and `-zmqpubgamepending` (`tcp://127.0.0.1:28332`; skipped for settings already in
  `spacexpanse.conf`), logs to `OSGSim/.data/rod-core/console.log` and waits for its RPC. It keeps running after
  the launcher exits; stop it with `spacexpanse-cli stop`. A node that is already running is used as it is
  (`OSGSIM_ROD_AUTOSTART=0` turns the start off). While a started node loads, the launcher prints a status line every
  10 s. The game needs a synchronized node: if it is still catching up, the launcher says where it stands
  (blocks of headers) and stops; the node keeps synchronizing, and the launcher is started again afterwards.
  RPC is used only on loopback, port 11999 unless `spacexpanse.conf` says otherwise. No setting is needed: the launcher tries the
  login that worked last time, the node's `spacexpanse.conf` (`rpcuser`/`rpcpassword`) and its `.cookie`, and keeps the first one the
  node accepts (`OSGSim\.data\spexgsp-rod\working-rpc.auth`). No password is built in. To force one login (and optionally the wallet), give a URL, `http://user:password@127.0.0.1:11999/wallet/<name>`, in
  `OSGSIM_ROD_RPC_URL` or on the first line of `OSGSim\rod-rpc-url.txt` (percent-encode special characters in the password).
  The node's `spacexpanse.conf` is searched in `OSGSIM_ROD_DATADIR` (alone, when set), else under
  the installation folder (3 levels), then `%APPDATA%\SpaceXpanse`; its `rpcport` is used (11999 when it sets none; 11998 is the
  peer-to-peer port, never RPC) with its `rpcuser`/`rpcpassword`, or the `.cookie` when no password is configured. A node the
  launcher starts gets `-rpcport=11999` unless the conf sets one.
  No private key leaves ROD Core: SpeXGSP calls `name_register`, `name_update` and
  `signmessage` through the wallet.
- A little ROD in the wallet: one `p/` registration per player and one `name_update` per game move. The launcher
  prints `SPEXGSP_ROD_FUNDING_ADDRESS` with the address to send ROD to (legacy type, kept in
  `OSGSim/.data/spexgsp-rod/funding-address.json`) and the wallet balance.

## Join a universe

```cmd
Start-SpeXGSP.bat                      :: default universe spexgsp/universe/default
Start-SpeXGSP.bat -Universe <realm>    :: another realm name or worldId
Start-SpeXGSP.bat -ListUniverses | -ChooseUniverse | -Preflight
```

The launcher verifies the release files (`RELEASE-FILES.json`), provisions OSG Multi, starts the
peer and then Metaverse. Player addresses are **legacy** (P2PKH), because ROD's `signmessage`
cannot sign with segwit addresses; SpeXGSP requests them with `getnewaddress "" legacy`.

## Create a universe (owner, once)

1. Copy `OSGSim/realm-authority.example.json` to `OSGSim/realm-authority.json` and set
   `realmName`, `realmId`, `gameId` (1-40 letters/digits), `ownerAddress` (legacy, or `null` for
   a new address) and `relayHost` (the public IP address of the PC that will run the
   relay; see "Public relay" below). Extra `relays` (up to 6 `wss://` URLs in total) are optional.
2. Run `Start-SpeXGSP.bat -CreateUniverse`. It registers the realm directory
   (`spexgsp/universe/...`) and the game genesis (`g/<gameId>`), journals progress in
   `OSGSim/.data/universe-create/`, never pays twice when re-run, and finishes by discovering the
   universe from ROD alone, as a joiner would.

Names never expire on ROD and each name value is limited to 2048 bytes.

## Relays and peer discovery

No public relay is used. Every peer runs the built-in relay
(`single-address/operator-relay.mjs`, default port 7447, `-RelayPort`, `-NoRelay`). It stores only
SpeXGSP event kinds (8427 history, 30328 peer adverts) and forwards 21328 live frames without
storing them.

Peers find each other through the relays listed in the ROD realm directory, then through peer
adverts. A relay other computers connect to must be a `wss://` endpoint; plain `ws://` is accepted
only on loopback.

### Public relay (owner, three steps, no certificate to buy)

1. In `OSGSim/realm-authority.json` set `"relayHost"` to the public IP address of the PC
   that will run the relay, with the port if it is not 7447: `"203.0.113.7"` or `"203.0.113.7:7447"`
   (IPv6: `"[2001:db8::1]:7447"`). IP addresses only, no host names. The
   address is written to ROD once, so use an address that does not change. Run `Start-SpeXGSP.bat -CreateUniverse`.
2. `-CreateUniverse` generates the TLS certificate itself (`OSGSim/.data/spexgsp-single-address/
   relay-tls/`, no OpenSSL needed) and registers the relay URL together with the SHA-256 of the
   certificate's public key (`relayPins`) in the realm directory.
3. Start SpeXGSP on that PC as usual. It finds the certificate, listens on `0.0.0.0:7447` as `wss://`
   and prints `SPEXGSP_ROD_RELAY_PUBLIC` with the two things only you can do: forward TCP 7447 on
   the router to this PC and allow it in the Windows firewall (the exact `netsh` command is printed).
   `SPEXGSP_ROD_RELAY_PUBLIC_CHECK` then tries your public address from this PC. Some routers do not
   loop traffic back, so a failed check is a hint; test from another network.

Joiners need nothing: they read the relay and its key hash from ROD, and connect to the relay only
if its certificate has that key. ROD is the trust root, so no certificate authority is involved. The
certificate is valid for 10 years and is re-created only when `relayHost` changes; keep the `relay-tls`
folder (the key hash in ROD must match it), and copy it to another PC to run the relay there.

A certificate from a certificate authority also works: set `OSGSIM_RELAY_TLS_CERT` and
`OSGSIM_RELAY_TLS_KEY` (they take precedence), or put a TLS proxy in front of the relay.

Relay protection: keepalive pings drop dead connections, at most 8 connections per remote address,
a client that does not read is cut off, the event file is rewritten when most of it is stale.

## Consensus (`osgsim-rod-primary-v3`)

Confirmed ROD moves define the world: joins allocate pads, moves must stay at the join owner's
address, and a player with no confirmed move for 240 blocks (~2 h) is retired and must rejoin.
Nostr carries the 4 Hz live lane and the signed history; OSG Multi stores the projection,
committing a ship's own frames at most once per second or on a mode change.

## Environment overrides

`OSGSIM_ROD_RPC_COOKIE`, `OSGSIM_ROD_DATADIR`, `OSGSIM_ROD_WALLET`,
`OSGSIM_ROD_ZMQ_ADDRESS`, `OSGSIM_ROD_EXE`, `OSGSIM_ROD_AUTOSTART`, `OSGSIM_ROD_START_TIMEOUT_MS`, `OSGSIM_RELAY_HOST`, `OSGSIM_RELAY_TLS_CERT`, `OSGSIM_RELAY_TLS_KEY` (override the generated certificate),
`OSGSIM_JOIN_DEPTH` (confirmations before spawning, default 6), `OSGSIM_LIVE_LANE=0`.

## Verification

```sh
node scripts/preflight.mjs --root=.     # Node, pyzmq, release files, engine, syntax, ZMQ self-test
node --test tests/*.test.mjs
python OSGSim/apps/metaverse-native/v26/rod-game/native-zmq.py --selftest
```

The suite covers the relay, ROD replay with reorgs, multi-peer projections, the publisher's
crash and refusal paths, universe creation and the C++ wire parser (when `g++` is present).
Not covered by tests: a live ROD node, two real Windows machines running DX9, and a TLS relay
reached from another network (the tests connect over loopback and a second local address).

## Changes

**28.0.1**
- Fixed in the DLL: the game thread could call into the hub client while the hub thread destroyed it (only when the hub thread ended on an exception). The hub thread now clears the pointer under a mutex before the client is destroyed, so no call is in flight.
- Fixed: the shared atomic write left a new temporary file after every crash between write and rename (the relay key's temporary file included). It now removes temporary files of dead processes on a file's first write, and a failed write removes its own.
- Fixed: a device clock more than one hour off was reported as `bootstrap_NTP_quorum_unavailable` since 28.0.0; it is `bootstrap_NTP_uncertainty_out_of_bounds` again.
- New tests: the DLL's live-versus-committed frame choice (`pickMotionFrame`), the bootstrap NTP path through `queryNtp`, orphan and failed-write handling. Removed two unused variables.
- New `Modules/Plugin/SpeXGSP.dll` (branch `v28.0.1-hub-pointer-lock` of `spaceexpanse/spexgsp-dll-build`).

**28.0.0**
- Every duplicated function is removed; the logic that is in `SpeXGSP.dll` exists only there. Not a drop-in update for old installs: the DLL no longer talks to a Node sidecar, so an old 26.x DLL cannot be used with 28.0.0 (use the 28.0.0 DLL from this package; the player passes it `SPEX_GSP_HUB_URL`).
  - Deleted: `OSGSim/apps/metaverse-native/v26/sidecar.mjs` and `png-verify.mjs` (their logic is `HubClient.hpp`, `V26Wire.hpp` and `Png.hpp` in the DLL), and the tests that only tested them (`e2e-native-emulated`, `native-rod-rebase`, the sidecar parts of `native-extrapolate-handoff`, `v2688-fixes`, `v26`). The C++ checks that compared the DLL with the JavaScript now compare with values recorded from it (`fixtures/extrapolate-golden.json`, golden PNG results in `native-hub-client.test.mjs`).
  - Removed from the DLL: the loopback TCP bridge, the HELLO handshake and `SPEX_GSP_BRIDGE_TOKEN` / `SPEX_GSP_BRIDGE_PORT`. Without `SPEX_GSP_HUB_URL` the DLL logs that it is not set and does nothing. The plugin ABI (`SpeXGSP_ABI_Version` 26) and the game protocol are unchanged.
  - One NTP query in JavaScript: `bootstrap-clock.mjs` now uses `queryNtp` from `world-time.mjs` (it had its own copy; it still accepts a device clock up to one hour off).
  - One atomic file write and one `sleep` (`OSGSim/apps/metaverse-native/v26/fs-util.mjs`) instead of nine and three copies. The publisher and the player identity keep fsync; the others still do not.
  - Still twice, because each side of a protocol needs it: `canonical`/`sha256` (JavaScript hub and world, C++ DLL) and the NTP code in the DLL, which cannot call JavaScript.
- New `Modules/Plugin/SpeXGSP.dll` (MSVC build in `spaceexpanse/spexgsp-dll-build`, branch `v28.0.0-dll-only`).

**27.0.0**
- New major version: the whole former Node sidecar runs inside `SpeXGSP.dll` (started in 26.8.29, finished here), and the player starts no sidecar. The game protocol, the ROD names and moves, the world format and the plugin ABI (`SpeXGSP_ABI_Version` 26) are unchanged, so 27.0.0 peers play with 26.8.x worlds.
- New `Modules/Plugin/SpeXGSP.dll` (MSVC build in `spaceexpanse/spexgsp-dll-build`). Fixes in the hub client that moved into the DLL in 26.8.29:
  - Ending the simulation no longer waits for a hub or RPC call (up to 12 s), a capture (up to 30 s) or an NTP lookup: they are cancelled at once.
  - Paths with non-ASCII characters (for example `C:\Users\Bürger\…`) work: the DLL reads its settings as UTF-16 and converts them to UTF-8.
  - The scene-proof capture runs in the background, so remote ships keep being updated during it (later game messages wait, as they did in the sidecar). NTP recalibration runs on its own thread; the name lookup of an NTP server is limited to 2 s.
  - `native-events.jsonl` is appended to, not emptied, when a second simulation starts in the same Metaverse; the player also reads it from the start again if it ever gets shorter.
  - Identical repeated events (retry loops while the hub or NTP is down, the poll's `world_verified`, `native_sample`) are written once per 30 s with a `repeated` count.
  - If the hub client stops on an error, it writes a `native_hub_stopped` event and a status with `stopped: true` (it only went to the Windows debug log).
  - The ROD RPC login is read once and removed from the Metaverse's environment; the capture PowerShell gets no `SPEX_GSP_` variable.
  - A remote ship that leaves within one frame of being spawned is no longer created after the newer ship list was applied.
- `spexgsp-rod-player.mjs` no longer recalibrates an NTP clock nothing uses.
- Tests: the root check of the hub-client test now compares with the hub's root; new tests cover `RETIRED` ships, a 401 renewal of the session, re-attesting the own ship with `RESUME`, a drifting game clock, the background capture and the event throttle; a race in the hub-client test (it checked for the `native_sample` event before it could have arrived) is fixed. The Windows code (WinHTTP, cancelling, UTF-8 paths and files, the capture process and its environment, NTP) now runs in the build workflow on the Windows runner (`tests/native-winplatform-test.cpp`); all checks pass there.

**26.8.29**
- New `Modules/Plugin/SpeXGSP.dll` (MSVC build in `spaceexpanse/spexgsp-dll-build`). **The whole Node sidecar now runs inside the DLL**: hub session with the wallet-signed challenge (`signmessage`/`verifymessage` through your ROD Core RPC), the NTP-calibrated world clock, the verified world view (root check), reconcile of native spacecraft, native proofs, physics samples and the scene proof (screen capture with PowerShell, PNG validation). It is a line-by-line port of `sidecar.mjs`, `world-time.mjs`, `peer-wire.mjs`, `png-verify.mjs` and the sidecar's RPC client; the wire between the DLL's game side and its hub side is unchanged.
- `spexgsp-rod-player.mjs` no longer starts a sidecar. It gives the DLL its settings in environment variables (`SPEX_GSP_HUB_URL`, `SPEX_GSP_ADDRESS`, `SPEX_GSP_RPC_URL` with `SPEX_GSP_RPC_USER`/`SPEX_GSP_RPC_PASSWORD` or `SPEX_GSP_RPC_COOKIE`, `SPEX_GSP_NTP_HOSTS`, `SPEX_GSP_ROOT`, `SPEX_GSP_CAPTURE_SCRIPT`, `SPEX_GSP_DATA_DIR`) and reads the DLL's events and status from `native-events.jsonl` and `native-status.json` in the data folder. **The ROD RPC login is therefore inside the Metaverse process.** A Metaverse started without `SPEX_GSP_HUB_URL` still uses the loopback bridge to a sidecar. `sidecar.mjs` stays in the archive as the reference the tests compare against.
- The DLL has WinHTTP, an SNTP client and a small inflater built in; it needs no new files.
- New tests run the C++ code on Linux against the real hub, the real ROD RPC protocol and the real `ownership.mjs`/`png-verify.mjs` outputs (canonical JSON and SHA-256 of random values, PNG inspection of valid and damaged images, enrollment, world root check, publishing, ship removal, scene proof, wrong RPC login).
- Not run: the DLL inside the Metaverse (WinHTTP, UDP NTP and PowerShell capture are Windows-only; they compile in CI but were not executed).

**26.8.28**
- New `Modules/Plugin/SpeXGSP.dll` (MSVC build in `spaceexpanse/spexgsp-dll-build`; an older DLL is refused with the usual `native_dll_rejected` hint, it now has to report `remote-set-v1`).
- More logic moved from the Node sidecar into the DLL: the decision which remote ships to remove. The sidecar sends the verified world's complete remote-ship set (`OSGREMOTES1`, when it changes and every 5 s); the DLL compares it with its own ships and removes the ones that are gone or were replaced. Previously the sidecar remembered what it had sent and sent one `OSGDESPAWN7` per ship, so a ship the sidecar had forgotten (after a sidecar restart) stayed in the game. The sidecar still sends `OSGDESPAWN7` to an older DLL.
- Fixed (sidecar and DLL hygiene): `removeRemote` cleared the scene-proof target without the mutex (data race with the I/O thread); a connection that never sent HELLO could hold the single native slot (now dropped after 10 s); `nativeErrors` grew without bound (now the last 64); a remote ship that was already `RETIRED` was still spawned.
- Everything else stays in Node on purpose (hub session, verified world, NTP clock, wallet signing, scene proofs).

**26.8.27**
- New `Modules/Plugin/SpeXGSP.dll` (rebuilt with MSVC in `spaceexpanse/spexgsp-dll-build`; replace the old one, an older DLL is refused with the usual `native_dll_rejected` hint).
- One piece of logic moved from the Node sidecar into the DLL: a remote ship in free flight is advanced along its velocity to the current simulation time (at most 10 s, never backwards) when the DLL applies it, using `oapiGetSimMJD()`. The DLL announces this as `extrapolate-v1`; the sidecar then sends the committed position unchanged. The numbers are identical to the old Node code (a test compares 400 random cases against it).
- Everything else stays in Node on purpose: the hub session, the verified world, wallet signing and scene proofs need an HTTP client, a JSON parser and your wallet login, which should not live inside the game process.
- Known issues stay frozen (see the project's frozen issues list); nothing else changed.

**26.8.26**
- Cleanup only; no runtime code and no `Modules/Plugin/SpeXGSP.dll` change (the DLL is byte-identical to 26.8.25).
- Removed `native/spexgsp-rod/linux-mingw/` (the Linux MinGW cross-build that produced the DLL that could not load in the Metaverse; the DLL is built with MSVC since 26.8.22) and `tests/osg-witness-fixture.mjs` (imported a module that is not part of the release, and nothing used it).
- Known issues of this proof of concept are frozen for later fixing; they are tracked outside this archive.

**26.8.25**
- Identical to 26.8.23 except `Modules/Plugin/SpeXGSP.dll`: the rebuilt DLL places other players' ships in `clbkPreStep`, which fixes the Metaverse crash "Vessel::InitLanded must not be called during state update".

**26.8.23**
- A local OSG store write that does not return within 30 s is abandoned with `SPEXGSP_OSG_WRITE_STALLED` instead of blocking the world, the ROD sync and the local endpoint behind it.
- `SPEXGSP_ROD_SYNC_SLOW` (with the current step) is printed every 30 s while a ROD sync scan runs.
- Fixed `ENOENT` rename errors for `ROD-PLAYER-OUTBOX.json`, `V26-*-STATUS.json` and `ROD-PEER-STATUS.json`: writes to one file are now serialized and use unique temporary names.

**26.8.22**
- `Modules/Plugin/SpeXGSP.dll` is now built with MSVC against the Metaverse sources (SpaceXpanse/metaverse branch 0.1.6), by a GitHub Windows build. Its imports were checked: `SpaceXpanse.exe` (MSVC-named Metaverse functions), `KERNEL32`, `WS2_32` and the Visual C++ runtime (`VCRUNTIME140`, `MSVCP140`, UCRT).
- **Fixes the Metaverse error "The procedure entry point GetCurrentProcessId could not be located ... SpeXGSP.dll".** Releases 26.8.7 to 26.8.21 contained a Linux MinGW test build of the DLL that could not load in the Metaverse, and extracting them replaced the DLL in `Modules\Plugin`.
- `native/spexgsp-rod/CMakeLists.txt` takes an optional `SDK_LIB` (SpaceXpansesdk.lib), which the DLL needs for the SDK's own definitions.
- The DLL needs the Microsoft Visual C++ Redistributable 2015-2022 (x64), which any machine that runs the Metaverse already has.

**26.8.21**
- A Metaverse DLL that the player refuses is now reported: `SPEXGSP_V26_PLAYER_EVENT {"type":"native_dll_rejected",...}` names the reason and the features the DLL reported against the required ones (`rod-remote-rebase-v1`, `clock-realign-v1`). If no DLL connects within 30 s: `native_dll_not_connected`. Before, both were silent: the ship still appeared (the Metaverse starts from a scenario) but nothing was sent to ROD.

**26.8.20**
- Fixed the native player crash right after `NATIVE_PLAYER_LAUNCHED`: `ReferenceError: Cannot access 'join' before initialization` in `sidecar.mjs` (a local `join` shadowed the path function). The end-to-end test now runs the sidecar with a data folder, as the player does; it failed before the fix.

**26.8.19**
- A startup step that takes longer than 10 s is reported every 10 s as `SPEXGSP_ROD_STARTUP_WAITING {step,seconds}` (for example `scan: writing the world into the local OSG store`), so a silent window names what it waits for.

**26.8.18**
- The wallet can be part of the RPC URL: `http://user:password@127.0.0.1:11999/wallet/game1`. That wallet pays for the player name and every move. It replaces a wallet chosen automatically by an earlier start (`spex-auto-player`). It is loaded if needed and never created; if it does not exist the start stops with `REQUESTED_ROD_WALLET_NOT_AVAILABLE`.
- This build's `OSGSim\rod-rpc-url.txt` names the wallet `game1`.

**26.8.17**
- No RPC setting is needed. The launcher tries the logins it can find, in order (last working login, `spacexpanse.conf`, `.cookie`, an old `local-rpc.auth`), skips any the node refuses (HTTP 401) and remembers the one that works. A stale `local-rpc.auth` from older builds no longer blocks the start.
- This build contains `OSGSim\rod-rpc-url.txt` with the maintainer's own login for his node, at his request. Do not pass this build on; delete or replace that file first. The program has no built-in password.
- Only when every login is refused: a clear `ROD_RPC_LOGIN_REFUSED` listing what was tried; in a console window the launcher then asks once for the URL and saves it.

**26.8.16**
- The RPC endpoint and login can be given as one URL: `http://user:password@127.0.0.1:11999` in `OSGSIM_ROD_RPC_URL` or `OSGSim\rod-rpc-url.txt`. Loopback only; the password is not logged or placed in the world configuration (it is written to a private auth file under `OSGSim\.data`). This replaces "no override" of 26.8.10-26.8.15.

**26.8.15**
- A `spacexpanse.conf` next to the program (under the installation folder, 3 levels) is found and used for `rpcport`, `rpcuser`/`rpcpassword`, and as `-datadir` for a node the launcher starts. `OSGSIM_ROD_DATADIR` still wins.
- A refused RPC login (HTTP 401, empty body; before: "Unexpected end of JSON input") stops the launcher at once with `ROD_RPC_LOGIN_REFUSED` and the credential file it used. An empty answer is reported as "probably not the RPC port".

**26.8.14**
- Fix: RPC was sent to 11998, which is ROD's peer-to-peer port, so a running wallet closed the connection. The launcher now uses `rpcport` from `spacexpanse.conf` (default 11999) and the `rpcuser`/`rpcpassword` from that file (ROD Core creates no `.cookie` when a password is set). Only the main-chain keys are read, never `[test]` or `[regtest]`.
- A node started by the launcher gets `-rpcport=11999` (the built-in RPC default 11998 collides with the P2P port).
- When a port accepts connections but does not answer RPC, the message says to check `rpcport`.

**26.8.13**
- `relayHost` accepts `ip:port` (and `[ipv6]:port`); `relayPort` is still accepted.
- A network failure talking to ROD names its real cause (`ECONNREFUSED`, `ECONNRESET`, timeout) instead of only "fetch failed".
- When ROD Core is already running, the waiting message shows the last line of its console log.

**26.8.12**
- `relayHost` accepts an IP address only (host names are rejected).

**26.8.11**
- `-CreateUniverse` generates the relay's TLS certificate (`relayHost` in `realm-authority.json`) and publishes the relay URL with the certificate key hash (`relayPins`) in the ROD realm directory; peers trust a pinned relay by that key hash, so no domain, CA or OpenSSL is needed.
- A peer that finds the generated certificate serves the relay as `wss://` automatically and prints the port-forward and firewall steps plus a reachability check.
- Relay hardening: keepalive pings, per-address connection limit, slow-reader cutoff, event file compaction, TLS 1.2 minimum.
- A peer no longer connects to its own public relay URL.
- A universe that is already registered keeps its directory: adding a relay later needs a new universe or a directory update, which this release does not provide.

**26.8.10**
- Progress line every 10 s while ROD Core loads (the launcher no longer looks frozen); warm-up wait up to 10 minutes.
- A node that is still synchronizing is reported (blocks of headers) and the launch stops; no waiting for the sync.
- (Port corrected in 26.8.14: the RPC port is not 11998.) `OSGSIM_ROD_RPC_URL` and the RPC entry in `SpeXGSP-world.json` are gone.

**26.8.9**
- The launcher starts ROD Core (`spacexpansed.exe`) from the installation folder and waits for its RPC.
- The launcher prints the address to send ROD to (`SPEXGSP_ROD_FUNDING_ADDRESS`) and the wallet balance.
- OSG Multi: no clone and no commit pin. The folder prepared for this setup is used when its 12 audited files match.
- Launcher checks run in `scripts/preflight.mjs` (tested); the pyzmq check no longer breaks on PowerShell quoting.
- The release file check lists every differing file at once and no longer hashes `Start-SpeXGSP.bat`.
- `name_update` always pins `destAddress`, so a player's name stays at the join address.
- `Start-SpeXGSP.ps1` requires Node.js 22 or newer.

**26.8.8**: first build of this audit round (not distributed under a distinct number; several builds shared it).
