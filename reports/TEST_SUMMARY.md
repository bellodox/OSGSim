# Verification — v0.2.1-dev

- Input v0.2.0 original suite: 35/35 passed.
- Twelve initial review regressions on original v0.2.0: 12/12 failed (before-regressions.log).
- Corrected Node suite: 66/66 passed (portable-verification.log).
- C++ serializer: direct g++ C++17, Release-style assertions and JS round-trip passed; CTest not run.
- Independent SciPy/NumPy fixture: 24 Hermite, 24 rotation and 24 conditional Gaussian cases passed.
- Synthetic load: 1,000 samples, all delivered to three Node WebSocket clients; 21 durable checkpoints; invalid tail rejected (ingress-load.json).
- Chromium integration attempt: blocked at browser launch by a required socket operation; no DOM/GPU pass.
- Native Windows and real OSG/LanceDB: unverified.

The suite has 31 additional Node tests. Two original integration assertions were updated to account for the new initial durable checkpoint; one original recovery assertion now expects NO_NATIVE_ANCHOR rather than a guessed historical anchor. Those changes follow the documented behavior and do not convert an unavailable native/browser gate into a pass.
