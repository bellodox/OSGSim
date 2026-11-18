# ShuttlePB source assets

These are unchanged files from the MIT-licensed SpaceXpanse Metaverse repository,
commit `3264a944196c48a39d14beab7dafdd10c6918461`:

- `Src/Vessel/ShuttlePB/Meshes/ShuttlePB.msh`
- `Src/Vessel/ShuttlePB/Textures/ShuttlePB.dds`
- `Src/Vessel/ShuttlePB/Textures/ShuttlePBwing.dds`

Source: https://github.com/SpaceXpanse/Metaverse/tree/3264a944196c48a39d14beab7dafdd10c6918461/Src/Vessel/ShuttlePB

The upstream MIT copyright/permission notice is retained in
`LICENSE-Metaverse.txt`. `scripts/import-landing-assets.mjs` decodes mip zero of
the original DDS files and samples the original mesh/materials into the derived
splat asset. The output manifest records source and output SHA-256 values. No
photogrammetry, training dataset or proprietary reconstruction output is used.
