const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildSongSourceLinksText,
  buildSourcePreview,
  groupOccurrencesByVideo,
  rankToggleModel,
} = require("../assets/frontend-utils");

test("fixture: one video with multiple timestamps uses timestamp disclosure copy", () => {
  const occurrences = [
    occurrence("same-video", "Fixture Channel", 61),
    occurrence("same-video", "Fixture Channel", 122),
    occurrence("same-video", "Fixture Channel", 183),
  ];
  const groups = groupOccurrencesByVideo(occurrences);

  assert.equal(groups.length, 1);
  assert.equal(groups[0].occurrences.length, 3);
  assert.equal(rankToggleModel({ mode: "song", isExpanded: false, videoCount: groups.length, occurrenceCount: occurrences.length }).text, "3个时间点");
  assert.equal(rankToggleModel({ mode: "song", isExpanded: false, videoCount: groups.length, occurrenceCount: occurrences.length, compact: true }).text, "3个时间点");
});

test("fixture: forty source videos keep all source links copyable", () => {
  const occurrences = Array.from({ length: 40 }, (_, index) =>
    occurrence(`source-${String(index + 1).padStart(2, "0")}`, `Channel ${index + 1}`, 60 + index),
  );
  const groups = groupOccurrencesByVideo(occurrences);
  const preview = buildSourcePreview(occurrences, { limit: 2 });
  const linkText = buildSongSourceLinksText(occurrences);

  assert.equal(groups.length, 40);
  assert.equal(preview.total, 40);
  assert.equal(preview.hiddenCount, 38);
  assert.equal(linkText.split("\n").length, 40);
  assert.match(linkText, /^Channel 1 https:\/\/www\.youtube\.com\/watch\?v=source-01&t=60s/u);
});

test("fixture: artist rank can contain multiple songs with multiple source groups", () => {
  const artistSongs = [
    {
      title: "Fixture Song A",
      occurrences: [occurrence("artist-a-1", "Artist Channel 1", 11), occurrence("artist-a-2", "Artist Channel 2", 22)],
    },
    {
      title: "Fixture Song B",
      occurrences: [occurrence("artist-b-1", "Artist Channel 1", 33), occurrence("artist-b-2", "Artist Channel 3", 44)],
    },
  ];

  assert.deepEqual(
    artistSongs.map((song) => [song.title, groupOccurrencesByVideo(song.occurrences).length, buildSongSourceLinksText(song.occurrences).split("\n").length]),
    [
      ["Fixture Song A", 2, 2],
      ["Fixture Song B", 2, 2],
    ],
  );
});

function occurrence(videoId, channelName, seconds) {
  return {
    item: {
      videoId,
      title: `Video ${videoId}`,
      channelName,
      channelId: `UC${videoId}`,
    },
    song: {
      title: "Fixture Song",
      artist: "Fixture Artist",
      seconds,
      time: `0:${String(seconds).padStart(2, "0")}`,
    },
  };
}
