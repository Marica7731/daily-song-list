# Daily Song List UI Proof

This page is the committed visual proof matrix for the current responsive UI. Regenerate every image and the manifest after UI-facing changes:

```powershell
npm run screenshots:readme -- http://127.0.0.1:8080/
npm run check:ui-proof
```

The manifest at [`docs/assets/screenshots/manifest.json`](assets/screenshots/manifest.json) records screenshot hashes, dimensions, generation time, source fingerprint, viewport, URL parameters, and selector metadata.

`7d`, `all`, partition pagination, search index, and snapshot index images are proof fixtures for the current shipped runtime contract.

## Desktop

| Song ranking | Monthly ranking | Video tab |
| --- | --- | --- |
| ![Desktop song ranking](assets/screenshots/desktop-song-rank.png) | ![Desktop monthly ranking](assets/screenshots/desktop-monthly-song-rank.png) | ![Desktop video tab](assets/screenshots/desktop-video-view.png) |

| 7d range fixture | All range fixture | Partition pagination |
| --- | --- | --- |
| ![Desktop 7d range fixture](assets/screenshots/desktop-range-7d.png) | ![Desktop all range fixture](assets/screenshots/desktop-range-all.png) | ![Desktop partition pagination fixture](assets/screenshots/desktop-partition-pagination.png) |

| Query panel | Expanded source drawer | Inline source thumbnails |
| --- | --- | --- |
| ![Desktop query panel](assets/screenshots/desktop-query-panel.png) | ![Desktop expanded sources](assets/screenshots/desktop-source-expanded.png) | ![Desktop inline source thumbnails](assets/screenshots/desktop-source-inline-3.png) |

| Middle pagination | Long timestamp source | Search and snapshot indexes |
| --- | --- | --- |
| ![Desktop middle pagination](assets/screenshots/desktop-pagination-middle.png) | ![Desktop long timestamp source](assets/screenshots/desktop-source-long-time.png) | ![Desktop search and snapshot index fixture](assets/screenshots/desktop-search-snapshot-index.png) |

## Tablet

| Inline source thumbnails |
| --- |
| ![Tablet inline source thumbnails](assets/screenshots/tablet-source-inline-3.png) |

## Mobile Main Views

| Song ranking | Artist ranking | Song index |
| --- | --- | --- |
| ![Mobile song ranking](assets/screenshots/mobile-song-rank.png) | ![Mobile artist ranking](assets/screenshots/mobile-artist-rank.png) | ![Mobile song index](assets/screenshots/mobile-song-index.png) |

| Song index middle | Song index last | 320px pagination |
| --- | --- | --- |
| ![Mobile song index middle page](assets/screenshots/mobile-song-index-middle-page.png) | ![Mobile song index last page](assets/screenshots/mobile-song-index-last-page.png) | ![Mobile 320px pagination](assets/screenshots/mobile-pagination-320.png) |

| Video tab | Expanded video | Expanded sources |
| --- | --- | --- |
| ![Mobile video tab](assets/screenshots/mobile-video-view.png) | ![Mobile expanded video](assets/screenshots/mobile-video-expanded.png) | ![Mobile expanded sources](assets/screenshots/mobile-source-expanded.png) |

## Mobile Query

| Active query strip | Recent searches | Search suggestions |
| --- | --- | --- |
| ![Mobile active query strip](assets/screenshots/mobile-active-query-strip.png) | ![Mobile recent searches](assets/screenshots/mobile-query-recent.png) | ![Mobile query suggestions](assets/screenshots/mobile-query-suggestions.png) |

| Snapshot history | Filtered summary | Active controls |
| --- | --- | --- |
| ![Mobile query history](assets/screenshots/mobile-query-history.png) | ![Mobile filtered summary](assets/screenshots/mobile-summary-filtered.png) | ![Mobile active controls](assets/screenshots/mobile-controls-active.png) |

| Bottom navigation |
| --- |
| ![Mobile active bottom navigation](assets/screenshots/mobile-bottom-nav-active.png) |

## Source States

| 0 sources | 1 source | 2 sources |
| --- | --- | --- |
| ![Mobile no source row](assets/screenshots/mobile-source-inline-0.png) | ![Mobile one source thumbnail](assets/screenshots/mobile-source-inline-1.png) | ![Mobile two source thumbnails](assets/screenshots/mobile-source-inline-2.png) |

| 3 sources compact | 4+ collapsed | 4+ expanded |
| --- | --- | --- |
| ![Mobile three-source row with two inline thumbnails and one compact remaining-source action](assets/screenshots/mobile-source-inline-3.png) | ![Mobile more source collapsed](assets/screenshots/mobile-source-more-than-3.png) | ![Mobile more source expanded](assets/screenshots/mobile-source-more-than-3-expanded.png) |

| Sources new-to-old | Thumbnail fallback | Long channel name |
| --- | --- | --- |
| ![Mobile sources ordered new-to-old](assets/screenshots/mobile-source-new-to-old.png) | ![Mobile thumbnail fallback](assets/screenshots/mobile-source-thumb-fallback.png) | ![Mobile long channel source](assets/screenshots/mobile-source-long-channel.png) |

| Long timestamp | Extra timestamps |
| --- | --- |
| ![Mobile long timestamp source](assets/screenshots/mobile-source-long-time.png) | ![Mobile extra timestamps](assets/screenshots/mobile-source-extra-times.png) |
