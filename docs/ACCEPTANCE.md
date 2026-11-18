# R01–R12 acceptance inventory — development checkpoint v0.2.1

Measured in Linux container on 2026-11-18. A `PARTIAL` result is not a full
pass, and local test injection of native-shaped JSON is not proof of the Windows
simulator running. A test requirement can only pass on evidence from the right
execution layer.

| Gate | Status | Evidence / remaining verification |
|---|---|---|
| R01 pinned sources | PARTIAL | Exact pinned Metaverse SDK/recorder and OSG core/storage source inspected through GitHub; no full clean checkout/build verification |
| R02 protocol / commands | PARTIAL | Strict sample/frame/time continuity, run/epoch reset, replay isolation, Host/Origin checks and token handshake tested; no authorized pre-step control channel |
| R03 flight recorder | PARTIAL | Authentic Earth `.pos/.att/.atc` excerpts, gap/metadata and import checks; complete native-sourced recording round-trip outstanding |
| R04 x64 native load | NOT_TESTED | SDK plugin and portable C++ serializer supplied; no Windows x64 DLL build or real module-load proof |
| R05 native Moon contact | PARTIAL | Accepted-input transition/physical asset algorithm tested; real Moon `GroundContact()` transition not observed |
| R06 physics non-perturbation | NOT_TESTED | Comparator available; requires two real controlled Metaverse runs |
| R07 OSG persistence | PARTIAL | Fsynced hash-chain, exclusive writer ownership, read-only verifier, immutable versioned CAS sample assets and OSG API-shape fake tests pass; real LanceDB graph integration outstanding |
| R08 4D numerical reference | PARTIAL | Hermite derivative, rotation/conditional Gaussian references from 24 independent SciPy/NumPy vector sets, SLERP and strict causality checks pass; no GPU/CPU 4D parity proof |
| R09 PlayCanvas Gaussian | NOT_TESTED | PlayCanvas 2.24 API checked in upstream source, deterministic contact slicing implemented; no actual GPU renderer test |
| R10 independent observers | PARTIAL | Three real Node WebSocket clients + native-shaped TCP transport pass; 1,000-sample load passed; browser-independent vessel/reset reducer passes. Current Chromium launch is blocked by a required socket operation; no v0.2.1 DOM pass |
| R11 security and licensing | PARTIAL | Local origin restriction, optional token, immutable assets and source licensing documented; no independent full audit or simulator attestation |
| R12 reproducible result | PARTIAL | 66 Node tests plus C++17 direct g++ build with active Release-style assertions and JS round-trip; CMake absent, CTest not run. Native/OSG/browser/GPU gates remain incomplete |

**Overall: PARTIAL — ready for Windows acceptance testing, not production or
FULL_PASS.** Preserve the original full harness-agnostic plan in
`docs/ORIGINAL_AUTONOMOUS_PLAN.md`; these narrower tests do not override it.
