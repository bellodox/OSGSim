# Local verification on 2026-11-18 (v0.2.0)

- `npm test`: 35/35 **PASS** portable tests. Covers exact published Metaverse recorder excerpts, protocol invalid inputs, native-shaped localhost TCP ingestion, real multi-peer Node WebSocket delivery and late join, restart recovery, local token handshake, malicious WebSocket Origin rejection, journal serialization and integrity, immutable binary contact assets, causal light propagation, HTTP evidence timing, and OSG API-shape test-double idempotence. These tests do NOT attest a simulator executable.
- `npm run test:wire`: **PASS**. CMake/g++ compiled portable C++17 serializer; ctest passed; output was parsed and validated by JavaScript protocol oracle. No Windows SDK compilation was performed.
- `npm run verify:portable`: **PASS**, combines the two checks above.
- `python3 scripts/test_browser_injected.py`: **PASS**. Chromium three independent documents, yaw/timeline differences, visible source gap and truthful `RECORDER LANDED` classification. HTTP responses are injected and WebSocket mocked; no full browser/network or GPU claim.
- `node scripts/import-recording.mjs fixtures/recordings/Atlantis <temp>`: **PASS**, imported 34 immutable source-derived records to an independent durable journal and generated content-addressed assets. Real OSG was not configured.
- `node scripts/osg-smoke.mjs`: expected **BLOCKED_ENVIRONMENT** without `OSG_SOURCE_DIR` and real OSG native dependencies, not a pass.
- Direct Chromium navigation to the local HTTP server: **BLOCKED** (`net::ERR_BLOCKED_BY_ADMINISTRATOR`), so browser/network acceptance is left to the Windows tester despite the real Node WebSocket test.
- Windows x64 Metaverse module load, actual Moon contact, baseline physics comparison and PlayCanvas GPU/CPU parity: **NOT_TESTED**.

Screen captures in this folder are from the injected-response Chromium test. They cannot establish actual native physics or GPU correctness.
