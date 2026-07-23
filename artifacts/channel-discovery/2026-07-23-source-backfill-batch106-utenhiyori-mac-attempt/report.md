# Batch106 UtenHiyori Mac Attempt

Status: `pending_partial`

Reason: `mac_resume_timed_out_before_complete_manifest`

## Scope

This artifact records a bounded Mac discovery attempt and checkpoint. It did not write `data/external`, did not rebuild any production DB, and did not push, deploy, or publish anything.

The initial Mac run produced a discovery marker with 60 candidates / 20 inspected / 7 usable videos / 105 occurrences, but `streams` had `reachedEnd=false`, so it is not treated as a complete importable source.

A bounded resume then advanced the checkpoint to 207 candidates / 27 details / 378 occurrences, with time coverage 27/27 published timestamps and 378/378 occurrence time/seconds. The resume timed out and was terminated before the discovery script emitted a new final marker or rewrote manifest/video-details/occurrences.

## Accepted Increment

The accepted increment is intentionally empty: 0 videos / 0 occurrences / 0 songs. This source remains pending for a later bounded continuation from `mac-checkpoint.json`.

## Cleanup

Mac temp directory cleanup was completed by the main session. Marker: `CODEX_MAC_BATCH106_CLEANUP_OK`. df after cleanup: `/dev/disk3s5 926Gi 326Gi 562Gi 37% /System/Volumes/Data`.

## Outputs

Generated pending evidence in `artifacts/channel-discovery/2026-07-23-source-backfill-batch106-utenhiyori-mac-attempt/`.
