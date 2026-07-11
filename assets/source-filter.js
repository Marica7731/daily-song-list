(function initSourceFilter(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }
  root.SourceFilter = factory();
})(typeof globalThis !== "undefined" ? globalThis : window, function createSourceFilter() {
  const TAIWAN_VTUBER_BLACKLIST = [
    { name: "羽芝扉扉", aliases: ["羽芝扉扉", "Uchi Fifi", "uchififi", "@uchififi"], titleAliases: ["#羽芝扉扉", "#扉出來啦"] },
    { name: "厄倫蒂兒", aliases: ["厄倫蒂兒", "厄伦蒂儿", "Earendel", "EarendelXDFP", "@EarendelXDFP"], titleAliases: ["#厄倫蒂兒", "#厄伦蒂儿", "#DearLive"] },
    { name: "露恰露恰", aliases: ["露恰露恰", "LutraLutra", "Lutralutra"] },
    { name: "歐妲", aliases: ["歐妲", "欧妲", "Olda"] },
    { name: "祈菈・貝希毛絲", aliases: ["祈菈", "祈菈‧貝希毛絲", "祈菈・貝希毛絲", "貝希毛絲", "STORIA", "Narrator"] },
    { name: "埃穆亞", aliases: ["埃穆亞", "埃穆亚", "Oumua"] },
    { name: "涅默", aliases: ["涅默", "Nemesis ch. 涅默"] },
    { name: "熙歌", aliases: ["熙歌", "Cygnus ch. 熙歌"] },
    { name: "雲隙光", aliases: ["雲隙光", "云隙光", "Kumosuki"] },
    { name: "冰霧", aliases: ["冰霧", "冰雾", "Eisnebel"] },
    { name: "白白虹", aliases: ["白白虹", "Xxhacucoxx"] },
    { name: "幻月", aliases: ["幻月", "Moondogs"] },
    { name: "光逸幸", aliases: ["光逸幸", "Kouitu Sin"] },
    { name: "希翁", aliases: ["希翁", "Chion"] },
    { name: "黑銀夜烏", aliases: ["黑銀夜烏", "黑银夜乌", "Karasu"] },
    { name: "繆・索緹絲", aliases: ["繆・索緹絲", "繆索緹絲", "缪索缇丝", "Sotis"] },
    { name: "庫路路", aliases: ["庫路路", "库路路", "Kururun"] },
    { name: "史黛菈・埃蕾諾亞", aliases: ["史黛菈", "史黛菈 埃蕾諾亞", "Stella Eleanor"] },
    { name: "克蕾", aliases: ["克蕾", "Cray Ch."] },
    { name: "火野貝", aliases: ["火野貝", "火野贝", "Hinokai"] },
    { name: "凝川眠", aliases: ["凝川眠", "Nemuri"] },
    { name: "汐海黑兔", aliases: ["汐海黑兔", "Usagi"] },
    { name: "香草奈若", aliases: ["香草奈若", "Vanilla Nyoro"] },
    { name: "蘇米", aliases: ["蘇米", "苏米", "Sumi Ch."] },
    { name: "菜姬", aliases: ["菜姬"] },
    { name: "希靈", aliases: ["希靈", "希灵", "ASMR Healing 希靈"] },
    { name: "高維爾", aliases: ["高維爾", "高维尔", "Cowell"] },
    { name: "朵璃安", aliases: ["朵璃安", "Dorian Vtuber"] },
    { name: "烟花蹦蹦蹦", aliases: ["烟花蹦蹦蹦"] },
    { name: "杏仁ミル", aliases: ["杏仁ミル", "杏仁咪嚕", "杏仁咪噜"] },
    { name: "汐 seki", aliases: ["汐 seki", "汐 Seki"] },
    { name: "璐洛洛", aliases: ["璐洛洛"] },
    { name: "稻乙緹", aliases: ["稻乙緹", "稻乙缇"] },
    { name: "李聽", aliases: ["李聽", "李听"] },
    { name: "Rumi 懶貓子", aliases: ["Rumi 懶貓子", "Rumi懶貓子", "懶貓子", "懒猫子"] },
    { name: "浠 Mizuki", aliases: ["浠 Mizuki", "浠Mizuki"] },
    { name: "森森鈴蘭", aliases: ["森森鈴蘭", "森森铃兰"] },
    { name: "瑪格麗特・諾爾絲", aliases: ["瑪格麗特", "玛格丽特", "Margaret Norns"] },
    { name: "綽貓喵", aliases: ["綽貓喵", "绰猫喵", "CheukCat", "CheukCat Ch.", "HKVtuber"] },
  ];

  function matchBlockedSource(item) {
    if (!item) return null;
    const channelText = normalizeMatcherText(
      [item.channelName, item.ownerText, item.longBylineText, item.shortBylineText, item.channelId, item.channelHandle].filter(Boolean).join(" "),
    );
    const titleText = normalizeMatcherText(item.title);
    for (const entry of TAIWAN_VTUBER_BLACKLIST) {
      for (const alias of entry.aliases || []) {
        const normalizedAlias = normalizeMatcherText(alias);
        if (normalizedAlias && channelText.includes(normalizedAlias)) {
          return { name: entry.name, alias, field: "channelName" };
        }
      }
      for (const alias of entry.titleAliases || []) {
        const normalizedAlias = normalizeMatcherText(alias);
        if (normalizedAlias && titleText.includes(normalizedAlias)) {
          return { name: entry.name, alias, field: "title" };
        }
      }
    }
    return null;
  }

  function isBlockedSource(item) {
    return Boolean(matchBlockedSource(item));
  }

  function filterBlockedVideos(items) {
    return (items || []).filter((item) => !isBlockedSource(item));
  }

  function filterPayloadBlockedSources(payload) {
    if (!payload?.groups) return payload;
    let removedSources = 0;
    let removedSongs = 0;
    let normalizedSongs = 0;
    const groups = Object.fromEntries(
      Object.entries(payload.groups).map(([groupId, group]) => {
        const items = [];
        for (const item of group.items || []) {
          if (isBlockedSource(item)) {
            removedSources += 1;
            continue;
          }
          const songs = [];
          for (const song of item.songs || []) {
            const normalizedSong = normalizeSongEntry(song);
            if (isBlockedSongEntry(normalizedSong)) {
              removedSongs += 1;
              continue;
            }
            if (normalizedSong !== song) normalizedSongs += 1;
            songs.push(normalizedSong);
          }
          if (songs.length) items.push({ ...item, songs });
        }
        return [groupId, { ...group, items }];
      }),
    );
    if (!removedSources && !removedSongs && !normalizedSongs) return payload;
    return {
      ...payload,
      groups,
      source: {
        ...(payload.source || {}),
        clientFilteredBlockedSourceCount: removedSources,
        clientFilteredBlockedSongCount: removedSongs,
        clientNormalizedSongCount: normalizedSongs,
      },
    };
  }

  function normalizeSongEntry(song) {
    if (!song || typeof song !== "object") return song;
    const title = cleanSongTitleNoise(song.title);
    if (title === song.title) return song;
    return { ...song, title };
  }

  function cleanSongTitleNoise(text) {
    let value = String(text || "").trim();
    for (let idx = 0; idx < 4; idx += 1) {
      const original = value;
      value = stripCustomEmojiAliases(value).trim();
      value = value
        .replace(/^\s*(?:[#＃]?\d{1,3}\s+)?[#＃]?\d{1,3}\s*[.)．、:：|｜]\s*/u, "")
        .trim();
      value = value
        .replace(/^\s*(?:[#＃]?\d{1,3}\s+)?[#＃]?\d{1,3}\s*曲目\s*(?:[.)．、:：|｜\-—–−]\s*)?/u, "")
        .trim();
      if (value === original) break;
    }
    return value;
  }

  function isBlockedSongEntry(song) {
    const title = String(song?.title || song?.raw || "").trim();
    const artist = String(song?.artist || "").trim();
    const hasArtist = Boolean(artist && !isUnknownArtist(artist));
    if (isStrongNonSongMarker(title) || isStrongNonSongMarker(artist)) return true;
    if (!hasArtist && isNonSongNoiseTitle(title)) return true;
    return !hasArtist && isChatReactionShoutText(title);
  }

  function isStrongNonSongMarker(text) {
    return new Set([
      "曲導入",
    ]).has(normalizeNoiseTitleKey(text));
  }

  function isNonSongNoiseTitle(text) {
    const rawCompact = stripCustomEmojiAliases(text)
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[\s\u3000]+/gu, "");
    if (/^\d+on\d+&/iu.test(rawCompact)) return true;

    const key = normalizeNoiseTitleKey(text);
    if (!key) return false;
    if (/^(?:第)?\d+個目$/u.test(key)) return true;
    return new Set([
      "この曲について",
      "待機",
      "待機画面op",
      "待機画面",
      "歌い終えて",
      "曲終わり",
      "曲終り",
      "曲おわり",
      "終わりの会",
      "終わりのあいさつ",
      "はじまり",
      "始まりました",
      "本日のサムネ",
      "チューニング",
      "ストローク練習",
      "インストカバーmv紹介",
      "予告あれこれ",
      "new",
      "start",
      "ご挨拶",
      "youtubeの新機能",
      "告知タイム",
      "特典告知1",
      "特典告知2",
      "お知らせ",
      "提供",
      "ending",
      "エンディング",
      "cパート",
      "お名前呼び",
    ]).has(key);
  }

  function normalizeNoiseTitleKey(text) {
    return stripCustomEmojiAliases(text)
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[\u{1F300}-\u{1FAFF}\uFE0E\uFE0F]/gu, "")
      .replace(/[\s\u3000[\]【】()（）「」『』"'“”‘’~～!！?？.,，。、:：;；\-—–−_・･/／|｜]+/gu, "")
      .trim();
  }

  function isUnknownArtist(value) {
    return new Set([
      "",
      "unknown",
      "na",
      "n/a",
      "none",
      "null",
      "未記載",
      "未记载",
      "不明",
      "なし",
      "无",
      "待补歌手",
      "待補歌手",
      "待补",
      "待補",
    ]).has(String(value || "").trim());
  }

  function isChatReactionShoutText(text) {
    const compact = normalizeChatReactionText(text);
    if (!compact) return false;
    if (/^(?:hi)?(?:dq|denq|天q)(?:clap)?$/iu.test(compact)) return true;
    if (/^wa{3,}$/iu.test(compact)) return true;
    return /^(?:hotsmile|kopipe|gola|golacheerskp|alelelelele|blessyou|pat|pienface|zoomin|mumumu|otugaugausmile|smile)$/iu.test(compact);
  }

  function normalizeChatReactionText(text) {
    return stripCustomEmojiAliases(text)
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[\u{1F300}-\u{1FAFF}\uFE0E\uFE0F]/gu, "")
      .replace(/[\s\u3000~～!！?？.,。:：;；\-—–−_]+/gu, "");
  }

  function stripCustomEmojiAliases(text) {
    let value = String(text || "");
    for (let idx = 0; idx < 8; idx += 1) {
      const stripped = value
        .replace(/(^|[\s\u3000])[:：]_[A-Za-z0-9]+[:：]?(?=$|[\s\u3000])/gu, " ")
        .replace(/(^|[\s\u3000])[_:：][A-Za-z0-9]+[:：]?(?=$|[\s\u3000])/gu, " ")
        .replace(/(^|[\s\u3000])[A-Za-z0-9]+(?:smile|cheers|clap|face|penlight|kp)(?=$|[\s\u3000])/giu, " ");
      if (stripped === value) break;
      value = stripped;
    }
    return value.trim();
  }

  function normalizeMatcherText(value) {
    return normalizeWhitespace(String(value || "").normalize("NFKC")).toLocaleLowerCase();
  }

  function normalizeWhitespace(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  return {
    cleanSongTitleNoise,
    filterBlockedVideos,
    filterPayloadBlockedSources,
    isBlockedSongEntry,
    isBlockedSource,
    isChatReactionShoutText,
    matchBlockedSource,
    normalizeSongEntry,
    normalizeMatcherText,
    TAIWAN_VTUBER_BLACKLIST,
  };
});
