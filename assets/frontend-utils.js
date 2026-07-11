(function initFrontendUtils(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }
  root.FrontendUtils = factory();
})(typeof globalThis !== "undefined" ? globalThis : window, function createFrontendUtils() {
  function createSnapshotLoader(callbacks) {
    let requestId = 0;
    let abortController = null;
    let hasSuccessfulPayload = false;

    async function loadSnapshot({ path, previousPath, isInitial = false }) {
      requestId += 1;
      const currentRequestId = requestId;
      if (abortController) abortController.abort();
      abortController = typeof AbortController === "function" ? new AbortController() : null;
      const signal = abortController?.signal;

      callbacks.onBusy?.(true, { path, previousPath });
      try {
        const payload = await callbacks.readJson(path, { signal });
        if (currentRequestId !== requestId) return { status: "stale" };
        hasSuccessfulPayload = true;
        callbacks.onSuccess?.({ payload, path, previousPath });
        return { status: "success", payload };
      } catch (error) {
        if (currentRequestId !== requestId || isAbortError(error)) return { status: "stale" };
        if (isInitial && !hasSuccessfulPayload) {
          callbacks.onFirstFailure?.({ error, path, previousPath });
          return { status: "initial-failure", error };
        }
        callbacks.onFailure?.({ error, path, previousPath });
        return { status: "failure", error };
      } finally {
        if (currentRequestId === requestId) {
          callbacks.onBusy?.(false, { path, previousPath });
          abortController = null;
        }
      }
    }

    return { loadSnapshot };
  }

  function isAbortError(error) {
    return error?.name === "AbortError";
  }

  function normalizeSearch(value) {
    return String(value ?? "").normalize("NFKC").toLocaleLowerCase();
  }

  function matchesSearch(parts, filter) {
    const normalized = normalizeSearch(filter);
    if (!normalized) return true;
    return normalizeSearch((parts || []).filter(Boolean).join(" ")).includes(normalized);
  }

  function filterItemsBySearch(items, filter) {
    const normalized = normalizeSearch(filter);
    if (!normalized) return items;
    return (items || []).filter((item) => {
      const songParts = (item.songs || []).flatMap((song) => [song.title, song.artist]);
      return matchesSearch([item.title, item.channelName, item.keyword, ...songParts], normalized);
    });
  }

  function filterOccurrencesBySearch(occurrences, filter) {
    const normalized = normalizeSearch(filter);
    if (!normalized) return occurrences;
    return (occurrences || []).filter(({ item, song }) =>
      matchesSearch([item?.title, item?.channelName, item?.keyword, song?.title, song?.artist], normalized),
    );
  }

  function paginateItems(items, options = {}) {
    const sourceItems = Array.isArray(items) ? items : [];
    const total = sourceItems.length;
    const pageSize = positiveInteger(options.pageSize, total || 1);
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = clamp(positiveInteger(options.page, 1), 1, pageCount);
    const startIndex = total ? (currentPage - 1) * pageSize : 0;
    const endIndex = Math.min(total, startIndex + pageSize);

    return {
      visible: sourceItems.slice(startIndex, endIndex),
      visibleCount: Math.max(0, endIndex - startIndex),
      total,
      page: currentPage,
      pageSize,
      pageCount,
      startIndex,
      endIndex,
    };
  }

  function visiblePageTokens(currentPage, totalPages) {
    const total = positiveInteger(totalPages, 1);
    const current = clamp(positiveInteger(currentPage, 1), 1, total);
    if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);

    const pages = new Set([1, total, current - 1, current, current + 1]);
    if (current <= 4) {
      for (let page = 2; page <= 5; page += 1) pages.add(page);
    }
    if (current >= total - 3) {
      for (let page = total - 4; page < total; page += 1) pages.add(page);
    }

    const ordered = [...pages].filter((page) => page >= 1 && page <= total).sort((a, b) => a - b);
    const tokens = [];
    for (const page of ordered) {
      const previous = tokens[tokens.length - 1];
      if (typeof previous === "number" && page - previous > 1) tokens.push("ellipsis");
      tokens.push(page);
    }
    return tokens;
  }

  function buildIndexBucketModel(records, options = {}) {
    const sourceRecords = Array.isArray(records) ? records : [];
    const getBucketLabel = typeof options.getBucketLabel === "function" ? options.getBucketLabel : () => "其他";
    const compareBuckets = typeof options.compareBuckets === "function" ? options.compareBuckets : compareBucketLabels;
    const bucketMap = new Map();

    for (const record of sourceRecords) {
      const label = cleanBucketLabel(getBucketLabel(record));
      if (!bucketMap.has(label)) {
        bucketMap.set(label, {
          label,
          records: [],
        });
      }
      bucketMap.get(label).records.push(record);
    }

    const buckets = Array.from(bucketMap.values()).sort(compareBuckets);
    const requestedBucket = cleanBucketLabel(options.bucket || "全部");
    const currentBucket =
      requestedBucket === "全部" || buckets.some((bucket) => bucket.label === requestedBucket) ? requestedBucket : "全部";
    const currentRecords =
      currentBucket === "全部" ? sourceRecords : bucketMap.get(currentBucket)?.records || [];

    return {
      buckets,
      currentBucket,
      records: currentRecords,
    };
  }

  function cleanBucketLabel(value) {
    const label = String(value ?? "").trim();
    return label || "其他";
  }

  function compareBucketLabels(a, b) {
    return String(a.label || "").localeCompare(String(b.label || ""), "zh-CN", {
      numeric: true,
      sensitivity: "base",
    });
  }

  function parseUrlState(search, options = {}) {
    const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
    const defaults = options.defaults || {};
    const validRanges = new Set(options.validRanges || []);
    const validViews = new Set(options.validViews || []);
    const validPageSizes = new Set((options.validPageSizes || []).map(Number));
    const fallbackRange = defaults.range || firstSetValue(validRanges) || "";
    const fallbackView = defaults.view || firstSetValue(validViews) || "";
    const fallbackPageSize = positiveInteger(defaults.pageSize, 50);
    const hasPageSizeParam = params.has("pageSize");
    const parsedPageSize = Number.parseInt(params.get("pageSize") || "", 10);

    return {
      range: validRanges.has(params.get("range")) ? params.get("range") : fallbackRange,
      view: validViews.has(params.get("view")) ? params.get("view") : fallbackView,
      page: positiveInteger(params.get("page"), positiveInteger(defaults.page, 1)),
      pageSize: validPageSizes.has(parsedPageSize) ? parsedPageSize : hasPageSizeParam ? 50 : fallbackPageSize,
      bucket: params.has("bucket") ? cleanBucketLabel(params.get("bucket")) : defaults.bucket || "全部",
      outside: parseBooleanParam(params.get("outside") ?? params.get("libraryOutside"), Boolean(defaults.outside)),
      q: params.has("q") ? String(params.get("q") || "").slice(0, 200) : defaults.q || "",
      snapshotPath: resolveSnapshotParam(params.get("snapshot"), options),
    };
  }

  function serializeUrlState(state, options = {}) {
    const params = new URLSearchParams();
    params.set("range", state.range || "");
    params.set("view", state.view || "");
    params.set("page", String(positiveInteger(state.page, 1)));
    params.set("pageSize", String(positiveInteger(state.pageSize, 50)));
    params.set("bucket", cleanBucketLabel(state.bucket || "全部"));
    if (state.outside) params.set("outside", "1");
    if (state.q) params.set("q", String(state.q).slice(0, 200));

    const snapshotParam = snapshotParamForPath(state.snapshotPath, options);
    if (snapshotParam) params.set("snapshot", snapshotParam);
    return params.toString();
  }

  function parseBooleanParam(value, fallback) {
    if (value === null || typeof value === "undefined") return fallback;
    return ["1", "true", "yes", "on"].includes(String(value).toLocaleLowerCase());
  }

  function firstSetValue(set) {
    return set.values().next().value;
  }

  function snapshotOptions(options) {
    const latestPath = options.latestSnapshotPath || "data/latest.json";
    return [
      { id: "latest", path: latestPath },
      ...(Array.isArray(options.snapshots) ? options.snapshots : []).filter((entry) => entry?.path),
    ];
  }

  function resolveSnapshotParam(value, options = {}) {
    const fallback = options.latestSnapshotPath || "data/latest.json";
    if (!value) return fallback;
    const match = snapshotOptions(options).find((entry) => entry.id === value || entry.path === value);
    return match?.path || fallback;
  }

  function snapshotParamForPath(path, options = {}) {
    const latestPath = options.latestSnapshotPath || "data/latest.json";
    if (!path || path === latestPath) return "";
    const match = snapshotOptions(options).find((entry) => entry.path === path);
    return match?.id || match?.path || "";
  }

  function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function createSongSearchLookup(index) {
    const titleKeys = new Set(Array.isArray(index?.titleKeys) ? index.titleKeys : []);
    const titleArtistKeys = new Set(Array.isArray(index?.titleArtistKeys) ? index.titleArtistKeys : []);
    return {
      available: Boolean(titleKeys.size || titleArtistKeys.size),
      titleKeys,
      titleArtistKeys,
      generatedAt: index?.generatedAt || "",
      source: index?.source || null,
    };
  }

  function annotatePayloadWithNiche(payload, lookup) {
    if (!payload || !lookup?.available) return payload;
    return {
      ...payload,
      groups: Object.fromEntries(
        Object.entries(payload.groups || {}).map(([groupId, group]) => [groupId, annotateGroupWithNiche(group, lookup)]),
      ),
    };
  }

  function annotateGroupWithNiche(group, lookup) {
    return {
      ...group,
      items: (group.items || []).map((item) => ({
        ...item,
        songs: (item.songs || []).map((song) => ({
          ...song,
          isNiche: !isSongSearchKnown(song, lookup),
        })),
      })),
    };
  }

  function filterItemsByNiche(items, nicheOnly) {
    if (!nicheOnly) return items;
    return (items || []).filter((item) => (item.songs || []).some(isNicheSong));
  }

  function filterOccurrencesByNiche(occurrences, nicheOnly) {
    if (!nicheOnly) return occurrences;
    return (occurrences || []).filter(({ song }) => isNicheSong(song));
  }

  function isNicheSong(song) {
    return song?.isNiche === true || song?.niche === true;
  }

  function hasNicheAnnotations(payload) {
    for (const group of Object.values(payload?.groups || {})) {
      for (const item of group.items || []) {
        if ((item.songs || []).some((song) => typeof song.isNiche === "boolean" || typeof song.niche === "boolean")) {
          return true;
        }
      }
    }
    return false;
  }

  function isSongSearchKnown(song, lookup) {
    if (!lookup?.available) return false;
    const keys = songSearchKeys(song);
    if (!keys.titleKey) return false;
    if (keys.titleArtistKey && lookup.titleArtistKeys.has(keys.titleArtistKey)) return true;
    return lookup.titleKeys.has(keys.titleKey);
  }

  function songSearchKeys(song) {
    const titleKey = normalizeSongSearchText(song?.title);
    const artistKey = normalizeSongSearchText(song?.artist);
    return {
      titleKey,
      artistKey,
      titleArtistKey: titleKey && artistKey && !isUnknownArtistKey(artistKey) ? `${titleKey}::${artistKey}` : "",
    };
  }

  function normalizeSongSearchText(value) {
    return String(value ?? "")
      .normalize("NFKC")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase()
      .replace(/[’‘]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/[・･]/g, " ")
      .replace(/[^\p{Letter}\p{Number}]+/gu, "");
  }

  function isUnknownArtistKey(value) {
    return new Set(["", "unknown", "na", "n/a", "none", "null", "未記載", "未记载", "不明", "なし", "无"]).has(value);
  }

  function buildSourcePreview(occurrences, options = {}) {
    const sourceOccurrences = (occurrences || []).filter(Boolean);
    const rawLimit = Number(options.limit ?? 1);
    const limit = Number.isFinite(rawLimit) ? Math.max(0, Math.floor(rawLimit)) : 1;
    if (!limit) {
      return {
        preview: [],
        hiddenCount: sourceOccurrences.length,
        total: sourceOccurrences.length,
      };
    }

    const preview = [];
    const seenSources = new Set();

    for (const occurrence of sourceOccurrences) {
      const sourceKey = sourcePreviewKey(occurrence);
      if (sourceKey && seenSources.has(sourceKey)) {
        continue;
      }
      if (sourceKey) seenSources.add(sourceKey);

      if (preview.length < limit) {
        preview.push(occurrence);
      }
      if (preview.length >= limit) break;
    }

    return {
      preview,
      hiddenCount: Math.max(0, sourceOccurrences.length - preview.length),
      total: sourceOccurrences.length,
    };
  }

  function sourcePreviewKey(occurrence) {
    const item = occurrence?.item || {};
    return normalizeSearch(item.channelName || item.title || item.videoId || "");
  }

  return {
    annotatePayloadWithNiche,
    buildIndexBucketModel,
    buildSourcePreview,
    createSnapshotLoader,
    createSongSearchLookup,
    filterItemsBySearch,
    filterItemsByNiche,
    filterOccurrencesBySearch,
    filterOccurrencesByNiche,
    hasNicheAnnotations,
    isNicheSong,
    isSongSearchKnown,
    matchesSearch,
    normalizeSearch,
    normalizeSongSearchText,
    paginateItems,
    parseUrlState,
    serializeUrlState,
    visiblePageTokens,
  };
});
