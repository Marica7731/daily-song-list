"use strict";

// Publication-time quality layer for the GitHub Pages static pipeline.
// Keep original day shards untouched: false positives can be restored without re-scraping.
const MIN_COLLISION_VIDEOS = 5;
const MIN_COLLISION_CHANNELS = 5;
const MIN_COLLISION_TITLES = 4;
const REVIEWED_BAD_DESCRIPTION_HASHES = new Set([
  // Seen on three unrelated karaoke channels; the attached text is a
  // non-music miracle broadcast chapter, not a song timestamp.
  "508e5918d7aa133eb0fbc4c0e16bd95e6f834cc5826b03c4b7529ef7f1fdf6b8",
]);
const MIXED_AIKATSU_CHAPTER_HASH = "0ed81627410668fc890661a0687651ce3c2990631a47c4ebf2e4eb0edfb90c47";
const MIXED_CLAUDE_CHAPTER_HASH = "49c8912f79f9ef9e037189882ddbd34b2915ec8b68de9de41f314317f7fa1b7e";
const ROBOCO_UNDELIMITED_CREDIT_HASH = "a7b481ab3db2c4b08ded6c4e2775e67b7e75c6f2ef4c159e9870c11907975231";

function unambiguousNonSongReason(song) {
  const title = String(song?.title || "").trim();
  const artist = String(song?.artist || "").trim();
  const raw = String(song?.raw || "").trim();
  const sourceHash = String(song?.sourceHash || "");

  if (REVIEWED_BAD_DESCRIPTION_HASHES.has(sourceHash) && /God Miracles Today\s+11:11/iu.test(raw)) {
    return "reviewed_bad_description_source";
  }

  // This one setlist comment mixes numbered songs with many prose chapters.
  // Every actual song row in the source is explicitly marked "♡ N.".
  if (sourceHash === MIXED_AIKATSU_CHAPTER_HASH && !/♡\s*\d+[.．]/u.test(raw)) {
    return "reviewed_mixed_chapter_comment";
  }
  // This DAM karaoke chapter comment explicitly numbers each song; all other
  // timestamp rows are reactions/conversation chapters.
  if (sourceHash === MIXED_CLAUDE_CHAPTER_HASH &&
      !/(?:-\s*\d+[.．]\s*|\b\d+[.．]\s*-\s*)/u.test(raw)) {
    return "reviewed_mixed_chapter_comment";
  }
  if (sourceHash === "6e50c51d121b4aed13920f19b3f4b4adaaf5ade07819fff8fce06e075c8a857a" &&
      /^54:51\s+joshi idol anime that mariring knows/iu.test(raw)) {
    return "reviewed_mixed_chapter_comment";
  }

  // A foreign prayer broadcast was parsed as a Japanese karaoke song and its
  // identical YouTube description was attached to unrelated VTuber videos.
  // Do not block short numeric song titles alone: "1/2" is a real song.
  if (
    /^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/u.test(title) &&
    /\bSanto Ros[aá]rio\b/iu.test(raw) &&
    /\b(?:Ao vivo|Dia)\b/iu.test(raw) &&
    /(?:\bDia\b|\bAo vivo\b)/iu.test(artist)
  ) return "prayer_broadcast_timeline";

  // A dated, weekday-stamped stream announcement is not a song credit.
  if (
    /(?:Vol[.]?\s*\d+).*(?:配信)\s*(?:20\d{2})[./-]\d{1,2}[./-]\d{1,2}/iu.test(title) &&
    /(?:\(\s*[月火水木金土日]\s*\)|（\s*[月火水木金土日]\s*）)/u.test(raw) &&
    /^[月火水木金土日]$/u.test(artist)
  ) return "dated_stream_announcement";

  if (
    /(?:達成できず|未達成)/u.test(title) &&
    /^\d{1,2}[月火水木金土日]$/u.test(artist) &&
    /^\d{1,2}:\d{2}まで[!！]?(?:達成できず|未達成)[^\n]{0,30}\d{1,2}\/\d{1,2}[月火水木金土日]$/u.test(raw)
  ) return "dated_stream_challenge_result";

  if (
    /\bANTES DE COMEÇAR O SEU DIA, OUÇA ESTA PALAVRA\b/iu.test(title) &&
    /\bLUCAS\s+12:31\b/iu.test(raw) &&
    /^LUCAS$/iu.test(artist)
  ) return "bible_verse_broadcast";

  // Identified from historical day shards: a spoken transition, not the
  // track title. Do not generalize this to songs with titles like "雑談".
  if (/^雑談パート[①-⑳\d]*$/u.test(title) && /雑談パート/u.test(raw)) {
    return "confirmed_chat_segment_label";
  }
  if (/^(?:枠スタート|歌枠スタート|配信スタート)$/u.test(title) &&
      /^(?:|未記載|不明|未知歌手|unknown)$/iu.test(artist) &&
      /(?:^|[\s　])(?:枠スタート|歌枠スタート|配信スタート)[!！\s　]*$/u.test(raw)) {
    return "confirmed_stream_start_marker";
  }

  // Complete spoken sentence split at the slash in 1/3 by the parser:
  // original: "VTuberのライブ制作費は生身の半分～1/3".
  if (/^VTuberのライブ制作費は生身の半分[～~〜]1$/iu.test(title) &&
      /^3$/u.test(artist) &&
      /VTuberのライブ制作費は生身の半分[～~〜]1\/3/iu.test(raw)) {
    return "spoken_fraction_split_as_artist";
  }

  // A date/comment show description mistakenly became a karaoke song.
  if (/^【一般ライブ】\d{1,2}$/u.test(title) &&
      /^[月火水木金土日]$/u.test(artist) &&
      /【一般ライブ】\d{1,2}\/\d{1,2}\s*[（(][月火水木金土日][）)]/u.test(raw)) {
    return "unrelated_livestream_listing";
  }
  if (/^【マンデーバスターズ】/u.test(title) && raw.includes(title)) {
    return "unrelated_talk_show_listing";
  }
  if (/^am Worship Livestream$/iu.test(title) &&
      /^\d{1,2}-20\d{2}$/u.test(artist) &&
      /Worship Livestream\s*[|｜]\s*\d{1,2}-\d{1,2}-20\d{2}/iu.test(raw)) {
    return "unrelated_worship_livestream_listing";
  }
  if (/^【#?雑談】.{0,12}\d{1,2}$/u.test(title) &&
      /^\d{1,2}$/u.test(artist) &&
      raw.trim().endsWith(title + "/" + artist)) {
    return "unrelated_talk_stream_listing";
  }
  if (/^\d{1,2}$/u.test(title) && /^[月火水木金土日]$/u.test(artist) &&
      /(?:^|\s)\d{1,2}\/\d{1,2}[（(][月火水木金土日][）)]\s*$/u.test(raw)) {
    return "date_split_as_song_and_artist";
  }
  if (/^(?:次回の配信は|現地ライブ|焔魔るり Birthday Live|†最強漆黒キングダム† で R\.E\.P\.O\.)/iu.test(title) &&
      /^[月火水木金土日]$/u.test(artist) &&
      /\d{1,2}\/\d{1,2}[（(][月火水木金土日][）)]/u.test(raw)) {
    return "dated_future_stream_announcement";
  }
  if (/^【茶話会】/u.test(title) &&
      /^\d{1,2}$/u.test(artist) &&
      /20\d{2}\/\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}/u.test(raw)) {
    return "dated_talk_event_announcement";
  }
  if (title === "ここらへんで一回ブツブツになり、YouTubeを再起動" &&
      raw.includes(title)) {
    return "confirmed_stream_technical_note";
  }

  if (/^次回の配信は\d{1,2}日$/u.test(title) &&
      /^[月火水木金土日]$/u.test(artist) &&
      /次回の配信は\d{1,2}日[（(][月火水木金土日][）)]/u.test(raw)) {
    return "dated_future_stream_announcement";
  }
  if (/^(?:19|20)\d{2}\/(?:0?[1-9]|1[0-2])$/u.test(title) &&
      /^(?:[1-9]|[12]\d|3[01])$/u.test(artist) &&
      raw.endsWith(title + "/" + artist)) {
    return "date_split_as_song_and_artist";
  }
  // Section markers require surrounding topic metadata in the original row,
  // not just a song title that happens to contain "talk" or "MC".
  if (/^MC\d{1,2}$/iu.test(title) &&
      /MC\d{1,2}[（(][^）)]{1,40}[）)]/iu.test(raw)) {
    return "confirmed_mc_break";
  }
  if (/^(?:MCパート|間奏MC)$/iu.test(title) &&
      /(?:MCパート|間奏MC)[（(][^）)]{1,80}[）)]/iu.test(raw) &&
      artist.length > 0) {
    return "confirmed_mc_break";
  }
  if (/^トーク$/u.test(title) &&
      /トーク[（(].{2,70}(?:お話|話)[）)]/u.test(raw) &&
      /話/u.test(artist)) {
    return "confirmed_talk_section";
  }
  if (/^雑談タイム[①-⑳\d]+$/u.test(title) &&
      /雑談タイム[①-⑳\d]+[（(].{2,70}[）)]/u.test(raw)) {
    return "confirmed_chat_section";
  }

  // Do not apply generic song-title or artist-name dictionaries: they can
  // silently remove real songs with everyday-language titles.
  return null;
}

function repeatedDescriptionSources(videos) {
  const byHash = new Map();
  for (const video of videos) {
    for (const song of video.songs || []) {
      const hash = String(song.sourceHash || "");
      if (!hash || !String(song.sourceId || "").startsWith("description:")) continue;
      if (String(song.raw || "").length < 35) continue;
      let item = byHash.get(hash);
      if (!item) {
        item = { videoIds: new Set(), channels: new Set(), titles: new Set(), rawRows: new Set(), examples: [] };
        byHash.set(hash, item);
      }
      item.videoIds.add(video.videoId);
      item.channels.add(String(video.channelId || video.channelHandle || video.channelName || video.videoId).normalize("NFKC"));
      item.titles.add(String(video.title || "").normalize("NFKC"));
      item.rawRows.add(String(song.raw || "").normalize("NFKC"));
      if (item.examples.length < 3 && !item.examples.some((entry) => entry.videoId === video.videoId)) {
        item.examples.push({ videoId: video.videoId, channelName: video.channelName || "", videoTitle: video.title || "", raw: String(song.raw || "").slice(0, 160) });
      }
    }
  }
  const collisions = new Map();
  for (const [hash, entry] of byHash) {
    if (
      entry.videoIds.size >= MIN_COLLISION_VIDEOS &&
      entry.channels.size >= MIN_COLLISION_CHANNELS &&
      entry.titles.size >= MIN_COLLISION_TITLES &&
      entry.rawRows.size <= 2
    ) {
      collisions.set(hash, {
        reason: "reused_description_across_unrelated_channels",
        videoCount: entry.videoIds.size,
        channelCount: entry.channels.size,
        distinctVideoTitles: entry.titles.size,
        examples: entry.examples,
      });
    }
  }
  return collisions;
}

function normalizeConservativeArtist(song) {
  const artist = String(song?.artist || "");
  const matched = artist.match(/^[/／|｜][\s　]+(.+)$/u);
  if (!matched?.[1]?.trim()) return song;
  // A delimiter copied from "title / artist" should never become part of
  // an artist name. A slash with no following whitespace or DISH// stays.
  return { ...song, artist: matched[1].trim() };
}

function repairReleaseDateCredit(song) {
  const title = String(song?.title || "").trim();
  const artist = String(song?.artist || "").trim();
  const raw = String(song?.raw || "").trim();
  // Recorded source ends with title/artist YYYY/MM/DD, but the slash parser
  // split the publication date and placed DD in the artist field.
  if (/^\d{1,2}$/u.test(artist) && Number(artist) >= 1 && Number(artist) <= 31 &&
      raw.endsWith(title + "/" + artist)) {
    const match = title.match(/^(.+)[/／]([^/／]{2,}?)\s+((?:19|20)\d{2})[/／](0?[1-9]|1[0-2])$/u);
    if (match?.[1]?.trim() && match?.[2]?.trim()) {
      return { ...song, title: match[1].trim(), artist: match[2].trim() };
    }
  }
  // Some sources have a year only; require exactly one title/artist slash so
  // impromptu song/version descriptions with several slashes are untouched.
  if (/^20\d{2}$/u.test(artist) && raw.endsWith(title + "/" + artist)) {
    const match = title.match(/^([^/／]+)[/／]([^/／]{2,})$/u);
    if (match) return { ...song, title: match[1].trim(), artist: match[2].trim() };
  }
  return song;
}

function isUnknownArtistValue(value) {
  return /^(?:|未記載|不明|未知歌手|unknown)$/iu.test(String(value || "").trim());
}

function repairStructuredSlashCredit(song) {
  const artist = String(song?.artist || "").trim();
  const raw = String(song?.raw || "").normalize("NFKC").trim();
  if (!isUnknownArtistValue(artist) &&
      !/^(?:19|20)\d{2}(?:[–—-](?:19|20)?\d{2})?(?:\s*※.*)?$/u.test(artist)) return song;
  const body = raw.replace(/^\s*\d{1,2}:\d{2}(?::\d{2})?\s+/u, "");
  const match = body.match(/^(.+?)\s*[/／]\s*(.+?)\s*[/／]\s*(.+)\s*[/／]\s*((?:19|20)\d{2}(?:[–—-](?:19|20)?\d{2})?)(?:\s*※.*)?$/u);
  const artistYear = artist.match(/^((?:19|20)\d{2}(?:[–—-](?:19|20)?\d{2})?)(?:\s*※.*)?$/u)?.[1] || "";
  if (!match || (artistYear && match[4] !== artistYear)) return song;
  const [, title, creditedArtist, metadata] = match;
  if (!/(?:Anime|アニメ|TVアニメ|ゲーム|OP|ED|insert song|挿入歌|主題歌|theme song|Culture Broadcasting|Macross|Cardcaptor|即興ソング|キャラクターソング)/iu.test(metadata)) {
    return song;
  }
  if (!title.trim() || !creditedArtist.trim()) return song;
  return { ...song, title: title.trim(), artist: creditedArtist.trim() };
}

function normalizeReleaseMetadataArtist(song, video = {}) {
  const artist = String(song?.artist || "").normalize("NFKC").trim();
  const raw = String(song?.raw || "").normalize("NFKC").trim();
  if (!artist) return song;

  // The source video is explicitly an 岡村靖幸-only karaoke stream; these
  // rows contain album names in the artist slot.
  if (video.videoId === "jsQX01izzbY" && /^アルバム\s*/u.test(artist) && /[（(]アルバム\s*/u.test(raw)) {
    return { ...song, artist: "岡村靖幸" };
  }

  let cleaned = artist
    .replace(/【[^】]{1,160}】\s*(?=[（(]\s*(?:19|20)\d{2}[./-]\d{1,2}[./-]\d{1,2}\s*[）)])/u, "")
    .replace(/\s*[（(]\s*(?:19|20)\d{2}[./-]\d{1,2}[./-]\d{1,2}\s*[）)].*$/u, "")
    .replace(/\s*※\s*(?:19|20)\d{2}[./-]\d{1,2}[./-]\d{1,2}.*$/u, "")
    .replace(/\s+[/／]\s+(?=(?:TVアニメ|Anime\b|ゲーム|Culture Broadcasting\b|『THE IDOLM@STER\b)).*$/iu, "")
    .replace(/\s*[（(](?=(?:劇場版|TVアニメ|アニメ|ゲーム|映画)\b).*?[）)]\s*$/iu, "")
    .replace(/\s+[/／]\s*$/u, "")
    .trim();
  if (!cleaned || cleaned === artist) return song;
  return { ...song, artist: cleaned };
}

function repairKnownSourceCredit(song) {
  const hash = String(song?.sourceHash || "");

  if (hash === "99b19f47604cfddfb64f05e5317e359c4d90755ed1c2b3f5cb169c52f9f45bc9" &&
      /^\d+(?:st|nd|rd|th)アルバム「[^」]+」より$/iu.test(String(song?.artist || "").normalize("NFKC").trim())) {
    return { ...song, artist: "Eighty eight" };
  }
  if (hash === "f62db69ee3c93d0d093367cd8755d892498b361e289772acc62c8dd972c422aa" &&
      song?.title === "奏" && /オリ曲\s*YOU＆合図\s*リリース/u.test(String(song?.raw || ""))) {
    return { ...song, artist: "スキマスイッチ" };
  }
  if (hash === "924e1a18c91dd603a7be0e9523559988d299ff51e649624795ba0402d60f5a4e" &&
      song?.title === "祝日天国" && /祝日天国[／/]35[.]7[（(]\d{4}[／/]\d{1,2}[／/]\d{1,2}/u.test(String(song?.raw || ""))) {
    return { ...song, artist: "35.7" };
  }
  if (hash === "3665facacaf3ad5caa221a2a0bbd346a2c5adf66fe0f69ce4bcc9bae83a46c6a" &&
      song?.title === "乙女のルートはひとつじゃない！") {
    return { ...song, artist: "angela" };
  }
  if (hash === "d723897d567d473dd7aea57f04f8ad70a15479135d554e912b12368fcf1b117a" &&
      /^観覧車[~〜]/u.test(String(song?.title || "")) &&
      /[／/]Duca[／/]/u.test(String(song?.raw || ""))) {
    return { ...song, title: "観覧車～あの日と、昨日と今日と明日と～", artist: "Duca" };
  }
  if (hash === "8dd644fb109f602a35f481a3f792d3511298f8ec5bafc63627a162487dbe7e67" &&
      /^Song 5: ["“]Chiisana Boukensha["”]$/u.test(String(song?.title || ""))) {
    return { ...song, title: "Chiisana Boukensha", artist: "Sora Amamiya, Rie Takahashi, Ai Kayano" };
  }
  if (hash === "7b6b7ed5a0d5ef6faa6271a57adca3ce57654e5984e7f515845853adfb0e8da0" &&
      song?.title === "1" && song?.artist === "2" &&
      /\b1\/2\/Kawamoto Makoto\/Anime\b/iu.test(String(song?.raw || ""))) {
    return { ...song, title: "1/2", artist: "川本真琴" };
  }
  if (hash === "401adaa520f8e84434c4e8581ede7277564e44dc0448fe962bccd7fe78d6046a" &&
      song?.title === "FLAGS" && /^T[.]M[.]Revolution\s*[（(].*(?:OP|主題歌)/iu.test(String(song?.artist || ""))) {
    return { ...song, artist: "T.M.Revolution" };
  }
  if (hash === MIXED_CLAUDE_CHAPTER_HASH &&
      song?.title === "ハッピーシンセサイザ" &&
      isUnknownArtistValue(song?.artist) &&
      /ハッピーシンセサイザ.*\bby\s+EasyPop\b/iu.test(String(song?.raw || ""))) {
    return { ...song, artist: "EasyPop" };
  }
  if (hash === "087f98b90de544c80795a5f24729ba2a5e1e9df8250379c29fc361e02012c6ef" &&
      /^34[\s　]+\(ｱﾝｺｰﾙ\)/u.test(String(song?.title || "")) &&
      /2:44:34[\s　]+\(ｱﾝｺｰﾙ\)/u.test(String(song?.raw || ""))) {
    return { ...song, title: String(song.title).replace(/^34[\s　]+/u, "") };
  }
  if (hash !== ROBOCO_UNDELIMITED_CREDIT_HASH || !isUnknownArtistValue(song?.artist)) return song;
  const known = new Map([
    ["はなびら (Hanabira / Petals) 奥華子", ["はなびら", "奥華子"]],
    ["Answer、幾田りら", ["Answer", "幾田りら"]],
    ["秒針を噛む (Byoushin wo Kamu / Biting the Second Hand) ずっと真夜中でいいのに。ZUTOMAYO", ["秒針を噛む", "ずっと真夜中でいいのに。"]],
    ["ギブス (Gibbs / Plaster Caster) 椎名林檎", ["ギブス", "椎名林檎"]],
    ["115万キロのフィルム (115man Kilo no Film / 115 Million Kilometer Film) Official髭男dism", ["115万キロのフィルム", "Official髭男dism"]],
  ]);
  const repaired = known.get(String(song?.title || "").trim());
  return repaired ? { ...song, title: repaired[0], artist: repaired[1] } : song;
}

function occurrenceIdentity(song) {
  const title = String(song?.title || "").normalize("NFKC").trim();
  const artist = String(song?.artist || "").normalize("NFKC").trim();
  const seconds = Number(song?.seconds);
  const time = String(song?.time || "").trim();
  if (!Number.isFinite(seconds) && !time) return "";
  const point = Number.isFinite(seconds) ? String(seconds) : time;
  return [point, title, artist].join("\u001f");
}

function cleanStaticVideos(videos) {
  const collisions = repeatedDescriptionSources(videos);
  const counters = {
    inputVideos: videos.length,
    inputOccurrences: 0,
    visibleVideos: 0,
    visibleOccurrences: 0,
    quarantinedOccurrences: 0,
    quarantinedVideos: 0,
    deduplicatedOccurrences: 0,
    normalizedArtistOccurrences: 0,
    normalizedReleaseMetadataOccurrences: 0,
    repairedDateCreditOccurrences: 0,
    repairedStructuredCreditOccurrences: 0,
    repairedKnownSourceCreditOccurrences: 0,
    byReason: {},
  };
  const examples = [];
  const byDay = {};
  const normalizedArtistExamples = [];
  const normalizedReleaseMetadataExamples = [];
  const repairedDateCreditExamples = [];
  const repairedStructuredCreditExamples = [];
  const repairedKnownSourceCreditExamples = [];
  const duplicateExamples = [];

  const cleaned = videos.map((video) => {
    const day = String(video.publishedAt || "").slice(0, 10) || "unknown";
    const seen = new Set();
    const songs = [];

    for (const originalSong of video.songs || []) {
      counters.inputOccurrences += 1;
      const reason = unambiguousNonSongReason(originalSong) ||
        (String(originalSong.sourceId || "").startsWith("description:") &&
         collisions.has(String(originalSong.sourceHash || ""))
          ? "reused_description_across_unrelated_channels"
          : null);
      if (reason) {
        counters.quarantinedOccurrences += 1;
        byDay[day] ||= { quarantinedOccurrences: 0, deduplicatedOccurrences: 0, byReason: {} };
        byDay[day].quarantinedOccurrences += 1;
        byDay[day].byReason[reason] = (byDay[day].byReason[reason] || 0) + 1;
        counters.byReason[reason] = (counters.byReason[reason] || 0) + 1;
        if (examples.length < 80) {
          examples.push({
            reason,
            videoId: video.videoId,
            channelName: video.channelName || "",
            occurrenceId: originalSong.occurrenceId || "",
            sourceId: originalSong.sourceId || "",
            sourceHash: originalSong.sourceHash || "",
            title: originalSong.title || "",
            artist: originalSong.artist || "",
            raw: String(originalSong.raw || "").slice(0, 200),
          });
        }
        continue;
      }

      let song = repairReleaseDateCredit(originalSong);
      if (song !== originalSong) {
        counters.repairedDateCreditOccurrences += 1;
        if (repairedDateCreditExamples.length < 40) repairedDateCreditExamples.push({
          videoId: video.videoId, before: originalSong.title + " - " + originalSong.artist,
          after: song.title + " - " + song.artist, raw: originalSong.raw || "",
        });
      }

      const structured = repairStructuredSlashCredit(song);
      if (structured !== song) {
        counters.repairedStructuredCreditOccurrences += 1;
        if (repairedStructuredCreditExamples.length < 40) repairedStructuredCreditExamples.push({
          videoId: video.videoId, before: song.title + " - " + song.artist,
          after: structured.title + " - " + structured.artist, raw: song.raw || "",
        });
        song = structured;
      }

      const knownSourceRepaired = repairKnownSourceCredit(song);
      if (knownSourceRepaired !== song) {
        counters.repairedKnownSourceCreditOccurrences += 1;
        if (repairedKnownSourceCreditExamples.length < 30) repairedKnownSourceCreditExamples.push({
          videoId: video.videoId, before: song.title + " - " + song.artist,
          after: knownSourceRepaired.title + " - " + knownSourceRepaired.artist, raw: song.raw || "",
        });
        song = knownSourceRepaired;
      }

      const releaseNormalized = normalizeReleaseMetadataArtist(song, video);
      if (releaseNormalized !== song) {
        counters.normalizedReleaseMetadataOccurrences += 1;
        if (normalizedReleaseMetadataExamples.length < 50) normalizedReleaseMetadataExamples.push({
          videoId: video.videoId, title: song.title || "",
          before: song.artist || "", after: releaseNormalized.artist, raw: song.raw || "",
        });
        song = releaseNormalized;
      }

      const normalized = normalizeConservativeArtist(song);
      if (normalized !== song) {
        counters.normalizedArtistOccurrences += 1;
        if (normalizedArtistExamples.length < 40) normalizedArtistExamples.push({
          videoId: video.videoId, title: song.title || "",
          before: song.artist || "", after: normalized.artist, sourceId: song.sourceId || "",
        });
        song = normalized;
      }

      const identity = occurrenceIdentity(song);
      if (identity && seen.has(identity)) {
        counters.deduplicatedOccurrences += 1;
        byDay[day] ||= { quarantinedOccurrences: 0, deduplicatedOccurrences: 0, byReason: {} };
        byDay[day].deduplicatedOccurrences += 1;
        if (duplicateExamples.length < 50) duplicateExamples.push({
          videoId: video.videoId,
          seconds: Number(song.seconds) || 0,
          title: song.title || "",
          artist: song.artist || "",
          sourceId: song.sourceId || "",
        });
        continue;
      }
      if (identity) seen.add(identity);
      songs.push(song);
    }

    if (songs.length) counters.visibleVideos += 1;
    else if ((video.songs || []).length) counters.quarantinedVideos += 1;
    counters.visibleOccurrences += songs.length;
    return { ...video, songs };
  }).filter((video) => video.songs.length);

  if (counters.inputOccurrences && counters.quarantinedOccurrences / counters.inputOccurrences > 0.1) {
    throw new Error("static quality guard quarantined over 10% of all occurrences; manual review required before publishing");
  }
  if (counters.visibleOccurrences + counters.quarantinedOccurrences + counters.deduplicatedOccurrences !== counters.inputOccurrences) {
    throw new Error("static quality guard occurrence accounting mismatch");
  }

  const audit = {
    schemaVersion: 1,
    policy: "quarantine/dedupe/normalize derived pages only; retain unmodified days/* and state.json",
    ...counters,
    repeatedDescriptionSources: [...collisions].map(([sourceHash, info]) => ({ sourceHash, ...info })),
    reviewedBadDescriptionHashes: [...REVIEWED_BAD_DESCRIPTION_HASHES],
    byDay,
    normalizedArtistExamples,
    normalizedReleaseMetadataExamples,
    repairedDateCreditExamples,
    repairedStructuredCreditExamples,
    repairedKnownSourceCreditExamples,
    duplicateExamples,
    examples,
  };
  return { videos: cleaned, audit };
}

module.exports = {
  cleanStaticVideos,
  normalizeConservativeArtist,
  normalizeReleaseMetadataArtist,
  occurrenceIdentity,
  repairKnownSourceCredit,
  repairReleaseDateCredit,
  repairStructuredSlashCredit,
  repeatedDescriptionSources,
  unambiguousNonSongReason,
};
