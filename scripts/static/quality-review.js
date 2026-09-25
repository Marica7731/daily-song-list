"use strict";

// Review-only scan: none of these signals is sufficient to delete a song.
// Helps distinguish single-source metadata errors from genuine song names.
function reviewReasons(song) {
  const title = String(song?.title || "").normalize("NFKC").trim();
  const artist = String(song?.artist || "").normalize("NFKC").trim();
  const raw = String(song?.raw || "").normalize("NFKC").trim();
  const reasons = [];

  if (/^(?:雑談|トーク|MC|スパチャ|コメント|告知)(?:パート|タイム|読み|紹介|開始|終了)?[①-⑳\d]*$/iu.test(title)) {
    reasons.push("possible_spoken_section");
  }
  if (/^(?:.*(?:配信|ライブ|stream|Live).*)?(?:20\d{2})[./-]\d{1,2}[./-]\d{1,2}/iu.test(title) &&
      /(?:配信|stream|live|配信予定|ch\.?)/iu.test(raw)) {
    reasons.push("possible_stream_poster");
  }
  if (/^(?:[月火水木金土日]|\d{1,2}|20\d{2}|\d{1,2}[月火水木金土日])$/u.test(artist) &&
      /\d{1,2}[./-]\d{1,2}|日|年|月|20\d{2}|配信|ライブ|Live/u.test(raw)) {
    reasons.push("possible_date_as_artist");
  }
  if (/(?:アルバム|リリース|発売|より|配信日|公開日|20\d{2}[./-]\d{1,2}[./-]\d{1,2})/iu.test(artist)) {
    reasons.push("possible_release_metadata_as_artist");
  }
  if (title.length > 75 || artist.length > 75) reasons.push("possible_unparsed_credits");
  if (title.length > 25 && /\b(?:YouTube|チャンネル登録|スパチャ|メンバーシップ|配信開始|配信終了|アーカイブ|コメント欄)\b/iu.test(title)) {
    reasons.push("possible_promotion_as_song");
  }
  return reasons;
}

function buildQualityReview(videos, audit, now) {
  const groups = new Map();
  const descriptionHash = new Map();
  let occurrenceCount = 0;
  const days = new Map();
  const add = (reason, video, song) => {
    const key = [reason, String(song.sourceHash || ""), String(song.raw || "").normalize("NFKC").slice(0, 220), song.title || "", song.artist || ""].join("\u001f");
    let row = groups.get(key);
    if (!row) {
      row = { reason, title: song.title || "", artist: song.artist || "", raw: String(song.raw || "").slice(0, 230), sourceHash: song.sourceHash || "", count: 0, channels: new Set(), videos: new Set(), sample: [] };
      groups.set(key, row);
    }
    row.count++;
    row.channels.add(video.channelId || video.channelName || video.videoId);
    row.videos.add(video.videoId);
    if (row.sample.length < 2 && !row.sample.some(x => x.videoId === video.videoId)) row.sample.push({ videoId: video.videoId, channelName: video.channelName || "", publishedAt: video.publishedAt || "" });
  };
  for (const video of videos) {
    const day = String(video.publishedAt || "").slice(0, 10) || "unknown";
    days.set(day, (days.get(day) || 0) + (video.songs || []).length);
    for (const song of video.songs || []) {
      occurrenceCount++;
      for (const reason of reviewReasons(song)) add(reason, video, song);
      const hash = String(song.sourceHash || "");
      if (hash && String(song.sourceId || "").startsWith("description:")) {
        let row = descriptionHash.get(hash);
        if (!row) { row = { videos: new Set(), channels: new Set(), raw: String(song.raw || "").slice(0, 200), sample: [] }; descriptionHash.set(hash, row); }
        row.videos.add(video.videoId);
        row.channels.add(video.channelId || video.channelName || video.videoId);
        if (row.sample.length < 3 && !row.sample.includes(video.videoId)) row.sample.push(video.videoId);
      }
    }
  }
  const byReason = {};
  for (const row of groups.values()) byReason[row.reason] = (byReason[row.reason] || 0) + row.count;
  return {
    schemaVersion: 1, status: "REVIEW_ONLY_NO_AUTO_DELETION", generatedAt: now.toISOString(),
    scannedVideoCount: videos.length, scannedOccurrenceCount: occurrenceCount,
    scannedDays: [...days].sort(([a],[b])=>a.localeCompare(b)).map(([date, occurrences])=>({ date, occurrences, quarantinedOccurrences: audit.byDay?.[date]?.quarantinedOccurrences || 0 })),
    byReason,
    candidates: [...groups.values()]
      .sort((a,b)=>b.channels.size-a.channels.size || b.count-a.count || a.reason.localeCompare(b.reason))
      .slice(0,250).map(({channels,videos,...row})=>({...row,videoCount:videos.size,channelCount:channels.size})),
    descriptionsSharedAcrossTwoToFourChannels: [...descriptionHash]
      .filter(([,row])=>row.channels.size >= 2 && row.channels.size < 5)
      .sort((a,b)=>b[1].channels.size-a[1].channels.size)
      .slice(0,80)
      .map(([sourceHash,row])=>({sourceHash,videoCount:row.videos.size,channelCount:row.channels.size,raw:row.raw,sample:row.sample})),
  };
}

module.exports = { buildQualityReview, reviewReasons };
