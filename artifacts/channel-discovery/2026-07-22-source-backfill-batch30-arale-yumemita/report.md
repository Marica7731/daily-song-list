# 2026-07-22-source-backfill-batch30-arale-yumemita

This is a status-only failed attempt for `https://www.youtube.com/@arale_yumemita`. It does not modify `data/external` and does not provide an accepted increment.

## Status

| Source | Status | Accepted videos | Accepted occurrences | Unique songs | Time coverage | Reason |
| --- | --- | ---: | ---: | ---: | --- | --- |
| `https://www.youtube.com/@arale_yumemita` | failed | 0 | 0 | 0 | 0/0 | local YouTube candidate-only preflight failed; remote upload was interrupted before any discovery command ran |

## Failure Summary

- Local candidate-only discovery had a 180000 ms timeout but failed before writing manifest/checkpoint. Worker observed `fetch failed` and `curl -4` TLS handshake failure to YouTube.
- Remote `vps-shadow` did not run discovery. The worker was interrupted while uploading `source.tar`, before unpacking or starting any node script.
- No `manifest.json`, `checkpoint.json`, `video-details.json`, `dirty-audit.json`, or `accepted-increment.json` was produced before this status record.
- This source remains pending for a later unique retry batch.

## Remote Cleanup

- Removed `vps-shadow:/opt/ytb-song-rank-source-backfill-20260722-batch30-arale-yumemita-vps-shadow`.
- Post-cleanup `df -h /`: `/dev/sda1 20G 5.9G 13G 32% /`.
