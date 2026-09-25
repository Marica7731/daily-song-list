"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  cleanStaticVideos,
  repeatedDescriptionSources,
  unambiguousNonSongReason,
} = require("../scripts/static/quality-guard");
const { filterRange, shanghaiCalendarStart } = require("../scripts/static/collect-and-build");
const { buildQualityReview, reviewReasons } = require("../scripts/static/quality-review");

function song(title, artist, options = {}) {
  return { title, artist, raw: options.raw ?? `00:10 ${title} - ${artist}`, ...options };
}

function video(index, rows, overrides = {}) {
  return {
    videoId: `test-video-${index}`,
    channelId: `test-channel-${index}`,
    channelName: `Test Channel ${index}`,
    title: `Unrelated karaoke title ${index}`,
    publishedAt: "2026-09-25T12:00:00.000Z",
    songs: rows,
    ...overrides,
  };
}

test("date-shaped real song and common-language song titles are retained", () => {
  assert.equal(unambiguousNonSongReason(song("1/2", "川本真琴")), null);
  assert.equal(unambiguousNonSongReason(song("12/09", "架空バンド")), null);
  assert.equal(unambiguousNonSongReason(song("おかえり", "絢香")), null);
  assert.equal(unambiguousNonSongReason(song("開始", "独立の作曲家")), null);
});

test("religious livestream date and weekday-coded livestream notice are not songs", () => {
  const prayer = song("12/09", "25° Dia [Live Ao vivo]", {
    raw: "Santo Rosário | 40 Dias com São Miguel Arcanjo 2026 | 03:40 | 12/09 | 25° Dia | Live Ao vivo",
  });
  assert.equal(unambiguousNonSongReason(prayer), "prayer_broadcast_timeline");
  const announcement = song("ばた音るーむ Vol.109 配信 2026.9.24", "木", {
    raw: "ばた音るーむ Vol.109 配信 2026.9.24(木)21:00-",
  });
  assert.equal(unambiguousNonSongReason(announcement), "dated_stream_announcement");
  assert.equal(unambiguousNonSongReason(song("まで！達成できず😭9", "26土", {
    raw: "8:00まで！達成できず😭9/26土",
  })), "dated_stream_challenge_result");
  assert.equal(unambiguousNonSongReason(song("ANTES DE COMEÇAR O SEU DIA, OUÇA ESTA PALAVRA", "LUCAS", {
    raw: "ANTES DE COMEÇAR O SEU DIA, OUÇA ESTA PALAVRA | LUCAS 12:31",
  })), "bible_verse_broadcast");
});

test("source hash collision requires several independent channels and video titles", () => {
  const hash = "a".repeat(64);
  const copied = song("Noisy copied text", "未記載", {
    raw: "Some long and unrelated title from a different YouTube livestream 2026",
    sourceId: "description:unrelated:source",
    sourceHash: hash,
  });
  assert.equal(repeatedDescriptionSources(Array.from({ length: 4 }, (_, i) => video(i, [copied]))).size, 0);
  assert.equal(repeatedDescriptionSources(Array.from({ length: 6 }, (_, i) => video(i, [copied], { channelId: "same-channel" }))).size, 0);
  assert.equal(repeatedDescriptionSources(Array.from({ length: 6 }, (_, i) => video(i, [copied]))).get(hash).videoCount, 6);
});

test("contaminated descriptions are reversibly quarantined, while unrelated and repeat songs stay", () => {
  const hash = "b".repeat(64);
  const copied = song("False entry", "Unknown", {
    raw: "Third-party livestream title copied across unrelated singing streams",
    sourceId: "description:wrong-source",
    sourceHash: hash,
  });
  // Over 10% quarantine blocks publication, so use a representative mixed
  // sample: six bad rows across different channels, 120 legitimate rows.
  const input = Array.from({ length: 6 }, (_, i) => video(i, [
    copied,
    ...Array.from({ length: 20 }, (_, n) => song(n ? `Legitimate song ${n}` : "1/2", n ? "Artist" : "川本真琴")),
  ]));
  const before = JSON.stringify(input);
  const result = cleanStaticVideos(input);
  assert.equal(result.audit.quarantinedOccurrences, 6);
  assert.equal(result.audit.visibleOccurrences, 120);
  assert.equal(result.audit.byReason.reused_description_across_unrelated_channels, 6);
  assert.equal(result.videos.length, 6);
  assert(result.videos.every((v) => v.songs.some((s) => s.title === "1/2")));
  assert.equal(JSON.stringify(input), before, "quality pass must never mutate the input/history");
});

test("mass quarantine above 10% fails publication rather than silently deleting music", () => {
  const bad = song("12/09", "25° Dia [Live Ao vivo]", {
    raw: "Santo Rosário | 40 Dias com São Miguel Arcanjo 2026 | 03:40 | 12/09 | 25° Dia | Live Ao vivo",
  });
  assert.throws(() => cleanStaticVideos([video(1, [bad, song("1/2", "川本真琴")])]), /over 10%/);
});

test("today and three-day ranges use Shanghai calendar days, not trailing 24/72 hours", () => {
  const now = new Date("2026-09-25T18:42:00.000Z"); // Sep 26 02:42 Shanghai
  assert.equal(new Date(shanghaiCalendarStart(now)).toISOString(), "2026-09-25T16:00:00.000Z");
  assert.equal(new Date(shanghaiCalendarStart(now, 3)).toISOString(), "2026-09-23T16:00:00.000Z");
  const input = [
    video(1, [song("A", "B")], { publishedAt: "2026-09-25T15:59:59.000Z" }),
    video(2, [song("A", "B")], { publishedAt: "2026-09-25T16:00:00.000Z" }),
    video(3, [song("A", "B")], { publishedAt: "2026-09-23T16:00:00.000Z" }),
    video(4, [song("A", "B")], { publishedAt: "2026-09-23T15:59:59.000Z" }),
  ];
  assert.deepEqual(filterRange(input, now, null, 1).map((v) => v.videoId), ["test-video-2"]);
  assert.deepEqual(filterRange(input, now, null, 3).map((v) => v.videoId), ["test-video-1", "test-video-2", "test-video-3"]);
  assert.equal(filterRange(input, now, 7).length, 4);
});

test("full-history review surfaces questionable records without dropping real songs", () => {
  assert.deepEqual(reviewReasons(song("1/2", "川本真琴")), []);
  const videos = [
    video(1, [song("1/2", "川本真琴"),
      song("栞", "6thアルバム「PUZZLE」より", { raw: "00:20 栞 / 6thアルバム「PUZZLE」より" })],
    { publishedAt: "2026-07-17T11:30:00Z" }),
    video(2, [song("新曲", "テスト", { raw: "00:50 新曲 / テスト" })],
    { publishedAt: "2026-08-20T11:30:00Z" }),
  ];
  const original = JSON.stringify(videos);
  const review = buildQualityReview(videos, { byDay: { "2026-07-17": { quarantinedOccurrences: 2 } } }, new Date("2026-09-25T19:00:00Z"));
  assert.equal(review.status, "REVIEW_ONLY_NO_AUTO_DELETION");
  assert.equal(review.scannedOccurrenceCount, 3);
  assert.equal(review.scannedDays.length, 2);
  assert.equal(review.scannedDays[0].quarantinedOccurrences, 2);
  assert(review.candidates.some((item) => item.reason === "possible_release_metadata_as_artist"));
  assert.equal(JSON.stringify(videos), original);
});
