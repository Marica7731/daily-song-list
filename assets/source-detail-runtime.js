(function initSourceDetailRuntime(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
    return;
  }
  root.SourceDetailRuntime = factory();
})(typeof globalThis !== "undefined" ? globalThis : window, () => {
  const DEFAULT_WINDOW_SIZE = 32;
  const DEFAULT_ROW_HEIGHT = 88;

  function isSourceDetailManifest(payload) {
    return payload?.kind === "source-detail-manifest-v3" && Array.isArray(payload.chunks);
  }

  function sourceDetailChunkPaths(manifest) {
    return (manifest?.chunks || [])
      .map((chunk) => ({
        index: Number(chunk.index) || 0,
        path: cleanText(chunk.path || chunk.legacyPath),
      }))
      .filter((chunk) => chunk.index > 0 && chunk.path)
      .sort((a, b) => a.index - b.index)
      .map((chunk) => chunk.path);
  }

  function normalizeSourceDetailOccurrences(payload, key = "") {
    if (Array.isArray(payload)) return payload.filter(isOccurrenceLike);
    if (Array.isArray(payload?.occurrences)) return payload.occurrences.filter(isOccurrenceLike);
    if (Array.isArray(payload?.sourceOccurrences)) return payload.sourceOccurrences.filter(isOccurrenceLike);
    if (Array.isArray(payload?.sources) && payload?.kind === "source-detail-chunk-v3") return sourceEntriesToOccurrences(payload.sources);
    if (Array.isArray(payload?.groups)) return payload.groups.flatMap((group) => group?.occurrences || []).filter(isOccurrenceLike);
    if (Array.isArray(payload?.items)) return collectSongOccurrences(payload.items);
    if (Array.isArray(payload?.sources)) return collectSongOccurrences(payload.sources);
    if (Array.isArray(payload?.records)) {
      const matched = key ? payload.records.find((record) => record?.key === key) : null;
      const source = matched || (payload.records.length === 1 ? payload.records[0] : null);
      return (source?.occurrences || []).filter(isOccurrenceLike);
    }
    return [];
  }

  function sourceEntriesToOccurrences(sources = []) {
    const occurrences = [];
    for (const source of sources || []) {
      const item = slimSourceToVideoItem(source);
      for (const point of source.timepoints || []) {
        const seconds = Math.max(0, Math.floor(Number(point?.seconds) || 0));
        const title = cleanText(point?.title);
        if (!title) continue;
        occurrences.push({
          item,
          song: {
            seconds,
            time: formatSeconds(seconds),
            title,
            artist: cleanText(point?.artist),
            isNiche: point?.isNiche === true,
          },
          searchText: normalizeSearch([item.videoId, item.title, item.channelName, title, point?.artist].join(" ")),
        });
      }
    }
    return occurrences;
  }

  function slimSourceToVideoItem(source = {}) {
    const item = {
      videoId: cleanText(source.videoId),
      title: cleanText(source.videoTitle || source.title || source.videoId),
      channelName: cleanText(source.channelName),
      publishedTimestamp: finiteTimestamp(source.publishedTimestamp),
      catalogFirstSeenAt: cleanText(source.firstSeenAt),
      _requiresVideoSetlist: true,
    };
    if (source.channelId) item.channelId = cleanText(source.channelId);
    if (source.channelHandle) item.channelHandle = cleanText(source.channelHandle);
    return item;
  }

  async function loadSourceDetailOccurrences(path, options = {}) {
    const readJson = options.readJson;
    if (typeof readJson !== "function") throw new Error("readJson is required");
    const key = cleanText(options.key);
    const payload = await readJson(path, options.readOptions || {});
    if (!isSourceDetailManifest(payload)) return normalizeSourceDetailOccurrences(payload, key);
    const paths = sourceDetailChunkPaths(payload);
    const occurrences = [];
    for (const [index, chunkPath] of paths.entries()) {
      const chunkPayload = await readJson(chunkPath, options.readOptions || {});
      const chunkOccurrences = normalizeSourceDetailOccurrences(chunkPayload, key);
      occurrences.push(...chunkOccurrences);
      if (typeof options.onChunk === "function") {
        options.onChunk(chunkOccurrences, {
          index: index + 1,
          chunkCount: paths.length,
          loadedOccurrences: occurrences.slice(),
          manifest: payload,
        });
      }
      if (index < paths.length - 1) await waitForIdle(options.idle);
    }
    return occurrences;
  }

  async function loadVideoSetlist(item, options = {}) {
    const readJson = options.readJson;
    if (typeof readJson !== "function") throw new Error("readJson is required");
    const videoId = cleanText(item?.videoId);
    if (!videoId) throw new Error("videoId is required");
    const payload = await readJson(videoSetlistPath(videoId), options.readOptions || {});
    return {
      videoId,
      title: cleanText(payload?.title || item?.title || videoId),
      channelName: cleanText(payload?.channelName || item?.channelName),
      songs: normalizeSetlistSongs(payload?.songs || []),
      dataVersion: cleanText(payload?.dataVersion),
      generatedAt: cleanText(payload?.generatedAt),
    };
  }

  function createVideoSetlistLoader(options = {}) {
    const readJson = options.readJson;
    if (typeof readJson !== "function") throw new Error("readJson is required");
    const cache = new Map();
    const inflight = new Map();
    return async function cachedVideoSetlistLoader(item) {
      const videoId = cleanText(item?.videoId || item);
      if (!videoId) throw new Error("videoId is required");
      if (cache.has(videoId)) return cache.get(videoId);
      if (inflight.has(videoId)) return inflight.get(videoId);
      const path = videoSetlistPath(videoId);
      const load = readJson(path, options.readOptions || {})
        .then((payload) => ({
          videoId,
          title: cleanText(payload?.title || item?.title || videoId),
          channelName: cleanText(payload?.channelName || item?.channelName),
          songs: normalizeSetlistSongs(payload?.songs || []),
          dataVersion: cleanText(payload?.dataVersion),
          generatedAt: cleanText(payload?.generatedAt),
        }))
        .then((payload) => {
          cache.set(videoId, payload);
          return payload;
        })
        .finally(() => {
          inflight.delete(videoId);
        });
      inflight.set(videoId, load);
      return load;
    };
  }

  function videoSetlistPath(videoId) {
    const safeVideoId = cleanText(videoId);
    const prefix = encodeURIComponent(safeVideoId.slice(0, 2) || "__");
    return `data/ui/video-setlists/${prefix}/${encodeURIComponent(safeVideoId)}.json`;
  }

  function drawerInitialState(options = {}) {
    const previewCount = Math.max(0, Number(options.previewCount) || 0);
    const totalCount = Math.max(previewCount, Number(options.totalCount) || previewCount);
    return {
      state: totalCount > previewCount ? "loading" : "ready",
      previewCount,
      loadedCount: previewCount,
      totalCount,
      label: totalCount > previewCount ? `已加载 ${previewCount} / ${totalCount} · 正在加载来源` : `全部 ${totalCount} 个来源`,
    };
  }

  function virtualWindow(options = {}) {
    const total = Math.max(0, Number(options.total) || 0);
    const rowHeight = Math.max(1, Number(options.rowHeight) || DEFAULT_ROW_HEIGHT);
    const windowSize = Math.max(1, Number(options.windowSize) || DEFAULT_WINDOW_SIZE);
    const overscan = Math.max(0, Number(options.overscan) || 0);
    const requestedStart = Math.max(0, Math.floor(Number(options.start) || 0) - overscan);
    const maxStart = Math.max(0, total - windowSize);
    const start = Math.min(requestedStart, maxStart);
    const end = Math.min(total, start + windowSize + overscan * 2);
    return {
      start,
      end,
      count: Math.max(0, end - start),
      beforeHeight: start * rowHeight,
      afterHeight: Math.max(0, total - end) * rowHeight,
    };
  }

  function collectSongOccurrences(items = []) {
    const occurrences = [];
    for (const item of items || []) {
      for (const song of item.songs || []) {
        if (!cleanText(song?.title)) continue;
        occurrences.push({
          item,
          song,
          searchText: normalizeSearch([item.videoId, item.title, item.channelName, item.keyword, song.title, song.artist].join(" ")),
        });
      }
    }
    return occurrences;
  }

  function isOccurrenceLike(value) {
    return Boolean(value?.item && value?.song);
  }

  function normalizeSetlistSongs(songs = []) {
    const seen = new Set();
    const result = [];
    for (const song of songs || []) {
      const seconds = Math.max(0, Math.floor(Number(song?.seconds) || 0));
      const title = cleanText(song?.title);
      if (!title) continue;
      const artist = cleanText(song?.artist);
      const key = `${seconds}::${title}::${artist}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        seconds,
        title,
        ...(artist ? { artist } : {}),
        ...(song?.isNiche === true ? { isNiche: true } : {}),
      });
    }
    return result.sort((a, b) => a.seconds - b.seconds || compareValues(a.title, b.title) || compareValues(a.artist, b.artist));
  }

  function waitForIdle(idle) {
    if (typeof idle === "function") return idle();
    return Promise.resolve();
  }

  function finiteTimestamp(value) {
    const direct = Number(value);
    if (Number.isFinite(direct) && direct > 0) return direct;
    const parsed = Date.parse(String(value || ""));
    return Number.isFinite(parsed) ? parsed : null;
  }

  function formatSeconds(value) {
    const total = Math.max(0, Math.floor(Number(value) || 0));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return hours
      ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
      : `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function normalizeSearch(value) {
    return String(value || "").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
  }

  function cleanText(value) {
    return String(value ?? "").trim();
  }

  function compareValues(a, b) {
    return String(a || "").localeCompare(String(b || ""), "en", {
      numeric: true,
      sensitivity: "base",
    });
  }

  return {
    createVideoSetlistLoader,
    drawerInitialState,
    isSourceDetailManifest,
    loadSourceDetailOccurrences,
    loadVideoSetlist,
    normalizeSourceDetailOccurrences,
    sourceDetailChunkPaths,
    sourceEntriesToOccurrences,
    slimSourceToVideoItem,
    videoSetlistPath,
    virtualWindow,
  };
});
