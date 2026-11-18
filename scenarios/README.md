# Moon contact acceptance fixture — proposed, NOT native validated

`OSG-Sim-Moon-Descent.scn` follows the actual `BEGIN_ENVIRONMENT`, `BEGIN_SHIPS`,
`STATUS Orbiting Moon`, `RPOS` and `RVEL` structure of SpaceXpanse Metaverse
v0.1.6a's `Scenarios/Missions/In orbit around Moon.scn`.

It places the `ShuttlePB` vessel approximately 1.6 km above the nominal Moon
mean radius (assumed 1,737.4 km), with 10 m/s initial inward radial velocity.
Terrain elevation, reference-frame conventions, vessel touchdown geometry,
landing stability, and actual accepted `GroundContact()` transitions **have not
been checked in a running Windows simulator**. This is a seed for the tester,
not a guaranteed contact-producing scenario. The observer's visual surface is
not an authoritative collision geometry.

On Windows, put the `.scn` under Metaverse's Scenarios folder, launch it with
`OSGSimBridge` enabled, and capture the actual native event trace. If it loads
below terrain or misses ground contact, adjust only this scenario (not upstream
Metaverse) and save the working variant with its exact input and output logs.

Upstream syntax reference: https://github.com/SpaceXpanse/Metaverse/blob/v0.1.6a/Scenarios/Missions/In%20orbit%20around%20Moon.scn
