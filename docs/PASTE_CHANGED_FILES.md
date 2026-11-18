# Apply OSGSim 0.4.0

The 0.4.0 changed-file archive is cumulative against GitHub main
`95a186eda6b658c7ce3b4818cb2197d031326801`, including the supplied 0.3.1 fixes.
Extract it at the OSGSim repository root, preserving your local edits first.
Use the complete archive: the source mesh/DDS files, derived splat binary,
vendor engine/notice, browser modules, server and native sources are all needed.
Copying only JavaScript does not install the scene. The matching OSG Multi
0.3.1 reference remains external and unchanged.

Read [LANDING_SCENE_0.4.0.md](LANDING_SCENE_0.4.0.md). Run `npm run start:landing`
for the explicitly synthetic renderer demo. For native capture, rebuild this
version of the DLL and install it into the simulator; the old binary lacks the
new visual metadata. Actual GPU/Windows acceptance is not claimed.

`OVERLAY_MANIFEST_0.4.0.json` lists the overlay byte hashes, excluding itself.
The older manifests below are historical checkpoint records.

---

# OSGSim 0.3.1-dev paste-over overlay

Extract at the OSGSim repository root, with package.json beside apps/.
These complete files are cumulative relative to main
95a186eda6b658c7ce3b4818cb2197d031326801, including the 0.3.0 graph integration.
Preserve newer local edits before applying. The GPU-summary and CSP corrections
in that baseline remain intact.

First apply OmniSpatialGraph-multi-Audit-Fixes.zip to the separate OSG
multi checkout and build it. The executable remains osg-multi. Do not use the
frozen osg-multi-worktree branch for this integration.

Follow [OSG_0.3.1.md](OSG_0.3.1.md) for complete setup, exact build command, module
installation, tokens, tests, API and the local native acceptance task. Replace
the installed native DLL using the matching DLL ZIP or rebuild the included source:

```powershell
powershell -ExecutionPolicy Bypass -File .\native\build-windows.ps1 -SdkDirectory "C:\Metaverse\SpaceXpansesdk"
```

The old DLL can still send observations, but lacks lifecycle and capture-age
support. It cannot exercise all the fixes. Valid existing world-mode stores are
readable; legacy event-only stores and repository agent memory stay separate.
The 0.3.1 overlay manifest is authoritative for this archive; earlier manifests
and 0.3.0 validation files describe historical deliveries.
