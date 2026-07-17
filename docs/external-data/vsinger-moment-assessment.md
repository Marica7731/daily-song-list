# VSinger Moment Official MCP Assessment

Assessment time: 2026-07-17 14:01 UTC / 2026-07-17 22:01 Asia/Taipei.

Sources checked:

- `https://vsinger-moment.jp/api/mcp-public`
- `https://vsinger-moment.jp/connect-ai`
- `https://vsinger-moment.jp/data-policy`
- `https://vsinger-moment.jp/terms`
- `https://vsinger-moment.jp/songs`
- `https://vsinger-moment.jp/robots.txt`

## Decision

Use the official MCP only as a bounded, resumable, source-attributed candidate provider.

Do not use the current MCP for a full catalog sync. The public MCP is documented as a beta AI assistant connector, has a 60 requests/minute limit, exposes no cursor/page/offset inputs, and does not publish output schemas. The public data policy also frames VSinger Moment as a secondary discovery database rather than an authoritative source. Any full sync, re-publication, or long-running batch import requires operator confirmation.

This branch therefore implements:

- Tool discovery and schema capture.
- Bounded `search_songs` / `get_song` imports.
- Request caching and resumable import state.
- Provenance envelopes and external-song candidate records.
- Small fixture/schema/example files only.

This branch intentionally does not implement:

- HTML site crawling.
- `/api/` scraping outside the official MCP protocol.
- Unbounded search enumeration.
- Direct import of VSinger Moment counts into local ranking or collection facts.
- A complete raw catalog dump.

## Official MCP Endpoint

Endpoint: `https://vsinger-moment.jp/api/mcp-public`

Authentication: none, per the official connector page.

Live handshake result saved in `data/external/vsinger-moment/mcp-schema.json`:

- `protocolVersion`: `2025-06-18`
- `serverInfo.name`: `vsinger-moment`
- `serverInfo.version`: `1.0.0`
- `capabilities.tools.listChanged`: `true`

## Tool List And Request Schemas

The live `tools/list` response returned 14 tools. Every discovered tool currently has `outputSchema: null`, so response handling must be defensive and schema-change aware.

| Tool | Request schema summary |
| --- | --- |
| `search` | Required `query` string, length 1-200. |
| `fetch` | Required `id` string, length 1-120. Intended for ids returned by `search`, including `stream:`, `singer:`, `song:`, and `video:` prefixes. |
| `search_songs` | Required `query` string, length 1-200. Optional `limit` integer 1-50 and `context` string 1-300. |
| `search_singers` | Required `query` string, length 1-200. Optional `limit` integer 1-50 and `context` string 1-300. |
| `get_singer` | Required `singerId` string, length 1-120. Optional `context` string 1-300. |
| `get_song` | Required `songId` string, length 1-120. Optional `limit` integer 1-50 and `context` string 1-300. |
| `get_video_setlist` | Required `videoId` string, length 1-120. Optional `context` string 1-300. |
| `recent_streams` | Optional `since`, `until`, `singerId`, `limit` integer 1-50, and `context`. |
| `random_singer` | Optional `context` string 1-300. |
| `top_songs` | Optional `limit` integer 1-50 and `context`. |
| `top_singers` | Optional `sortBy` enum: `streamsLast30Days`, `totalStreams`, `totalSongs`; optional `limit` and `context`. |
| `find_singers_for_artist` | Required `artist` string, length 1-200. Optional `limit` integer 1-50 and `context`. |
| `create_listening_queue` | Required `keyword` string 1-200 and `targetMinutes` integer 10-180. Optional `maxPerSinger` integer 1-5 and `context`. |
| `propose_correction` | Required `type` enum `SONG`/`STREAM`/`SINGER`, `targetId`, `proposedData`, `reason` string 1-2000, and `sources` array of 1-10 URL strings. This is a write/proposal tool and is not used by this adapter. |

`search` and `fetch` are present and recorded for deep-research-compatible discovery, but the adapter uses the narrower song tools for catalog candidates.

## Response Schemas

No formal response schema is published through `tools/list`. Observed MCP responses use JSON-RPC 2.0 with a `result` object. Tool payloads can appear as JSON text inside `result.content[]`; `search` and `fetch` may also include structured content.

The adapter therefore:

- Captures the raw hash for every normalized record.
- Accepts JSON text, array payloads, `songs[]`, `results[]`, and direct object payloads.
- Treats unexpected shapes as import failures to be retried or reviewed.
- Saves discovered request schemas separately from normalized external song records.

## Rate Limits

Official limit from `connect-ai`: 60 requests/minute. Exceeding it returns HTTP 429.

Adapter behavior:

- Default rate: 36 requests/minute, within the requested 30-40 requests/minute band.
- No concurrent request bypass.
- Honors `Retry-After` on 429.
- Uses bounded exponential backoff with jitter for 408, 429, and 5xx responses.
- Supports `--max-requests` and `--dry-run`.
- Request caching prevents repeated identical calls.

`propose_correction` has separate public limits: 3 proposals per source IP per day and 20 total per day. The adapter does not call it.

## Terms, Data Policy, And Robots

Data policy summary:

- VSinger Moment is built from YouTube Data API metadata, public videos/archives, description setlists/timestamps, viewer comments, and user correction proposals.
- It covers public videos from channels confirmed by the operator.
- It may contain AI extraction and rule-based matching errors.
- It recommends using YouTube or YouTube Data API as the primary source when exact data is required.

Terms summary:

- Prohibits unauthorized use, reverse engineering, excessive system load, harm to other users, illegal/public-order violations, and other inappropriate use.
- Does not grant explicit permission for full automated republication or long-running bulk extraction.

Robots summary:

- Allows public page paths such as `/singers/`, `/songs/`, `/streams/`, `/videos/`, `/recommend`, and `/stats`.
- Disallows `/api/` except `/api/og-image/`.
- Sets `Crawl-delay: 1`.
- This branch does not crawl public HTML pages or scrape API endpoints outside the official MCP protocol.

## Pagination, Cursor, And Bulk Access

The MCP schemas expose no `cursor`, `page`, `offset`, `updated_after`, or tombstone feed. Most list-style tools only expose `limit` with maximum 50.

`get_song` may indicate that more history exists, but the live request schema has no continuation parameter. Because of that, the adapter must not simulate full sync by issuing thousands of searches.

Supported import mode:

- Bounded query import via `--query`.
- Bounded direct detail import via `--song-id`.
- Local cache and import state for retry/resume.
- Operator-confirmed future cursor support can be added without changing the external song schema.

## External Song Candidate Model

Version: `vsinger-moment.external-song.v1`

Fields:

- `externalSongId`
- `title`
- `artist`
- `titleAliases`
- `artistAliases`
- `latestPerformanceAt`
- `singingCountReference`
- `sourcePageUrl`
- `sourceSystem`
- `fetchedAt`
- `rawHash`
- `schemaVersion`

`singingCountReference` is reference-only. It may support data quality review, prioritization, and conflict reports. It must not feed local collection counts or local rankings.

## Allowed Local Uses

Allowed outputs:

- Known song candidates.
- Standard title candidates.
- Standard artist candidates.
- Alias candidates.
- Kana and romanization candidates.
- Local missing-song candidates.
- Video candidates for the existing verification pipeline.

## Forbidden Local Uses

Forbidden outputs:

- Local collection facts.
- Local singing counts.
- Local rankings.
- Local timestamps.
- Local video validity.

Final facts and timestamps must come from YouTube or the existing local verification pipeline.

## Operator Questions Before Any Full Sync

1. Is `https://vsinger-moment.jp/api/mcp-public` intended only for interactive AI assistant use, or may a program run bounded batch jobs against it?
2. Does `robots.txt` `Disallow: /api/` apply to MCP clients, or only to traditional crawlers?
3. Is full catalog synchronization permitted? If yes, what cadence, cache TTL, deletion handling, attribution, and maximum request budget are acceptable?
4. Will the service provide stable `outputSchema`, a schema version, or a change log?
5. How should clients continue when `get_song` indicates more history than returned?
6. Are there plans for `cursor`, `updated_after`, or tombstone endpoints?
7. What attribution format is required for cached or republished candidate data?
8. Is commercial use, redistribution, or embedding of derived candidate aliases allowed?
9. Is 429 rate limiting keyed by IP, connector, user, or global service state?
10. Should clients treat singing counts as approximate discovery hints only, as this adapter does?
