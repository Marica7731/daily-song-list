# Batch 131 queue refresh after SoraOtoha and KohanaLam partials

- Input queue: `2026-07-23-source-backfill-batch130-queue-refresh-after-ucrf92d-remaining`
- This is audit-only: no YouTube fetch, no import, no `data/external` write.
- SoraOtoha cumulative partial: 35 videos / 563 occurrences / 563 acceptedSongs under the existing queue counter; batch128 has 169 title/artist-unique songs. Published 35/35, occurrence time 563/563, seconds 563/563, thumbnails 35/35; still pending because reachedEnd=false and the latest run was interrupted after the bounded window.
- KohanaLam cumulative partial: 30 videos / 274 occurrences / 147 acceptedSongs under the existing queue counter; batch129 manifest reports 134 unique songs, while validation recalculates 133 title-only unique and 136 title/artist-unique songs. Published 30/30, occurrence time 274/274, seconds 274/274, accepted JSON thumbnail field 0/30; still pending because Mac runner timed out with rc=124 before reachedEnd.
- Queue totals after refresh: 640 videos / 8347 occurrences / 7262 songs.
- Remaining partial full-source-pending handles: ebakyouka, KohanaLam, SoraOtoha, UtenHiyori, UCrF92dEkXiTtexol0yg4Gmw.
