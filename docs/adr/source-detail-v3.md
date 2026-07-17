# ADR: Source Detail V3

## Status

Accepted for `perf/source-entity-shards-v3`.

## Context

The previous request source detail layout grouped many song entities into one keyed shard. Opening one popular song could download unrelated songs from the same shard before the drawer appeared. The source payload also reused video-shaped objects that could carry more data than the drawer needed.

Observed production symptoms:

- A single source drawer request transferred megabyte-scale JSON for popular ranges.
- Clicking one song downloaded source detail records for other songs in the same shard.
- The drawer waited for all source details before becoming visible.
- Popular songs could render more than 100 source rows and media controls at once.
- Full video setlists were coupled to source rows even though they are only needed after the music-note copy action.

## Decision

Source detail V3 writes a deterministic manifest for each song identity:

```text
data/ui/ranges/{range}/sources/{prefix}/{songIdentityKey}/manifest.json
data/ui/ranges/{range}/sources/{prefix}/{songIdentityKey}/chunk-0001.json
data/ui/ranges/{range}/sources/{prefix}/{songIdentityKey}/chunk-0002.json
```

The manifest contains `schemaVersion`, `range`, `dataVersion`, `songIdentityKey`, `sourceCount`, `chunkSize`, `chunkCount`, `chunks`, `generatedAt`, and `sha256`.

Each chunk stores only drawer data for the current song:

- `videoId`
- `channelName`
- `channelId` or `channelHandle`
- `publishedTimestamp`
- short `videoTitle`
- current-song `timepoints`
- `firstSeenAt`
- compact source status

Chunks do not store full video song lists, descriptions, comments, hashtags, thumbnail URLs, repeated search text, complete video items, or unrelated timestamps. Thumbnails are derived from `videoId` by the client.

Full video setlists are moved to:

```text
data/ui/video-setlists/{prefix}/{videoId}.json
```

The source drawer does not request these files. The music-note copy button requests the specific video setlist on demand and then caches the result by `videoId`.

## Frontend Runtime

The drawer opens synchronously with preview sources and skeleton rows. It then loads the source manifest and chunks in the background. The first chunk replaces the skeleton, and later chunks hydrate the same drawer without a second user action.

Failure behavior:

- Keep the drawer open.
- Keep the preview sources.
- Show a retry action.
- Do not fall back to full `all` JSON.

Large source lists are windowed so the DOM retains a small source-row set while preserving source order. Source thumbnails keep lazy loading and low fetch priority.

## Compatibility

The runtime still accepts legacy source detail payloads:

- raw occurrence arrays
- `occurrences`
- `sourceOccurrences`
- `groups[].occurrences`
- `items` / `sources` video arrays
- keyed `records` shards

The new build output does not write the old multi-song request source detail shard.

## Integration Notes

This branch creates `assets/source-detail-runtime.js` but does not edit `index.html`. A follow-up integration branch should load this asset before `assets/app.js`, or keep the in-app fallback until the next asset-version wiring pass.

The existing request detail records already carry `sourceDetailPath`, so no view HTML change is required. The build hook is `writeRequestRuntimeSet` in `scripts/build-runtime-data.js`.

## Verification

Run:

```text
node --test test/source-entity-shards.test.js
node --test test/source-detail-runtime.test.js
node scripts/benchmark-source-detail.js
npm test
```
