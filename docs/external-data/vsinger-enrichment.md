# VSinger Moment Enrichment

This branch treats VSinger Moment only as an external candidate source for identity, aliases, known-song hints, and videos that still need local verification.

It does not import VSinger Moment singing counts into local rankings, and it does not trust VSinger Moment timestamps or video status as local facts.

## Inputs

Accepted external records follow `data/external/vsinger-moment/external-song.schema.json` or the equivalent adapter output fields:

- `externalSongId`
- `title`
- `artist`
- `titleAliases`
- `artistAliases`
- `sourcePageUrl`
- `fetchedAt`
- `rawHash`
- optional singing history or YouTube URL fields

The committed fixture input is:

- `data/external/vsinger-moment/enrichment-input.fixture.json`

Real external cache should remain outside git in `.local-cache/vsinger-moment`.

## Identity Enrichment Rules

Automatic identity candidates are emitted only when all conditions hold:

- The local title and artist match the external title/artist or approved alias keys at high confidence.
- The candidate is unique.
- There is no same-title different-artist conflict.
- There is no `Remix`, `Mashup`, or `Medley` conflict.
- There is no version suffix difference such as a local base title versus an external `Piano Ver.` title.
- There is no existing manual curation for the same local identity.

Review candidates are emitted for:

- External-only songs.
- Same title with different artists.
- Piano/version suffix differences.
- Remix/Mashup/Medley conflicts.
- Existing manual curation, which always wins over external enrichment.
- Any ambiguous local match.

The core implementation is:

- `scripts/lib/external-song-enrichment.js`

## Outputs

`scripts/build-external-song-aliases.js` writes:

- `external-song-alias-candidates.json`: automatic identity/alias candidates.
- `external-known-song-candidates.json`: independent known-song candidates.
- `external-song-identity-candidates.json`: review candidates.
- `external-song-conflicts.json`: conflict report.

For this branch, only small fixture outputs are committed:

- `data/external/vsinger-moment/external-song-alias-candidates.fixture.json`
- `data/external/vsinger-moment/external-known-song-candidates.fixture.json`
- `data/external/vsinger-moment/external-song-identity-candidates.fixture.json`
- `data/external/vsinger-moment/external-song-conflicts.fixture.json`

`scripts/build-external-video-candidates.js` writes:

- `external-video-candidates.json`

The committed fixture output is:

- `data/external/vsinger-moment/external-video-candidates.fixture.json`

## Known Song Candidates

Known-song candidates are separate from the production known-song index.

They include:

- `matchingReason`
- `confidence`
- `externalSongId`
- `sourceUrl`
- `verifiedAt`
- `provenance`

`verifiedAt` is initially `null`. A candidate may only reduce false niche markings after local rules or human review confirms it. The builder does not mark every external song as known.

## Video Candidates

When external records include `youtubeUrl`, direct `videoId`, or singing history entries with YouTube links, the video builder extracts a candidate:

- `videoId`
- `externalSongId`
- `reportedSongTitle`
- `reportedArtist`
- `reportedSinger`
- `reportedTimestamp`
- `sourceUrl`
- `fetchedAt`
- `verificationStatus`

`verificationStatus` is always `unverified` at creation.

These candidates must not enter `catalog`, `all`, `7d`, runtime data, or source timestamps until the existing local pipeline verifies:

- Watch page readability.
- Video metadata.
- Timestamp parsing.
- Source quality.
- Blocklist status.
- Curation overrides.

## Provenance

Every enrichment and video candidate carries:

- `externalSystem`
- `externalId`
- `sourceUrl`
- `fetchedAt`
- `rawHash`
- `adapterVersion`
- `matchingVersion`
- `decision`
- `confidence`

This preserves source proof even if local external caches are deleted later.

## Conflict Report Types

The conflict report can include:

- `external_missing_local`
- `local_missing_external`
- `same_title_different_artist`
- `artist_kana_romaji`
- `version_suffix_difference`
- `external_data_conflict`

Future real-data runs can extend the same report with timestamp differences, externally reported invalid videos, possible local identity splits, and possible local identity over-merges after the local verification pipeline has evidence.

## Data Boundary

Allowed:

- Canonical title candidates.
- Canonical artist candidates.
- Title aliases.
- Artist aliases.
- Kana/romaji candidates.
- Known-song candidates.
- Unverified video candidates.

Forbidden:

- Local ranking facts.
- Local singing counts.
- Local collection counts.
- Local timestamps.
- Local video validity.
- Automatic override of manual curation.

## Commands

Fixture build:

```powershell
node scripts\build-external-song-aliases.js --external-input data\external\vsinger-moment\enrichment-input.fixture.json --local-input data\external\vsinger-moment\enrichment-input.fixture.json --manual-curation-input data\external\vsinger-moment\enrichment-input.fixture.json --alias-output data\external\vsinger-moment\external-song-alias-candidates.fixture.json --known-output data\external\vsinger-moment\external-known-song-candidates.fixture.json --review-output data\external\vsinger-moment\external-song-identity-candidates.fixture.json --conflict-output data\external\vsinger-moment\external-song-conflicts.fixture.json --now 2026-07-17T14:30:00.000Z
node scripts\build-external-video-candidates.js --external-input data\external\vsinger-moment\enrichment-input.fixture.json --output data\external\vsinger-moment\external-video-candidates.fixture.json --now 2026-07-17T14:30:00.000Z
```

Tests:

```powershell
node --test test\external-song-enrichment.test.js
node --test test\external-video-candidates.test.js
```

## Integration Steps

1. Run the official MCP adapter to refresh bounded external candidates into `.local-cache/vsinger-moment`.
2. Run `build-external-song-aliases.js` with an explicit external cache input and current local song input.
3. Review `external-song-identity-candidates.json` before any alias is copied into curation/config.
4. Review `external-known-song-candidates.json` before adding any record to local known-song overrides.
5. Run `build-external-video-candidates.js` and feed only `unverified` candidates into the existing watch-page and timestamp verification flow.
6. Apply confirmed results through existing local curation, blocklist, parser, and rebuild scripts.
