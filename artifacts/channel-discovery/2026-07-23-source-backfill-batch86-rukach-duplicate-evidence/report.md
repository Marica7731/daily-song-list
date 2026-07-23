# RukaCh Duplicate Evidence

- Status: `skipped_duplicate`
- Reason: `duplicate_concrete_accepted_artifact_exists`
- Target channelHandle: `/@RukaCh.%E9%9B%A8%E6%B5%B7%E3%83%AB%E3%82%AB`
- Target channelUrl: `https://www.youtube.com/@RukaCh.%E9%9B%A8%E6%B5%B7%E3%83%AB%E3%82%AB`

## Existing Batch6 Evidence

- Accepted JSON: `artifacts/channel-discovery/2026-07-22-source-backfill-batch6/accepted/2026-07-22-source-backfill-batch6.accepted.json`
- Raw export JSON: `artifacts/channel-discovery/2026-07-22-source-backfill-batch6/accepted/2026-07-22-source-backfill-batch6.raw-export.json`
- Manifest: `artifacts/channel-discovery/2026-07-22-source-backfill-batch6/manifest.json`
- Report: `artifacts/channel-discovery/2026-07-22-source-backfill-batch6/report.md`
- Dirty audit: `artifacts/channel-discovery/2026-07-22-source-backfill-batch6/dirty-audit.json`
- RukaCh remote discovery manifest: `artifacts/channel-discovery/2026-07-22-source-backfill-batch6/remote-download/vps3/RukaCh/manifest.json`
- RukaCh remote discovery report: `artifacts/channel-discovery/2026-07-22-source-backfill-batch6/remote-download/vps3/RukaCh/report.md`

## Accepted Duplicate Stats

- Existing accepted videos: 29
- Existing accepted occurrences: 271
- Existing accepted unique songs: 239
- Batch6 manifest/report accepted summary: 29/271/239
- Unique song note: batch6 manifest/report reports 239; main-session verification of the accepted JSON with normalized title+artist keys also yields 239.
- Published timestamp coverage: count=29, min=1753134951694, max=1784498151694
- Occurrence time coverage: count=271, min=0:01:33, max=8:18:33
- Seconds coverage: count=271, min=93, max=29913
- acceptedFileHasThumbnailOrCoverFields: false
- Discovery thumbnail coverage from batch6 manifest/report: 29/29
- Accepted file has no thumbnail/cover fields for this channel; discovery thumbnail coverage is referenced from batch6 manifest/report metadata.

## Batch6 Manifest Source Entry

- candidateCount: 48
- inspectedCount: 48
- usableVideoCount: 30
- discoveryOccurrenceCount: 272
- reachedEnd: true
- elapsedSeconds: 689

## Dirty Audit

- Dirty dropped videos: 0
- Dirty dropped occurrences: 0
- Suspicious videos/items: 3
- Suspicious occurrences: 21
- Non-usable candidate videos: 18 (48 candidates - 30 usable videos; tracked separately from dirty dropped).
- Source note: batch6 dirty-audit.json and audit-summary.json have dirty dropped 0/0. RukaCh non-usable candidate evidence is cross-checked from the batch6 RukaCh remote discovery manifest/report: 48 candidates minus 30 usable videos = 18 non-usable candidate videos.
- Skipped existing regression: _zMnCDv-Tw4

Non-usable candidate short-title summary:
- 【 映像あり 】 ライブありがとう！裏話＆振り返りと告知！ 【 雨海ルカ 天晴ひなた / WeatherPlanet 】 (ライブ) (candidate_matched_broad_live_signal_but_not_parsed_as_usable_song_video)
- 【 歌枠 】 この時間のゲリラなら誰も見つけられない！ 【 雨海ルカ / WeatherPlanet 】 (歌, 歌枠) (candidate_matched_broad_live_signal_but_not_parsed_as_usable_song_video)
- 【 歌枠 】 リクエスト◎ 台風だし雨海の出番っしょ！ 【 雨海ルカ / WeatherPlanet 】 (歌, 歌枠) (candidate_matched_broad_live_signal_but_not_parsed_as_usable_song_video)
- 【 歌枠 】 リク◎ 可愛いも切ないもかっこいいも全部歌う！【 雨海ルカ / WeatherPlanet 】 (歌, 歌枠) (candidate_matched_broad_live_signal_but_not_parsed_as_usable_song_video)
- 【 歌枠 】 真夜中にしっとり歌います☔リク◎【 雨海ルカ / WeatherPlanet 】 (歌, 歌枠) (candidate_matched_broad_live_signal_but_not_parsed_as_usable_song_video)
- 【 縦型 歌枠 】 今日もいっぱい歌うぞ～～～！💙リク◎【 雨海ルカ / WeatherPlanet 】 (歌, 歌枠) (candidate_matched_broad_live_signal_but_not_parsed_as_usable_song_video)
- 【 1周年ありがとう 】 ウェザプラから重大告知があります！歌います！！！【 雨海ルカ / WeatherPlanet 】 (歌) (candidate_matched_broad_live_signal_but_not_parsed_as_usable_song_video)
- 【 歌枠 】 リクエスト◎ 降雨予報です！【 雨海ルカ / WeatherPlanet 】 (歌, 歌枠) (candidate_matched_broad_live_signal_but_not_parsed_as_usable_song_video)
- 【 歌枠 】 リクエスト◎ 新しく覚えた曲とかも歌います！【 雨海ルカ / WeatherPlanet 】 (歌, 歌枠) (candidate_matched_broad_live_signal_but_not_parsed_as_usable_song_video)
- 【 #ウェザプラバレンタイン歌枠リレー 】 かわいいルカじゃダメですか？＞＜【 雨海ルカ / WeatherPlanet 】 (歌, 歌枠) (candidate_matched_broad_live_signal_but_not_parsed_as_usable_song_video)
- 【 歌枠 】 新しく覚えた曲も歌ってみルカ！！！【 雨海ルカ / WeatherPlanet 】 (歌, 歌枠) (candidate_matched_broad_live_signal_but_not_parsed_as_usable_song_video)
- 【 歌枠 】 リクエストの曲多めに歌います☔【 雨海ルカ / WeatherPlanet 】 (歌, 歌枠) (candidate_matched_broad_live_signal_but_not_parsed_as_usable_song_video)
- 6 additional candidate rows are elided by the batch6 RukaCh report.

Suspicious short-title summary:
- 【 WP 3DLIVE 】 - 天体観測日和 - 【 雨海ルカ 天晴ひなた / WeatherPlanet 】
- 【 Parking Together! 】 ウェザプラと危険なドライブ！ 【 雨海ルカ / WeatherPlanet 】
- 【 首都高バトル 】雨海ルカと危険なドライブ！【 雨海ルカ / WeatherPlanet 】

## Cleanup And Scope

- Batch6 report evidence includes VPS3/VPS5 df cleanup summary lines:
  - ## Remote Cleanup
  - - VPS3 `/opt/ytb-song-rank-source-backfill-20260722-batch6-vps3`: removed; df `/dev/sda1 99G 11G 89G 11% /`.
  - - VPS5 `/opt/ytb-song-rank-source-backfill-20260722-batch6-vps5`: removed; df `/dev/vda1 10G 2.6G 7.0G 27% /`.
- This batch did not use Mac or VPS.
- No remote temporary directory was created.
- No YouTube fetch was started.
- No `data/external` files were modified.
- No push, deploy, restart, package, or install step was run.
- This batch intentionally emits no duplicate `videos` or `candidates` rows; duplicate details live in `duplicateEvidence`.
