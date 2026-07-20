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
        await callbacks.onSuccess?.({ payload, path, previousPath });
        return { status: "success", payload };
      } catch (error) {
        if (currentRequestId !== requestId || isAbortError(error)) return { status: "stale" };
        if (isInitial && !hasSuccessfulPayload) {
          await callbacks.onFirstFailure?.({ error, path, previousPath });
          return { status: "initial-failure", error };
        }
        await callbacks.onFailure?.({ error, path, previousPath });
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
      return matchesSearch([item.videoId, item.title, item.channelName, item.keyword, ...songParts], normalized);
    });
  }

  function filterOccurrencesBySearch(occurrences, filter) {
    const normalized = normalizeSearch(filter);
    if (!normalized) return occurrences;
    return (occurrences || []).filter(({ item, song }) =>
      matchesSearch([item?.videoId, item?.title, item?.channelName, item?.keyword, song?.title, song?.artist], normalized),
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

  function responsiveListPageSize(mode = "desktop", options = {}) {
    const sizes = {
      mobile: positiveInteger(options.mobile, 20),
      tablet: positiveInteger(options.tablet, 50),
      desktop: positiveInteger(options.desktop, 50),
    };
    return sizes[mode] || sizes.desktop;
  }

  function sourceDrawerPageModel(options = {}) {
    const total = nonNegativeInteger(options.totalCount ?? options.total, 0);
    const pageSize = positiveInteger(options.pageSize, total || 1);
    const pageCount = Math.max(1, Math.ceil(total / pageSize));
    const page = clamp(positiveInteger(options.page, 1), 1, pageCount);
    const visibleCount = nonNegativeInteger(options.visibleCount, 0);
    const startIndex = total ? (page - 1) * pageSize : 0;
    const endIndex = Math.min(total, startIndex + visibleCount);
    return {
      page,
      pageSize,
      pageCount,
      total,
      totalCount: total,
      visibleCount,
      startIndex,
      endIndex,
      hasPrevious: page > 1,
      hasNext: page < pageCount,
      previousPage: page > 1 ? page - 1 : null,
      nextPage: page < pageCount ? page + 1 : null,
      currentLabel: `${page}/${pageCount}`,
    };
  }

  function desktopPageTokens(currentPage, totalPages, options = {}) {
    const total = positiveInteger(totalPages, 1);
    const current = clamp(positiveInteger(currentPage, 1), 1, total);
    const maxTokens = Math.max(5, positiveInteger(options.maxTokens, 7));
    const pageToken = (page) => ({ type: "page", page, current: page === current });
    const ellipsisToken = (side) => ({ type: "ellipsis", side });

    if (total <= maxTokens) return Array.from({ length: total }, (_, index) => pageToken(index + 1));

    const siblingCount = maxTokens >= 7 ? 1 : 0;
    const leftSibling = Math.max(2, current - siblingCount);
    const rightSibling = Math.min(total - 1, current + siblingCount);
    const showLeftEllipsis = leftSibling > 2;
    const showRightEllipsis = rightSibling < total - 1;

    if (!showLeftEllipsis && showRightEllipsis) {
      const end = Math.min(total - 1, maxTokens - 2);
      const pages = Array.from({ length: end }, (_, index) => index + 1);
      return [...pages.map(pageToken), ellipsisToken("right"), pageToken(total)];
    }

    if (showLeftEllipsis && !showRightEllipsis) {
      const start = Math.max(2, total - (maxTokens - 3));
      const pages = Array.from({ length: total - start + 1 }, (_, index) => start + index);
      return [pageToken(1), ellipsisToken("left"), ...pages.map(pageToken)];
    }

    const pages = Array.from({ length: rightSibling - leftSibling + 1 }, (_, index) => leftSibling + index);
    return [pageToken(1), ellipsisToken("left"), ...pages.map(pageToken), ellipsisToken("right"), pageToken(total)];
  }

  function visiblePageTokens(currentPage, totalPages, options = {}) {
    return desktopPageTokens(currentPage, totalPages, options);
  }

  function mobilePageModel(currentPage, totalPages) {
    const pageCount = positiveInteger(totalPages, 1);
    const current = clamp(positiveInteger(currentPage, 1), 1, pageCount);
    const previousPage = current > 1 ? current - 1 : null;
    const nextPage = current < pageCount ? current + 1 : null;
    return {
      currentPage: current,
      totalPages: pageCount,
      pageCount,
      hasPrevious: previousPage !== null,
      hasNext: nextPage !== null,
      previousPage,
      previousNeighbors: previousPage ? [previousPage] : [],
      currentLabel: `${current}/${pageCount}`,
      nextNeighbors: nextPage ? [nextPage] : [],
      nextPage,
    };
  }

  function mobilePageStepperModel(currentPage, totalPages) {
    const model = mobilePageModel(currentPage, totalPages);
    return {
      ...model,
      previousNeighbor: model.previousNeighbors[0] || null,
      nextNeighbor: model.nextNeighbors[0] || null,
    };
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
    const validRankMetrics = new Set(options.validRankMetrics || ["occurrences", "videos"]);
    const validVideoLayouts = new Set(options.validVideoLayouts || ["cards", "compact"]);
    const fallbackRange = normalizeRangeId(defaults.range || firstSetValue(validRanges) || "", options);
    const fallbackView = defaults.view || firstSetValue(validViews) || "";
    const fallbackPageSize = positiveInteger(defaults.pageSize, 50);
    const hasPageSizeParam = params.has("pageSize");
    const parsedPageSize = Number.parseInt(params.get("pageSize") || "", 10);
    const parsedMinCount = Number.parseInt(params.get("minCount") || "", 10);
    const rankMetric = params.get("metric");
    const videoLayout = params.get("layout");
    const trend = params.get("trend");
    const validTrendFilters = new Set(options.validTrendFilters || ["all", "new", "up", "down"]);
    const validMinCounts = new Set((options.validMinCounts || [1, 2, 5, 10]).map(Number));

    return {
      range: parseRangeParam(params.get("range"), validRanges, fallbackRange, options),
      view: validViews.has(params.get("view")) ? params.get("view") : fallbackView,
      page: positiveInteger(params.get("page"), positiveInteger(defaults.page, 1)),
      pageSize: validPageSizes.has(parsedPageSize) ? parsedPageSize : hasPageSizeParam ? 50 : fallbackPageSize,
      bucket: params.has("bucket") ? cleanBucketLabel(params.get("bucket")) : defaults.bucket || "全部",
      rankMetric: validRankMetrics.has(rankMetric) ? rankMetric : defaults.rankMetric || "occurrences",
      videoLayout: validVideoLayouts.has(videoLayout) ? videoLayout : defaults.videoLayout || "cards",
      outside: parseBooleanParam(params.get("outside") ?? params.get("libraryOutside"), Boolean(defaults.outside)),
      ...parseUnknownArtistUrlState(params, defaults),
      q: params.has("q") ? String(params.get("q") || "").slice(0, 200) : defaults.q || "",
      snapshotPath: resolveSnapshotParam(params.get("snapshot"), options),
      trend: validTrendFilters.has(trend) ? trend : defaults.trend || "all",
      minCount: validMinCounts.has(parsedMinCount) ? parsedMinCount : positiveInteger(defaults.minCount, 1),
    };
  }

  function serializeUrlState(state, options = {}) {
    const params = new URLSearchParams();
    const defaults = {
      range: "7d",
      view: "songRank",
      page: 1,
      pageSize: 50,
      bucket: "全部",
      rankMetric: "occurrences",
      videoLayout: "cards",
      trend: "all",
      minCount: 1,
      ...(options.defaults || {}),
    };
    const range = normalizeRangeId(state.range || defaults.range, options);
    const view = state.view || defaults.view;
    const page = positiveInteger(state.page, defaults.page);
    const pageSize = positiveInteger(state.pageSize, defaults.pageSize);
    const bucket = cleanBucketLabel(state.bucket || defaults.bucket);
    const rankMetric = state.rankMetric || defaults.rankMetric;
    const videoLayout = state.videoLayout || defaults.videoLayout;
    const trend = state.trend || defaults.trend;
    const minCount = positiveInteger(state.minCount, defaults.minCount);

    if (range !== defaults.range) params.set("range", range);
    if (view !== defaults.view) params.set("view", view);
    if (page !== defaults.page) params.set("page", String(page));
    if (view !== "videos" && pageSize !== defaults.pageSize) params.set("pageSize", String(pageSize));
    if (view === "songAz" && bucket !== defaults.bucket) params.set("bucket", bucket);
    if ((view === "songRank" || view === "artistRank" || view === "vtuberRank") && rankMetric !== defaults.rankMetric) {
      params.set("metric", rankMetric);
    }
    if (view === "videos" && videoLayout !== defaults.videoLayout) params.set("layout", videoLayout);
    if (state.outside) params.set("outside", "1");
    if (unknownArtistsHiddenForUrl(state, defaults)) params.set("hideUnknown", "1");
    if (state.q) params.set("q", String(state.q).slice(0, 200));
    if ((view === "songRank" || view === "artistRank") && trend !== defaults.trend) params.set("trend", trend);
    if (view !== "videos" && view !== "vtuberRank" && minCount !== defaults.minCount) params.set("minCount", String(minCount));

    const snapshotParam = snapshotParamForPath(state.snapshotPath, options);
    if (snapshotParam) params.set("snapshot", snapshotParam);
    if (options.includeShared) params.set("shared", "1");
    return params.toString();
  }

  function defaultQueryDraft(defaults = {}) {
    return {
      q: "",
      nicheOnly: false,
      hideUnknownArtist: false,
      rankMetric: "occurrences",
      trend: "all",
      minCount: 1,
      pageSize: positiveInteger(defaults.pageSize, 50),
      snapshotPath: defaults.snapshotPath || "data/latest.json",
      ...defaults,
    };
  }

  function makeQueryDraftFromState(source = {}, defaults = {}) {
    return sanitizeQueryDraft(
      {
        ...defaultQueryDraft(defaults),
        q: source.filter ?? source.q ?? "",
        nicheOnly: Boolean(source.nicheOnly ?? source.outside),
        hideUnknownArtist: unknownArtistsHiddenForDraft(source, defaults),
        rankMetric: source.rankMetric,
        trend: source.trend,
        minCount: source.minCount,
        pageSize: source.pageSize,
        snapshotPath: source.currentSnapshotPath || source.snapshotPath,
      },
      defaults,
    );
  }

  function sanitizeQueryDraft(draft = {}, options = {}) {
    const defaults = defaultQueryDraft(options.defaults || {});
    const validRankMetrics = new Set(options.validRankMetrics || ["occurrences", "videos"]);
    const validTrendFilters = new Set(options.validTrendFilters || ["all", "new", "up", "down"]);
    const validMinCounts = new Set((options.validMinCounts || [1, 2, 5, 10]).map(Number));
    const validPageSizes = new Set((options.validPageSizes || [50, 100]).map(Number));
    const latestSnapshotPath = options.latestSnapshotPath || defaults.snapshotPath || "data/latest.json";
    const snapshots = snapshotOptions({ latestSnapshotPath, snapshots: options.snapshots });
    const snapshotPath = snapshots.find((entry) => entry.path === draft.snapshotPath)?.path || latestSnapshotPath;
    const minCount = Number(draft.minCount);
    const pageSize = Number(draft.pageSize);
    const next = {
      q: String(draft.q ?? "").trim().slice(0, 200),
      nicheOnly: Boolean(draft.nicheOnly),
      hideUnknownArtist: typeof draft.hideUnknownArtist === "boolean" ? draft.hideUnknownArtist : defaults.hideUnknownArtist,
      rankMetric: validRankMetrics.has(draft.rankMetric) ? draft.rankMetric : defaults.rankMetric,
      trend: validTrendFilters.has(draft.trend) ? draft.trend : defaults.trend,
      minCount: validMinCounts.has(minCount) ? minCount : defaults.minCount,
      pageSize: validPageSizes.has(pageSize) ? pageSize : defaults.pageSize,
      snapshotPath,
    };
    if (snapshotPath !== latestSnapshotPath && options.disableTrendForSnapshots !== false) next.trend = "all";
    return next;
  }

  function activeQueryConditionCount(draft = {}, options = {}) {
    return activeQueryConditionItems(draft, options).length;
  }

  function activeQueryConditionItems(draft = {}, options = {}) {
    const normalized = sanitizeQueryDraft(draft, options);
    const view = options.view || "songRank";
    const items = [];
    if (normalized.q) items.push({ key: "q", label: normalized.q, fullLabel: normalized.q });
    if (normalized.nicheOnly) items.push({ key: "nicheOnly", label: "只看小众" });
    if (normalized.hideUnknownArtist && filterAppliesToView("hideUnknownArtist", view)) items.push({ key: "hideUnknownArtist", label: "隐藏无歌手" });
    if ((view === "songRank" || view === "artistRank") && normalized.trend !== "all") {
      const trendLabels = options.trendLabels || {};
      items.push({ key: "trend", label: trendLabels[normalized.trend] || "趋势" });
    }
    if (view !== "videos" && view !== "vtuberRank" && normalized.minCount > 1) items.push({ key: "minCount", label: `${normalized.minCount}次以上` });
    return items;
  }

  function clearRestrictiveFilter(draft = {}, key, options = {}) {
    const normalized = sanitizeQueryDraft(draft, options);
    if (key === "q") return { ...normalized, q: "" };
    if (key === "nicheOnly") return { ...normalized, nicheOnly: false };
    if (key === "hideUnknownArtist") return { ...normalized, hideUnknownArtist: false };
    if (key === "trend") return { ...normalized, trend: "all" };
    if (key === "minCount") return { ...normalized, minCount: 1 };
    if (key === "all") return clearAllRestrictiveFilters(normalized, options);
    return normalized;
  }

  function clearAllRestrictiveFilters(draft = {}, options = {}) {
    const normalized = sanitizeQueryDraft(draft, options);
    return {
      ...normalized,
      q: "",
      nicheOnly: false,
      hideUnknownArtist: false,
      trend: "all",
      minCount: 1,
    };
  }

  function filterEffectModel(draft = {}, options = {}) {
    const items = activeQueryConditionItems(draft, options);
    return {
      count: items.length,
      items,
      hasRestrictiveFilters: items.length > 0,
    };
  }

  function filterAppliesToView(key, view = "songRank") {
    if (key === "hideUnknownArtist") return view !== "artistRank" && view !== "vtuberRank";
    if (key === "trend") return view === "songRank" || view === "artistRank";
    if (key === "minCount") return view !== "videos" && view !== "vtuberRank";
    return true;
  }

  function queryTriggerModel(draft = {}, options = {}) {
    const items = activeQueryConditionItems(draft, options);
    const labels = items.map((item) => item.fullLabel || item.label).filter(Boolean);
    const count = labels.length;
    const compact = options.mode === "mobile" || options.compact === true;
    return {
      count,
      labels,
      hasActive: count > 0,
      visibleCountText: !compact && count > 0 ? String(count) : "",
      ariaLabel: count > 0 ? `打开搜索与筛选，当前有 ${count} 个筛选条件：${labels.join("、")}` : "打开搜索与筛选",
    };
  }

  function parseUnknownArtistUrlState(params, defaults = {}) {
    const defaultHideUnknown = Boolean(defaults.hideUnknown ?? defaults.hideUnknownArtist ?? false);
    const hideUnknown = params.has("hideUnknown")
      ? parseBooleanParam(params.get("hideUnknown"), defaultHideUnknown)
      : params.has("showUnknown")
        ? !parseBooleanParam(params.get("showUnknown"), !defaultHideUnknown)
        : defaultHideUnknown;
    return {
      hideUnknown,
      showUnknown: !hideUnknown,
    };
  }

  function unknownArtistsHiddenForUrl(state = {}, defaults = {}) {
    if (typeof state.hideUnknown === "boolean") return state.hideUnknown;
    if (typeof state.hideUnknownArtist === "boolean") return state.hideUnknownArtist;
    if (typeof state.showUnknown === "boolean") return !state.showUnknown;
    return Boolean(defaults.hideUnknown ?? defaults.hideUnknownArtist ?? false);
  }

  function unknownArtistsHiddenForDraft(source = {}, defaults = {}) {
    if (typeof source.hideUnknownArtist === "boolean") return source.hideUnknownArtist;
    if (typeof source.hideUnknown === "boolean") return source.hideUnknown;
    if (typeof source.showUnknown === "boolean") return !source.showUnknown;
    return Boolean(defaults.hideUnknownArtist ?? defaults.hideUnknown ?? false);
  }

  function summaryVideoCountModel(options = {}) {
    const visibleCount = nonNegativeInteger(options.visibleCount ?? options.visibleVideoCount, 0);
    const sourceCount = nonNegativeInteger(options.sourceCount ?? options.sourceVideoCount, visibleCount);
    const hasSearchFilter = cleanText(options.filter ?? options.q).length > 0;
    const hasSourceDirectory = sourceCount > 0;
    const usesSourceCount = hasSourceDirectory && !hasSearchFilter && visibleCount !== sourceCount;
    return {
      count: visibleCount,
      note: "",
      sourceCount,
      visibleCount,
      ratioText: usesSourceCount ? `${visibleCount}/${sourceCount}` : String(visibleCount),
      usesSourceCount,
    };
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

  function nonNegativeInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function parseRangeParam(value, validRanges, fallback, options = {}) {
    const normalized = normalizeRangeId(value, options);
    return validRanges.has(normalized) ? normalized : fallback;
  }

  function normalizeRangeId(value, options = {}) {
    const id = cleanText(value);
    if (!id) return "";
    const aliases = options.rangeAliases || {};
    return cleanText(aliases[id] || id);
  }

  function rangeIdCandidates(rangeId, options = {}) {
    const canonical = normalizeRangeId(rangeId, options);
    const candidates = [canonical];
    const legacy = options.legacyRangeIds?.[canonical] || [];
    for (const id of legacy) {
      const cleanId = cleanText(id);
      if (cleanId && !candidates.includes(cleanId)) candidates.push(cleanId);
    }
    const aliases = options.rangeAliases || {};
    for (const [legacyId, targetId] of Object.entries(aliases)) {
      if (targetId === canonical && !candidates.includes(legacyId)) candidates.push(legacyId);
    }
    return candidates.filter(Boolean);
  }

  function createSongSearchLookup(index) {
    const titleKeys = new Set(Array.isArray(index?.titleKeys) ? index.titleKeys : []);
    const titleArtistKeys = new Set(Array.isArray(index?.titleArtistKeys) ? index.titleArtistKeys : []);
    const combinedTitleArtistKeys = createCombinedTitleArtistKeys(titleArtistKeys);
    return {
      available: Boolean(titleKeys.size || titleArtistKeys.size),
      titleKeys,
      titleArtistKeys,
      combinedTitleArtistKeys,
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
    const keys = songSearchKeyCandidates(song);
    if (!keys.titleKeys.size) return false;
    for (const titleArtistKey of keys.titleArtistKeys) {
      if (lookup.titleArtistKeys.has(titleArtistKey)) return true;
    }
    for (const titleKey of keys.titleKeys) {
      if (lookup.titleKeys.has(titleKey)) return true;
      if (lookup.combinedTitleArtistKeys?.has(titleKey)) return true;
    }
    return false;
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

  function songSearchKeyCandidates(song) {
    const artistKey = normalizeSongSearchText(song?.artist);
    const titleKeys = new Set();
    const titleArtistKeys = new Set();
    for (const titleText of songSearchTitleTextCandidates(song?.title)) {
      const titleKey = normalizeSongSearchText(titleText);
      if (!titleKey) continue;
      titleKeys.add(titleKey);
      if (artistKey && !isUnknownArtistKey(artistKey)) titleArtistKeys.add(`${titleKey}::${artistKey}`);
    }
    for (const pair of songSearchTitleArtistTextCandidates(song?.title)) {
      const titleKey = normalizeSongSearchText(pair.title);
      const inferredArtistKey = normalizeSongSearchText(pair.artist);
      if (!titleKey) continue;
      titleKeys.add(titleKey);
      if (inferredArtistKey && !isUnknownArtistKey(inferredArtistKey)) {
        titleArtistKeys.add(`${titleKey}::${inferredArtistKey}`);
      }
    }
    return { titleKeys, titleArtistKeys };
  }

  function songSearchTitleTextCandidates(value) {
    const text = cleanSongSearchCandidateText(value);
    const candidates = [text, stripLeadingSongListMarker(text)];
    for (const pair of songSearchTitleArtistTextCandidates(text)) {
      candidates.push(pair.title, stripLeadingSongListMarker(pair.title));
    }
    return uniqueCleanValues(candidates);
  }

  function songSearchTitleArtistTextCandidates(value) {
    const rawText = String(value ?? "").trim();
    const normalizedSpaceText = cleanSongSearchCandidateText(rawText);
    const pairs = [];
    if (rawText.includes("\t")) {
      const [title, ...artistParts] = rawText.split(/\t+/u);
      pairs.push({ title, artist: artistParts.join(" ") });
    }
    const quotedMatch = normalizedSpaceText.match(/^(?:[「『｢【\["'“‘])\s*(.+?)\s*(?:[」』｣】\]"'”’])\s*(.+)$/u);
    if (quotedMatch) pairs.push({ title: quotedMatch[1], artist: quotedMatch[2] });
    return pairs
      .map((pair) => ({
        title: cleanSongSearchCandidateText(stripLeadingSongListMarker(pair.title)),
        artist: cleanSongSearchCandidateText(pair.artist),
      }))
      .filter((pair) => pair.title && pair.artist);
  }

  function cleanSongSearchCandidateText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function stripLeadingSongListMarker(value) {
    let result = cleanSongSearchCandidateText(value);
    for (let index = 0; index < 4; index += 1) {
      const next = result
        .replace(/^[\u200b-\u200f\u202a-\u202e\u2600-\u27BF\u{1F300}-\u{1FAFF}\uFE0F♪♫♬♩▶▷►▸▹>|・･●○◆◇■□├└│┃┏┗┣┳┻━─┬┴┌┐┘┤┼→⇒꒱⁅⁆\s]+/u, "")
        .replace(/^[＊*]\s*(?=(?:[#＃]?\s*[0-9０-９]{1,3}[.．](?![0-9０-９])|[#＃]?\s*[0-9０-９]{1,3}[)）、:：]|[\u2460-\u2473\u3251-\u325f\u32b1-\u32bf]))/u, "")
        .replace(/^[\u2460-\u2473\u3251-\u325f\u32b1-\u32bf]\s*/u, "")
        .replace(
          /^(?:[#＃]?\s*[0-9０-９]{1,3}[\s\]）)、。:：|｜\-_/／]+|[#＃]?\s*[0-9０-９]{1,3}[.．](?![0-9０-９])\s*)/u,
          "",
        );
      if (next === result) break;
      result = cleanSongSearchCandidateText(next);
    }
    return result;
  }

  function createCombinedTitleArtistKeys(titleArtistKeys) {
    const combined = new Set();
    for (const key of titleArtistKeys || []) {
      const separatorIndex = String(key).indexOf("::");
      if (separatorIndex <= 0) continue;
      const titleKey = String(key).slice(0, separatorIndex);
      const artistKey = String(key).slice(separatorIndex + 2);
      if (!titleKey || !artistKey) continue;
      combined.add(`${titleKey}${artistKey}`);
      combined.add(`${artistKey}${titleKey}`);
    }
    return combined;
  }

  function uniqueCleanValues(values) {
    return [...new Set((values || []).map(cleanSongSearchCandidateText).filter(Boolean))];
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

  function sourcePresentationModel(occurrences, options = {}) {
    const groups = Array.isArray(options.groups) ? options.groups : groupOccurrencesByVideo(occurrences);
    const inlineLimit = positiveInteger(options.inlineLimit, 3);
    const expanded = Boolean(options.expanded);
    const totalVideoCount = nonNegativeInteger(options.totalVideoCount ?? options.videoCount, groups.length);
    const videoCount = Math.max(groups.length, totalVideoCount);
    const occurrenceCount = groups.reduce((sum, group) => sum + (group.occurrences?.length || 0), 0);
    const previewGroups = expanded ? [] : groups.slice(0, Math.min(inlineLimit, groups.length));
    const inlineGroups = previewGroups;
    const hiddenGroups = videoCount > inlineLimit ? groups.slice(inlineLimit) : [];
    const allGroups = expanded ? groups : [];
    const externalDetailCount = Math.max(0, videoCount - previewGroups.length - hiddenGroups.length);
    const canExpand = hiddenGroups.length > 0 || (Boolean(options.hasExternalDetails) && externalDetailCount > 0);
    const mode = videoCount === 0 ? "none" : canExpand ? (expanded ? "expanded" : "collapsed") : "inline";
    const remainingCount = Math.max(0, videoCount - previewGroups.length);

    return {
      mode,
      videoCount,
      occurrenceCount,
      inlineLimit,
      previewGroups,
      allGroups,
      showPreview: !expanded && videoCount > 0,
      showDrawer: expanded && canExpand,
      inlineGroups,
      inlineVisibleCount: previewGroups.length,
      hiddenGroups,
      detailGroups: expanded ? allGroups : [],
      remainingCount,
      hasMore: canExpand && !expanded,
      canExpand,
      collapsedLabel: canExpand ? "查看全部来源" : "",
      collapsedAriaLabel: canExpand ? `查看该歌曲的全部 ${videoCount} 个来源` : "",
      expandedLabel: "收起来源",
      expandedAriaLabel: "收起来源",
      showCopyAll: videoCount > 1 && !canExpand,
    };
  }

  function sourcePreviewKey(occurrence) {
    const item = occurrence?.item || {};
    return normalizeSearch(item.channelName || item.title || item.videoId || "");
  }

  function groupOccurrencesByVideo(occurrences) {
    const groups = new Map();
    for (const occurrence of occurrences || []) {
      if (!occurrence) continue;
      const item = occurrence.item || {};
      const key = cleanText(item.videoId) || `${cleanText(item.channelName)}::${cleanText(item.title)}` || "unknown";
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          videoId: cleanText(item.videoId),
          item,
          title: cleanText(item.title || item.videoId || item.channelName || "来源视频"),
          channelName: cleanText(item.channelName),
          publishedTimestamp: cleanText(item.publishedTimestamp || item.publishedAt || item.publishedTime),
          firstSeenAt: cleanText(item.firstSeenAt || item.catalogFirstSeenAt || item.discoveredAt),
          occurrences: [],
          firstSeconds: Number.POSITIVE_INFINITY,
          occurrenceCount: 0,
        });
      }
      const group = groups.get(key);
      group.occurrences.push(occurrence);
      group.occurrenceCount += 1;
      const seconds = validSeconds(occurrence?.song?.seconds);
      if (seconds !== null) group.firstSeconds = Math.min(group.firstSeconds, seconds);
    }

    return Array.from(groups.values())
      .map((group) => {
        group.occurrences.sort(compareOccurrenceSeconds);
        if (!Number.isFinite(group.firstSeconds)) group.firstSeconds = null;
        return group;
      })
      .sort((a, b) => {
        return (
          compareTimestampDesc(a.publishedTimestamp, b.publishedTimestamp) ||
          compareTimestampDesc(a.firstSeenAt, b.firstSeenAt) ||
          compareValues(a.videoId || a.key, b.videoId || b.key) ||
          compareValues(a.title, b.title)
        );
      });
  }

  function mergeCompleteSourceOccurrences(detailOccurrences = [], previewOccurrences = []) {
    const previewGroups = groupOccurrencesByVideo(previewOccurrences);
    const detailGroups = groupOccurrencesByVideo(detailOccurrences);
    const previewKeys = new Set(previewGroups.map((group) => group.videoId || group.key).filter(Boolean));
    const detailKeys = new Set(detailGroups.map((group) => group.videoId || group.key).filter(Boolean));
    const detailIsComplete = previewKeys.size > 0 && [...previewKeys].every((key) => detailKeys.has(key));
    const source = detailIsComplete ? detailOccurrences : [...(previewOccurrences || []), ...(detailOccurrences || [])];
    const seen = new Set();
    const merged = [];
    for (const occurrence of source || []) {
      if (!occurrence) continue;
      const key = occurrenceIdentityKey(occurrence);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(occurrence);
    }
    return groupOccurrencesByVideo(merged).flatMap((group) => group.occurrences || []);
  }

  function buildCompleteSourceGroups(detailOccurrences = [], previewOccurrences = []) {
    return groupOccurrencesByVideo(mergeCompleteSourceOccurrences(detailOccurrences, previewOccurrences));
  }

  function occurrenceIdentityKey(occurrence) {
    const item = occurrence?.item || {};
    const song = occurrence?.song || {};
    const videoKey = cleanText(item.videoId) || `${cleanText(item.channelName)}::${cleanText(item.title)}` || "unknown";
    const seconds = validSeconds(song.seconds);
    return [
      videoKey,
      seconds === null ? "" : String(seconds),
      normalizeSearch(song.title || ""),
      normalizeSearch(song.artist || ""),
    ].join("::");
  }

  function compareTimestampDesc(a, b) {
    const timeA = timestampValue(a);
    const timeB = timestampValue(b);
    if (timeA === timeB) return 0;
    if (timeA === null) return 1;
    if (timeB === null) return -1;
    return timeB - timeA;
  }

  function timestampValue(value) {
    if (value === null || value === undefined || value === "") return null;
    const direct = Number(value);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function compareValues(a, b) {
    return String(a || "").localeCompare(String(b || ""), "en", {
      numeric: true,
      sensitivity: "base",
    });
  }

  function compareOccurrenceSeconds(a, b) {
    const secondsA = validSeconds(a?.song?.seconds);
    const secondsB = validSeconds(b?.song?.seconds);
    if (secondsA === null && secondsB === null) return 0;
    if (secondsA === null) return 1;
    if (secondsB === null) return -1;
    return secondsA - secondsB;
  }

  function validSeconds(value) {
    if (value === null || value === undefined || value === "") return null;
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  }

  function formatSetlistTime(value) {
    const total = Math.max(0, Math.floor(Number(value) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
      : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  function normalizeSetlistSongs(songs, options = {}) {
    const isUnknownArtistName =
      typeof options.isUnknownArtistName === "function"
        ? options.isUnknownArtistName
        : globalThis.RankingUtils?.isUnknownArtistName || (() => false);
    const seen = new Set();
    const normalized = [];
    for (const song of songs || []) {
      const seconds = validSeconds(song?.seconds);
      const title = cleanText(song?.title);
      if (seconds === null || !title) continue;
      const artist = cleanText(song?.artist);
      const key = `${seconds}::${title}::${artist}`;
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push({
        seconds,
        title,
        artist: artist && !isUnknownArtistName(artist) ? artist : "",
      });
    }
    return normalized.sort((a, b) => a.seconds - b.seconds);
  }

  function buildSetlistText(item, options = {}) {
    const songs = normalizeSetlistSongs(item?._allSongs || item?.songs || [], options);
    return songs
      .map((song, index) => {
        const ordinal = String(index + 1).padStart(2, "0");
        const base = `${formatSetlistTime(song.seconds)} ${ordinal}. ${song.title}`;
        return song.artist ? `${base} - ${song.artist}` : base;
      })
      .join("\n");
  }

  function buildSongSourceLinksText(occurrences) {
    const rows = [];
    const seen = new Set();
    for (const group of groupOccurrencesByVideo(occurrences)) {
      const item = group.item || group.occurrences?.[0]?.item || {};
      const videoId = cleanText(item.videoId || group.videoId);
      const seconds = validSeconds(group.firstSeconds);
      if (!videoId || seconds === null || seen.has(videoId)) continue;
      seen.add(videoId);
      const channelName = cleanText(item.channelName || group.channelName) || "未知频道";
      rows.push(`${channelName} https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${Math.floor(seconds)}s`);
    }
    return rows.join("\n");
  }

  function buildInlineSourceModel(occurrence) {
    const item = occurrence?.item || {};
    const song = occurrence?.song || {};
    const timeText = song.time || formatSeconds(song.seconds);
    const channel = youtubeChannelLink(item);
    const channelText = cleanText(item.channelName || item.title || item.videoId || "来源");
    return {
      time: {
        text: timeText,
        href: youtubeTimeUrl(item.videoId, song.seconds),
        ariaLabel: `打开视频时间戳：${timeText}`,
      },
      channel: {
        text: channelText,
        href: channel.href,
        isFallbackSearch: channel.isFallbackSearch,
        ariaLabel: channel.isFallbackSearch ? `搜索频道：${channelText}` : `打开频道：${channelText}`,
      },
    };
  }

  function rankToggleModel(options = {}) {
    const mode = options.mode || "song";
    const isExpanded = Boolean(options.isExpanded);
    if (mode === "artist") {
      const songCount = Math.max(0, Number(options.songCount) || 0);
      return {
        text: isExpanded ? "收起" : `${songCount}首曲目`,
        ariaLabel: isExpanded ? "收起该歌手曲目" : `查看该歌手的 ${songCount} 首歌曲`,
      };
    }
    if (mode === "vtuber") {
      const songCount = Math.max(0, Number(options.songCount) || 0);
      const compactSongMetric = options.rankMetric === "songs" && Number(options.rankCount) === songCount;
      return {
        text: isExpanded ? "收起" : (options.compact || compactSongMetric) ? "曲目" : `${songCount}首曲目`,
        ariaLabel: isExpanded ? "收起该频道曲目" : `查看该频道的 ${songCount} 首歌曲`,
      };
    }

    const videoCount = Math.max(0, Number(options.videoCount) || 0);
    const occurrenceCount = Math.max(0, Number(options.occurrenceCount ?? options.total) || 0);
    const model = compactSourceToggleModel({
      isExpanded,
      rankMetric: options.rankMetric,
      rankCount: options.rankCount,
      videoCount,
      occurrenceCount,
    });
    const ariaLabel = isExpanded
      ? "收起该歌曲来源"
      : model.kind === "source"
        ? `查看该歌曲的 ${videoCount} 个来源视频`
        : model.kind === "time"
          ? `查看该歌曲的 ${occurrenceCount} 个时间点`
          : "该歌曲没有来源";
    return {
      text: model.text,
      ariaLabel,
    };
  }

  function vtuberAvatarModel(record = {}) {
    const name = cleanText(record.name || record.channelName || record.channelHandle || record.channelId || "VTuber");
    const media = vtuberDisplayImageModel(record);
    return {
      src: media.src,
      fallback: "",
      alt: `${name} 显示图`,
      hasRemoteAvatar: media.isRealAvatar,
      kind: media.kind,
      isRealAvatar: media.isRealAvatar,
      isThumbnailFallback: media.isThumbnailFallback,
      missingDisplayImage: media.missingDisplayImage,
    };
  }

  function vtuberCollectionBadgeModel(record = {}) {
    const type = cleanText(firstNonEmpty(
      record.knownSourceType,
      record.sourceType,
      record.collectionType,
      record.knownSource?.type,
      record.source?.knownSourceType,
    )).toLocaleLowerCase();
    const explicit = record.isCollected ?? record.collected ?? record.isKnownSource ?? record.knownSource?.isCollected;
    const falseTypes = new Set(["0", "false", "no", "none", "unknown", "uncollected", "not_collected", "not-collected"]);
    const trueTypes = new Set(["1", "true", "yes", "known", "collected", "library", "song-search", "song_search", "manual", "verified"]);
    const isCollected =
      explicit === true ||
      explicit === 1 ||
      explicit === "1" ||
      String(explicit).toLocaleLowerCase() === "true" ||
      trueTypes.has(type) ||
      (Boolean(type) && !falseTypes.has(type));
    return {
      text: isCollected ? "已收录" : "",
      isCollected,
      sourceType: type,
    };
  }

  function firstNonEmpty(...values) {
    for (const value of values) {
      const text = cleanText(value);
      if (text) return text;
    }
    return "";
  }

  function compactSourceToggleModel(options = {}) {
    const isExpanded = Boolean(options.isExpanded);
    if (isExpanded) return { text: "收起", kind: "expanded" };
    const videoCount = Math.max(0, Number(options.videoCount) || 0);
    const occurrenceCount = Math.max(0, Number(options.occurrenceCount) || 0);
    const rankCount = Math.max(0, Number(options.rankCount) || 0);
    const rankMetric = options.rankMetric || "occurrences";

    if (!videoCount && !occurrenceCount) return { text: "无来源", kind: "none" };
    if (videoCount <= 1 && occurrenceCount > 1) return { text: `${occurrenceCount}个时间点`, kind: "time" };
    if (videoCount > 1 && rankMetric !== "videos" && videoCount !== rankCount) return { text: `${videoCount}个来源`, kind: "source" };
    return { text: "来源", kind: "source" };
  }

  function trendDisplayModel(trend) {
    if (!trend) return null;
    const rankDelta = Number(trend.rankDelta) || 0;
    const countDelta = Number(trend.countDelta) || 0;
    const rankText =
      rankDelta > 0
        ? `排名上升 ${rankDelta} 名`
        : rankDelta < 0
          ? `排名下降 ${Math.abs(rankDelta)} 名`
          : "排名未变化";
    if (trend.isNew) {
      return {
        text: "新",
        kind: "new",
        title: "本期新进入榜单",
        ariaLabel: "本期新进入榜单",
      };
    }
    if (countDelta > 0) {
      return {
        text: `收录+${countDelta}`,
        kind: "increase",
        title: `收录增加 ${countDelta} 次；${rankText}`,
        ariaLabel: `收录增加 ${countDelta} 次；${rankText}`,
      };
    }
    if (countDelta < 0) {
      const value = Math.abs(countDelta);
      const reason = trend.reason || trend.reasonCode || "数据修正";
      return {
        text: `修正−${value}`,
        kind: "decrease",
        title: `${reason}导致收录减少 ${value} 次；${rankText}`,
        ariaLabel: `${reason}导致收录减少 ${value} 次；${rankText}`,
      };
    }
    if (rankDelta > 0) {
      return {
        text: `名次↑${rankDelta}`,
        kind: "up",
        title: `排名上升 ${rankDelta} 名，收录次数未减少`,
        ariaLabel: `排名上升 ${rankDelta} 名，收录次数未减少`,
      };
    }
    if (rankDelta < 0) {
      const value = Math.abs(rankDelta);
      return {
        text: `名次↓${value}`,
        kind: "down",
        title: `排名下降 ${value} 名，收录次数未减少；其他歌曲增加导致相对名次变化`,
        ariaLabel: `排名下降 ${value} 名，收录次数未减少；其他歌曲增加导致相对名次变化`,
      };
    }
    return null;
  }

  function indexBucketButtonModel(label, bucket, isCurrent) {
    const current = Boolean(isCurrent);
    return {
      className: current ? "index-bucket is-current" : "index-bucket",
      type: "button",
      dataset: { indexBucket: bucket },
      text: label,
      ariaPressed: current ? "true" : "false",
      ariaCurrent: current ? "page" : "",
    };
  }

  function youtubeTimeUrl(videoId, seconds) {
    const safeSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
    return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId || "")}&t=${safeSeconds}s`;
  }

  function youtubeChannelLink(item = {}) {
    const channelHandle = cleanText(item.channelHandle);
    const handleUrl = youtubeChannelHandleUrl(channelHandle);
    if (handleUrl) {
      return { href: handleUrl, isFallbackSearch: false };
    }

    const channelId = cleanText(item.channelId);
    if (channelId) {
      return {
        href: `https://www.youtube.com/channel/${encodeURIComponent(channelId)}`,
        isFallbackSearch: false,
      };
    }

    const directUrl = youtubeChannelDirectUrl(item.channelUrl || item.authorUrl || item.ownerUrl);
    if (directUrl) {
      return { href: directUrl, isFallbackSearch: false };
    }

    const channelName = cleanText(item.channelName);
    if (channelName) {
      return {
        href: `https://www.youtube.com/results?search_query=${encodeURIComponent(channelName)}`,
        isFallbackSearch: true,
      };
    }

    return {
      href: item.videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}` : "https://www.youtube.com/",
      isFallbackSearch: true,
    };
  }

  function youtubeChannelHandleUrl(value) {
    if (!value) return "";
    if (/^https?:\/\/(www\.)?youtube\.com\//i.test(value)) return value;
    if (value.startsWith("/")) return `https://www.youtube.com${value}`;
    if (value.startsWith("@")) return `https://www.youtube.com/${value}`;
    if (value.startsWith("channel/") || value.startsWith("c/") || value.startsWith("user/")) {
      return `https://www.youtube.com/${value}`;
    }
    return "";
  }

  function youtubeChannelDirectUrl(value) {
    const url = cleanText(value);
    if (!/^https?:\/\/(www\.)?youtube\.com\//i.test(url)) return "";
    if (/\/(?:channel|@|c\/|user\/)/i.test(url.replace(/^https?:\/\/(www\.)?youtube\.com/i, ""))) return url;
    return "";
  }

  function formatSeconds(value) {
    const total = Math.max(0, Number(value) || 0);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
      : `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function runtimeRangePath(rangeId, meta, options = {}) {
    if (!meta && options.requireMeta) throw new Error(`runtime meta missing before loading ${rangeId}`);
    return runtimeRangeMeta(rangeId, meta, options)?.path || `data/ui/${normalizeRangeId(rangeId, options) || rangeId}.json`;
  }

  function runtimeRangeMeta(rangeId, meta, options = {}) {
    const ranges = meta?.ranges || {};
    for (const id of rangeIdCandidates(rangeId, options)) {
      if (ranges[id]) {
        return {
          id,
          canonicalId: normalizeRangeId(rangeId, options),
          ...ranges[id],
        };
      }
    }
    return null;
  }

  function runtimeRangeShards(rangeId, meta, options = {}) {
    const rangeMeta = runtimeRangeMeta(rangeId, meta, options);
    const shards = rangeMeta?.shards || {};
    const page = firstObject(
      rangeMeta?.pageShard,
      rangeMeta?.pageShards,
      rangeMeta?.pages,
      shards.runtime,
      shards.runtimePages,
      shards.page,
      shards.pages,
    );
    const sourceDetail = firstObject(
      rangeMeta?.sourceDetailShard,
      rangeMeta?.sourceDetailShards,
      rangeMeta?.sourceDetails,
      shards.sourceDetail,
      shards.sourceDetails,
    );
    const search = firstObject(
      rangeMeta?.searchShard,
      rangeMeta?.searchShards,
      rangeMeta?.search,
      shards.search,
      shards.searches,
    );
    const request = firstObject(
      rangeMeta?.requestShard,
      rangeMeta?.requestShards,
      rangeMeta?.request,
      shards.request,
    );
    return {
      page,
      sourceDetail,
      search,
      request,
      hasPageShard: Boolean(shardPath(page)),
      hasSourceDetailShard: Boolean(shardPath(sourceDetail) || sourceDetail?.pathPattern || sourceDetail?.byKey),
      hasSearchShard: Boolean(shardPath(search) || search?.pathPattern || search?.byKey),
      hasRequestShard: Boolean(request?.summary?.path || request?.views),
    };
  }

  function firstObject(...values) {
    return values.find((value) => value && typeof value === "object") || null;
  }

  function shardPath(shard, key = "") {
    if (!shard) return "";
    if (typeof shard === "string") return shard;
    if (Array.isArray(shard)) return shardPath(shard[0], key);
    if (key && shard.byKey?.[key]) return shardPath(shard.byKey[key], key);
    return cleanText(shard.path || shard.initialPath || shard.indexPath || shard.manifestPath);
  }

  function validateRuntimeRangePayload(payload, expected = {}) {
    const rangeId = normalizeRangeId(expected.rangeId || payload?.id || "", expected);
    const acceptedRangeIds = rangeIdCandidates(rangeId, expected);
    const rangeMeta = expected.rangeMeta || runtimeRangeMeta(rangeId, expected.meta, expected);
    const itemCount = Number.isInteger(rangeMeta?.itemCount) ? rangeMeta.itemCount : null;
    const expectedDataVersion = expected.dataVersion || rangeMeta?.dataVersion || expected.meta?.dataVersion || "";
    const allowLegacyDataVersion = Boolean(expected.allowLegacyDataVersion);
    const allowPartial = Boolean(expected.allowPartial);
    const errors = [];

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw runtimeRangeValidationError("runtime range payload must be object", { rangeId, path: expected.path });
    }
    if (payload.schemaVersion !== 1) errors.push("schemaVersion must be 1");
    if (!acceptedRangeIds.includes(payload.id)) errors.push(`id must be ${acceptedRangeIds.join(" or ")}`);
    if (typeof payload.generatedAt !== "string") errors.push("generatedAt must be string");
    if (typeof payload.capturedAt !== "string") errors.push("capturedAt must be string");
    if (!allowLegacyDataVersion && expectedDataVersion && payload.dataVersion !== expectedDataVersion) {
      errors.push("dataVersion mismatch");
    }
    if (!Number.isInteger(payload.filterVersion)) errors.push("filterVersion must be integer");
    if (expected.blocklistHash && payload.blocklistHash !== expected.blocklistHash) errors.push("blocklistHash mismatch");
    if (typeof payload.nicheAnnotated !== "boolean") errors.push("nicheAnnotated must be boolean");
    if (!Array.isArray(payload.items)) {
      errors.push("items must be array");
    } else {
      if (!allowPartial && itemCount !== null && payload.items.length !== itemCount) errors.push("items length does not match meta");
      if (!allowPartial && itemCount > 0 && payload.items.length === 0) errors.push("items unexpectedly empty");
      validateRuntimeItems(payload.items, errors);
    }
    if (errors.length) {
      throw runtimeRangeValidationError(errors.join("; "), { rangeId, path: expected.path, dataVersion: payload.dataVersion || "" });
    }
    return payload;
  }

  function validateRuntimeItems(items, errors) {
    for (const [videoIndex, item] of (items || []).entries()) {
      if (!/^[A-Za-z0-9_-]{11}$/u.test(item?.videoId || "")) errors.push(`items[${videoIndex}].videoId invalid`);
      if (!Array.isArray(item?.songs) || item.songs.length <= 0) {
        errors.push(`items[${videoIndex}].songs empty`);
        continue;
      }
      for (const [songIndex, song] of item.songs.entries()) {
        if (!Number.isInteger(song?.seconds) || song.seconds < 0) {
          errors.push(`items[${videoIndex}].songs[${songIndex}].seconds invalid`);
        }
        if (!String(song?.title || "").trim()) errors.push(`items[${videoIndex}].songs[${songIndex}].title missing`);
        if (typeof song?.isNiche !== "boolean") {
          errors.push(`items[${videoIndex}].songs[${songIndex}].isNiche must be boolean`);
        }
      }
    }
  }

  function runtimeRangePayloadFromGroup(group, options = {}) {
    const rangeId = options.rangeId || group?.id || "";
    const items = Array.isArray(group?.items) ? group.items : [];
    const payload = {
      schemaVersion: 1,
      id: rangeId,
      title: group?.title || rangeId,
      generatedAt: group?.generatedAt || options.generatedAt || "",
      capturedAt: options.capturedAt || group?.capturedAt || group?.generatedAt || options.generatedAt || "",
      dataVersion: options.dataVersion || "",
      filterVersion: Number.isInteger(options.filterVersion) ? options.filterVersion : 0,
      blocklistVersion: options.blocklistVersion || "",
      blocklistHash: options.blocklistHash || "",
      nicheAnnotated: items.some((item) => (item.songs || []).some((song) => typeof song.isNiche === "boolean")),
      items,
      fallbackFrom: options.fallbackFrom || "",
    };
    return payload;
  }

  function runtimeRangeValidationError(message, details = {}) {
    const error = new Error(message);
    error.name = "RuntimeRangeValidationError";
    error.details = details;
    return error;
  }

  function createTrendLookup(diff) {
    return {
      songRank: trendMapFromEntries(diff?.songRank),
      artistRank: trendMapFromEntries(diff?.artistRank),
    };
  }

  function trendMapFromEntries(entries) {
    return new Map((entries || []).map((entry) => [entry.entityKey, entry]));
  }

  function shouldPrefetchRuntimeRange(options = {}) {
    if (options.visibilityState === "hidden") return false;
    const connection = options.connection || {};
    if (connection.saveData) return false;
    return !["2g", "slow-2g"].includes(connection.effectiveType || "");
  }

  function shouldSkipSourceFilter(payload, currentFilterVersion, currentBlocklistHash = "") {
    return (
      Number(payload?.filterVersion) >= Number(currentFilterVersion) &&
      Boolean(payload?.blocklistHash) &&
      Boolean(currentBlocklistHash) &&
      payload.blocklistHash === currentBlocklistHash
    );
  }

  function vtuberDisplayImageModel(record = {}, options = {}) {
    const excluded = new Set((options.excludeAvatarUrls || []).map(cleanText).filter(Boolean));
    const avatarUrl = [
      record.avatarUrl,
      record.channelAvatarUrl,
      record.authorAvatarUrl,
      record.profileImageUrl,
    ]
      .map(realChannelAvatarUrl)
      .find((url) => url && !excluded.has(url)) || "";
    const thumbnailUrl = displayThumbnailUrl(
      record.thumbnailUrl ||
        record.videoThumbnail ||
        record.videoThumbnailUrl ||
        record.displayThumbnailUrl ||
        occurrenceThumbnailUrl(record.occurrences) ||
        youtubeThumbnailFromVideoId(record.videoId || occurrenceVideoId(record.occurrences)),
    );
    if (avatarUrl) {
      return {
        kind: "realAvatar",
        src: avatarUrl,
        isRealAvatar: true,
        isThumbnailFallback: false,
        missingDisplayImage: false,
      };
    }
    if (thumbnailUrl) {
      return {
        kind: "thumbnailFallback",
        src: thumbnailUrl,
        isRealAvatar: false,
        isThumbnailFallback: true,
        missingDisplayImage: false,
      };
    }
    return {
      kind: "missingDisplayImage",
      src: "",
      isRealAvatar: false,
      isThumbnailFallback: false,
      missingDisplayImage: true,
    };
  }

  function realChannelAvatarUrl(value) {
    const text = cleanText(value);
    if (/^https:\/\/yt3\.googleusercontent\.com\//iu.test(text) || /^https:\/\/yt[0-9]\.ggpht\.com\//iu.test(text)) return text;
    if (/^https?:\/\/example\.test\//iu.test(text)) return text;
    return "";
  }

  function displayThumbnailUrl(value) {
    const text = cleanText(value);
    if (!/^https?:\/\//iu.test(text)) return "";
    if (/^data:image\//iu.test(text)) return "";
    return text;
  }

  function occurrenceThumbnailUrl(occurrences) {
    for (const occurrence of occurrences || []) {
      const item = occurrence?.item || {};
      const url = displayThumbnailUrl(item.thumbnailUrl || item.videoThumbnail || item.videoThumbnailUrl || item.thumbnail);
      if (url) return url;
    }
    return "";
  }

  function occurrenceVideoId(occurrences) {
    for (const occurrence of occurrences || []) {
      const id = youtubeVideoId(occurrence?.item?.videoId || occurrence?.videoId);
      if (id) return id;
    }
    return "";
  }

  function youtubeThumbnailFromVideoId(value) {
    const id = youtubeVideoId(value);
    return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : "";
  }

  function youtubeVideoId(value) {
    const text = cleanText(value);
    const direct = text.match(/^[A-Za-z0-9_-]{11}$/u);
    if (direct) return direct[0];
    const match = text.match(/(?:v=|\/vi\/|youtu\.be\/|\/shorts\/|\/embed\/)([A-Za-z0-9_-]{11})/u);
    return match ? match[1] : "";
  }

  function cleanText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  return {
    annotatePayloadWithNiche,
    buildSetlistText,
    buildSongSourceLinksText,
    buildIndexBucketModel,
    buildInlineSourceModel,
    buildSourcePreview,
    createSnapshotLoader,
    createSongSearchLookup,
    createTrendLookup,
    activeQueryConditionCount,
    activeQueryConditionItems,
    clearAllRestrictiveFilters,
    clearRestrictiveFilter,
    filterItemsBySearch,
    filterItemsByNiche,
    filterOccurrencesBySearch,
    filterOccurrencesByNiche,
    filterEffectModel,
    formatSetlistTime,
    formatSeconds,
    groupOccurrencesByVideo,
    mergeCompleteSourceOccurrences,
    buildCompleteSourceGroups,
    hasNicheAnnotations,
    isNicheSong,
    isSongSearchKnown,
    indexBucketButtonModel,
    matchesSearch,
    normalizeSearch,
    normalizeSetlistSongs,
    normalizeSongSearchText,
    paginateItems,
    responsiveListPageSize,
    sourceDrawerPageModel,
    desktopPageTokens,
    mobilePageModel,
    mobilePageStepperModel,
    queryTriggerModel,
    parseUrlState,
    defaultQueryDraft,
    makeQueryDraftFromState,
    compactSourceToggleModel,
    rankToggleModel,
    vtuberAvatarModel,
    vtuberCollectionBadgeModel,
    runtimeRangeMeta,
    runtimeRangePayloadFromGroup,
    runtimeRangePath,
    runtimeRangeShards,
    serializeUrlState,
    sanitizeQueryDraft,
    shouldPrefetchRuntimeRange,
    shouldSkipSourceFilter,
    sourcePresentationModel,
    summaryVideoCountModel,
    validateRuntimeRangePayload,
    trendDisplayModel,
    vtuberDisplayImageModel,
    visiblePageTokens,
    youtubeChannelLink,
    youtubeTimeUrl,
  };
});
