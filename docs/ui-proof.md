# Daily Song List UI Proof

This page is the committed visual proof matrix for the current responsive UI. Regenerate every image and the manifest after UI-facing changes:

```powershell
npm run screenshots:readme -- http://127.0.0.1:8080/
npm run check:ui-proof
```

The manifest at [`docs/assets/screenshots/manifest.json`](assets/screenshots/manifest.json) records screenshot hashes, dimensions, generation time, source fingerprint, viewport, URL parameters, and selector metadata.

`7d`, `all`, partition pagination, search index, and snapshot index images are proof fixtures for the current shipped runtime contract.

## Desktop

| Song ranking | All range via legacy `1m` URL | Artist ranking |
| --- | --- | --- |
| ![Desktop song ranking](assets/screenshots/desktop-song-rank.png) | ![Desktop all range ranking through legacy 1m URL](assets/screenshots/desktop-monthly-song-rank.png) | ![Desktop artist ranking](assets/screenshots/desktop-artist-rank.png) |

| Song index | VTuber channels | Video tab |
| --- | --- | --- |
| ![Desktop song index](assets/screenshots/desktop-song-index.png) | ![Desktop VTuber channel ranking](assets/screenshots/desktop-vtuber-rank.png) | ![Desktop video tab](assets/screenshots/desktop-video-view.png) |

| Summary baseline |
| --- |
| ![Desktop summary baseline](assets/screenshots/desktop-summary-baseline.png) |

| 7d range fixture | All range fixture | Partition pagination |
| --- | --- | --- |
| ![Desktop 7d range fixture](assets/screenshots/desktop-range-7d.png) | ![Desktop all range fixture](assets/screenshots/desktop-range-all.png) | ![Desktop partition pagination fixture](assets/screenshots/desktop-partition-pagination.png) |

| Cumulative diff proof | Kana/Romaji merge proof |
| --- | --- |
| ![Desktop cumulative diff explanation proof](assets/screenshots/desktop-all-diff-explanation.png) | ![Desktop same-title kana and romaji merge proof](assets/screenshots/desktop-song-kana-romaji-merged.png) |

| Unified query panel | Expanded source drawer | Inline source thumbnails |
| --- | --- | --- |
| ![Desktop unified search and filters panel](assets/screenshots/desktop-query-panel.png) | ![Desktop expanded sources](assets/screenshots/desktop-source-expanded.png) | ![Desktop inline source thumbnails](assets/screenshots/desktop-source-inline-3.png) |

| Middle pagination | Long timestamp source | Search and snapshot indexes |
| --- | --- | --- |
| ![Desktop middle pagination](assets/screenshots/desktop-pagination-middle.png) | ![Desktop long timestamp source](assets/screenshots/desktop-source-long-time.png) | ![Desktop search and snapshot index fixture](assets/screenshots/desktop-search-snapshot-index.png) |

## Tablet

| Inline source thumbnails |
| --- |
| ![Tablet inline source thumbnails](assets/screenshots/tablet-source-inline-3.png) |

## Mobile Main Views

| Song ranking | Artist ranking | VTuber channels |
| --- | --- | --- |
| ![Mobile song ranking](assets/screenshots/mobile-song-rank.png) | ![Mobile artist ranking](assets/screenshots/mobile-artist-rank.png) | ![Mobile VTuber channel ranking](assets/screenshots/mobile-vtuber-rank.png) |

| VTuber 320px | Song index |
| --- | --- |
| ![Mobile 320px VTuber channel ranking](assets/screenshots/mobile-vtuber-rank-320.png) | ![Mobile song index](assets/screenshots/mobile-song-index.png) |

| Summary baseline | Toast |
| --- | --- |
| ![Mobile summary baseline](assets/screenshots/mobile-summary-baseline.png) | ![Mobile copy setlist toast](assets/screenshots/mobile-toast-copy-setlist.png) |

| All-time summary | Trend count increase | Trend rank down |
| --- | --- | --- |
| ![Mobile all-time monotonic summary proof](assets/screenshots/mobile-all-monotonic-summary.png) | ![Mobile trend count increase label](assets/screenshots/mobile-trend-count-increase.png) | ![Mobile trend rank-only down label](assets/screenshots/mobile-trend-rank-only-down.png) |

| Trend correction | Kana/Romaji merge | Video diagnostic |
| --- | --- | --- |
| ![Mobile corrected count decrease label](assets/screenshots/mobile-trend-corrected-decrease.png) | ![Mobile same-title kana and romaji merge proof](assets/screenshots/mobile-song-kana-romaji-merged.png) | ![Mobile video diagnostic proof](assets/screenshots/mobile-video-diagnostic-result.png) |

| Song index middle | Song index last | 320px pagination |
| --- | --- | --- |
| ![Mobile song index middle page](assets/screenshots/mobile-song-index-middle-page.png) | ![Mobile song index last page](assets/screenshots/mobile-song-index-last-page.png) | ![Mobile 320px pagination](assets/screenshots/mobile-pagination-320.png) |

| Video tab | Expanded video top | Expanded video bottom |
| --- | --- | --- |
| ![Mobile video tab](assets/screenshots/mobile-video-view.png) | ![Mobile expanded video top](assets/screenshots/mobile-video-expanded.png) | ![Mobile expanded video bottom](assets/screenshots/mobile-video-expanded-bottom.png) |

| Expanded sources |
| --- |
| ![Mobile expanded sources](assets/screenshots/mobile-source-expanded.png) |

## Mobile Query

| Restrictive filter chips | Search suggestions |
| --- | --- |
| ![Mobile restrictive filter chips](assets/screenshots/mobile-active-query-strip.png) | ![Mobile query suggestions](assets/screenshots/mobile-query-suggestions.png) |

| Unified filter controls | Snapshot history | Filtered summary |
| --- | --- | --- |
| ![Mobile unified query filter controls](assets/screenshots/mobile-query-filter.png) | ![Mobile query history](assets/screenshots/mobile-query-history.png) | ![Mobile filtered summary](assets/screenshots/mobile-summary-filtered.png) |

| Active controls | Bottom navigation |
| --- | --- |
| ![Mobile active controls](assets/screenshots/mobile-controls-active.png) | ![Mobile active bottom navigation](assets/screenshots/mobile-bottom-nav-active.png) |

## Source States

| 0 sources | 1 source | 2 sources |
| --- | --- | --- |
| ![Mobile no source row](assets/screenshots/mobile-source-inline-0.png) | ![Mobile one source thumbnail](assets/screenshots/mobile-source-inline-1.png) | ![Mobile two source thumbnails](assets/screenshots/mobile-source-inline-2.png) |

| 3 sources compact | 4+ collapsed | 4+ expanded top |
| --- | --- | --- |
| ![Mobile three-source row with two inline thumbnails and one compact view-all action](assets/screenshots/mobile-source-inline-3.png) | ![Mobile more source collapsed](assets/screenshots/mobile-source-more-than-3.png) | ![Mobile more source expanded top](assets/screenshots/mobile-source-more-than-3-expanded.png) |

| 4+ expanded bottom |
| --- |
| ![Mobile more source expanded bottom](assets/screenshots/mobile-source-more-than-3-expanded-bottom.png) |

| Sources new-to-old | Thumbnail fallback | Long channel name |
| --- | --- | --- |
| ![Mobile sources ordered new-to-old](assets/screenshots/mobile-source-new-to-old.png) | ![Mobile thumbnail fallback](assets/screenshots/mobile-source-thumb-fallback.png) | ![Mobile long channel source](assets/screenshots/mobile-source-long-channel.png) |

| Long timestamp | Extra timestamps |
| --- | --- |
| ![Mobile long timestamp source](assets/screenshots/mobile-source-long-time.png) | ![Mobile extra timestamps](assets/screenshots/mobile-source-extra-times.png) |
