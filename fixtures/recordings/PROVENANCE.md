# Metaverse source fixture provenance

The lines in `Atlantis.pos`, `Atlantis.att`, and `Atlantis.atc` are **unaltered excerpts** from `SpaceXpanse/Metaverse`, branch `0.1.6`, commit `3264a944196c48a39d14beab7dafdd10c6918461`, directory `Flights/Space Shuttle final approach/`.

The `.pos` file contains the first 15 and final 18 samples only, with an intentional temporal gap. Interpolation across that gap is inappropriate for an authoritative physical replay. The viewer marks the omitted interval as **unavailable**, and does not smooth it as if native data existed. The `.att` fixture contains only the first four angle samples; a verified conversion of `HORIZON` Euler angles into global-space quaternions is **not** assumed. The `.atc` fixture includes the original `LANDED Earth` event at 217.2886439 s. This is a recorder event, **not** proof of a `GroundContact()` transition from the live SDK.

These excerpt files are included only as fixtures under the source project's applicable license. They are not a claim of complete recording coverage.
