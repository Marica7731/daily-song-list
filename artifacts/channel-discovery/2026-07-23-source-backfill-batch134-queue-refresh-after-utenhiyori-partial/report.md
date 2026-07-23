# Batch 134 queue refresh after UtenHiyori partial

- Input queue: `2026-07-23-source-backfill-batch131-queue-refresh-after-sora-kohana-partials`.
- This is audit-only: no YouTube fetch, no import, no `data/external` write.
- UtenHiyori cumulative partial: 262 videos / 5394 occurrences / 1489 songs.
- Batch132 new increment: 232 videos / 4763 accepted occurrences / 1018 songs; published 232/232, occurrence time 4763/4763, seconds 4763/4763.
- Dirty audit pre-export occurrence count was 4766; final accepted export has 4763, so the 3-row delta is recorded explicitly.
- UtenHiyori remains pending because reachedEnd=false.
- Queue totals after refresh: 872 videos / 13110 occurrences / 8280 songs.
