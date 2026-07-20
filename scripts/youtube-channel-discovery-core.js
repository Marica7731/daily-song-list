const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");

const SOURCE_SYSTEM = "youtube_channel_discovery";
const DEFAULT_KEYWORDS = ["LIVE", "歌", "弾き語", "リレー"];
const DEFAULT_TABS = ["streams", "videos"];
const DEFAULT_CLIENT_VERSION = "2.20260601.00.00";

function parseCliArgs(argv = process.argv.slice(2)) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const rawKey = item.slice(2);
    const equalsIndex = rawKey.indexOf("=");
    const key = equalsIndex >= 0 ? rawKey.slice(0, equalsIndex) : rawKey;
    const inlineValue = equalsIndex >= 0 ? rawKey.slice(equalsIndex + 1) : null;
    const next = argv[index + 1];
    const value = inlineValue ?? (!next || next.startsWith("--") ? true : next);
    if (inlineValue == null && next && !next.startsWith("--")) index += 1;
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      args[key] = Array.isArray(args[key]) ? [...args[key], value] : [args[key], value];
    } else {
      args[key] = value;
    }
  }
  return args;
}

function keywordList(value = null) {
  const raw = listValues(value)
    .flatMap((item) => String(item || "").split(","))
    .map((item) => item.trim())
    .filter(Boolean);
  return uniqueStrings(raw.length ? raw : DEFAULT_KEYWORDS);
}

function tabList(value = null) {
  const raw = listValues(value)
    .flatMap((item) => String(item || "").split(","))
    .map((item) => item.trim().replace(/^\/+/u, ""))
    .filter(Boolean);
  return uniqueStrings(raw.length ? raw : DEFAULT_TABS);
}

function positiveInteger(value, fallback, label) {
  if (value == null || value === "" || value === true) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function channelDiscoveryOptionsFromArgs(args, defaults = {}) {
  const rawChannelUrl = String(args["channel-url"] || args.url || args._?.[0] || defaults.channelUrl || "").trim();
  if (!rawChannelUrl) throw new Error("Usage: npm run youtube:discover-channel -- --channel-url <YouTube channel URL>");
  const channelUrl = normalizeChannelUrl(rawChannelUrl);
  const requestIntervalMs = positiveInteger(args["request-interval-ms"], defaults.requestIntervalMs ?? 2500, "--request-interval-ms");
  return {
    channelUrl,
    singerName: String(args["singer-name"] || args.name || defaults.singerName || "").trim(),
    outputDir: path.resolve(String(args["output-dir"] || defaults.outputDir || path.join("artifacts", "channel-discovery", safePathName(channelUrl)))),
    cacheDir: path.resolve(String(args["cache-dir"] || defaults.cacheDir || path.join(".local-cache", "youtube-channel-discovery"))),
    keywords: keywordList(args.keyword || args.keywords || defaults.keywords),
    tabs: tabList(args.tab || args.tabs || defaults.tabs),
    maxChannelPages: positiveInteger(args["max-channel-pages"], defaults.maxChannelPages ?? 3, "--max-channel-pages"),
    maxCandidates: positiveInteger(args["max-candidates"] || args["max-videos"], defaults.maxCandidates ?? 100, "--max-candidates"),
    maxInspect: positiveInteger(args["max-inspect"], defaults.maxInspect ?? 20, "--max-inspect"),
    requestIntervalMs,
    requestJitterMs: positiveInteger(args["request-jitter-ms"], defaults.requestJitterMs ?? 1000, "--request-jitter-ms"),
    inspectShardIndex: positiveInteger(args["inspect-shard-index"], defaults.inspectShardIndex ?? 0, "--inspect-shard-index"),
    inspectShardCount: positiveInteger(args["inspect-shard-count"], defaults.inspectShardCount ?? 1, "--inspect-shard-count"),
    fresh: args.fresh === true || args.fresh === "1" || args.fresh === "true",
    candidateOnly: args["candidate-only"] === true || args["candidate-only"] === "1" || args["candidate-only"] === "true",
  };
}

async function runChannelDiscovery(options, deps) {
  const startedAt = new Date();
  const normalizedChannelUrl = normalizeChannelUrl(options.channelUrl);
  const pageUrls = channelTabUrls(normalizedChannelUrl, options.tabs);
  const checkpointPath = path.join(options.outputDir, "checkpoint.json");
  const checkpoint = options.fresh ? emptyCheckpoint() : loadCheckpoint(checkpointPath);
  const candidatesByVideoId = new Map();
  const pageSummaries = [];

  for (const pageUrl of pageUrls) {
    const pageResult = await fetchChannelPageWithContinuations(pageUrl, options, deps);
    pageSummaries.push(pageResult.summary);
    for (const item of pageResult.items) {
      mergeDiscoveryCandidate(candidatesByVideoId, item, {
        channelUrl: normalizedChannelUrl,
        discoverySourceUrl: pageUrl,
        singerName: options.singerName,
        keywords: options.keywords,
        fetchedAt: startedAt.toISOString(),
      });
    }
  }

  const candidates = [...candidatesByVideoId.values()]
    .sort(candidateSort)
    .slice(0, options.maxCandidates || candidatesByVideoId.size);
  const rawVideos = candidates.map((candidate) => rawVideoCandidate(candidate, options.singerName));
  const previousDetails = Array.isArray(checkpoint.details) ? checkpoint.details : [];
  const previousAudits = Array.isArray(checkpoint.audits) ? checkpoint.audits : [];
  const completed = new Set(checkpoint.completedVideoIds || previousDetails.map((detail) => detail?.videoId).filter(Boolean));
  const details = [...previousDetails.filter((detail) => detail?.videoId && candidates.some((candidate) => candidate.videoId === detail.videoId))];
  const audits = [...previousAudits.filter((audit) => audit?.videoId && candidates.some((candidate) => candidate.videoId === audit.videoId))];
  let inspectedCount = 0;

  if (!options.candidateOnly && options.maxInspect > 0) {
    validateInspectShardOptions(options);
    const inspectable = candidates
      .filter((candidate, index) => isCandidateInInspectShard(index, options))
      .filter((candidate) => !completed.has(candidate.videoId))
      .slice(0, options.maxInspect);
    for (const candidate of inspectable) {
      await maybeDelay(options.requestIntervalMs);
      const result = await inspectVideoSongListWithRetry(candidate, deps, options);
      if (result?.detail) {
        details.push(enrichDetail(result.detail, candidate, options.singerName));
        completed.add(candidate.videoId);
      }
      if (result?.audit) audits.push(result.audit);
      inspectedCount += 1;
      saveCheckpoint(checkpointPath, {
        schemaVersion: 1,
        channelUrl: normalizedChannelUrl,
        singerName: options.singerName,
        keywords: options.keywords,
        completedVideoIds: [...completed].sort(),
        candidateCount: candidates.length,
        inspectedInLatestRun: inspectedCount,
        detailCount: details.length,
        updatedAt: new Date().toISOString(),
        details,
        audits,
      });
      if (inspectedCount < inspectable.length) await maybeDelay(options.requestIntervalMs + randomJitterMs(options.requestJitterMs));
    }
  }

  const occurrences = details.flatMap((detail) => occurrenceRecordsFromDetail(detail, options.singerName));
  const generatedAt = new Date().toISOString();
  const manifest = {
    schemaVersion: 1,
    kind: "youtube-channel-discovery",
    sourceSystem: SOURCE_SYSTEM,
    generatedAt,
    channelUrl: normalizedChannelUrl,
    singerName: options.singerName,
    keywords: options.keywords,
    tabs: options.tabs,
    pageUrls,
    maxChannelPages: options.maxChannelPages,
    maxCandidates: options.maxCandidates,
    maxInspect: options.maxInspect,
    inspectShardIndex: options.inspectShardIndex || 0,
    inspectShardCount: options.inspectShardCount || 1,
    candidateOnly: options.candidateOnly,
    candidateCount: rawVideos.length,
    inspectedInLatestRun: inspectedCount,
    usableVideoCount: details.length,
    occurrenceCount: occurrences.length,
    pageSummaries,
    outputs: {
      rawVideos: "raw-videos.json",
      videoDetails: "video-details.json",
      occurrences: "occurrences.json",
      audits: "audits.json",
      report: "report.md",
      checkpoint: "checkpoint.json",
    },
    requestStats: deps.client?.metrics || null,
  };

  fs.mkdirSync(options.outputDir, { recursive: true });
  writeJson(path.join(options.outputDir, "manifest.json"), manifest);
  writeJson(path.join(options.outputDir, "raw-videos.json"), rawVideos);
  writeJson(path.join(options.outputDir, "video-details.json"), details);
  writeJson(path.join(options.outputDir, "occurrences.json"), occurrences);
  writeJson(path.join(options.outputDir, "audits.json"), audits);
  fs.writeFileSync(path.join(options.outputDir, "report.md"), reportMarkdown(manifest, rawVideos, details, occurrences), "utf8");
  saveCheckpoint(checkpointPath, {
    schemaVersion: 1,
    channelUrl: normalizedChannelUrl,
    singerName: options.singerName,
    keywords: options.keywords,
    completedVideoIds: [...completed].sort(),
    candidateCount: rawVideos.length,
    detailCount: details.length,
    updatedAt: generatedAt,
    details,
    audits,
  });

  return { manifest, rawVideos, details, occurrences, audits };
}

function validateInspectShardOptions(options) {
  const shardCount = positiveInteger(options.inspectShardCount, 1, "--inspect-shard-count") || 1;
  const shardIndex = positiveInteger(options.inspectShardIndex, 0, "--inspect-shard-index");
  if (shardCount < 1) throw new Error("--inspect-shard-count must be at least 1");
  if (shardIndex >= shardCount) throw new Error("--inspect-shard-index must be less than --inspect-shard-count");
}

function isCandidateInInspectShard(index, options) {
  const shardCount = Number(options.inspectShardCount) || 1;
  if (shardCount <= 1) return true;
  const shardIndex = Number(options.inspectShardIndex) || 0;
  return index % shardCount === shardIndex;
}

async function inspectVideoSongListWithRetry(candidate, deps, options) {
  const attempts = Math.max(1, Number(options.inspectMaxAttempts) || 3);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await deps.inspectVideoSongList(candidate);
    } catch (error) {
      lastError = error;
      if (!isRetriableRequestError(error) || attempt === attempts) throw error;
      await maybeDelay(Math.max(250, Number(options.requestIntervalMs) || 0) * (attempt + 1) + randomJitterMs(options.requestJitterMs));
    }
  }
  throw lastError || new Error(`inspect failed for ${candidate.videoId || candidate.title || "candidate"}`);
}

async function fetchChannelPageWithContinuations(pageUrl, options, deps) {
  const items = [];
  const seenContinuationTokens = new Set();
  let pageCount = 0;
  let continuation = "";
  let apiKey = "";
  let clientVersion = "";

  const response = await deps.client.getText(pageUrl);
  pageCount += 1;
  const page = parseYouTubePage(response.body);
  apiKey = page.apiKey;
  clientVersion = page.clientVersion || DEFAULT_CLIENT_VERSION;
  addCandidateItems(items, page.initialData, deps.extractSearchItems, options, pageUrl);
  continuation = findBrowseContinuation(page.initialData);

  while (continuation && apiKey && pageCount < options.maxChannelPages) {
    if (seenContinuationTokens.has(continuation)) break;
    seenContinuationTokens.add(continuation);
    await maybeDelay(options.requestIntervalMs + randomJitterMs(options.requestJitterMs));
    const continuationResponse = await fetchBrowseContinuation({
      apiKey,
      clientVersion,
      continuation,
      fetchImpl: deps.fetchImpl || fetch,
      requestIntervalMs: options.requestIntervalMs,
      userAgent: deps.userAgent,
    });
    pageCount += 1;
    addCandidateItems(items, continuationResponse, deps.extractSearchItems, options, pageUrl);
    continuation = findBrowseContinuation(continuationResponse);
  }

  const filtered = filterDiscoveryCandidates(items, options.keywords, Date.now());
  return {
    items: filtered,
    summary: {
      pageUrl,
      status: response.status,
      pageCount,
      rawItemCount: items.length,
      candidateCount: filtered.length,
      continuationRounds: Math.max(0, pageCount - 1),
      reachedEnd: !continuation,
      fromCache: response.fromCache === true,
      bytes: response.bytes || 0,
    },
  };
}

function addCandidateItems(target, data, extractSearchItems, options, pageUrl) {
  const channel = channelMetadataFromInitialData(data);
  const optionHandle = handleFromUrl(options.channelUrl);
  const extracted = extractSearchItems(data).map((item) => ({
    ...item,
    channelName: item.channelName || channel.title || options.singerName || "",
    channelId: item.channelId || channel.channelId,
    channelHandle: item.channelHandle || handleFromUrl(channel.handleUrl) || optionHandle,
    discoverySourceUrl: pageUrl,
    channelUrl: normalizeChannelUrl(options.channelUrl),
    singerName: options.singerName || "",
  }));
  target.push(...extracted);
}

function parseYouTubePage(html) {
  return {
    apiKey: extractRegex(html, /"INNERTUBE_API_KEY":"([^"]+)"/u),
    clientVersion: extractRegex(html, /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/u),
    initialData: extractJsonAfter(html, "ytInitialData"),
  };
}

function channelMetadataFromInitialData(data) {
  for (const item of walkDicts(data)) {
    const metadata = item.channelMetadataRenderer;
    if (!metadata) continue;
    return {
      title: metadata.title || "",
      channelId: metadata.externalId || "",
      channelUrl: metadata.channelUrl || metadata.ownerUrls?.[0] || "",
      handleUrl: (metadata.ownerUrls || []).find((url) => /youtube\.com\/@/iu.test(url)) || "",
      thumbnailUrl: bestSourceUrl(metadata.avatar),
    };
  }
  return { title: "", channelId: "", channelUrl: "", handleUrl: "", thumbnailUrl: "" };
}

async function fetchBrowseContinuation({ apiKey, clientVersion, continuation, fetchImpl = fetch, requestIntervalMs = 0, userAgent = "", maxAttempts = 3 }) {
  let lastError = null;
  const attempts = Math.max(1, Number(maxAttempts) || 1);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await maybeDelay(attempt === 1 ? requestIntervalMs : Math.max(250, requestIntervalMs) * attempt);
    let response = null;
    try {
      response = await fetchImpl(`https://www.youtube.com/youtubei/v1/browse?prettyPrint=false&key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: {
          "user-agent":
            userAgent ||
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          "accept-language": "ja,en-US;q=0.8,en;q=0.6",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          context: {
            client: {
              clientName: "WEB",
              clientVersion: clientVersion || DEFAULT_CLIENT_VERSION,
              hl: "ja",
              gl: "JP",
            },
          },
          continuation,
        }),
      });
    } catch (error) {
      lastError = error;
      continue;
    }
    if (response.ok) {
      try {
        return await response.json();
      } catch (error) {
        lastError = error;
        if (attempt === attempts) throw lastError;
        continue;
      }
    }
    lastError = new Error(`youtubei browse continuation HTTP ${response.status}`);
    if (!isRetriableContinuationStatus(response.status) || attempt === attempts) throw lastError;
  }
  throw lastError || new Error("youtubei browse continuation failed");
}

function isRetriableContinuationStatus(status) {
  const code = Number(status);
  return code === 429 || (code >= 500 && code < 600);
}

function isRetriableRequestError(error) {
  const message = String(error?.message || error || "");
  return /(?:HTTP\s+(?:429|5\d\d)|fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|UND_ERR|terminated|timeout|network)/iu.test(message);
}

function findBrowseContinuation(data) {
  for (const item of walkDicts(data)) {
    const endpoint = item.continuationEndpoint;
    const token = endpoint?.continuationCommand?.token;
    const apiUrl = endpoint?.commandMetadata?.webCommandMetadata?.apiUrl || "";
    if (token && /\/youtubei\/v1\/browse/i.test(apiUrl)) return token;
  }
  for (const item of walkDicts(data)) {
    const token = item.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token || item.continuationCommand?.token;
    if (token) return token;
  }
  return "";
}

function filterDiscoveryCandidates(items, keywords = DEFAULT_KEYWORDS, nowMs = Date.now()) {
  return dedupeByVideoId(items)
    .map((item) => {
      const matchedKeywords = matchedDiscoveryKeywords(item.title, keywords);
      const publishedTimestamp = finiteTimestamp(item.publishedTimestamp) || parsePublishedTimestamp(item.publishedText, nowMs);
      return {
        ...item,
        matchedKeywords,
        keyword: matchedKeywords[0] || item.keyword || "",
        keywords: uniqueStrings([...(item.keywords || []), ...matchedKeywords]),
        sourceGroup: SOURCE_SYSTEM,
        sourceGroups: uniqueStrings([...(item.sourceGroups || []), SOURCE_SYSTEM]),
        sourceUrls: uniqueStrings([...(item.sourceUrls || []), item.discoverySourceUrl || item.sourceUrl || ""]),
        publishedTimestamp,
      };
    })
    .filter((item) => item.videoId && item.title && item.matchedKeywords.length && !isActiveLiveOrUpcomingCandidate(item));
}

function mergeDiscoveryCandidate(target, item, context) {
  const candidate = {
    ...item,
    sourceSystem: SOURCE_SYSTEM,
    channelUrl: context.channelUrl,
    singerName: context.singerName || item.singerName || "",
    matchedKeywords: uniqueStrings([...(item.matchedKeywords || []), ...matchedDiscoveryKeywords(item.title, context.keywords)]),
    sourceUrls: uniqueStrings([...(item.sourceUrls || []), item.discoverySourceUrl || context.discoverySourceUrl]),
    discoverySourceUrl: item.discoverySourceUrl || context.discoverySourceUrl,
    fetchedAt: context.fetchedAt,
    thumbnailUrl: item.thumbnailUrl || (item.videoId ? `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg` : ""),
  };
  const existing = target.get(candidate.videoId);
  if (!existing) {
    target.set(candidate.videoId, candidate);
    return;
  }
  existing.matchedKeywords = uniqueStrings([...existing.matchedKeywords, ...candidate.matchedKeywords]);
  existing.keywords = uniqueStrings([...(existing.keywords || []), ...(candidate.keywords || [])]);
  existing.sourceGroups = uniqueStrings([...(existing.sourceGroups || []), ...(candidate.sourceGroups || [])]);
  existing.sourceUrls = uniqueStrings([...(existing.sourceUrls || []), ...(candidate.sourceUrls || [])]);
  if (!existing.publishedTimestamp && candidate.publishedTimestamp) existing.publishedTimestamp = candidate.publishedTimestamp;
  for (const key of ["publishedText", "durationText", "thumbnailUrl", "viewText", "channelName", "channelId", "channelHandle"]) {
    if (!existing[key] && candidate[key]) existing[key] = candidate[key];
  }
}

function rawVideoCandidate(candidate, singerName = "") {
  return {
    sourceSystem: SOURCE_SYSTEM,
    channelUrl: candidate.channelUrl || "",
    channelId: candidate.channelId || "",
    singerName: singerName || candidate.singerName || "",
    youtubeVideoId: candidate.videoId,
    youtubeUrl: `https://www.youtube.com/watch?v=${candidate.videoId}`,
    videoTitle: candidate.title || "",
    channelName: candidate.channelName || "",
    thumbnailUrl: candidate.thumbnailUrl || `https://i.ytimg.com/vi/${candidate.videoId}/hqdefault.jpg`,
    streamedAt: timestampToIso(candidate.publishedTimestamp),
    publishedAt: timestampToIso(candidate.publishedTimestamp),
    publishedText: candidate.publishedText || "",
    durationText: candidate.durationText || "",
    matchedKeywords: candidate.matchedKeywords || [],
    discoverySourceUrl: candidate.discoverySourceUrl || candidate.sourceUrls?.[0] || "",
    fetchedAt: candidate.fetchedAt || "",
    rawHash: hashNormalizedText(
      [
        SOURCE_SYSTEM,
        candidate.videoId,
        candidate.title,
        candidate.channelName,
        candidate.publishedText,
        candidate.durationText,
        (candidate.matchedKeywords || []).join(","),
      ].join("\n"),
    ),
  };
}

function bestSourceUrl(value) {
  const list = value?.thumbnails || value?.sources;
  if (!Array.isArray(list) || !list.length) return "";
  return [...list].sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url || "";
}

function handleFromUrl(value) {
  try {
    const url = new URL(value);
    const [handle] = url.pathname.split("/").filter(Boolean);
    return handle?.startsWith("@") ? `/${handle}` : "";
  } catch {
    return "";
  }
}

function enrichDetail(detail, candidate, singerName = "") {
  return {
    ...detail,
    sourceSystem: SOURCE_SYSTEM,
    channelName: detail.channelName || candidate.channelName || candidate.singerName || "",
    channelId: detail.channelId || candidate.channelId || "",
    channelHandle: detail.channelHandle || candidate.channelHandle || handleFromUrl(candidate.channelUrl),
    discoverySingerName: singerName || candidate.singerName || "",
    discoveryChannelUrl: candidate.channelUrl || "",
    discoverySourceUrls: candidate.sourceUrls || [candidate.discoverySourceUrl].filter(Boolean),
    matchedKeywords: candidate.matchedKeywords || [],
    publishedTimestamp: detail.publishedTimestamp || candidate.publishedTimestamp || null,
    thumbnailUrl: detail.thumbnailUrl || candidate.thumbnailUrl || `https://i.ytimg.com/vi/${candidate.videoId}/hqdefault.jpg`,
  };
}

function occurrenceRecordsFromDetail(detail, singerName = "") {
  return (detail.songs || []).map((song) => ({
    sourceSystem: SOURCE_SYSTEM,
    channelUrl: detail.discoveryChannelUrl || "",
    channelId: detail.channelId || "",
    singerName: singerName || detail.discoverySingerName || "",
    youtubeVideoId: detail.videoId,
    youtubeUrl: `https://www.youtube.com/watch?v=${detail.videoId}&t=${Number(song.seconds) || 0}s`,
    videoTitle: detail.title || "",
    channelName: detail.channelName || "",
    thumbnailUrl: detail.thumbnailUrl || `https://i.ytimg.com/vi/${detail.videoId}/hqdefault.jpg`,
    streamedAt: timestampToIso(detail.publishedTimestamp),
    publishedAt: timestampToIso(detail.publishedTimestamp),
    seconds: Number(song.seconds) || 0,
    timestampText: song.time || secondsToTimestamp(Number(song.seconds) || 0),
    rawTitle: song.raw || song.title || "",
    rawArtist: song.artist || "",
    cleanedTitle: song.title || "",
    cleanedArtist: song.artist || "",
    sourceText: song.raw || "",
    sourceUrl: `https://www.youtube.com/watch?v=${detail.videoId}&t=${Number(song.seconds) || 0}s`,
    verificationStatus: "youtube_discovered",
    matchedKeywords: detail.matchedKeywords || [],
    provenance: {
      kind: detail.sourceQuality?.sourceType ? `${detail.sourceQuality.sourceType}_timestamp` : "comment_or_description_timestamp",
      sourceId: song.sourceId || detail.selectedSourceId || "",
      sourceHash: song.sourceHash || detail.selectedSourceHash || "",
      rawHash: song.rawHash || hashNormalizedText(song.raw || `${song.time || ""} ${song.title || ""}`),
    },
  }));
}

function reportMarkdown(manifest, rawVideos, details, occurrences) {
  const lines = [
    "# YouTube channel discovery report",
    "",
    `- Generated: ${manifest.generatedAt}`,
    `- Channel: ${manifest.channelUrl}`,
    `- Singer: ${manifest.singerName || "(not set)"}`,
    `- Keywords: ${manifest.keywords.join(", ")}`,
    `- Candidates: ${manifest.candidateCount}`,
    `- Usable videos: ${manifest.usableVideoCount}`,
    `- Occurrences: ${manifest.occurrenceCount}`,
    "",
    "## Candidate videos",
    "",
  ];
  for (const video of rawVideos.slice(0, 30)) {
    lines.push(`- ${video.youtubeVideoId} ${video.videoTitle} (${video.matchedKeywords.join(", ")})`);
  }
  if (rawVideos.length > 30) lines.push(`- ... ${rawVideos.length - 30} more`);
  lines.push("", "## Parsed videos", "");
  for (const detail of details.slice(0, 30)) {
    lines.push(`- ${detail.videoId} ${detail.title} songs=${detail.songs?.length || 0}`);
  }
  if (details.length > 30) lines.push(`- ... ${details.length - 30} more`);
  lines.push("", "## Occurrence sample", "");
  for (const occurrence of occurrences.slice(0, 30)) {
    lines.push(`- ${occurrence.youtubeVideoId} ${occurrence.timestampText} ${occurrence.cleanedTitle} / ${occurrence.cleanedArtist}`);
  }
  if (occurrences.length > 30) lines.push(`- ... ${occurrences.length - 30} more`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function channelTabUrls(channelUrl, tabs = DEFAULT_TABS) {
  const normalized = new URL(normalizeChannelUrl(channelUrl));
  normalized.hash = "";
  normalized.search = "";
  const parts = normalized.pathname.split("/").filter(Boolean);
  if (["featured", "streams", "videos", "shorts", "live", "community"].includes(parts.at(-1))) parts.pop();
  const basePath = `/${parts.join("/")}`;
  return tabList(tabs).map((tab) => {
    const url = new URL(`${basePath}/${tab}`, normalized.origin);
    url.searchParams.set("hl", "ja");
    url.searchParams.set("persist_hl", "1");
    return url.toString();
  });
}

function normalizeChannelUrl(value) {
  const text = String(value || "").trim();
  if (!text) throw new Error("channel URL is required");
  const withScheme =
    text.startsWith("@") || /^[A-Za-z0-9_.-]+$/u.test(text)
      ? `https://www.youtube.com/${text.startsWith("@") ? text : `@${text}`}`
      : /^https?:\/\//iu.test(text)
        ? text
        : `https://www.youtube.com/${text.replace(/^\/+/u, "")}`;
  const url = new URL(withScheme);
  if (!/(^|\.)youtube\.com$/iu.test(url.hostname)) throw new Error(`Expected a youtube.com channel URL, got ${value}`);
  url.protocol = "https:";
  url.hostname = "www.youtube.com";
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/u, "");
}

function matchedDiscoveryKeywords(title, keywords = DEFAULT_KEYWORDS) {
  const text = normalizeText(title).toLocaleLowerCase();
  return keywordList(keywords).filter((keyword) => text.includes(keyword.toLocaleLowerCase()));
}

function isActiveLiveOrUpcomingCandidate(item) {
  const status = normalizeText(`${item.statusText || ""} ${item.publishedText || ""} ${item.durationText || ""}`);
  const title = normalizeText(item.title || "");
  const hasDuration = /\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b/u.test(item.durationText || "");
  if (!hasDuration && /(?:がライブ配信中|ライブ配信中[!！]?|配信中です|is live|streaming now)/iu.test(title)) return true;
  if (/(?:upcoming|scheduled|premiere|公開予定|配信予定|ライブ配信予定|予定|予約|待機|まもなく|即将|預約|预约)/iu.test(status)) {
    return !hasDuration;
  }
  if (/(?:LIVE|ライブ|配信中|生放送|視聴中|watching|直播中|正在观看|正在觀看|실시간|시청 중)/iu.test(status)) {
    return !hasDuration;
  }
  return false;
}

function parsePublishedTimestamp(value, nowMs = Date.now()) {
  const text = normalizeDigits(normalizeText(value));
  if (!text) return null;
  const absolute = text.match(/((?:19|20)\d{2})[\/.\-年]\s*(\d{1,2})[\/.\-月]\s*(\d{1,2})/u);
  if (absolute) {
    const [, year, month, day] = absolute;
    const parsed = Date.parse(`${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}T00:00:00Z`);
    return Number.isFinite(parsed) ? parsed : null;
  }
  const match = text.match(/(\d+)\s*(second|seconds|sec|secs|minute|minutes|min|mins|hour|hours|hr|hrs|day|days|week|weeks|month|months|year|years|秒|分|時間|日|週間|週|周|か月|ヶ月|月|年)/iu);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2].toLocaleLowerCase();
  let multiplier = 0;
  if (/second|sec|秒/u.test(unit)) multiplier = 1000;
  else if (/minute|min|分/u.test(unit)) multiplier = 60 * 1000;
  else if (/hour|hr|時間/u.test(unit)) multiplier = 60 * 60 * 1000;
  else if (/day|日/u.test(unit)) multiplier = 24 * 60 * 60 * 1000;
  else if (/week|週間|週|周/u.test(unit)) multiplier = 7 * 24 * 60 * 60 * 1000;
  else if (/month|か月|ヶ月|月/u.test(unit)) multiplier = 30 * 24 * 60 * 60 * 1000;
  else if (/year|年/u.test(unit)) multiplier = 365 * 24 * 60 * 60 * 1000;
  return multiplier ? nowMs - amount * multiplier : null;
}

function extractJsonAfter(text, marker) {
  const idx = String(text || "").indexOf(marker);
  if (idx < 0) throw new Error(`${marker} not found`);
  const start = text.indexOf("{", idx);
  if (start < 0) throw new Error(`${marker} object start not found`);
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let pos = start; pos < text.length; pos += 1) {
    const ch = text[pos];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(start, pos + 1));
    }
  }
  throw new Error(`${marker} object end not found`);
}

function extractRegex(text, regex) {
  return String(text || "").match(regex)?.[1] || "";
}

function* walkDicts(value) {
  if (Array.isArray(value)) {
    for (const child of value) yield* walkDicts(child);
  } else if (value && typeof value === "object") {
    yield value;
    for (const child of Object.values(value)) yield* walkDicts(child);
  }
}

function dedupeByVideoId(items) {
  const seen = new Map();
  for (const item of items || []) {
    if (!item?.videoId) continue;
    const previous = seen.get(item.videoId);
    if (!previous || candidateCompletenessScore(item) > candidateCompletenessScore(previous)) seen.set(item.videoId, item);
  }
  return [...seen.values()];
}

function candidateCompletenessScore(item) {
  return (
    (item.title ? 16 : 0) +
    (item.thumbnailUrl ? 8 : 0) +
    (item.durationText ? 4 : 0) +
    (item.publishedText || item.publishedTimestamp ? 2 : 0) +
    (item.channelName ? 1 : 0)
  );
}

function candidateSort(a, b) {
  const timeDiff = (b.publishedTimestamp || 0) - (a.publishedTimestamp || 0);
  if (timeDiff) return timeDiff;
  const titleDiff = String(a.title || "").localeCompare(String(b.title || ""), "ja");
  if (titleDiff) return titleDiff;
  return String(a.videoId || "").localeCompare(String(b.videoId || ""));
}

function timestampToIso(value) {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  return new Date(timestamp).toISOString();
}

function secondsToTimestamp(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const rest = value % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
    : `${minutes}:${String(rest).padStart(2, "0")}`;
}

function finiteTimestamp(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function normalizeDigits(text) {
  return String(text || "").replace(/[０-９]/gu, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

function normalizeText(value) {
  return String(value || "").replace(/\u00a0/gu, " ").replace(/\s+/gu, " ").trim();
}

function normalizeSourceText(text) {
  return String(text || "")
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "\n")
    .replace(/\u00a0/gu, " ")
    .replace(/\u200b/gu, "")
    .replace(/[ \t]+/gu, " ")
    .trim();
}

function hashNormalizedText(text) {
  return crypto.createHash("sha256").update(normalizeSourceText(text), "utf8").digest("hex");
}

function uniqueStrings(values) {
  return [...new Set(listValues(values).map((value) => String(value || "").trim()).filter(Boolean))];
}

function listValues(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === false) return [];
  return [value];
}

function safePathName(value) {
  return String(value || "channel")
    .replace(/^https?:\/\//iu, "")
    .replace(/[^A-Za-z0-9_.@-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
}

function loadCheckpoint(filePath) {
  if (!fs.existsSync(filePath)) return emptyCheckpoint();
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return emptyCheckpoint();
  }
}

function emptyCheckpoint() {
  return { schemaVersion: 1, completedVideoIds: [], details: [], audits: [] };
}

function saveCheckpoint(filePath, checkpoint) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeJson(filePath, checkpoint);
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

async function maybeDelay(ms) {
  const value = Number(ms);
  if (Number.isFinite(value) && value > 0) await delay(value);
}

function randomJitterMs(maxJitterMs, random = Math.random) {
  const max = Number(maxJitterMs);
  return Number.isFinite(max) && max > 0 ? Math.floor(random() * (max + 1)) : 0;
}

module.exports = {
  DEFAULT_KEYWORDS,
  DEFAULT_TABS,
  SOURCE_SYSTEM,
  channelDiscoveryOptionsFromArgs,
  channelTabUrls,
  candidateSort,
  enrichDetail,
  extractJsonAfter,
  filterDiscoveryCandidates,
  findBrowseContinuation,
  keywordList,
  matchedDiscoveryKeywords,
  normalizeChannelUrl,
  occurrenceRecordsFromDetail,
  parseCliArgs,
  parsePublishedTimestamp,
  parseYouTubePage,
  positiveInteger,
  rawVideoCandidate,
  reportMarkdown,
  runChannelDiscovery,
  tabList,
};
