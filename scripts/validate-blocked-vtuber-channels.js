#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_BLOCKLIST_PATH,
  DEFAULT_GENERATED_ASSET_PATH,
  DEFAULT_GENERATED_META_ASSET_PATH,
  blocklistHash,
  createBlockedSourceMatcher,
  loadBlocklist,
  validateBlocklist,
} = require("./blocked-vtuber-utils");
const { BLOCKED_REGIONAL_VTUBER_CHANNELS, BLOCKLIST_HASH, matchBlockedSource } = require("../assets/source-filter");

const ROOT_DIR = path.resolve(__dirname, "..");
const INDEX_PATH = path.join(ROOT_DIR, "index.html");

function main() {
  const blocklist = loadBlocklist(DEFAULT_BLOCKLIST_PATH);
  const errors = validateBlocklist(blocklist, { requireGeneratedAsset: true, assetPath: DEFAULT_GENERATED_ASSET_PATH }).errors;
  const hash = blocklistHash(blocklist);

  if (hash !== BLOCKLIST_HASH) errors.push("assets/source-filter.js exported BLOCKLIST_HASH mismatch");
  if (blocklistHash(BLOCKED_REGIONAL_VTUBER_CHANNELS) !== hash) errors.push("assets/source-filter.js exported blocklist data mismatch");

  assertHtml(errors, hash);
  assertMatcherSamples(errors, createBlockedSourceMatcher(blocklist), matchBlockedSource);
  assertRuntimeNames(errors);

  if (errors.length) fail(errors.join("\n"));
  const counts = regionCounts(blocklist);
  console.log(
    `BLOCKLIST_VALIDATE_OK entries=${blocklist.entries.length} tw=${counts.TW} hk=${counts.HK} legacy=${counts.LEGACY_REVIEW} hash=${hash}`,
  );
}

function assertHtml(errors, hash) {
  const html = fs.readFileSync(INDEX_PATH, "utf8");
  if (!html.includes("assets/blocked-vtuber-meta.js")) errors.push("index.html missing blocked-vtuber-meta.js");
  if (html.includes("assets/blocked-vtuber-channels.js")) errors.push("index.html must not load full blocked-vtuber-channels.js on first screen");
  if (html.includes("assets/source-filter.js")) errors.push("index.html must not load source-filter.js on first screen");
  if (!html.includes(`assets/blocked-vtuber-meta.js?v=`)) errors.push("blocked-vtuber meta asset must be versioned");
  const generated = fs.readFileSync(DEFAULT_GENERATED_ASSET_PATH, "utf8");
  if (!generated.includes(`blocklistHash: "${hash}"`)) errors.push("generated asset hash mismatch");
  const meta = fs.readFileSync(DEFAULT_GENERATED_META_ASSET_PATH, "utf8");
  if (!meta.includes(`blocklistHash: "${hash}"`)) errors.push("generated meta asset hash mismatch");
  const app = fs.readFileSync(path.join(ROOT_DIR, "assets", "app.js"), "utf8");
  if (!app.includes('versionedAssetPath("assets/blocked-vtuber-channels.js")')) errors.push("app.js missing dynamic blocklist load");
  if (!app.includes('versionedAssetPath("assets/source-filter.js")')) errors.push("app.js missing dynamic source-filter load");
}

function assertMatcherSamples(errors, nodeMatcher, sourceFilterMatcher) {
  const blockedSamples = [
    ["Yukichan channelId", { channelId: "UCQymE4njJ-t9oahwX9-iC8w", channelName: "Japanese Channel", title: "歌枠" }],
    ["Yukichan handle", { channelHandle: "@yukichanch", channelName: "Japanese Channel", title: "歌枠" }],
    ["Yukichan channelUrl", { channelUrl: "https://www.youtube.com/@yukichanch", channelName: "Japanese Channel", title: "歌枠" }],
    ["Rhoda channelId", { channelId: "UC3zo1jR17JMM53_Ru7yDjfA", channelName: "Japanese Channel", title: "歌枠" }],
    ["Rhoda handle", { channelHandle: "@rhoda1126", channelName: "Japanese Channel", title: "歌枠" }],
    ["HK exact id", { channelId: "UCW8G8aeRjbIOlL-Fgms8hEQ", channelName: "Japanese Channel", title: "歌枠" }],
    ["HK exact handle", { channelHandle: "@CheukCat_hkvtuber", channelName: "Japanese Channel", title: "歌枠" }],
    ["Aruma exact id", { channelId: "UCD1QOCJIAPsMKMvRSXjLahw", channelName: "Aruma Ch. 薬袋アルマ", title: "歌枠" }],
    ["Aruma handle", { channelHandle: "@ArumaCh", channelName: "Japanese Channel", title: "歌枠" }],
  ];
  for (const [name, sample] of blockedSamples) {
    if (!nodeMatcher(sample)) errors.push(`node blocked sample did not match: ${name}`);
    if (!sourceFilterMatcher(sample)) errors.push(`source-filter blocked sample did not match: ${name}`);
  }

  const allowedSamples = [
    ["Taiwan travel title", { channelName: "日本旅行チャンネル", title: "台湾旅行 vlog 歌枠" }],
    ["Hong Kong live title", { channelName: "日本音楽チャンネル", title: "香港ライブ" }],
    ["VTuber channel word", { channelName: "VTuber Music", title: "歌枠" }],
    ["Narrator Music", { channelName: "Narrator Music", title: "歌枠" }],
    ["HKVtuber title only", { channelName: "Japanese Channel", title: "HKVtuber discussion" }],
    ["collaboration title only", { channelName: "Japanese Channel", title: "今日は小雪Yukichan Ch. とコラボ" }],
    ["individual word", { channelName: "個人勢 Music", title: "歌枠" }],
  ];
  for (const [name, sample] of allowedSamples) {
    if (nodeMatcher(sample)) errors.push(`node false positive sample matched: ${name}`);
    if (sourceFilterMatcher(sample)) errors.push(`source-filter false positive sample matched: ${name}`);
  }
}

function assertRuntimeNames(errors) {
  const source = fs.readFileSync(path.join(ROOT_DIR, "assets", "source-filter.js"), "utf8");
  if (/TAIWAN_VTUBER_BLACKLIST/u.test(source)) errors.push("source-filter must not contain TAIWAN_VTUBER_BLACKLIST");
  if (!source.includes("BLOCKED_REGIONAL_VTUBER_CHANNELS")) errors.push("source-filter must export BLOCKED_REGIONAL_VTUBER_CHANNELS");
}

function regionCounts(blocklist) {
  const counts = { TW: 0, HK: 0, LEGACY_REVIEW: 0 };
  for (const entry of blocklist.entries || []) {
    for (const region of entry.regions || []) counts[region] = (counts[region] || 0) + 1;
  }
  return counts;
}

function fail(message) {
  console.error(`BLOCKLIST_VALIDATE_FAIL ${message}`);
  process.exit(1);
}

if (require.main === module) main();
