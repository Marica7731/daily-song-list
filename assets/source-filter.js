(function initSourceFilter(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(root);
    return;
  }
  root.SourceFilter = factory(root);
})(typeof globalThis !== "undefined" ? globalThis : window, function createSourceFilter(root) {
  const blocklistPackage = loadRegionalBlocklist(root);
  const BLOCKED_REGIONAL_VTUBER_CHANNELS = blocklistPackage.data;
  const BLOCKLIST_VERSION = blocklistPackage.version;
  const BLOCKLIST_HASH = blocklistPackage.hash;
  const matchBlockedRegionalSource = createBlockedSourceMatcher(BLOCKED_REGIONAL_VTUBER_CHANNELS);

  function matchBlockedSource(item) {
    if (!item) return null;
    return matchBlockedRegionalSource(item);
  }

  function isBlockedSource(item) {
    return Boolean(matchBlockedSource(item));
  }

  function filterBlockedVideos(items, options = {}) {
    return (items || []).filter((item) => {
      const match = matchBlockedSource(item);
      if (match) {
        recordBlockedSourceAudit(options.audit, match);
        return false;
      }
      return true;
    });
  }

  function filterPayloadBlockedSources(payload) {
    if (!payload?.groups) return payload;
    let removedSources = 0;
    let removedSongs = 0;
    let normalizedSongs = 0;
    const blockedSourceAudit = createBlockedSourceAudit();
    const groups = Object.fromEntries(
      Object.entries(payload.groups).map(([groupId, group]) => {
        const items = [];
        for (const item of group.items || []) {
          const blockedSourceMatch = matchBlockedSource(item);
          if (blockedSourceMatch) {
            removedSources += 1;
            recordBlockedSourceAudit(blockedSourceAudit, blockedSourceMatch);
            continue;
          }
          const normalizedItemSongs = (item.songs || []).map(normalizeSongEntry);
          const dropTitleOnlyFromArtistRichList = isArtistRichMixedSongList(normalizedItemSongs);
          const songs = [];
          for (let index = 0; index < normalizedItemSongs.length; index += 1) {
            const song = (item.songs || [])[index];
            const normalizedSong = normalizedItemSongs[index];
            if (isBlockedSongEntry(normalizedSong, item)) {
              removedSongs += 1;
              continue;
            }
            if (dropTitleOnlyFromArtistRichList && !hasKnownArtist(normalizedSong)) {
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
      blocklistVersion: BLOCKLIST_VERSION,
      blocklistHash: BLOCKLIST_HASH,
      groups,
      source: {
        ...(payload.source || {}),
        blocklistVersion: BLOCKLIST_VERSION,
        blocklistHash: BLOCKLIST_HASH,
        clientFilteredBlockedSourceCount: removedSources,
        clientFilteredBlockedSongCount: removedSongs,
        clientNormalizedSongCount: normalizedSongs,
        clientBlockedSourceAudit: blockedSourceAudit.summary(),
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
      value = value.replace(/[\u200b-\u200f\u202a-\u202e\ufe0e\ufe0f]/gu, "").trim();
      value = value
        .replace(
          /^\s*(?:[#＃]?\d{1,3}\s+)?(?:[mｍ]\d{1,3}\s*[.．]\s*|[#＃]?\d{1,3}\s*[)）、:：|｜≫>]\s*|[#＃]?\d{1,3}\s*[.．](?![\d０-９])\s*)/iu,
          "",
        )
        .trim();
      value = value
        .replace(/^\s*(?:[꒱〉》»≫>]+[\s\u3000]*)?(?:[#＃]?\d{1,3}|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])\s*(?:(?:[.．](?![\d０-９]))|[、)）:：|｜≫>])\s*/u, "")
        .trim();
      value = value.replace(/^\s*[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]\s*/u, "").trim();
      value = value.replace(/^\s*0\d{1,2}[.．](?=[\d０-９])/u, "").trim();
      value = value.replace(/^\s*[1-9]\d{1,2}[.．](?=[\d０-９]+(?:[^\d０-９.]|$))/u, "").trim();
      value = value
        .replace(/^\s*(?:[#＃]?\d{1,3}\s+)?[#＃]?\d{1,3}\s*曲目\s*(?:[.)．、:：|｜\-—–−]\s*)?/u, "")
        .trim();
      if (value === original) break;
    }
    return value;
  }

  function isBlockedSongEntry(song, source = {}) {
    const title = String(song?.title || song?.raw || "").trim();
    const hasArtist = hasKnownArtist(song);
    const artist = String(song?.artist || "").trim();
    if (isChannelScopedUnknownArtistDirtySong(song, source)) return true;
    if (isStrongNonSongMarker(title) || isStrongNonSongMarker(artist)) return true;
    if (isNonSongMarkerWithDescriptor(title, artist)) return true;
    if (isStrongNonSongActivityText(title)) return true;
    if (isCommentaryNoiseEntry(title, artist, song?.raw)) return true;
    if (isNumericIndexFragmentEntry(title, artist, song?.raw)) return true;
    if (!hasArtist && isNonSongNoiseTitle(title)) return true;
    return !hasArtist && isChatReactionShoutText(title);
  }

  function isChannelScopedUnknownArtistDirtySong(song, source = {}) {
    return !hasKnownArtist(song) && isRionaChannelSource(source);
  }

  function isRionaChannelSource(source = {}) {
    const handleValues = uniqueStrings([source.channelHandle, source.handle, source.ownerHandle, ...channelUrlValues(source)]);
    if (handleValues.some((value) => normalizeHandle(value) === "isakiriona")) return true;
    const channelUrlMatch = channelUrlValues(source).some((value) => normalizeChannelUrl(value) === "@isakiriona");
    if (channelUrlMatch) return true;
    const channelName = normalizeMatcherText(source.channelName || source.ownerText || source.longBylineText || source.shortBylineText || "");
    return channelName.includes("響咲リオナ") || /^riona ch\./iu.test(channelName);
  }

  function isNumericIndexFragmentEntry(title, artist, raw) {
    const numericTitle = String(title || "").normalize("NFKC").trim();
    if (!/^(?:0?[1-9]|[1-9]\d{1,2})$/u.test(numericTitle)) return false;

    const artistText = String(artist || "").normalize("NFKC").trim();
    if (!artistText || isUnknownArtist(artistText)) return true;
    if (isStrongNonSongMarker(artistText) || isStrongNonSongActivityText(artistText) || isNonSongNoiseTitle(artistText)) return true;
    if (isNumericFragmentArtistText(artistText)) return true;

    const rawText = String(raw || "").normalize("NFKC");
    return Boolean(rawText && new RegExp(`(?:^|\\s)0?${Number(numericTitle)}\\s*[／/]\\s*${escapeRegExp(artistText)}`, "u").test(rawText));
  }

  function isNumericFragmentArtistText(text) {
    const value = stripCustomEmojiAliases(text).normalize("NFKC").trim();
    const compact = value.replace(/[\s\u3000]+/gu, "");
    if (!compact) return false;
    if (/^\d+(?:の|コ目|個目|時間|分|月|日|人|周年)/u.test(compact)) return true;
    if (/^\d{1,2}(?:[\/／]\d{1,2}|\([月火水木金土日]\)|（[月火水木金土日]）|[月火水木金土日]曜?)/u.test(compact)) return true;
    if (/[|｜￤∣丨]/u.test(value) && /[A-Za-zぁ-んァ-ヶ一-龯々]/u.test(value)) return true;
    return /(?:配信予定|デビュー配信|ニコニコ生放送|ワンマンライブ|クラファン|追加ゴール|ライブ開催|開催決定|出演決定|お写真公開|写真公開|周年記念|チャンネル登録|登録者|達成|CROSS\s*REALITY|Vol\.?\s*\d+)/iu.test(value);
  }

  function isArtistRichMixedSongList(songs) {
    const entries = Array.isArray(songs) ? songs : [];
    const artistCount = entries.filter(hasKnownArtist).length;
    const titleOnlyCount = entries.length - artistCount;
    const artistRatio = entries.length ? artistCount / entries.length : 0;
    return artistCount >= 8 && titleOnlyCount >= 2 && artistRatio >= 0.35;
  }

  function hasKnownArtist(song) {
    const artist = String(song?.artist || "").trim();
    return Boolean(artist && !isUnknownArtist(artist));
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
    if (/^\d+\s*(?:人|名)(?:達成|に目標変更)$/u.test(key)) return true;
    if (/^(?:本日の)?目標[:：]?.*(?:目指|達成|人|名)/u.test(key)) return true;
    if (isStrongNonSongActivityText(text)) return true;
    if (/チャンネル登録者?\d*(?:人|名)?達成/u.test(key)) return true;
    if (/^(?:今晩の)?メニューと配信時間/u.test(key)) return true;
    if (/^(?:朝食|配信の食事事情|心音asmr|ギターの話|お声も起きてきた|告知とed)$/iu.test(key)) return true;
    if (/^(?:\d+時間じゃ足りない|平均配信時間\d+時間|喉の調子が|のどおぢ|だいぶ慣れてきた|ストリームモンスター|どう見てもロ)$/iu.test(key)) {
      return true;
    }
    if (/^(?:前半|後半)?再開$/u.test(key)) return true;
    if (/^おつ[\p{L}\p{N}ー]{1,18}$/iu.test(key)) return true;
    if (/^せーの.*おつ/u.test(key)) return true;
    if (/^こん[\p{L}\p{N}ー]{2,16}$/iu.test(key)) return true;
    return new Set([
      "この曲について",
      "待機",
      "open",
      "opening",
      "op",
      "ed",
      "end",
      "intro",
      "outro",
      "setlist",
      "セットリスト",
      "セトリ",
      "タイムスタンプ",
      "曲名",
      "開始",
      "歌唱開始",
      "歌唱開始時間",
      "歌唱開始時刻",
      "配信開始",
      "配信スタート",
      "待機画面スタート",
      "startstream",
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
      "オープニング",
      "エンディング",
      "エンドカード",
      "cパート",
      "お名前呼び",
      "tunamipon",
      "換気タイム",
      "tタイム",
      "オケが止まった",
    ]).has(key);
  }

  function isNonSongMarkerWithDescriptor(title, artist) {
    const titleIsMarker = isNonSongNoiseTitle(title) || isSectionMarkerKey(title);
    if (!titleIsMarker) return false;
    return isNonSongDescriptorField(artist);
  }

  function isSectionMarkerKey(text) {
    const key = normalizeNoiseTitleKey(text);
    return new Set([
      "open",
      "opening",
      "op",
      "ed",
      "end",
      "ending",
      "オープニング",
      "エンディング",
      "エンドカード",
      "intro",
      "outro",
      "start",
      "setlist",
      "セットリスト",
      "セトリ",
      "タイムスタンプ",
      "曲名",
      "開始",
      "歌唱開始",
      "歌唱開始時間",
      "歌唱開始時刻",
      "配信開始",
      "配信スタート",
      "待機画面スタート",
      "startstream",
      "自己紹介",
      "ご挨拶",
      "挨拶",
    ]).has(key);
  }

  function isNonSongDescriptorField(text) {
    const key = normalizeNoiseTitleKey(text);
    if (!key) return true;
    if (isSectionMarkerKey(text)) return true;
    if (/^(?:歌唱|歌|曲)?開始(?:時間|時刻)?$/iu.test(key)) return true;
    if (/^(?:歌唱|初手|声|音|お遊戯|おゆうぎ)(?:あり|有り)$/iu.test(key)) return true;
    if (/^(?:順番は)?じゃんけんで$/iu.test(key)) return true;
    return false;
  }

  function isStrongNonSongActivityText(text) {
    const value = stripCustomEmojiAliases(text)
      .normalize("NFKC")
      .replace(/[\s\u3000]+/gu, "")
      .replace(/[!！?？。．.]+$/gu, "")
      .trim();
    if (!value) return false;
    if (/^(?:閉会式|閉会|開会式)(?:も?(?:見てください|みてください|見てね|みてね))?$/u.test(value)) return true;
    if (/^\d+を手で表現した$/u.test(value)) return true;
    if (/(?:周年記念)?(?:お)?写真公開/u.test(value)) return true;
    if (/3Dライブ開催決定/u.test(value)) return true;
    if (/3Dお披露目でスタンドマイク回したかった/u.test(value)) return true;
    if (/\d{1,2}[\/／]\d{1,2}.+(?:出演決定|開催決定|フェス|イベント|告知)/u.test(value)) return true;
    if (/(?:アルバム)?発売記念キャンペーン開催/u.test(value)) return true;
    if (/(?:地声|歌声|バラード).+(?:すごい|合ってる|透明感)/u.test(value)) return true;
    if (/(?:免許の適正性|声がサイレン|楽しそう|触れれる|褒め合って体にいい|難しい曲を挑戦|花火大会.*行きたい|すぐ会えるよって意味で歌いたい|謝罪会見|改めて謝罪|ばいちょろり.*終了|マリパのわさび事件)/u.test(value)) {
      return true;
    }
    return false;
  }

  function isCommentaryNoiseEntry(title, artist, raw) {
    const hasArtist = Boolean(artist && !isUnknownArtist(artist));
    const titleIsNoise = isCommentaryNoiseText(title);
    if (isNaraetanSelfReference(`${title || ""} ${artist || ""} ${raw || ""}`) && !isKnownSongSafeFromCommentary(title, artist)) return true;
    if (!hasArtist && (titleIsNoise || isCommentaryNoiseText(raw) || isNaraetanSelfReference(title) || isTopicLikeBilingualCommentary(title, artist, raw))) return true;
    if (titleIsNoise && (isNonSongDescriptorField(artist) || isCommentaryNoiseText(artist) || isSentenceLikeCredit(artist))) return true;
    if (isNaraetanSelfReference(title) && !hasStructuredSongNumber(raw)) return true;
    if (isTopicLikeBilingualCommentary(title, artist, raw)) return true;
    return false;
  }

  function isCommentaryNoiseText(text) {
    const value = stripCustomEmojiAliases(text)
      .normalize("NFKC")
      .replace(/[\s\u3000]+/gu, "")
      .replace(/[!！?？。．.]+$/gu, "")
      .trim();
    if (!value) return false;
    if (/^(?:コメ|コメント|米)[「『"].{1,80}[」』"]$/iu.test(value)) return true;
    if (/^(?:アンケート|投票)(?:結果|タイム|中|する|して|お願いします|お願い)?(?:[（(].{1,80}[）)])?$/u.test(value)) return true;
    if (/^(?:リクエスト|リク)(?:募集|確認|受付|タイム|ください|下さい|募集中|受付中|ok|OK)?$/iu.test(value)) return true;
    if (/^(?:コメント|コメ)(?:読み|欄|確認|返信|返し|して|ください|下さい|募集中|歓迎)$/iu.test(value)) return true;
    if (/^(?:配信|歌枠)(?:開始|終了|予定|告知|中|について|ありがとう|お疲れさま?|おつかれさま?)$/iu.test(value)) return true;
    if (/喉(?:が|は)?(?:痛い|いたい|不調|治らない|やられた|終わった)|のど(?:が|は)?(?:痛い|いたい|不調)|喉の調子(?:が|は)?/iu.test(value)) return true;
    if (/^(?:なれたん|naraetan)(?:は|が|の|も|って|です|だよ|である|自称|説明|自己紹介|について).{0,60}$/iu.test(value)) return true;
    return false;
  }

  function isTopicLikeBilingualCommentary(title, artist, raw) {
    const titleText = String(title || "").trim();
    const artistText = String(artist || "").trim();
    const rawText = String(raw || "");
    const combined = `${titleText} ${artistText} ${rawText}`;
    if (isKnownSongSafeFromCommentary(titleText, artistText)) return false;
    if (hasStructuredSongNumber(rawText) && !isCommentaryNoiseText(titleText)) return false;
    if (/(?:話|理由|コメント|コメ|リクエスト|アンケート|おすすめ|おススメ|喉|のど|配信|動画|練習|噛|食べ|飲み|旅行|友達|家族|姉|妹|幼馴染|指|身長|リップ|フリ|視聴者|収益化|チャンネル|スーパー|キーボード|アレルギー|リスナー|歌声|サビ|歌詞)/u.test(combined)) {
      return isTopicLikeTitle(titleText) || isSentenceLikeTitle(titleText) || isSentenceLikeCredit(artistText) || isCommentaryNoiseText(titleText) || isCommentaryNoiseText(artistText);
    }
    return isSentenceLikeTitle(titleText) && isSentenceLikeCredit(artistText);
  }

  function isKnownSongSafeFromCommentary(title, artist) {
    const titleText = String(title || "").trim();
    const artistText = String(artist || "").trim();
    if (/星座になれたら/u.test(titleText)) return true;
    if (/^(?:ENDLESS STORY|Never Ending Story|Opening|Ending)$/iu.test(titleText) && artistText && !isUnknownArtist(artistText)) return true;
    return false;
  }

  function isNaraetanSelfReference(text) {
    return /なれたん/u.test(String(text || ""));
  }

  function hasStructuredSongNumber(raw) {
    const value = String(raw || "").replace(/^\s*(?:[\[【(（]\s*)?\d{1,2}:\d{2}(?::\d{2})?\s*(?:[\]】)）])?\s*/u, "");
    return /(?:^|[\s　])#?\d{1,3}\s*[.)．、）:：]/u.test(value) || /(?:^|[\s　])#\d{1,3}\s+/u.test(value);
  }

  function isSentenceLikeTitle(text) {
    const value = String(text || "").trim();
    if (!value) return false;
    if (value.length >= 18 && /(?:だった|でした|です|ます|して|した|する|され|たい|ない|ある|いる|なる|なった|くる|行く|来る|思う|忘れ|信じ|疑う|食べ|飲み|寝て|痛い|怖い|楽しい|辛い|欲しい|ください|お願い|かな|ですね|ですよ|だよ|なの|のか|のは|とは|って|コメ|コメント)/u.test(value)) return true;
    return /^(?:[^/／|｜]{1,40})(?:\?|？)$/u.test(value) && /(?:なれたん|人|何|どこ|いる|する|です|ます|なの|のか)/u.test(value);
  }

  function isTopicLikeTitle(text) {
    const value = String(text || "").trim();
    if (!value) return false;
    return /(?:おすすめ.*(?:集|紹介)|曲紹介|歌うフリ|(?:姉|妹|幼馴染).*(?:or|または)|指が細い|身長が低い|家族に例える)/iu.test(value);
  }

  function isSentenceLikeCredit(text) {
    const value = String(text || "").trim();
    if (!value || isUnknownArtist(value)) return false;
    if (/^(?:Recommended|Poll:|Are you trying|I envy|I(?:’|'|)ll pretend|Older Sister|Younger Sister|.+\?)\b/iu.test(value)) return true;
    if (value.length >= 24 && /\s/u.test(value) && /\b(?:i|you|we|my|your|the|a|an|to|that|this|was|were|is|are|be|being|been|have|has|had|do|does|did|can|can't|cannot|will|want|trying|because|with|from|about|people|song|comment|viewers|family|friend|reason|recommended|pretend|believe|forgot)\b/iu.test(value)) return true;
    return value.length >= 18 && /(?:だった|でした|です|ます|して|した|する|され|たい|ない|ある|いる|なる|なった|くる|行く|来る|思う|忘れ|信じ|疑う|食べ|飲み|痛い|怖い|欲しい|ください|お願い|ですね|ですよ|だよ|なの|のか|のは|とは|って)/u.test(value);
  }

  function normalizeNoiseTitleKey(text) {
    return stripCustomEmojiAliases(text)
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[\u{1F300}-\u{1FAFF}\uFE0E\uFE0F♪♫♬♩]/gu, "")
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
      "-",
    ]).has(String(value || "").trim());
  }

  function isChatReactionShoutText(text) {
    const compact = normalizeChatReactionText(text);
    if (!compact) return false;
    if (/^(?:hi)?(?:(?:dq|denq|天q)+)(?:wo+|clap)?$/iu.test(compact)) return true;
    if (/^wa{3,}$/iu.test(compact)) return true;
    return /^(?:hotsmile|kopipe|gola|golacheerskp|kp|ft|alelelele|alelelelele|blessyou|pat|pienface|zoomin|mumumu|otugaugausmile|smile|hawawa|bua+a+|he+he+|eho+eho+|a+testtest)$/iu.test(compact);
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
        .replace(/(^|[\s\u3000])[:：]_[^\s\u3000:：/／|｜]+[:：]?(?=$|[\s\u3000]|[:：]_[^\s\u3000:：/／|｜]+)/gu, " ")
        .replace(/(^|[\s\u3000])[_:：][A-Za-z0-9]+[:：]?(?=$|[\s\u3000])/gu, " ")
        .replace(/(^|[\s\u3000])_[A-Za-z0-9]+[;；]\s*/gu, " ")
        .replace(/(^|[\s\u3000])[A-Za-z0-9]+(?:smile|cheers|clap|face|penlight|kp)(?=$|[\s\u3000])/giu, " ");
      if (stripped === value) break;
      value = stripped;
    }
    return value.trim();
  }

  function loadRegionalBlocklist(rootObject) {
    if (typeof module === "object" && module.exports && typeof require === "function") {
      const { blocklistHash, loadEffectiveBlocklist } = require("../scripts/blocked-vtuber-utils");
      const data = loadEffectiveBlocklist();
      return {
        data,
        version: data.listVersion || "",
        hash: blocklistHash(data),
      };
    }
    const runtime = rootObject?.BlockedVtuberChannels;
    if (!runtime?.blocklistHash) throw new Error("BlockedVtuberChannels must be loaded before source-filter");
    return {
      data: runtime,
      version: runtime.listVersion || "",
      hash: runtime.blocklistHash || "",
    };
  }

  function createBlockedSourceMatcher(blocklist) {
    const entries = (blocklist.entries || []).filter((entry) => entry.status === "blocked");
    const channelIdIndex = new Map();
    const handleIndex = new Map();
    const channelUrlIndex = new Map();
    const aliasIndex = new Map();
    const titleAliasIndex = new Map();

    for (const entry of entries) {
      const meta = entryMeta(entry);
      for (const value of entry.channelIds || []) channelIdIndex.set(value, { ...meta, matchedField: "channelId", matchedValue: value, matchType: "exact" });
      for (const value of entry.handles || []) {
        const normalized = normalizeHandle(value);
        if (normalized) handleIndex.set(normalized, { ...meta, matchedField: "handle", matchedValue: value, matchType: "exact" });
      }
      for (const value of entry.channelUrls || []) {
        const normalized = normalizeChannelUrl(value);
        if (normalized) channelUrlIndex.set(normalized, { ...meta, matchedField: "channelUrl", matchedValue: value, matchType: "exact" });
      }
      for (const value of [entry.name, ...(entry.aliases || [])]) {
        const normalized = normalizeMatcherText(value);
        if (normalized) aliasIndex.set(normalized, { ...meta, matchedField: "channelName", matchedValue: value, matchType: "exact" });
      }
      for (const value of entry.titleAliases || []) {
        const normalized = normalizeMatcherText(value);
        if (normalized) titleAliasIndex.set(normalized, { ...meta, matchedField: "title", matchedValue: value, matchType: "contains" });
      }
    }

    return function blockedSourceMatcher(item = {}) {
      for (const value of uniqueStrings([item.channelId, item.authorChannelId, item.ownerChannelId])) {
        const match = channelIdIndex.get(value);
        if (match) return match;
      }
      for (const value of uniqueStrings([item.channelHandle, item.handle, item.ownerHandle, ...channelUrlValues(item).map(normalizeChannelUrl)])) {
        const normalized = normalizeHandle(value);
        const match = normalized ? handleIndex.get(normalized) : null;
        if (match) return match;
      }
      for (const value of channelUrlValues(item)) {
        const normalized = normalizeChannelUrl(value);
        const match = normalized ? channelUrlIndex.get(normalized) : null;
        if (match) return match;
      }
      for (const value of uniqueStrings([item.channelName, item.ownerText, item.longBylineText, item.shortBylineText])) {
        const normalized = normalizeMatcherText(value);
        const match = normalized ? aliasIndex.get(normalized) : null;
        if (match) return match;
      }
      const title = normalizeMatcherText(item.title || "");
      if (title) {
        for (const [alias, match] of titleAliasIndex.entries()) {
          if (title.includes(alias)) return match;
        }
      }
      return null;
    };
  }

  function entryMeta(entry) {
    return {
      entryId: entry.id,
      name: entry.name,
      region: (entry.regions || []).join(","),
    };
  }

  function channelUrlValues(item = {}) {
    return uniqueStrings([item.channelUrl, item.authorUrl, item.ownerUrl]);
  }

  function normalizeHandle(value) {
    const cleaned = String(value || "")
      .trim()
      .replace(/^https?:\/\/(?:www\.)?youtube\.com\//iu, "")
      .replace(/^\/+/u, "")
      .split(/[/?#]/u)[0]
      .replace(/^@/u, "")
      .trim();
    return /^[A-Za-z0-9._-]+$/u.test(cleaned) ? cleaned.toLocaleLowerCase() : "";
  }

  function normalizeChannelUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      const url = new URL(raw, "https://www.youtube.com");
      const host = url.hostname.replace(/^www\./iu, "").toLocaleLowerCase();
      if (!["youtube.com", "m.youtube.com"].includes(host)) return "";
      const segments = url.pathname.split("/").filter(Boolean);
      if (!segments.length) return "";
      if (segments[0].startsWith("@")) return `@${normalizeHandle(segments[0])}`;
      if (segments[0] === "channel" && segments[1]) return segments[1];
      return `/${segments.slice(0, 2).join("/")}`.toLocaleLowerCase();
    } catch {
      return "";
    }
  }

  function createBlockedSourceAudit() {
    return {
      removed: 0,
      byRegion: {},
      byMatchedField: {},
      record(match) {
        recordBlockedSourceAudit(this, match);
      },
      summary() {
        return {
          removed: this.removed,
          byRegion: { ...this.byRegion },
          byMatchedField: { ...this.byMatchedField },
        };
      },
    };
  }

  function recordBlockedSourceAudit(audit, match) {
    if (!audit || !match) return;
    audit.removed = (audit.removed || 0) + 1;
    for (const region of String(match.region || "UNKNOWN").split(",").filter(Boolean)) {
      audit.byRegion = audit.byRegion || {};
      audit.byRegion[region] = (audit.byRegion[region] || 0) + 1;
    }
    const field = match.matchedField || "unknown";
    audit.byMatchedField = audit.byMatchedField || {};
    audit.byMatchedField[field] = (audit.byMatchedField[field] || 0) + 1;
  }

  function assertNoBlockedVideos(items, label = "videos") {
    const match = (items || []).map((item) => ({ item, match: matchBlockedSource(item) })).find((entry) => entry.match);
    if (match) {
      throw new Error(`${label} contains blocked source: ${match.item?.videoId || match.item?.title || "unknown"} (${match.match.name})`);
    }
  }

  function uniqueStrings(values) {
    const seen = new Set();
    const result = [];
    for (const raw of values || []) {
      const value = String(raw || "").trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      result.push(value);
    }
    return result;
  }

  function normalizeMatcherText(value) {
    return normalizeWhitespace(String(value || "").normalize("NFKC")).toLocaleLowerCase();
  }

  function escapeRegExp(value) {
    return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function normalizeWhitespace(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  return {
    cleanSongTitleNoise,
    assertNoBlockedVideos,
    BLOCKED_REGIONAL_VTUBER_CHANNELS,
    BLOCKLIST_HASH,
    BLOCKLIST_VERSION,
    createBlockedSourceAudit,
    filterBlockedVideos,
    filterPayloadBlockedSources,
    isArtistRichMixedSongList,
    isBlockedSongEntry,
    isBlockedSource,
    isChannelScopedUnknownArtistDirtySong,
    isChatReactionShoutText,
    matchBlockedSource,
    normalizeSongEntry,
    normalizeMatcherText,
  };
});
