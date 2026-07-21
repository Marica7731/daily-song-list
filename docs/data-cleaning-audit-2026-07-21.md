# Data cleaning audit 2026-07-21

This note documents the conservative dirty-song cleanup used by the DB API worker for accepted YouTube channel discovery rows.

## Scope

- Reviewed accepted discovery JSON is kept under `data/external/youtube-channel-discovery/accepted/*.json`.
- Naraetan and KanaruHanon accepted files are `2026-07-19-naraetanV-full.json` and `2026-07-19-kanaruhanon-full.json`.
- VSinger Moment raw backfill remains under `data/external/vsinger-http/backfill/manifest.json` and shards.
- The local `artifacts/channel-discovery` directory only contains the current added-sources and pannomimimi work dirs in this checkout; it does not contain raw Naraetan/KanaruHanon discovery work dirs.

## Rules

- Drop strong non-song rows such as OP/ED/opening/ending markers, setlist/timestamp headers, stream starts, closing/opening ceremony markers, and short reaction rows only when they are not protected known songs.
- Drop unknown-artist singleton or obvious daily chatter rows such as greetings, "たすかる", "はのぴょーん", episode/closing markers, "大阪の話", and song-cover commentary notes.
- Drop bilingual topic rows where a Japanese daily-life/commentary sentence is split as `title / English gloss` and the English side is not a known artist.
- Keep reviewed real songs and known English artist names through `config/known-song-artist-overrides.json`, `config/song-aliases.json`, and source-filter safe-song checks.

## Audit

Run:

```bash
node scripts/audit-accepted-cleaning-impact.js
```

The script prints JSON plus the marker `CODEX_ACCEPTED_CLEANING_IMPACT_OK`. It reports before/after counts for Naraetan, KanaruHanon, blocked Riona samples, and query-focused summaries for `晴る`, `晩餐歌`, and `花になって`.
