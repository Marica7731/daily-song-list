const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

const CANONICAL_RANGES = ["7d", "all"];
const LEGACY_RANGE_ALIASES = {
  "72h": "7d",
  "1m": "all",
};
const LEGACY_RANGE_IDS = {
  "7d": ["72h"],
  all: ["1m"],
};
const RANGE_TITLES = {
  "7d": "Last 7 days timestamp song lists",
  all: "All accumulated timestamp song lists",
};
const RANGE_LABELS = {
  "7d": "最近7天",
  all: "本月",
};
const RANGE_DESCRIPTIONS = {
  "7d": "最近7天内发布的视频。",
  all: "累计全量目录；按钮保留“本月”文案以兼容旧产品入口。",
};
const DIFF_RANGES = [
  { id: "7d", file: "latest-7d.json" },
  { id: "all", file: "latest-all.json" },
];

function canonicalRangeId(value) {
  const id = String(value || "").trim();
  return LEGACY_RANGE_ALIASES[id] || id;
}

function rangeIdCandidates(value) {
  const canonical = canonicalRangeId(value);
  return [canonical, ...(LEGACY_RANGE_IDS[canonical] || [])].filter(Boolean);
}

function groupForRange(groups, rangeId) {
  const source = groups || {};
  for (const id of rangeIdCandidates(rangeId)) {
    if (source[id]) return source[id];
  }
  return null;
}

function canonicalGroups(groups) {
  return Object.fromEntries(CANONICAL_RANGES.map((rangeId) => [rangeId, groupForRange(groups, rangeId)]));
}

function canonicalItemCounts(groups) {
  return Object.fromEntries(
    CANONICAL_RANGES.map((rangeId) => [rangeId, groupForRange(groups, rangeId)?.items?.length || 0]),
  );
}

function legacyAliasManifest(legacyId, targetGroup) {
  const targetId = canonicalRangeId(legacyId);
  return {
    schemaVersion: 2,
    id: legacyId,
    aliasOf: targetId,
    path: `data/${targetId}.json`,
    generatedAt: targetGroup?.generatedAt || "",
    updatedAt: targetGroup?.updatedAt || targetGroup?.generatedAt || "",
    itemCount: targetGroup?.items?.length || 0,
  };
}

module.exports = {
  CANONICAL_RANGES,
  DAY_MS,
  DIFF_RANGES,
  LEGACY_RANGE_ALIASES,
  LEGACY_RANGE_IDS,
  RANGE_DESCRIPTIONS,
  RANGE_LABELS,
  RANGE_TITLES,
  WEEK_MS,
  canonicalGroups,
  canonicalItemCounts,
  canonicalRangeId,
  groupForRange,
  legacyAliasManifest,
  rangeIdCandidates,
};
