const {
  UUID_PATTERN,
  absoluteUrl,
  decodeHtml,
  extractMetaContent,
  extractTitle,
  extractUuidFromPath,
  getAttr,
  normalizeText,
  parseJapaneseDate,
  parseTimestampToSeconds,
  parseYouTubeVideoId,
  sha256,
  stripTags,
  uniqueBy,
} = require("./html-utils");

const BASE_URL = "https://vsinger-moment.jp";
const SONG_DETAIL_RE = new RegExp(`<a\\b[^>]*href="(/songs/(${UUID_PATTERN})(?:\\?[^"]*)?)"[^>]*>詳細を見る</a>`, "gi");
const STREAM_DETAIL_RE = new RegExp(`<a\\b[^>]*href="(/videos/(${UUID_PATTERN}))"[^>]*>詳細を見る</a>`, "gi");
const SINGER_DETAIL_RE = new RegExp(`<a\\b[^>]*href="(/singers/(${UUID_PATTERN}))"[^>]*>詳細を見る</a>`, "gi");

function parseSongsPage(html, pageUrl = `${BASE_URL}/songs`) {
  const pageHash = sha256(html);
  const songs = [];
  const detailMatches = [...html.matchAll(SONG_DETAIL_RE)];

  for (const match of detailMatches) {
    const songPagePath = match[1];
    const externalSongId = match[2];
    const cardStart = html.lastIndexOf('<div class="bg-white rounded-lg shadow-sm hover:shadow-lg', match.index);
    if (cardStart === -1) continue;
    const nextCardStart = html.indexOf('<div class="bg-white rounded-lg shadow-sm hover:shadow-lg', match.index + match[0].length);
    const cardEnd = nextCardStart === -1 ? html.indexOf('<div class="mt-12', match.index) : nextCardStart;
    const card = html.slice(cardStart, cardEnd === -1 ? Math.min(html.length, match.index + 6000) : cardEnd);
    const title = stripTags(card.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1] || "");
    const artist = stripTags(card.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] || "");
    const singingCountText = stripTags(card.match(/title="歌唱回数"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || "");
    const singingCountReference = Number.parseInt((singingCountText.match(/\d+/) || [])[0] || "", 10);
    const latestPerformanceDate = parseJapaneseDate(card.match(/title="最新歌唱日"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || "");
    const recentSingerName = stripTags(card.match(/最近:[\s\S]*?<a\b[^>]*href="\/singers\/[^"]+"[^>]*>([\s\S]*?)<\/a>/i)?.[1] || "");

    songs.push({
      externalSongId,
      title,
      originalArtist: artist,
      singingCountReference: Number.isFinite(singingCountReference) ? singingCountReference : null,
      latestPerformanceDate,
      recentSingerName,
      songPageUrl: absoluteUrl(songPagePath, BASE_URL),
      sourceSystem: "vsinger_moment_http",
      fetchedAt: new Date().toISOString(),
      pageCursor: new URL(pageUrl, BASE_URL).searchParams.get("cursor") || "",
      rawHash: pageHash,
    });
  }

  return {
    pageUrl: absoluteUrl(pageUrl, BASE_URL),
    pageHash,
    observedSiteSongCount: extractObservedSongCount(html),
    songs: uniqueBy(songs, (song) => song.externalSongId),
    rawRowCount: songs.length,
    nextPageUrl: extractNextCursorUrl(html, "songs"),
    linkFormats: {
      songDetail: detailMatches.length ? "/songs/{uuid}" : "",
      youtube: inferYouTubeFormat(html),
    },
  };
}

function parseStreamsPage(html, pageUrl = `${BASE_URL}/streams`) {
  const pageHash = sha256(html);
  const videos = [];
  const detailMatches = [...html.matchAll(STREAM_DETAIL_RE)];

  for (const match of detailMatches) {
    const videoPagePath = match[1];
    const externalVideoId = match[2];
    const cardStart = html.lastIndexOf('<div class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden', match.index);
    if (cardStart === -1) continue;
    const nextCardStart = html.indexOf('<div class="bg-white rounded-lg shadow-sm border border-gray-200 overflow-hidden', match.index + match[0].length);
    const cardEnd = nextCardStart === -1 ? html.indexOf('<div class="mt-12', match.index) : nextCardStart;
    const card = html.slice(cardStart, cardEnd === -1 ? Math.min(html.length, match.index + 6000) : cardEnd);
    const imgTag = card.match(/<img\b[^>]*>/i)?.[0] || "";
    const singerAnchor = card.match(/<a\b[^>]*href="\/singers\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    const youtubeUrl = decodeHtml((card.match(/https:\/\/www\.youtube\.com\/watch\?v=[^"'<\s]+/i) || [])[0] || "");
    const setlistSongs = parseSetlistRows(card, { includeArtists: false });
    const hasNoSetlist = /セットリスト情報なし/.test(card);
    const setlistStatus = hasNoSetlist
      ? "none"
      : setlistSongs.length
        ? setlistSongs.some((song) => song.seconds == null || !song.externalSongId)
          ? "incomplete"
          : "complete"
        : "unknown";

    videos.push({
      externalVideoId,
      youtubeVideoId: parseYouTubeVideoId(youtubeUrl),
      youtubeUrl,
      videoPageUrl: absoluteUrl(videoPagePath, BASE_URL),
      videoTitle: stripTags(card.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1] || ""),
      singerId: singerAnchor?.[1] || "",
      singerName: stripTags(singerAnchor?.[2] || ""),
      streamedAt: parseJapaneseDate(card.match(/lucide-calendar[\s\S]*?<\/svg>([\s\S]*?)<\/div>/i)?.[1] || ""),
      thumbnailUrl: getAttr(imgTag, "src"),
      setlistStatus,
      setlistSongs,
      detailQueueReasons: detailQueueReasons({
        youtubeVideoId: parseYouTubeVideoId(youtubeUrl),
        setlistStatus,
        setlistSongs,
      }),
      sourceSystem: "vsinger_moment_http",
      fetchedAt: new Date().toISOString(),
      pageCursor: new URL(pageUrl, BASE_URL).searchParams.get("cursor") || "",
      rawHash: pageHash,
    });
  }

  return {
    pageUrl: absoluteUrl(pageUrl, BASE_URL),
    pageHash,
    videos: uniqueBy(videos, (video) => video.externalVideoId),
    rawRowCount: videos.length,
    nextPageUrl: extractNextCursorUrl(html, "streams"),
    linkFormats: {
      videoDetail: detailMatches.length ? "/videos/{uuid}" : "",
      songDetail: new RegExp(`/songs/${UUID_PATTERN}`, "i").test(html) ? "/songs/{uuid}" : "",
      youtube: inferYouTubeFormat(html),
    },
    setlistPresentInHtml: /セットリスト/.test(html) && new RegExp(`/songs/${UUID_PATTERN}`, "i").test(html),
  };
}

function parseSingersPage(html, pageUrl = `${BASE_URL}/singers`) {
  const pageHash = sha256(html);
  const singers = [];
  const detailMatches = [...html.matchAll(SINGER_DETAIL_RE)];

  for (const match of detailMatches) {
    const singerPagePath = match[1];
    const externalSingerId = match[2];
    const cardStart = html.lastIndexOf('<div class="bg-white rounded-lg shadow-sm hover:shadow-lg', match.index);
    if (cardStart === -1) continue;
    const nextCardStart = html.indexOf('<div class="bg-white rounded-lg shadow-sm hover:shadow-lg', match.index + match[0].length);
    const cardEnd = nextCardStart === -1 ? html.indexOf('<div class="mt-12', match.index) : nextCardStart;
    const card = html.slice(cardStart, cardEnd === -1 ? Math.min(html.length, match.index + 6000) : cardEnd);
    const imgTag = card.match(/<img\b[^>]*>/i)?.[0] || "";
    const singerSongsUrl = extractSingerScopedLink(card, "songs", externalSingerId);
    const singerStreamsUrl = extractSingerScopedLink(card, "streams", externalSingerId);
    const youtubeChannelUrl = extractYouTubeChannelUrl(card);

    singers.push({
      externalSingerId,
      singerName: stripTags(card.match(/<h2\b[^>]*>([\s\S]*?)<\/h2>/i)?.[1] || ""),
      description: stripTags(card.match(/<p\b[^>]*line-clamp-2[^>]*>([\s\S]*?)<\/p>/i)?.[1] || ""),
      imageUrl: getAttr(imgTag, "src"),
      lastStreamText: stripTags(card.match(/title="最終配信"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || ""),
      lastStreamDate: parseJapaneseDate(card.match(/title="最終配信"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || ""),
      totalSingingCount: parseTitledCount(card, "総歌唱数"),
      streamVideoCount: parseTitledCount(card, "配信動画数"),
      repertoireSongCount: parseTitledCount(card, "レパートリー数"),
      vocalFeatures: extractSingerFeatureTags(card),
      singerPageUrl: absoluteUrl(singerPagePath, BASE_URL),
      singerSongsUrl,
      singerStreamsUrl,
      youtubeChannelUrl,
      youtubeChannelId: extractYouTubeChannelId(youtubeChannelUrl),
      sourceSystem: "vsinger_moment_http",
      fetchedAt: new Date().toISOString(),
      pageCursor: new URL(pageUrl, BASE_URL).searchParams.get("cursor") || "",
      rawHash: pageHash,
    });
  }

  return {
    pageUrl: absoluteUrl(pageUrl, BASE_URL),
    pageHash,
    observedSingerCount: extractObservedSingerCount(html),
    singers: uniqueBy(singers, (singer) => singer.externalSingerId),
    rawRowCount: singers.length,
    nextPageUrl: extractNextCursorUrl(html, "singers"),
    linkFormats: {
      singerDetail: detailMatches.length ? "/singers/{uuid}" : "",
      singerSongs: new RegExp(`/songs\\?[^"]*singerId=${UUID_PATTERN}`, "i").test(html) ? "/songs?singerId={uuid}&singerName={name}" : "",
      singerStreams: new RegExp(`/streams\\?[^"]*singerId=${UUID_PATTERN}`, "i").test(html) ? "/streams?singerId={uuid}&singerName={name}" : "",
      youtubeChannel: extractYouTubeChannelUrl(html) ? "https://www.youtube.com/channel/{channelId}" : "",
    },
  };
}

function parseSingerDetailPage(html, pageUrl) {
  const canonicalUrl = extractMetaContent(html, "property", "og:url") || pageUrl;
  const externalSingerId = extractUuidFromPath(canonicalUrl, "singers") || extractUuidFromPath(pageUrl, "singers");
  const name = stripTags(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "") || extractTitle(html).replace(/\s+\|[\s\S]*$/, "");
  const text = stripTags(html);
  const singerSongsUrl = extractSingerScopedLink(html, "songs", externalSingerId);
  const singerStreamsUrl = extractSingerScopedLink(html, "streams", externalSingerId);
  const youtubeChannelUrl = extractYouTubeChannelUrl(html);

  return {
    externalSingerId,
    singerName: name,
    description: extractMetaContent(html, "name", "description") || extractMetaContent(html, "property", "og:description"),
    imageUrl: getAttr(html.match(new RegExp(`<img\\b[^>]*alt="${escapeRegExp(name)}"[^>]*>`, "i"))?.[0] || "", "src") || extractMetaContent(html, "property", "og:image"),
    streamVideoCount: parseLabelCount(text, "歌枠動画"),
    repertoireSongCount: parseLabelCount(text, "レパートリー"),
    totalSingingCount: parseLabelCount(text, "歌唱数"),
    singerSongsUrl,
    singerStreamsUrl,
    youtubeChannelUrl,
    youtubeChannelId: extractYouTubeChannelId(youtubeChannelUrl),
    dateModified: (html.match(/"dateModified":"([^"]+)"/) || [])[1] || "",
    lastReviewed: (html.match(/"lastReviewed":"([^"]+)"/) || [])[1] || "",
    sourceSystem: "vsinger_moment_http",
    fetchedAt: new Date().toISOString(),
    singerPageUrl: absoluteUrl(canonicalUrl || pageUrl, BASE_URL),
    rawHash: sha256(html),
  };
}

function parseVideoDetailPage(html, pageUrl) {
  const canonicalUrl = extractMetaContent(html, "property", "og:url") || pageUrl;
  const externalVideoId = extractUuidFromPath(canonicalUrl, "videos") || extractUuidFromPath(pageUrl, "videos");
  const title = (extractMetaContent(html, "property", "og:title") || extractTitle(html)).replace(/\s+-\s+VSinger Moment$/, "");
  const description = extractMetaContent(html, "property", "og:description");
  const singerName = stripTags(description.match(/^(.+?)の歌枠配信/)?.[1] || "");
  const image = extractMetaContent(html, "property", "og:image");
  const imageYouTubeId = parseYouTubeVideoId(image.replace(/https:\/\/i\.ytimg\.com\/vi\/([^/]+).*/, "https://www.youtube.com/watch?v=$1"));
  const youtubeUrl = decodeHtml((html.match(/https:\/\/www\.youtube\.com\/watch\?v=[^"'<\s]+/i) || [])[0] || "");
  const setlistSongs = parseSetlistRows(html, { includeArtists: true });
  return {
    externalVideoId,
    youtubeVideoId: parseYouTubeVideoId(youtubeUrl) || imageYouTubeId,
    youtubeUrl: youtubeUrl || (imageYouTubeId ? `https://www.youtube.com/watch?v=${imageYouTubeId}` : ""),
    videoPageUrl: absoluteUrl(canonicalUrl || pageUrl, BASE_URL),
    videoTitle: title,
    singerId: "",
    singerName,
    streamedAt: parseJapaneseDate(html),
    thumbnailUrl: image,
    setlistStatus: setlistSongs.length ? "complete" : "none",
    setlistSongs,
    sourceSystem: "vsinger_moment_http",
    fetchedAt: new Date().toISOString(),
    rawHash: sha256(html),
  };
}

function parseSongDetailPage(html, pageUrl) {
  const canonicalUrl = extractMetaContent(html, "property", "og:url") || pageUrl;
  const externalSongId = extractUuidFromPath(canonicalUrl, "songs") || extractUuidFromPath(pageUrl, "songs");
  const heading = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "";
  const title = stripTags(heading) || (extractMetaContent(html, "property", "og:title") || extractTitle(html)).replace(/\s+-\s+VSinger Moment$/, "");
  const firstArtist = stripTags(html.match(/<h1\b[\s\S]*?<\/h1>\s*<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] || "");
  return {
    externalSongId,
    title,
    originalArtist: firstArtist,
    songPageUrl: absoluteUrl(canonicalUrl || pageUrl, BASE_URL),
    videoLinkCount: (html.match(new RegExp(`/videos/${UUID_PATTERN}`, "gi")) || []).length,
    youtubeLinkFormat: inferYouTubeFormat(html),
    rawHash: sha256(html),
  };
}

function parseSongOccurrencesPage(html, pageUrl) {
  const canonicalUrl = extractMetaContent(html, "property", "og:url") || pageUrl;
  const page = new URL(pageUrl, BASE_URL);
  const externalSongId = extractUuidFromPath(canonicalUrl, "songs") || extractUuidFromPath(pageUrl, "songs");
  const singerIdFilter = page.searchParams.get("singerId") || "";
  const title = stripTags(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || "") || extractTitle(html).replace(/\s+-\s+VSinger Moment$/, "");
  const originalArtist = stripTags(html.match(/<h1\b[\s\S]*?<\/h1>\s*<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] || "");
  const totalSingingCount = parseLabelCount(stripTags(html), "回歌われています");
  const singerCount = parseLabelCount(stripTags(html), "人が歌っています");
  const historyCount = Number.parseInt((stripTags(html).match(/全\s*(\d[\d,]*)\s*件/) || [])[1]?.replace(/,/g, "") || "", 10);
  const occurrences = [];
  const videoAnchorRe = new RegExp(`<a\\b[^>]*href="(/videos/(${UUID_PATTERN}))"[^>]*>([\\s\\S]*?)</a>`, "gi");

  for (const match of html.matchAll(videoAnchorRe)) {
    const row = surroundingOccurrenceRow(html, match.index);
    const timestampText = (stripTags(row).match(/(?:(?:\d{1,2}:)?\d{1,2}:\d{2})/) || [])[0] || "";
    if (!timestampText) continue;
    const singerAnchor = row.match(new RegExp(`<a\\b[^>]*href="/singers/(${UUID_PATTERN})"[^>]*>([\\s\\S]*?)</a>`, "i"));
    const youtubeUrl = decodeHtml((row.match(/https:\/\/www\.youtube\.com\/watch\?v=[^"'<\s]+/i) || [])[0] || "");
    occurrences.push({
      externalSongId,
      rawTitle: title,
      rawArtist: originalArtist || null,
      songPageUrl: absoluteUrl(canonicalUrl || pageUrl, BASE_URL),
      externalVideoId: match[2],
      videoPageUrl: absoluteUrl(match[1], BASE_URL),
      videoTitle: stripTags(match[3] || ""),
      singerId: singerAnchor?.[1] || singerIdFilter,
      singerName: stripTags(singerAnchor?.[2] || ""),
      youtubeVideoId: parseYouTubeVideoId(youtubeUrl),
      youtubeUrl,
      streamedAt: parseJapaneseDate(row),
      seconds: parseTimestampToSeconds(timestampText),
      timestampText,
      sourceSystem: "vsinger_moment_http",
      sourceUrl: absoluteUrl(pageUrl, BASE_URL),
      fetchedAt: new Date().toISOString(),
      rawHash: sha256(row),
    });
  }

  return {
    externalSongId,
    title,
    originalArtist,
    songPageUrl: absoluteUrl(canonicalUrl || pageUrl, BASE_URL),
    singerIdFilter,
    totalSingingCount: Number.isFinite(totalSingingCount) ? totalSingingCount : null,
    singerCount: Number.isFinite(singerCount) ? singerCount : null,
    historyCount: Number.isFinite(historyCount) ? historyCount : null,
    occurrences: uniqueBy(occurrences, (occurrence) => `${occurrence.singerId}:${occurrence.externalVideoId}:${occurrence.seconds}`),
    rawHash: sha256(html),
  };
}

function parseSetlistRows(html, options = {}) {
  const rows = [];
  const anchorRe = new RegExp(`<a\\b[^>]*href="(/songs/(${UUID_PATTERN}))"[^>]*>([\\s\\S]*?)</a>`, "gi");
  for (const match of html.matchAll(anchorRe)) {
    const row = surroundingSetlistRow(html, match.index);
    const songHref = match[1] || "";
    const externalSongId = extractUuidFromPath(songHref, "songs");
    const timestampText =
      stripTags((row.match(/<span\b[^>]*font-mono[^>]*>([\s\S]*?)<\/span>/i) || [])[1] || "") ||
      (stripTags(row).match(/(?:(?:\d{1,2}:)?\d{1,2}:\d{2})/) || [])[0] ||
      "";
    if (!timestampText) continue;
    const title =
      stripTags((row.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i) || [])[1] || "") ||
      stripTags(match[3] || "");
    const artist = options.includeArtists ? stripTags((row.match(/<p\b[^>]*text-gray-600[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || "") : "";
    rows.push({
      externalSongId,
      rawTitle: title,
      rawArtist: artist || null,
      seconds: parseTimestampToSeconds(timestampText),
      timestampText,
      songPageUrl: songHref ? absoluteUrl(songHref, BASE_URL) : "",
    });
  }
  return uniqueBy(rows, (song) => `${song.externalSongId}:${song.seconds}:${song.rawTitle}`);
}

function surroundingOccurrenceRow(html, index) {
  const starts = [
    html.lastIndexOf('<div class="group', index),
    html.lastIndexOf('<div class="flex', index),
    html.lastIndexOf("<li", index),
  ].filter((value) => value >= 0);
  const start = starts.length ? Math.max(...starts) : Math.max(0, index - 1200);
  const nextStarts = [
    html.indexOf('<div class="group', index + 1),
    html.indexOf("<li", index + 1),
  ].filter((value) => value > index);
  const end = nextStarts.length ? Math.min(...nextStarts) : Math.min(html.length, index + 2400);
  return html.slice(start, end);
}

function surroundingSetlistRow(html, index) {
  const starts = [
    html.lastIndexOf('<div class="group', index),
    html.lastIndexOf('<div class="text-xs text-gray-700', index),
    html.lastIndexOf("<li", index),
  ].filter((value) => value >= 0);
  const start = starts.length ? Math.max(...starts) : Math.max(0, index - 1000);
  const nextStarts = [
    html.indexOf('<div class="group', index + 1),
    html.indexOf('<div class="text-xs text-gray-700', index + 1),
    html.indexOf("<li", index + 1),
  ].filter((value) => value > index);
  const end = nextStarts.length ? Math.min(...nextStarts) : Math.min(html.length, index + 2000);
  return html.slice(start, end);
}

function extractObservedSongCount(html) {
  const sources = [
    extractMetaContent(html, "name", "description"),
    extractMetaContent(html, "property", "og:description"),
    html.slice(0, 20000),
  ];
  for (const source of sources) {
    const match = decodeHtml(source).match(/(\d[\d,]*)\s*曲以上|楽曲:\s*(\d[\d,]*)\s*曲/);
    if (match) return Number.parseInt((match[1] || match[2]).replace(/,/g, ""), 10);
  }
  return null;
}

function extractObservedSingerCount(html) {
  const sources = [
    extractMetaContent(html, "name", "description"),
    extractMetaContent(html, "property", "og:description"),
    html.slice(0, 20000),
  ];
  for (const source of sources) {
    const match = decodeHtml(source).match(/(\d[\d,]*)\s*名/);
    if (match) return Number.parseInt(match[1].replace(/,/g, ""), 10);
  }
  return null;
}

function extractNextCursorUrl(html, route) {
  const match = html.match(new RegExp(`href="(/${route}\\?cursor=[^"]+)"[^>]*>[\\s\\S]*?(?:次のページ|もっと見る)`, "i"));
  if (!match) return "";
  return absoluteUrl(match[1], BASE_URL);
}

function inferYouTubeFormat(html) {
  if (/https:\/\/www\.youtube\.com\/watch\?v=/.test(html)) return "https://www.youtube.com/watch?v={videoId}";
  if (/https:\/\/youtu\.be\//.test(html)) return "https://youtu.be/{videoId}";
  return "";
}

function detailQueueReasons(video) {
  const reasons = [];
  if (video.setlistStatus === "none") reasons.push("setlist_none");
  if (video.setlistStatus === "unknown" || video.setlistStatus === "incomplete") reasons.push("setlist_incomplete");
  if (!video.youtubeVideoId) reasons.push("missing_youtube_id");
  for (const song of video.setlistSongs || []) {
    if (!song.songPageUrl || !song.externalSongId) reasons.push("missing_song_link");
    if (song.seconds == null) reasons.push("invalid_timestamp");
  }
  return [...new Set(reasons)];
}

function parseTitledCount(html, label) {
  const match = html.match(new RegExp(`title="${escapeRegExp(label)}"[^>]*>([\\s\\S]*?)</span>`, "i"));
  return parseCountText(match?.[1] || "");
}

function parseLabelCount(text, label) {
  const match = String(text || "").match(new RegExp(`(\\d[\\d,]*)\\s*${escapeRegExp(label)}`));
  return parseCountText(match?.[1] || "");
}

function parseCountText(value) {
  const count = Number.parseInt((stripTags(value).match(/\d[\d,]*/) || [])[0]?.replace(/,/g, "") || "", 10);
  return Number.isFinite(count) ? count : null;
}

function extractSingerScopedLink(html, route, singerId) {
  if (!singerId) return "";
  const match = html.match(new RegExp(`href="(/${route}\\?[^"]*singerId=${escapeRegExp(singerId)}[^"]*)"`, "i"));
  return match ? absoluteUrl(match[1], BASE_URL) : "";
}

function extractSingerFeatureTags(card) {
  return uniqueBy(
    [...card.matchAll(/<span\b[^>]*bg-purple-50[^>]*>([\s\S]*?)<\/span>/gi)].map((match) => stripTags(match[1])).filter(Boolean),
    (value) => value,
  );
}

function extractYouTubeChannelUrl(html) {
  return decodeHtml((html.match(/https:\/\/www\.youtube\.com\/(?:channel\/[^"'<\s]+|@[^"'<\s]+)/i) || [])[0] || "");
}

function extractYouTubeChannelId(url) {
  return (url.match(/\/channel\/([^/?#]+)/) || [])[1] || "";
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

module.exports = {
  BASE_URL,
  detailQueueReasons,
  parseSingerDetailPage,
  parseSingersPage,
  parseSongDetailPage,
  parseSongOccurrencesPage,
  parseSongsPage,
  parseStreamsPage,
  parseVideoDetailPage,
};
