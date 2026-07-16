# Daily Song List UI Proof

This page is the committed visual proof matrix for the current responsive UI. Regenerate every image and the manifest after UI-facing changes:

```powershell
npm run screenshots:readme -- http://127.0.0.1:8080/
npm run check:ui-proof
```

The manifest at [`docs/assets/screenshots/manifest.json`](assets/screenshots/manifest.json) records screenshot hashes, dimensions, generation time, source fingerprint, viewport, URL parameters, and selector metadata.

## Desktop

| Song ranking | Monthly ranking | Video tab |
| --- | --- | --- |
| ![Desktop song ranking](assets/screenshots/desktop-song-rank.png) | ![Desktop monthly ranking](assets/screenshots/desktop-monthly-song-rank.png) | ![Desktop video tab](assets/screenshots/desktop-video-view.png) |

| Query panel | Expanded source drawer | Inline source thumbnails |
| --- | --- | --- |
| ![Desktop query panel](assets/screenshots/desktop-query-panel.png) | ![Desktop expanded sources](assets/screenshots/desktop-source-expanded.png) | ![Desktop inline source thumbnails](assets/screenshots/desktop-source-inline-3.png) |

| Middle pagination |
| --- |
| ![Desktop middle pagination](assets/screenshots/desktop-pagination-middle.png) |

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

| Snapshot history |
| --- |
| ![Mobile query history](assets/screenshots/mobile-query-history.png) |

## Source States

| 0 sources | 1 source | 2 sources |
| --- | --- | --- |
| ![Mobile no source row](assets/screenshots/mobile-source-inline-0.png) | ![Mobile one source thumbnail](assets/screenshots/mobile-source-inline-1.png) | ![Mobile two source thumbnails](assets/screenshots/mobile-source-inline-2.png) |

| 3 sources | 4+ collapsed | 4+ expanded |
| --- | --- | --- |
| ![Mobile three source thumbnail tail](assets/screenshots/mobile-source-inline-3.png) | ![Mobile more source collapsed](assets/screenshots/mobile-source-more-than-3.png) | ![Mobile more source expanded](assets/screenshots/mobile-source-more-than-3-expanded.png) |

| Thumbnail fallback | Long channel name |
| --- | --- |
| ![Mobile thumbnail fallback](assets/screenshots/mobile-source-thumb-fallback.png) | ![Mobile long channel source](assets/screenshots/mobile-source-long-channel.png) |
