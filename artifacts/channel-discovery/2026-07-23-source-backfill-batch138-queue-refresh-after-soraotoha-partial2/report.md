# Batch 138 queue refresh after SoraOtoha partial 2

- Input queue: `2026-07-23-source-backfill-batch135-queue-refresh-after-ebakyouka-partial`.
- This is audit-only: no YouTube fetch, no import, no `data/external` write.
- SoraOtoha cumulative partial: 57 videos / 985 occurrences / 985 songs.
- Batch136 new increment: 22 videos / 422 occurrences / 422 songs; published 22/22, occurrence time 422/422, seconds 422/422. Worker reported thumbnail 22/22, but accepted JSON has no thumbnail field for these 22 videos.
- SoraOtoha remains pending because reachedEnd=false and the run was interrupted at the bounded window.
- Queue totals after refresh: 979 videos / 15737 occurrences / 10082 songs.
