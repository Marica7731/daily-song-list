# 2026-07-21 added YouTube source backfill worker

This note records the local source discovery/import pass for the six user-added
YouTube channels. Moment/runtime presence was not used as collected evidence;
the accepted rows below come from this worker's YouTube channel discovery output.

## Commands

Discovery was run per channel with bounded commands and resumable checkpoints
under `artifacts/channel-discovery/2026-07-21-added-sources/`.

Accepted increment:

```bash
npm run youtube:export-channel-increment -- --input-dir artifacts/channel-discovery/2026-07-21-added-sources/AoiFuu5 --input-dir artifacts/channel-discovery/2026-07-21-added-sources/963Noah --input-dir artifacts/channel-discovery/2026-07-21-added-sources/suzu_kmkg --input-dir artifacts/channel-discovery/2026-07-21-added-sources/Shino_Kasukane --input-dir artifacts/channel-discovery/2026-07-21-added-sources/YutoMuchiko --input-dir artifacts/channel-discovery/2026-07-21-added-sources/Robocosan --output data/external/youtube-channel-discovery/accepted/2026-07-21-added-sources-worker.json
```

Marker:

```text
CODEX_CHANNEL_DISCOVERY_INCREMENT_OK inputs=6 readVideos=248 usableVideos=248 acceptedVideos=243 skippedRegressions=5 occurrences=2225
```

## Channel status

| Channel | Status | Candidates | Usable details | Accepted videos | Accepted songs | Accepted occurrences | Skipped regressions | Manifest |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `@AoiFuu5` | imported | 11 | 2 | 2 | 23 | 23 | 0 | `artifacts/channel-discovery/2026-07-21-added-sources/AoiFuu5/manifest.json` |
| `@963Noah` | imported | 43 | 28 | 28 | 151 | 151 | 0 | `artifacts/channel-discovery/2026-07-21-added-sources/963Noah/manifest.json` |
| `@suzu_kmkg` | imported | 112 | 32 | 32 | 151 | 151 | 0 | `artifacts/channel-discovery/2026-07-21-added-sources/suzu_kmkg/manifest.json` |
| `UCTbEua7o1f8I7EMBQlLjTpQ` | imported | 142 | 133 | 131 | 1410 | 1410 | 2 | `artifacts/channel-discovery/2026-07-21-added-sources/Shino_Kasukane/manifest.json` |
| `@YutoMuchiko` | imported | 7 | 6 | 4 | 86 | 86 | 2 | `artifacts/channel-discovery/2026-07-21-added-sources/YutoMuchiko/manifest.json` |
| `@Robocosan` | imported | 109 | 47 | 46 | 404 | 404 | 1 | `artifacts/channel-discovery/2026-07-21-added-sources/Robocosan/manifest.json` |

No channel failed. The five skipped-regression videos were omitted by
`export-channel-discovery-increment.js` because the existing catalog row had a
richer song list than the discovery detail.

## Artifacts

- Accepted increment: `data/external/youtube-channel-discovery/accepted/2026-07-21-added-sources-worker.json`
- Checkpoints: `artifacts/channel-discovery/2026-07-21-added-sources/<channel>/checkpoint.json`
- Video details: `artifacts/channel-discovery/2026-07-21-added-sources/<channel>/video-details.json`
- Occurrence previews: `artifacts/channel-discovery/2026-07-21-added-sources/<channel>/occurrences.json`

The discovery rows include video thumbnails. Channel metadata already had cached
entries for `@AoiFuu5`, `@suzu_kmkg`, `UCTbEua7o1f8I7EMBQlLjTpQ`,
`@YutoMuchiko`, and `@Robocosan`; `@963Noah` did not have a confirmed
`channel-metadata.json` avatar entry in this pass, so runtime display may fall
back to video thumbnail until a later avatar cache pass resolves it.

## Cleanup

No remote worker or VPS temporary directory was used for this pass, so there was
no remote cleanup to perform. Local ignored artifacts are intentionally retained
as checkpoint evidence and can be removed after the accepted increment is merged
and verified in the target runtime.
