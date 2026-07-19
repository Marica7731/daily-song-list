const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

process.env.DAILY_SONG_REQUEST_DELAY_MS = "0";
process.env.DAILY_SONG_REQUEST_JITTER_MS = "0";

const { extractSearchItems } = require("../scripts/update-songlist");
const {
  channelDiscoveryOptionsFromArgs,
  channelTabUrls,
  filterDiscoveryCandidates,
  findBrowseContinuation,
  matchedDiscoveryKeywords,
  occurrenceRecordsFromDetail,
  parseCliArgs,
  parseYouTubePage,
  rawVideoCandidate,
  runChannelDiscovery,
} = require("../scripts/youtube-channel-discovery-core");

test("channel options normalize YouTube handles, tabs, keywords, and output paths", () => {
  const options = channelDiscoveryOptionsFromArgs(parseCliArgs([
    "--channel-url",
    "@noa_polaris",
    "--singer-name",
    "Noa Polaris",
    "--keyword",
    "LIVE,歌",
    "--tab",
    "streams,videos",
    "--output-dir",
    "artifacts/channel-discovery/noa",
  ]));

  assert.equal(options.channelUrl, "https://www.youtube.com/@noa_polaris");
  assert.equal(options.singerName, "Noa Polaris");
  assert.deepEqual(options.keywords, ["LIVE", "歌"]);
  assert.deepEqual(options.tabs, ["streams", "videos"]);
  assert.equal(path.isAbsolute(options.outputDir), true);
  assert.deepEqual(channelTabUrls(options.channelUrl, options.tabs), [
    "https://www.youtube.com/@noa_polaris/streams?hl=ja&persist_hl=1",
    "https://www.youtube.com/@noa_polaris/videos?hl=ja&persist_hl=1",
  ]);
});

test("channel page parser extracts renderers and browse continuation", () => {
  const html = youtubeHtml({
    initialData: channelData({
      videos: [
        videoRenderer("AAAAAAAAAAA", "【歌枠】夜のうた", "2 日前"),
        videoRenderer("BBBBBBBBBBB", "雑談します", "1 日前"),
      ],
      continuation: "CONTINUATION_TOKEN",
    }),
  });

  const page = parseYouTubePage(html);
  const items = extractSearchItems(page.initialData);
  const filtered = filterDiscoveryCandidates(items, ["歌"], Date.parse("2026-07-19T00:00:00Z"));

  assert.equal(page.apiKey, "API_KEY");
  assert.equal(page.clientVersion, "2.20260719.00.00");
  assert.equal(findBrowseContinuation(page.initialData), "CONTINUATION_TOKEN");
  assert.deepEqual(
    filtered.map((item) => item.videoId),
    ["AAAAAAAAAAA"],
  );
  assert.equal(filtered[0].matchedKeywords[0], "歌");
  assert.equal(new Date(filtered[0].publishedTimestamp).toISOString(), "2026-07-17T00:00:00.000Z");
});

test("channel discovery handles YouTube lockupViewModel channel pages", () => {
  const data = {
    metadata: {
      channelMetadataRenderer: {
        title: "ノア・ポラリス -Noa Polaris-",
        externalId: "UCIu1rRiQLeUU8e1saN6I0eg",
        ownerUrls: ["http://www.youtube.com/@noa_polaris"],
      },
    },
    contents: {
      richGridRenderer: {
        contents: [
          {
            richItemRenderer: {
              content: {
                lockupViewModel: lockupViewModel("EEEEEEEEEEE", "【#推し前／歌枠リレー】再生してください。", "4 か月前"),
              },
            },
          },
        ],
      },
    },
  };

  const items = extractSearchItems(data);
  const filtered = filterDiscoveryCandidates(items, ["歌", "リレー"], Date.parse("2026-07-19T00:00:00Z"));

  assert.equal(items.length, 1);
  assert.equal(items[0].videoId, "EEEEEEEEEEE");
  assert.equal(items[0].title, "【#推し前／歌枠リレー】再生してください。");
  assert.equal(items[0].durationText, "27:45");
  assert.equal(items[0].thumbnailUrl, "https://i.ytimg.com/vi/EEEEEEEEEEE/hqdefault.jpg");
  assert.deepEqual(filtered[0].matchedKeywords, ["歌", "リレー"]);
});

test("runChannelDiscovery writes raw videos, parsed details, occurrences, and report", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-discovery-test-"));
  const firstUrl = "https://www.youtube.com/@noa_polaris/streams?hl=ja&persist_hl=1";
  const pages = {
    [firstUrl]: youtubeHtml({
      initialData: channelData({
        videos: [videoRenderer("AAAAAAAAAAA", "【歌枠】夜のうた", "2 日前"), videoRenderer("BBBBBBBBBBB", "LIVE リレー", "3 日前")],
        continuation: "NEXT_PAGE",
      }),
    }),
  };
  const client = {
    metrics: { requestCount: 1 },
    async getText(url) {
      assert.equal(url, firstUrl);
      return { status: 200, body: pages[url], bytes: Buffer.byteLength(pages[url]), fromCache: false };
    },
  };
  let continuationRequests = 0;
  const fetchImpl = async (url) => {
    assert.match(url, /youtubei\/v1\/browse/u);
    continuationRequests += 1;
    if (continuationRequests === 1) {
      return {
        ok: false,
        status: 500,
        async json() {
          throw new Error("unexpected json read for failed continuation");
        },
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return channelData({ videos: [videoRenderer("CCCCCCCCCCC", "弾き語り セットリスト", "4 日前")] });
      },
    };
  };
  const inspected = [];
  const inspectVideoSongList = async (candidate) => {
    inspected.push(candidate.videoId);
    return {
      detail: {
        videoId: candidate.videoId,
        title: candidate.title,
        channelName: "Noa Polaris",
        channelId: "UC_NOA",
        publishedTimestamp: candidate.publishedTimestamp,
        thumbnailUrl: candidate.thumbnailUrl,
        selectedSourceId: "UgxSongs",
        selectedSourceHash: "hash-source",
        sourceQuality: { sourceType: "comment" },
        songs: [
          {
            time: "12:34",
            seconds: 754,
            title: "少女レイ",
            artist: "みきとP",
            raw: "12:34 少女レイ / みきとP",
            rawHash: "raw-hash",
            sourceId: "UgxSongs",
            sourceHash: "hash-source",
          },
        ],
      },
      audit: { videoId: candidate.videoId, result: "selected" },
    };
  };

  const result = await runChannelDiscovery(
    {
      channelUrl: "https://www.youtube.com/@noa_polaris",
      singerName: "Noa Polaris",
      outputDir: dir,
      cacheDir: path.join(dir, "cache"),
      keywords: ["LIVE", "歌", "弾き語", "リレー"],
      tabs: ["streams"],
      maxChannelPages: 2,
      maxCandidates: 10,
      maxInspect: 2,
      requestIntervalMs: 0,
      requestJitterMs: 0,
      fresh: true,
      candidateOnly: false,
    },
    { client, extractSearchItems, inspectVideoSongList, fetchImpl },
  );

  assert.deepEqual(inspected, ["AAAAAAAAAAA", "BBBBBBBBBBB"]);
  assert.equal(result.manifest.candidateCount, 3);
  assert.equal(result.manifest.usableVideoCount, 2);
  assert.equal(result.manifest.occurrenceCount, 2);
  assert.equal(continuationRequests, 2);
  assert.equal(result.rawVideos[0].sourceSystem, "youtube_channel_discovery");
  assert.equal(result.occurrences[0].sourceSystem, "youtube_channel_discovery");
  assert.equal(result.occurrences[0].verificationStatus, "youtube_discovered");
  assert.equal(fs.existsSync(path.join(dir, "manifest.json")), true);
  assert.equal(fs.existsSync(path.join(dir, "raw-videos.json")), true);
  assert.equal(fs.existsSync(path.join(dir, "occurrences.json")), true);
  assert.match(fs.readFileSync(path.join(dir, "report.md"), "utf8"), /Occurrences: 2/u);
});

test("channel discovery retries transient video detail failures", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-discovery-retry-test-"));
  const firstUrl = "https://www.youtube.com/@noa_polaris/streams?hl=ja&persist_hl=1";
  const client = {
    metrics: { requestCount: 1 },
    async getText(url) {
      assert.equal(url, firstUrl);
      return {
        status: 200,
        body: youtubeHtml({
          initialData: channelData({
            videos: [videoRenderer("AAAAAAAAAAA", "【歌枠】夜のうた", "2 日前")],
          }),
        }),
        bytes: 10,
        fromCache: false,
      };
    },
  };
  let inspectCalls = 0;
  const inspectVideoSongList = async (candidate) => {
    inspectCalls += 1;
    if (inspectCalls === 1) throw new Error("https://www.youtube.com/watch?v=AAAAAAAAAAA HTTP 429");
    return {
      detail: {
        videoId: candidate.videoId,
        title: candidate.title,
        channelName: "Noa Polaris",
        songs: [{ time: "1:00", seconds: 60, title: "Retry Song", artist: "Retry Artist", raw: "1:00 Retry Song / Retry Artist" }],
      },
      audit: { videoId: candidate.videoId, result: "selected" },
    };
  };

  const result = await runChannelDiscovery(
    {
      channelUrl: "https://www.youtube.com/@noa_polaris",
      singerName: "Noa Polaris",
      outputDir: dir,
      cacheDir: path.join(dir, "cache"),
      keywords: ["歌"],
      tabs: ["streams"],
      maxChannelPages: 1,
      maxCandidates: 10,
      maxInspect: 1,
      requestIntervalMs: 0,
      requestJitterMs: 0,
      fresh: true,
      candidateOnly: false,
    },
    { client, extractSearchItems, inspectVideoSongList },
  );

  assert.equal(inspectCalls, 2);
  assert.equal(result.manifest.usableVideoCount, 1);
  assert.equal(result.manifest.occurrenceCount, 1);
});

test("raw and occurrence records carry fields needed by the review/import pipeline", () => {
  const raw = rawVideoCandidate({
    channelUrl: "https://www.youtube.com/@kanaruhanon",
    channelId: "UC_HANON",
    videoId: "DDDDDDDDDDD",
    title: "歌リレー",
    channelName: "Hanon",
    thumbnailUrl: "https://example.test/thumb.jpg",
    publishedTimestamp: Date.parse("2026-07-18T00:00:00Z"),
    matchedKeywords: ["歌", "リレー"],
    discoverySourceUrl: "https://www.youtube.com/@kanaruhanon/streams",
    fetchedAt: "2026-07-19T00:00:00Z",
  });
  const occurrences = occurrenceRecordsFromDetail(
    {
      videoId: "DDDDDDDDDDD",
      title: "歌リレー",
      channelName: "Hanon",
      channelId: "UC_HANON",
      discoveryChannelUrl: "https://www.youtube.com/@kanaruhanon",
      discoverySingerName: "Hanon",
      thumbnailUrl: "https://example.test/thumb.jpg",
      publishedTimestamp: Date.parse("2026-07-18T00:00:00Z"),
      matchedKeywords: ["歌", "リレー"],
      selectedSourceId: "UgxSource",
      selectedSourceHash: "source-hash",
      songs: [{ time: "1:02:03", seconds: 3723, title: "花に亡霊", artist: "ヨルシカ", raw: "1:02:03 花に亡霊 / ヨルシカ" }],
    },
    "Hanon",
  );

  assert.equal(raw.youtubeVideoId, "DDDDDDDDDDD");
  assert.equal(raw.youtubeUrl, "https://www.youtube.com/watch?v=DDDDDDDDDDD");
  assert.equal(raw.publishedAt, "2026-07-18T00:00:00.000Z");
  assert.equal(raw.rawHash.length, 64);
  assert.equal(occurrences.length, 1);
  assert.equal(occurrences[0].youtubeUrl, "https://www.youtube.com/watch?v=DDDDDDDDDDD&t=3723s");
  assert.equal(occurrences[0].timestampText, "1:02:03");
  assert.equal(occurrences[0].cleanedTitle, "花に亡霊");
  assert.equal(occurrences[0].provenance.kind, "comment_or_description_timestamp");
});

test("keyword matching handles the requested channel styles", () => {
  assert.deepEqual(matchedDiscoveryKeywords("朝活 LIVE karaoke", ["LIVE", "歌"]), ["LIVE"]);
  assert.deepEqual(matchedDiscoveryKeywords("弾き語り多めの歌配信", ["LIVE", "歌", "弾き語"]), ["歌", "弾き語"]);
  assert.deepEqual(matchedDiscoveryKeywords("大型歌枠リレー", ["歌", "リレー"]), ["歌", "リレー"]);
});

function youtubeHtml({ initialData }) {
  return `<!doctype html><script nonce="x">var ytcfg = {}; "INNERTUBE_API_KEY":"API_KEY","INNERTUBE_CLIENT_VERSION":"2.20260719.00.00"; var ytInitialData = ${JSON.stringify(
    initialData,
  )};</script>`;
}

function channelData({ videos, continuation = "" }) {
  return {
    contents: {
      twoColumnBrowseResultsRenderer: {
        tabs: [
          {
            tabRenderer: {
              content: {
                richGridRenderer: {
                  contents: [
                    ...videos.map((video) => ({ richItemRenderer: { content: { videoRenderer: video } } })),
                    ...(continuation
                      ? [
                          {
                            continuationItemRenderer: {
                              continuationEndpoint: {
                                commandMetadata: { webCommandMetadata: { apiUrl: "/youtubei/v1/browse" } },
                                continuationCommand: { token: continuation },
                              },
                            },
                          },
                        ]
                      : []),
                  ],
                },
              },
            },
          },
        ],
      },
    },
  };
}

function videoRenderer(videoId, title, publishedText) {
  return {
    videoId,
    title: { runs: [{ text: title }] },
    ownerText: {
      runs: [
        {
          text: "Noa Polaris",
          navigationEndpoint: { browseEndpoint: { browseId: "UC_NOA", canonicalBaseUrl: "/@noa_polaris" } },
        },
      ],
    },
    publishedTimeText: { simpleText: publishedText },
    lengthText: { simpleText: "1:23:45" },
    thumbnail: {
      thumbnails: [
        { url: `https://i.ytimg.com/vi/${videoId}/default.jpg`, width: 120 },
        { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, width: 480 },
      ],
    },
  };
}

function lockupViewModel(videoId, title, publishedText) {
  return {
    contentId: videoId,
    contentImage: {
      thumbnailViewModel: {
        image: {
          sources: [
            { url: `https://i.ytimg.com/vi/${videoId}/default.jpg`, width: 120 },
            { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, width: 480 },
          ],
        },
        overlays: [
          {
            thumbnailBottomOverlayViewModel: {
              badges: [{ thumbnailBadgeViewModel: { text: "27:45" } }],
            },
          },
        ],
      },
    },
    metadata: {
      lockupMetadataViewModel: {
        title: { content: title },
        metadata: {
          contentMetadataViewModel: {
            metadataRows: [
              {
                metadataParts: [{ text: { content: "680回視聴" } }, { text: { content: publishedText } }],
              },
            ],
          },
        },
      },
    },
    rendererContext: {
      commandContext: {
        onTap: {
          innertubeCommand: {
            watchEndpoint: { videoId },
          },
        },
      },
    },
  };
}
