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

const REVIEWED_NUMBERED_SETLIST_HASHES = new Set([
  "ae9a67b4a59214c5b5936d095e43ea9e11c46133b79891c2d968cc5f65db219f",
  "0c4e427c76ae5910267ca613807e36fd3fb14d1a9ec2d866846481d3e59ad71b",
  "472599b63ab850c21f239c14359636ec399e14fc860b9c5c7541e6e6c2baed80",
  "cfdabe4c9486f849e9b103ddec6532b1f74b1d4656add59b9854342d6955fc67",
  "da296b61ea105747d1fa4527becd8e0c253f92e7d3efedd2cd8fa8017d5e55ad",
  "af9b78791e417efa33bc5d649ed166553507376faf8b4b6e7564a0fc5a9194c3",
]);

function isExplicitNumberedSetlistRow(value) {
  const text = String(value || "").normalize("NFKC");
  return /(?:^|\s)(?:[-–—]\s*)?(?:♡\s*)?\d{1,2}[.．]\s*|(?:^|\s)\d{1,2}[.．]\s*[-–—]?\s*/u.test(text);
}


const REVIEWED_MIXED_SOURCE_HASHES = Object.freeze({
  hinataVocaloid: "30d4fba63bb782028af7ca03a506cf94714933e93de48d1c5eef13b84d9438a4",
  kokoneConan: "e0d69e03eeba0ccb8e420e88af51d810907dfb9b1e8b50d98579bf4d8646df60",
  kanraMorning: "c2f39a5fb479d4d148f076609150d3662d0bef7611973817c5f56f2ea7d6af4e",
  vezaliusDam: "ae9a67b4a59214c5b5936d095e43ea9e11c46133b79891c2d968cc5f65db219f",
  uraraAnniversary: "7d072c6a6bd42aa23a499fbc04ed5cbffc12a44a51d5456644a1b6cff6ace681",
  inoriAcoustic: "1922f6d700c7615e8ff682c9ea9ac82ea19d0b2a145d31e4ea73df7d243bc352",
  pleuvoirFirstKaraoke: "c2fe7785dffa7d43c6405b4efd19edb8dfa6d3d0d276084a42c6431f16ee8777",
  aranneHundredSongs: "2f784a14e4122ab625a239f2693dd725658688982e1b9aa526fad3f379efe188",
  otsukaRay: "9ef1860f9676617e865cc613ba0a58db75fbf30fb1ffd8f903682b7cdf0d8ca1",
  hisagiDay: "ca0982ddee79fcf66cff3f5f20e2ac15539603a7d8a538d5cd9176d40f6d5d61",
  suiminMc: "92a7e650f684e741d7da5d2dfc6c2344abb06d8829c46237b25604f8716a5da6",
  minaseSummerFest: "930bc7636c4c769fa8a832e8ea56faed82c9a6c76b31db3f000a499885f18b26",
  piimanHarp: "6c02c324915aa78e9c30deda5783635ebff969c99c89d8828f8f24486711c5bd",
  suiTabSetlist: "a2014dae610c4d64cabf398a0ac40f72c0a8f6475d02e05d068393071cd545a1",
  omakiraraUnderscore: "478f401bb24ee9ed1d84eb42f0679395ee7b93c24c8bbff25d86e3120ea79661",
});

const REVIEWED_ACTIVITY_TITLES_BY_HASH = new Map([
  ["0d63e5c4ca38df917fb58c74f1b5be81c8a54a893fdd1050b81aad849e18314d", new Set([
    "しずさん感想", "ミアさん感想", "もこさん感想", "えうさん感想", "ちびさん感想", "ミルフィさん感想", "アメリアさん感想",
  ])],
  ["659ae22b401a27a4bca6da0ef342efd58b28b1cc165f3d32cc8b802135116607", new Set(["3年前の今頃は1万人耐久してた"])],
  ["59d1c427961b10883c2d3b17b772920ce0148f27b9ba08c7ceefa993588dd8d6", new Set(["(キャンセル)"])],
  ["addd6bca4c4f9b4bb19a2dc2dbc195044e86388410caefd7e93eb53d2fb57c88", new Set(["今日歌えなかったのは次回に"])],
  ["e7222a91ae57bdfda1f088c68eda67af15f2e205b416603a3cd95dd84713043a", new Set(["㊗ 1,000人達成 ㊗"])],
  ["9ef1860f9676617e865cc613ba0a58db75fbf30fb1ffd8f903682b7cdf0d8ca1", new Set(["(予告の時間だよ)"])],
  ["daa5b33f30849ad8f51e3e4a341e4437211118a6345e7c3c9c18c570a9f391f4", new Set(["再起動の為一旦オフラインに"])],
  ["eea0b29c20df0499c8615d9923b9ac1461e842580dc94a8bb75e87694a960dd3", new Set(["音量チェック"])],
  ["016e10a4d788a2121bf17ef9ce966e5619f39b907249a7f1f1ad9d991b7fcc5d", new Set(["サイゼリヤの話オモロかったw"])],
  ["06bd48e78ee945d7277ad6a7129142a29217e446b396311f90e7647d0cef12c9", new Set(["サドデレボイス販売中！"])],
  ["f24981ce65cfc831d89cf1a30adeeca3c27a168c2b1f22e93e5392ff66103894", new Set(["8月の新しいチャレンジ"])],
  ["b04aa8bcb7319194e2eb49532361b52f9c69682e2391caa690f814dbbf240a3c", new Set(["弾き語り再開"])],
  ["42905902c261c911575a27b731c7b2787aa9198c4a7df808ac4135eb18de5118", new Set(["(音量チェックから"])],
  ["d8fa84948e6a14761c1282b08d3ff97909311696b94e344fb9cb66e17e19c565", new Set(["休憩:牛乳パンもぐもぐ"])],
  ["1af631bc2ab20bdb747ac3472747891c983e70837523efde6ad2a7b65c4d41d7", new Set(["100曲歌いきり達成！！"])],
  ["82f54a2f57ce35898615d6b461eab89604fb94a22958c5b4ff65d485024153d7", new Set(["はじめの挨拶", "終わりの挨拶"])],
  ["e3c5ffcfd932a59fdcb1509d526c512c6113a00c519195153ec91d5d19bf85a7", new Set(["はじめの挨拶", "終わりの挨拶"])],
  ["443da0c1db13b4aa0ccab16fb9669ba9ea086f290ee9322498ab6f352f7050cc", new Set(["伯方の塩キャンセル", "ミリしらプリキュアチャレンジ"])],
  ["135df318540aff50b6c0aae4adfce203debcd1b63a4a750dd61c5749eab9f893", new Set(["勇者と悪の美学について", "フリーレンや勇者ヨシヒコの感想"])],
  ["2c8b3e1800a624fe53dc9a2f1bafb6568f8820c1ed7cb3082bffbd745cd1887c", new Set(["000名様達成"])],
  ["e1e8ceae96c624fa64f350e8fca4b5e743608c5ca0435626fb6417b350a79c83", new Set(["締めの挨拶"])],
  ["5c51cf7224987245ad77ddc3ed788f0af7bc2a26dc5e861e4dd51dc44854c9e3", new Set(["2万人達成㊗㊗㊗"])],
  ["4ade3d7cd6fee19793ebf822817b2bf7f750973b32450adc3e4f02fdba63e5fc", new Set(["入信用タイムスタンプ"])],
  ["9f7992f8df392d38f9331321486300c71ce474117ea78741b2261be2941917ec", new Set(["閉めの挨拶"])],
  ["c728d89c08ae88a35328e561e0e8237a7ca41603f41602cf84b3e3cfb7dc4743", new Set(["名探偵コナンの雑談"])],
  ["c393b3aa879ae4155bd68579997d51538e5846b2c76f5d0b684a42d2e22a20a1", new Set(["㊗ 4,000人達成 ㊗"])],
  ["4a9f8e9d2068168b661e82152a89e22e58ff6ced50711a9491391b15730d761e", new Set(["機材トラブルにつきここから！"])],
  ["d1168c68e8b644a8a07427f9af72bb6b73e00f3c06255002e04914f16fd743d3", new Set(["MC2 (Talk)"])],
  ["f82ca590f5648863fff5bc9c0435aa99f44a210b0f055433e18178f603c258be", new Set(["開演前のご挨拶"])],
  ["8f6931da27cc8151b3f7fb4e0163c07b238cebca5bd9ee21790850b466063ebf", new Set(["顔が", "世代が…", "動くメモ帳の時に聞いてた", "取り立て再び", "どっか行っちゃった", "40万人達成!!", "ゴールは100億万人", "声が", "お面付けよ", "今日は酒やな"])],
  ["252d604b36225d4a16ad3a4b0e3a0b64f9656d7fe0ada9c101c3735b6714e923", new Set(["電波チェック"])],
  ["f90c0d67a7cc35526d97b7f46e03172c1db3094cddf6043654e0e3108a0a7af9", new Set(["さまとんについて"])],
  ["b79cdf8deac7d22c36320bc75d4c69ecc3bbe4891dae163ef78aa5d247e76606", new Set(["離席中のつぶれたなこ"])],
  ["0381d99c0dd2c8c3cacd9d7ade4eb9a1340d3cc4f8e7f32fe221fdf858cd2b4b", new Set(["水分補給助かる〜"])],
  ["70b8b925725feb23b4743e3479c8f071cce4736534011f9d694da3feae736ce2", new Set(["200％達成"])],
  ["201cea643e0d3e23851743bb3cb0c05e648834548e928ec3ed06e9003e6e08b3", new Set(["最後の挨拶"])],
  ["6f6c5c547c35d25427ecd8780243a858466436857172c345f855c47230bd76c8", new Set(["OPスタート"])],
  ["636b75d9748c69f725265fed45b7378faa9b68454e299da8b894744213a9189d", new Set(["※編み物について", "※まどマギ新作についての感想"])],
  ["0bf3b8880078abf8016686411df9674e22bdb3514ecc1fa32a007781474cb9e6", new Set(["個展・コラボカフェについて"])],
  ["42734abd53f8dd702c0aabc0d2752c43dcb7945662049393d75dbf29c00237ff", new Set(["1通目・・・仕事の変化→ペットの話に"])],
  ["cd68601d67481f8a25c11b8544fd5ec4566e940701c9d1b57114109670e5a611", new Set(["開演"])],
  ["f72d3dc695600b152a61ec0c4825039bf03653af7bd50a24c7761ad8ae8e3c84", new Set(["Vack-ON!! Blink side 振り返り"])],
  ["c776f69a9e14e5f412e5084def96b086dedf3664a62a995b244ede5a39706984", new Set(["ばちゃすての振り返り"])],
  ["0307ee20170acfbb8ec4f9f52cfb1d136a76e01c0c0ff3589f4360fe5df096df", new Set(["特大スクープ詳細は次回！！！"])],
  ["db6e48ac96ece9a1ffb1fabc447175845a31779438fa722efb07879587e64838", new Set(["締めの挨拶"])],
  ["aecd22582a4e2bbd1ee61cece9d5e420e1c8dcb5252ac3e776b159572c932710", new Set(["～8"])],
  ["1417a20bd96f281a8175858186e650a70612f18bb745400dc20ca8d0161c253f", new Set(["ワンマンライブ12"])],
  ["4bb6b16914332005d78c5618640485453eff7d6369b6b5a2216185e6647522ac", new Set(["【#雑談】🍔9"])],
  ["e3d480117f9e4eb504e6ffea2c5998a689bb46c3fe9019446acdf971e0b2ff40", new Set(["わこチョま", "おっチョまでした！"])],
  ["2419b0e29aeb1329a357d68bc6cb1632df8ffa3a1bd6129db2ba96212c55e9c8", new Set(["エルちゃんコラボ振り返り"])],
  ["2dc3f49c2917e6d0f05a56e800bb2e05d7dfac79e2deee0be29b40efd18d69db", new Set(["締めの挨拶"])],
  ["bddbda04442cade80cb79d3c3671bba11f75cbeb89cbf687850766fd02742fdc", new Set(["～　初見さん20人達成"])],
  ["6c02c324915aa78e9c30deda5783635ebff969c99c89d8828f8f24486711c5bd", new Set(["雖然知道只是翻譯歌詞，但還是要再說一次:「不可能！絕對不可能！」)", "好聽故事一直聽)", "的笑聲最真實)"])],
  ["478f401bb24ee9ed1d84eb42f0679395ee7b93c24c8bbff25d86e3120ea79661", new Set(["いーや俺に手を振ってたね！合戦", "騎士バッチ進化記念", "1144記念、私(隷)の一番カワイイトコロ", "全て(ｼﾞｮﾊﾞを)受け止めるよぉ"])],
  ["eaa8f87146f3fb5bc0d06b8c918efa421fafcd0a68053d288ab233a87900821a", new Set([
    "学文路トキ さん", "さはらしょう さん", "雅はつる さん", "咲月羽兎 さん", "リーエ香澄 さん", "おもやいっか さん",
    "デュクス・オルトゥス さん", "羽月うずな さん", "瀬川ネガ さん", "百珠百珠しのぶ さん", "喜常みお さん", "ささみん さん", "燈璃ライト さん",
  ])],
  ["cfdabe4c9486f849e9b103ddec6532b1f74b1d4656add59b9854342d6955fc67", new Set([
    "Soraさん", "小鳥遊ゆとはさん", "花開ふりるさん", "Ibukiさん", "すとらてぃあさん", "夜紺火花さん",
    "からくりんねさん", "INARIさん", "音魂ヒビクさん", "にじゅなさん",
  ])],
  ["92e6dbcf323ba0aefd66e44f6627b6947cde9d8fe666a345ec6999e5d6e3e652", new Set([
    "本日のお夕飯の発表", "猿飛佐奈さん", "音羽ララさん", "凪乃ましろさん", "焔魔るりさん",
    "にじゅなさん", "メラ・アカルさん", "ノア・ポラリスさん", "woucaさん", "ブランク・ウリカさん",
  ])],
  ["da325a515ad3121f2a0fe37bc45584256c47215217244fb1d849a2188d9d9947", new Set([
    "九十九みな (つくもみな) さん", "羽鳥あん (はとりあん) さん", "詠音ガト (うたねがと) さん", "時音ありす (ときねありす) さん",
    "竹雫まい (たけだまい) さん", "間宵しゃな (まよいしゃな) さん", "天才八雲 (てんさいやくも) さん", "熨斗目メナ (のしめめな) さん",
  ])],
  ["da296b61ea105747d1fa4527becd8e0c253f92e7d3efedd2cd8fa8017d5e55ad", new Set([
    "メーデーじゃなかったｗ", "記憶が曖昧～当日の朝〜ポエトリー", "これから反応するよ", "異種のアプローチ",
    "昼公演と夜公演の-ERROR", "何選曲したっけ…", "お互いのオリ曲", "嬉しさと悔しさ", "記憶が…",
  ])],
  ["472599b63ab850c21f239c14359636ec399e14fc860b9c5c7541e6e6c2baed80", new Set([
    "̗̀ start ̖́", "イベントの規模がでかい", "クローゼットがスッキリする", "なんだか陽気になれる", "夏のやなとこ",
    "終わるのやだ", "湿気爆発やだ", "日焼け止めべたべたやだ", "何故か蚊に刺されない体質のらんぜ", "̗̀ Last Talk ̖́",
  ])],
  ["0c2ce3917069fe9808059242f460c98cc2782c355cabcd8b9af00249d326dd0a", new Set([
    "お前らは天使じゃない", "総再生時間あと1000時間で収益化条件クリア！", "1129の日のピザのすすめ", "村民みんなのお家にピザを届ける村長",
    "草原のとうふ小僧-その1", "音楽は家族みたいなもの", "草原のとうふ小僧-その2", "泥くさいロックがいいね", "ワンナイトカーニバルのショート上げるよ！あっぽー！",
  ])],
  ["f60e7d209b0f8a7a088c520ddf48a4003e898576dee09ba6b84742fe723cb1a0", new Set([
    "令和8年8月8日", "今日はお披露目あり", "仮眠した", "1on1楽しかった", "18時にショートが上がる", "お披露目",
    "良い曲", "デスクツアー", "スピーカー気になってる", "カメラ買った", "低音みっちゃん",
  ])],
  ["14b62e6cf9ca10b9a65ad61c8206c716303081b558d4abe1f6caac4193c16a93", new Set([
    "重大発表②『歌ってみた』", "余韻タイム♪",
  ])],
  ["42d4d97e7d15d913149a925e1f84604c9085df3123b373a8662329f736fa5829", new Set([
    "ろれつがまわらない", "wow Oh", "よいちょチャレンジ", "クリスマスイベントを画策するぷれち", "バットルートへ", "ポンデリ発言",
  ])],
  ["0ec641ae9fdbac9c09a70b10019eaa89660dfd1a4567e28ed91dbd5dd871e030", new Set([
    "夏曲の自己解釈", "口内炎の二次被害", "ICE BOX", "次枠:折咲もしゅ さん",
  ])],
  ["8c4da34922c46dc95f572643cf823ec19e0eb131aab1b5563a63be25a1355875", new Set([
    "起動 -START", "ロムがみんなのために改めて思うこと", "『イキナクチャ』導入",
  ])],
  ["c42bc673a091cab8fb3a026527c7452440b7b34814debb56a9b944b7248811f1", new Set([
    "初のシチュエーションボイス発売！", "ストーリーのあらすじ", "内容詳細＆ラインナップ",
  ])],
  ["aa41fbab29fc5cb71d37fcb3ab6b4cb4cf1b64f9ef1e73253d905e001c0d102a", new Set([
    "直近の出来事", "モーニングページを始めました！", "そういえばVIVANT始まったよね！", "ちぃかわ気になってる！",
  ])],
  ["82a8c48d1fd261a6bd987b9a956db0ddb7d5476ab4dd875873ce3e4728fc2a8c", new Set([
    "(ボイス)ねぇまって　終わってる",
  ])],
  ["2d5b755ce969ec2a9a7970440f52728f4054b8daa5a15efcb0451752502cd0c0", new Set([
    "Talk segment",
  ])],

]);

function reviewedSourceNonSongReason(song) {
  const sourceHash = String(song?.sourceHash || "");
  const title = String(song?.title || "").trim();
  const artist = String(song?.artist || "").trim();
  const raw = String(song?.raw || "").normalize("NFKC").trim();
  const unknownArtist = /^(?:|未記載|不明|未知歌手|unknown)$/iu.test(artist);

  if (sourceHash === REVIEWED_MIXED_SOURCE_HASHES.hinataVocaloid &&
      !/^\d{2},\d{1,2}:\d{2}/u.test(raw) &&
      title !== "桜ノ雨ｱｶﾍﾟﾗ") return "reviewed_mixed_chapter_comment";

  if (sourceHash === REVIEWED_MIXED_SOURCE_HASHES.kokoneConan &&
      !raw.includes("▶")) return "reviewed_mixed_chapter_comment";

  if (sourceHash === REVIEWED_MIXED_SOURCE_HASHES.kanraMorning &&
      !/\s[\/／]\s/u.test(raw)) return "reviewed_mixed_chapter_comment";

  if (sourceHash === REVIEWED_MIXED_SOURCE_HASHES.vezaliusDam &&
      !/^\p{Nd}{2}[.．]\s/u.test(raw)) return "reviewed_mixed_chapter_comment";

  if (sourceHash === REVIEWED_MIXED_SOURCE_HASHES.uraraAnniversary &&
      title !== "Luv Rendezvous 💎 七海うらら") return "reviewed_mixed_chapter_comment";

  if (sourceHash === REVIEWED_MIXED_SOURCE_HASHES.inoriAcoustic &&
      unknownArtist) return "reviewed_mixed_chapter_comment";

  if (sourceHash === REVIEWED_MIXED_SOURCE_HASHES.pleuvoirFirstKaraoke &&
      !/[\/／]/u.test(raw)) return "reviewed_mixed_chapter_comment";

  if (sourceHash === REVIEWED_MIXED_SOURCE_HASHES.aranneHundredSongs &&
      (/^休憩\d+$/u.test(title) || title === "100曲達成！")) {
    return "reviewed_source_activity_chapter";
  }

  if (sourceHash === REVIEWED_MIXED_SOURCE_HASHES.otsukaRay &&
      !/^\d+:\d{2}:\d{2}\s+\d{2}-/u.test(raw)) {
    return "reviewed_mixed_chapter_comment";
  }

  if (sourceHash === REVIEWED_MIXED_SOURCE_HASHES.hisagiDay &&
      !/\[[^\]]+\/[^\]]+\]/u.test(raw)) {
    return "reviewed_mixed_chapter_comment";
  }

  if (sourceHash === REVIEWED_MIXED_SOURCE_HASHES.suiminMc &&
      /^MC\s*-\s*/iu.test(title)) {
    return "reviewed_source_activity_chapter";
  }

  if (sourceHash === REVIEWED_MIXED_SOURCE_HASHES.minaseSummerFest &&
      unknownArtist) {
    return "reviewed_mixed_chapter_comment";
  }

  if (sourceHash === "4f0ebf635214d0dc35c7423a0a51578f8996f8086ee17aa5ec573be364db84a9" &&
      title === "トーク" && artist === "お見送り" &&
      /トーク\s*[（(]お見送り[）)]/u.test(raw)) {
    return "reviewed_source_activity_chapter";
  }

  if (REVIEWED_ACTIVITY_TITLES_BY_HASH.get(sourceHash)?.has(title)) {
    return "reviewed_source_activity_chapter";
  }
  return null;
}

function unambiguousNonSongReason(song) {
  const title = String(song?.title || "").trim();
  const artist = String(song?.artist || "").trim();
  const raw = String(song?.raw || "").trim();
  const sourceHash = String(song?.sourceHash || "");

  const reviewedReason = reviewedSourceNonSongReason(song);
  if (reviewedReason) return reviewedReason;

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

  if (REVIEWED_NUMBERED_SETLIST_HASHES.has(sourceHash) && !isExplicitNumberedSetlistRow(raw)) {
    return "reviewed_non_song_chapter_in_numbered_setlist";
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
  const title = String(song?.title || "").trim();
  const raw = String(song?.raw || "").normalize("NFKC");
  const trimmed = artist.normalize("NFKC").trim();

  if (/^(?:歌えません|練習中)$/u.test(trimmed) &&
      (raw.includes(`${title}(${trimmed})`) || raw.includes(`${title}（${trimmed}）`) ||
       raw.includes(`${title}-(${trimmed})`))) {
    return { ...song, artist: "" };
  }

  const originalSong = trimmed.match(/^(.+?)\s*[✨⭐★☆]*\s*Original\s+Song\s*[✨⭐★☆]*$/iu);
  if (originalSong?.[1]?.trim()) return { ...song, artist: originalSong[1].trim() };

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
  if (match && (!artistYear || match[4] === artistYear)) {
    const [, title, creditedArtist, metadata] = match;
    if (/(?:Anime|アニメ|TVアニメ|ゲーム|OP|ED|insert song|挿入歌|主題歌|theme song|Culture Broadcasting|Macross|Cardcaptor|即興ソング|キャラクターソング|CM(?:ソング)?|commercial)/iu.test(metadata) &&
        title.trim() && creditedArtist.trim()) {
      return { ...song, title: title.trim(), artist: creditedArtist.trim() };
    }
  }

  if (isUnknownArtistValue(artist)) {
    const simple = body.match(/^(.+?)\s*[/／]\s*([^/／]{2,})\s*[/／]\s*((?:19|20)\d{2})\s*$/u);
    if (simple?.[1]?.trim() && simple?.[2]?.trim()) {
      return { ...song, title: simple[1].trim(), artist: simple[2].trim() };
    }
  }
  return song;
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

  if (hash === REVIEWED_MIXED_SOURCE_HASHES.uraraAnniversary &&
      /^Luv Rendezvous\s*💎\s*七海うらら$/u.test(String(song?.title || "").trim())) {
    return { ...song, title: "Luv Rendezvous", artist: "七海うらら" };
  }

  if (hash === REVIEWED_MIXED_SOURCE_HASHES.piimanHarp) {
    const title = String(song?.title || "").trim();
    if (title === "世界で一番幸せな死に方(") return { ...song, title: "世界で一番幸せな死に方" };
    if (title === "バースデイ(") return { ...song, title: "バースデイ" };
    if (title === "忘れじ言の葉(整段話只有") return { ...song, title: "忘れじ言の葉" };
    if (title === "フクロウ" && song?.artist === "學貓頭鷹叫真的架勾錐") return { ...song, artist: "" };
    if (title === "練舞功" && song?.artist === "一小段") return { ...song, artist: "" };
  }

  if (hash === REVIEWED_MIXED_SOURCE_HASHES.suiTabSetlist) {
    const raw = String(song?.raw || "");
    const match = raw.match(/^\d+\t([^\t]+)\t([^\t]+)\t\d+:\d{2}:\d{2}\s*$/u);
    if (match &&
        (isUnknownArtistValue(song?.artist) || String(song?.title || "").includes("\t") || raw.includes("W/X/Y"))) {
      let artist = match[2].trim();
      if (artist === "Back number") artist = "back number";
      if (artist === "Tuki.") artist = "tuki.";
      return { ...song, title: match[1].replace(/\s{2,}/gu, " ").trim(), artist };
    }
  }

  if (hash === REVIEWED_MIXED_SOURCE_HASHES.omakiraraUnderscore) {
    const raw = String(song?.raw || "");
    const match = raw.match(/^\d+:\d{2}(?::\d{2})?\s+(.+?)\s*＿\s*(.+?)\s*$/u);
    if (match) {
      let title = match[1].trim();
      if (/^[（(]アンコール[）)]/u.test(title)) {
        title = title.replace(/^[（(]アンコール[）)]\s*/u, "").normalize("NFKC");
      }
      return { ...song, title, artist: match[2].trim() };
    }
  }
  if (hash === "99b19f47604cfddfb64f05e5317e359c4d90755ed1c2b3f5cb169c52f9f45bc9" &&
      /^\d+(?:st|nd|rd|th)アルバム「[^」]+」より$/iu.test(String(song?.artist || "").normalize("NFKC").trim())) {
    return { ...song, artist: "Eighty eight" };
  }

  if (hash === "132be6b41618301ab3f400aeda33d5eb3b287beacda40f1ddbe2b1e944a3798f" &&
      song?.title === "うまるん体操" &&
      /^妹S（シスターズ）\s*\[土間うまる/u.test(String(song?.artist || "")) &&
      /うまるん体操\s*[/／]\s*妹S（シスターズ）\s*\[[^\n]+\]\s*$/u.test(String(song?.raw || ""))) {
    return { ...song, artist: String(song.artist).trim() + "]" };
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
  isExplicitNumberedSetlistRow,
  repairKnownSourceCredit,
  repairReleaseDateCredit,
  repairStructuredSlashCredit,
  repeatedDescriptionSources,
  unambiguousNonSongReason,
};
