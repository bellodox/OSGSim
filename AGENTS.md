# AGENTS.md

This file provides guidance to agents when working with code in this repository.

- Start feature discovery with the [acceptance inventory](docs/ACCEPTANCE.md) and [Windows runbook](docs/WINDOWS_TESTING.md); portable, injected, native DLL and GPU evidence are separate gates.
- Run a single portable test from the repository root: [node --test tests/integration.test.mjs](tests/integration.test.mjs). Fixture resolution depends on the working directory; do not append a path to the full-suite script ([command definitions](package.json)).
- The [manifest](package.json) defines no lint or application build command. The portable service/tests need no npm dependencies; do not invent formatter or import-order requirements.
- The [wire check](scripts/test-wire.mjs) compiles a portable C++ serializer, not the simulator DLL. Windows requires CMake/CTest; its direct compiler fallback is non-Windows only.
- The [native preflight](scripts/native-preflight.mjs) intentionally exits 2 even on Windows without real acceptance evidence; the aggregate verification chain therefore does not establish a full pass.
- Keep repository OSG memory separate from the simulation adapter's data-directory store ([adapter](packages/osg-physical/osg-adapter.mjs), [persistence explanation](README.md#persistence-and-osg)).
- Recorded landing and missing orientation are not native contact/orientation evidence; preserve the fixture's deliberate gap ([provenance](fixtures/recordings/PROVENANCE.md)).

## Mode guidance

- [Code](.spexcode/rules-code/AGENTS.md)
- [Debug](.spexcode/rules-debug/AGENTS.md)
- [Ask](.spexcode/rules-ask/AGENTS.md)
- [Architect](.spexcode/rules-architect/AGENTS.md)

These mode files are local guidance under the intentionally ignored SpeXcode directory; Git alone does not distribute them.
