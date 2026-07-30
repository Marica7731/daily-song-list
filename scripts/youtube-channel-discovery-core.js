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

function candidateInitialTabs(value = null) {
  const raw = listValues(value)
    .flatMap((item) => String(item || "").split(","))
    .map((item) => item.trim().replace(/^\/+/u, ""))
    .filter(Boolean);
  const tabs = raw.length ? raw : DEFAULT_TABS;
  if (tabs.length !== DEFAULT_TABS.length || tabs.some((tab, index) => tab !== DEFAULT_TABS[index])) {
    throw new Error("candidate discovery requires exactly --tab streams --tab videos in that order");
  }
  return [...DEFAULT_TABS];
}

function positiveInteger(value, fallback, label) {
  if (value == null || value === "" || value === true) return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function strictBoolean(value, fallback, label) {
  if (value == null || value === "") return fallback;
  if (value === true || value === "true" || value === "1") return true;
  if (value === false || value === "false" || value === "0") return false;
  throw new Error(`${label} must be a strict boolean`);
}

function channelDiscoveryOptionsFromArgs(args, defaults = {}) {
  const rawChannelUrl = String(args["channel-url"] || args.url || args._?.[0] || defaults.channelUrl || "").trim();
  const rawDiscoveryUrl = String(args["discovery-url"] || defaults.discoveryUrl || "").trim();
  const candidateOnly = args["candidate-only"] === true || args["candidate-only"] === "1" || args["candidate-only"] === "true";
  const expectedChannelId = String(args["expected-channel-id"] || defaults.expectedChannelId || "").trim();
  const expectedChannelHandle = String(args["expected-channel-handle"] || defaults.expectedChannelHandle || "").trim();
  if (!rawChannelUrl) throw new Error("Usage: npm run youtube:discover-channel -- --channel-url <YouTube channel URL>");
  if (candidateOnly && !/^UC[A-Za-z0-9_-]{22}$/u.test(expectedChannelId)) throw new Error("candidate discovery requires an exact immutable --expected-channel-id");
  if (candidateOnly && !/^@[A-Za-z0-9._-]{3,30}$/u.test(expectedChannelHandle)) throw new Error("candidate discovery requires an exact ASCII --expected-channel-handle");
  const channelUrl = normalizeChannelUrl(rawChannelUrl);
  const requestIntervalMs = positiveInteger(args["request-interval-ms"], defaults.requestIntervalMs ?? 2500, "--request-interval-ms");
  const fresh = args.fresh === true || args.fresh === "1" || args.fresh === "true";
  const forceRefresh = strictBoolean(args["force-refresh"], defaults.forceRefresh ?? fresh, "--force-refresh");
  if (candidateOnly && forceRefresh !== fresh) {
    throw new Error("candidate --force-refresh must exactly match the literal --fresh flag");
  }
  return {
    channelUrl,
    expectedChannelId,
    expectedChannelHandle,
    discoveryUrl: rawDiscoveryUrl ? normalizeDiscoveryUrl(rawDiscoveryUrl) : "",
    singerName: String(args["singer-name"] || args.name || defaults.singerName || "").trim(),
    outputDir: path.resolve(String(args["output-dir"] || defaults.outputDir || path.join("artifacts", "channel-discovery", safePathName(channelUrl)))),
    cacheDir: path.resolve(String(args["cache-dir"] || defaults.cacheDir || path.join(".local-cache", "youtube-channel-discovery"))),
    candidateManifestPath: String(args["candidate-manifest"] || defaults.candidateManifestPath || "").trim(),
    keywords: keywordList(args.keyword || args.keywords || defaults.keywords),
    tabs: candidateOnly ? candidateInitialTabs(args.tab || args.tabs || defaults.tabs) : tabList(args.tab || args.tabs || defaults.tabs),
    maxChannelPages: positiveInteger(args["max-channel-pages"], defaults.maxChannelPages ?? 3, "--max-channel-pages"),
    maxCandidates: positiveInteger(args["max-candidates"] || args["max-videos"], defaults.maxCandidates ?? 100, "--max-candidates"),
    maxInspect: positiveInteger(args["max-inspect"], defaults.maxInspect ?? 20, "--max-inspect"),
    requestIntervalMs,
    requestTimeoutMs: positiveInteger(args["request-timeout-ms"], defaults.requestTimeoutMs ?? Number(process.env.YOUTUBE_DISCOVERY_REQUEST_TIMEOUT_MS || 15000), "--request-timeout-ms"),
    requestJitterMs: positiveInteger(args["request-jitter-ms"], defaults.requestJitterMs ?? 1000, "--request-jitter-ms"),
    inspectShardIndex: positiveInteger(args["inspect-shard-index"], defaults.inspectShardIndex ?? 0, "--inspect-shard-index"),
    inspectShardCount: positiveInteger(args["inspect-shard-count"], defaults.inspectShardCount ?? 1, "--inspect-shard-count"),
    sourceCommit: String(args["source-commit"] || defaults.sourceCommit || "").trim(),
    channelSlug: String(args["channel-slug"] || defaults.channelSlug || "").trim(),
    forceRefresh,
    fresh,
    candidateOnly,
  };
}

function loadCandidateManifest(filePath) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) throw new Error(`candidate manifest not found: ${resolvedPath}`);
  const text = fs.readFileSync(resolvedPath, "utf8").trim();
  const records = text
    ? (text.startsWith("[") ? JSON.parse(text) : text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line)))
    : [];
  const manifestPath = path.join(path.dirname(resolvedPath), "manifest.json");
  const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : {};
  return {
    manifest,
    records: records.map((record) => ({
      videoId: record.videoId || record.youtubeVideoId || "",
      title: record.title || record.videoTitle || "",
      channelUrl: record.channelUrl || "",
      channelId: record.channelId || "",
      observedChannelId: record.observedChannelId || "",
      observedChannelHandle: record.observedChannelHandle || "",
      observedChannelUrl: record.observedChannelUrl || "",
      observedChannelSourceUrl: record.observedChannelSourceUrl || "",
      observedChannelResponseUrl: record.observedChannelResponseUrl || "",
      channelName: record.channelName || "",
      thumbnailUrl: record.thumbnailUrl || "",
      publishedTimestamp: record.publishedTimestamp ?? record.publishedAtTimestampMs ?? null,
      publishedText: record.publishedText || record.publishedAtOriginalText || "",
      durationText: record.durationText || "",
      matchedKeywords: record.matchedKeywords || record.keywords || [],
      discoverySourceUrl: record.discoverySourceUrl || record.sourceUrl || "",
    })),
  };
}
async function runChannelDiscovery(options, deps) {
  const startedAt = new Date();
  const normalizedChannelUrl = normalizeChannelUrl(options.channelUrl);
  const candidateInput = options.candidateManifestPath ? loadCandidateManifest(options.candidateManifestPath) : null;
  const pageUrls = candidateInput?.manifest?.pageUrls?.length
    ? candidateInput.manifest.pageUrls
    : (options.discoveryUrl ? [options.discoveryUrl] : channelTabUrls(normalizedChannelUrl, options.tabs));
  const checkpointPath = path.join(options.outputDir, "checkpoint.json");
  const checkpoint = options.fresh ? emptyCheckpoint() : loadCheckpoint(checkpointPath);
  const candidatesByVideoId = new Map();
  const pageSummaries = [];
  // Evidence is deliberately inside the unique output root.  It is never a
  // cache entry and is copied into the candidate artifact before cleanup.
  const pageEvidenceDir = path.join(options.outputDir, "pages");

  if (candidateInput) {
    for (const item of candidateInput.records) {
      mergeDiscoveryCandidate(candidatesByVideoId, item, {
        channelUrl: normalizedChannelUrl,
        discoverySourceUrl: item.discoverySourceUrl || candidateInput.manifest.discoveryUrl || options.discoveryUrl,
        singerName: options.singerName,
        keywords: options.keywords,
        fetchedAt: startedAt.toISOString(),
      });
    }
    pageSummaries.push(...(candidateInput.manifest.pageSummaries || []));
  } else {
    for (const pageUrl of pageUrls) {
      const pageResult = await fetchChannelPageWithContinuations(pageUrl, { ...options, pageEvidenceDir, candidateEvidenceNowMs: startedAt.getTime() }, deps, pageSummaries.length);
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
  }

  const observedPages = validateObservedPageSummaries(pageSummaries, options);

  const candidates = [...candidatesByVideoId.values()]
    .sort(candidateSort)
    .slice(0, options.maxCandidates || candidatesByVideoId.size);
  const observedChannelIdentity = validateObservedChannelIdentity(candidates, options, observedPages);
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
  // One terminal state is deliberately shared by the source manifest and final
  // checkpoint.  Candidate artifacts must never claim a completed source while
  // their resumable checkpoint says something else.
  const complete = options.candidateOnly
    ? candidateInitialPagesComplete(pageSummaries, options.maxChannelPages)
    : pageSummaries.length > 0 && pageSummaries.at(-1)?.reachedEnd === true;
  const partial = !complete;
  const pageEvidenceFiles = options.candidateOnly ? candidatePageEvidenceFiles(pageSummaries) : [];
  const manifest = {
    schemaVersion: 1,
    kind: options.candidateOnly ? "channel-discovery-source-manifest" : "youtube-channel-discovery",
    sourceSystem: SOURCE_SYSTEM,
    generatedAt,
    sourceCommit: options.sourceCommit || "",
    channelId: observedChannelIdentity.channelId,
    channelHandle: observedChannelIdentity.channelHandle,
    channelSlug: options.channelSlug || "",
    channelUrl: normalizedChannelUrl,
    forceRefresh: options.forceRefresh === true,
    expectedChannelId: observedChannelIdentity.expectedChannelId,
    expectedChannelHandle: observedChannelIdentity.expectedChannelHandle,
    expectedChannelUrl: observedChannelIdentity.expectedChannelUrl,
    observedChannelId: observedChannelIdentity.channelId,
    observedChannelHandle: observedChannelIdentity.channelHandle,
    observedChannelUrl: observedChannelIdentity.channelUrl,
    observedChannelSourceUrls: observedChannelIdentity.sourceUrls,
    observedChannelResponseUrls: observedChannelIdentity.responseUrls,
    discoveryUrl: options.discoveryUrl || "",
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
    candidateEvidenceNowMs: options.candidateOnly ? startedAt.getTime() : null,
    complete,
    partial,
    candidateManifestPath: options.candidateManifestPath || "",
    sourceReachedEnd: complete,
    candidateCount: rawVideos.length,
    // rawItemCount and pageCandidateCountSum are pre cross-tab de-duplication;
    // candidateCount/uniqueCandidateCount are the retained unique video IDs.
    rawItemCount: pageSummaries.reduce((total, page) => total + Number(page.rawItemCount || 0), 0),
    pageCandidateCountSum: pageSummaries.reduce((total, page) => total + Number(page.candidateCount || 0), 0),
    uniqueCandidateCount: rawVideos.length,
    inspectedInLatestRun: inspectedCount,
    usableVideoCount: details.length,
    occurrenceCount: occurrences.length,
    pageSummaries,
    pageEvidenceFiles,
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
  if (options.candidateOnly) writeNdjson(path.join(options.outputDir, "candidate-manifest.ndjson"), rawVideos);
  writeJson(path.join(options.outputDir, "video-details.json"), details);
  writeJson(path.join(options.outputDir, "occurrences.json"), occurrences);
  writeJson(path.join(options.outputDir, "audits.json"), audits);
  fs.writeFileSync(path.join(options.outputDir, "report.md"), reportMarkdown(manifest, rawVideos, details, occurrences), "utf8");
  const discoveryCheckpoint = {
    schemaVersion: 1,
    channelUrl: normalizedChannelUrl,
    expectedChannelId: observedChannelIdentity.expectedChannelId,
    expectedChannelHandle: observedChannelIdentity.expectedChannelHandle,
    expectedChannelUrl: observedChannelIdentity.expectedChannelUrl,
    observedChannelId: observedChannelIdentity.channelId,
    observedChannelHandle: observedChannelIdentity.channelHandle,
    observedChannelUrl: observedChannelIdentity.channelUrl,
    observedChannelSourceUrls: observedChannelIdentity.sourceUrls,
    observedChannelResponseUrls: observedChannelIdentity.responseUrls,
    pageSummaries,
    sourceReachedEnd: complete,
    complete,
    partial,
    singerName: options.singerName,
    keywords: options.keywords,
    completedVideoIds: [...completed].sort(),
    candidateCount: rawVideos.length,
    detailCount: details.length,
    updatedAt: generatedAt,
    details,
    audits,
  };
  saveCheckpoint(checkpointPath, options.candidateOnly
    ? {
      schemaVersion: 1,
      kind: "channel-discovery-candidate-checkpoint",
      sourceCommit: options.sourceCommit || "",
      channelId: observedChannelIdentity.channelId,
      channelHandle: observedChannelIdentity.channelHandle,
      channelSlug: options.channelSlug || "",
      channelUrl: normalizedChannelUrl,
      expectedChannelId: observedChannelIdentity.expectedChannelId,
      expectedChannelHandle: observedChannelIdentity.expectedChannelHandle,
      expectedChannelUrl: observedChannelIdentity.expectedChannelUrl,
      forceRefresh: options.forceRefresh === true,
      complete,
      partial,
      observedChannelId: observedChannelIdentity.channelId,
      observedChannelHandle: observedChannelIdentity.channelHandle,
      observedChannelUrl: observedChannelIdentity.channelUrl,
      observedChannelSourceUrls: observedChannelIdentity.sourceUrls,
      observedChannelResponseUrls: observedChannelIdentity.responseUrls,
      candidateCount: rawVideos.length,
      discoveryCheckpoint,
    }
    : discoveryCheckpoint);

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

async function fetchChannelPageWithContinuations(pageUrl, options, deps, pageIndex = 0) {
  const items = [];
  const seenContinuationTokens = new Set();
  const continuationEvidence = [];
  let pageCount = 0;
  let continuation = "";
  let tokenChainSha256 = "";
  let apiKey = "";
  let clientVersion = "";

  const response = await deps.client.getText(pageUrl);
  if (!response || Number(response.status) !== 200) throw new Error(`channel discovery initial page requires HTTP 200: ${pageUrl}`);
  if (typeof response.body !== "string") throw new Error(`channel discovery initial page body is missing: ${pageUrl}`);
  const rawBody = Buffer.from(response.body, "utf8");
  const tab = channelTabFromPageUrl(pageUrl);
  const evidencePath = options.candidateOnly ? writePageEvidence(options.pageEvidenceDir, pageIndex, tab, rawBody) : "";
  pageCount += 1;
  const page = parseYouTubePage(response.body);
  const identityRequired = options.candidateOnly || Boolean(options.expectedChannelId || options.expectedChannelHandle);
  let observedChannel;
  try {
    observedChannel = observedChannelIdentityFromPage(page.initialData, response.url || (options.candidateOnly ? "" : pageUrl), pageUrl);
  } catch (error) {
    if (identityRequired) throw error;
    observedChannel = { channelId: "", channelHandle: "", channelUrl: "", sourceUrl: pageUrl, responseUrl: "" };
  }
  apiKey = page.apiKey;
  clientVersion = page.clientVersion || DEFAULT_CLIENT_VERSION;
  const initialEvidence = {
    kind: "initial-html",
    path: evidencePath,
    sha256: options.candidateOnly ? crypto.createHash("sha256").update(rawBody).digest("hex") : "",
    bytes: rawBody.byteLength,
    pageIndex,
    tab,
    round: 0,
    apiPath: "",
  };
  const initialItems = candidateItemsFromPage(page.initialData, deps.extractSearchItems, options, pageUrl, observedChannel, initialEvidence);
  items.push(...initialItems);
  const continuationApiPath = continuationApiPathForPage(pageUrl);
  continuation = findBrowseContinuation(page.initialData, continuationApiPath);

  if (options.candidateOnly && continuation && !apiKey) {
    throw new Error(`candidate continuation requires an API key: tab=${tab}`);
  }
  while (continuation && apiKey && pageCount < options.maxChannelPages) {
    if (seenContinuationTokens.has(continuation)) {
      throw new Error(`candidate continuation token loop: tab=${tab}`);
    }
    seenContinuationTokens.add(continuation);
    const requestTokenSha256 = crypto.createHash("sha256").update(continuation, "utf8").digest("hex");
    const previousTokenChainSha256 = tokenChainSha256;
    tokenChainSha256 = crypto.createHash("sha256").update(`${tokenChainSha256}\n${requestTokenSha256}`, "utf8").digest("hex");
    await maybeDelay(options.requestIntervalMs + randomJitterMs(options.requestJitterMs));
    const continuationResult = await fetchBrowseContinuation({
      apiKey,
      clientVersion,
      continuation,
      apiPath: continuationApiPath,
      fetchImpl: deps.fetchImpl || fetch,
      requestIntervalMs: options.requestIntervalMs,
      requestTimeoutMs: options.requestTimeoutMs,
      userAgent: deps.userAgent,
      includeRawResponse: options.candidateOnly,
    });
    const continuationResponse = options.candidateOnly ? continuationResult.data : continuationResult;
    const continuationRawBody = options.candidateOnly ? continuationResult.rawBody : null;
    pageCount += 1;
    const round = pageCount - 1;
    const nextContinuation = findBrowseContinuation(continuationResponse, continuationApiPath);
    if (nextContinuation && seenContinuationTokens.has(nextContinuation)) {
      throw new Error(`candidate continuation token loop: tab=${tab} round=${round}`);
    }
    if (options.candidateOnly) {
      const continuationPath = writeContinuationEvidence(options.pageEvidenceDir, pageIndex, tab, round, continuationRawBody);
      const continuationSha256 = crypto.createHash("sha256").update(continuationRawBody).digest("hex");
      const ownerBoundItems = continuationCandidateItems(
        continuationResponse,
        deps.extractSearchItems,
        options,
        pageUrl,
        {
          kind: "youtubei-continuation",
          path: continuationPath,
          sha256: continuationSha256,
          bytes: continuationRawBody.byteLength,
          pageIndex,
          tab,
          round,
          apiPath: continuationApiPath,
          requestTokenSha256,
          previousTokenChainSha256,
          nextTokenSha256: nextContinuation ? crypto.createHash("sha256").update(nextContinuation, "utf8").digest("hex") : "",
          tokenChainSha256,
        },
        observedChannel,
      );
      items.push(...ownerBoundItems);
      const candidateEvidenceNowMs = Number(options.candidateEvidenceNowMs) || Date.now();
      const roundCandidates = filterDiscoveryCandidates(ownerBoundItems, options.keywords, candidateEvidenceNowMs);
      continuationEvidence.push({
        tab,
        round,
        apiPath: continuationApiPath,
        requestTokenSha256,
        nextTokenSha256: nextContinuation ? crypto.createHash("sha256").update(nextContinuation, "utf8").digest("hex") : "",
        tokenChainSha256,
        evidencePath: continuationPath,
        sha256: continuationSha256,
        bytes: continuationRawBody.byteLength,
        rawItemCount: ownerBoundItems.length,
        candidateCount: roundCandidates.length,
        videoIds: uniqueStrings(ownerBoundItems.map((item) => item.videoId)).sort(),
        ownerChannelIds: uniqueStrings(ownerBoundItems.map((item) => item.rendererOwnerChannelId)).sort(),
        ownerChannelHandles: uniqueStrings(ownerBoundItems.map((item) => item.rendererOwnerChannelHandle)).sort(),
        inheritedOwnerVideoIds: uniqueStrings(ownerBoundItems.filter((item) => item.rendererOwnerIdentityInherited).map((item) => item.videoId)).sort(),
      });
    } else {
      addCandidateItems(items, continuationResponse, deps.extractSearchItems, options, pageUrl, observedChannel);
    }
    continuation = nextContinuation;
  }

  const summary = {
    tab,
    pageIndex,
    pageUrl,
    status: response.status,
    pageCount,
    rawItemCount: items.length,
    candidateCount: 0,
    continuationRounds: Math.max(0, pageCount - 1),
    requiresContinuation: Boolean(continuation),
    reachedEnd: !continuation,
    continuationEvidence,
    fromCache: response.fromCache === true,
    bytes: rawBody.byteLength,
    rawSha256: options.candidateOnly ? crypto.createHash("sha256").update(rawBody).digest("hex") : "",
    evidencePath,
    inheritedInitialOwnerVideoIds: uniqueStrings(initialItems.filter((item) => item.rendererOwnerIdentityInherited).map((item) => item.videoId)).sort(),
    observedChannelId: observedChannel.channelId,
    observedChannelHandle: observedChannel.channelHandle,
    observedChannelUrl: observedChannel.channelUrl,
    observedChannelResponseUrl: observedChannel.responseUrl,
  };
  const candidateEvidenceNowMs = Number(options.candidateEvidenceNowMs) || Date.now();
  const filtered = filterDiscoveryCandidates(items, options.keywords, candidateEvidenceNowMs);
  summary.candidateCount = filtered.length;
  validateObservedPageSummary(summary, options);
  return {
    items: filtered,
    summary,
  };
}

function writePageEvidence(pageEvidenceDir, pageIndex, tab, rawBody) {
  const relativePath = `pages/${String(pageIndex).padStart(2, "0")}-${safePathName(tab)}.html`;
  if (!pageEvidenceDir || !Buffer.isBuffer(rawBody) || !/^pages\/\d{2}-(streams|videos)\.html$/u.test(relativePath)) {
    throw new Error("invalid candidate page evidence path");
  }
  const outputRoot = path.resolve(pageEvidenceDir, "..");
  const destination = path.resolve(outputRoot, relativePath);
  if (!destination.startsWith(`${outputRoot}${path.sep}`)) throw new Error("candidate page evidence path escaped output root");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const parent = fs.lstatSync(path.dirname(destination));
  if (parent.isSymbolicLink()) throw new Error("candidate page evidence directory must not be a symlink");
  fs.writeFileSync(destination, rawBody, { flag: "wx" });
  return relativePath;
}

function writeContinuationEvidence(pageEvidenceDir, pageIndex, tab, round, rawBody) {
  const relativePath = `pages/${String(pageIndex).padStart(2, "0")}-${safePathName(tab)}-continuation-${String(round).padStart(3, "0")}.json`;
  if (
    !pageEvidenceDir ||
    !Buffer.isBuffer(rawBody) ||
    !/^pages\/\d{2}-(streams|videos)-continuation-\d{3}\.json$/u.test(relativePath) ||
    !Number.isSafeInteger(round) ||
    round < 1
  ) {
    throw new Error("invalid candidate continuation evidence path");
  }
  const outputRoot = path.resolve(pageEvidenceDir, "..");
  const destination = path.resolve(outputRoot, relativePath);
  if (!destination.startsWith(`${outputRoot}${path.sep}`)) throw new Error("candidate continuation evidence path escaped output root");
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const parent = fs.lstatSync(path.dirname(destination));
  if (parent.isSymbolicLink()) throw new Error("candidate continuation evidence directory must not be a symlink");
  fs.writeFileSync(destination, rawBody, { flag: "wx" });
  return relativePath;
}

function continuationApiPathForPage(pageUrl) {
  try {
    return new URL(pageUrl).pathname === "/results" ? "/youtubei/v1/search" : "/youtubei/v1/browse";
  } catch {
    return "/youtubei/v1/browse";
  }
}

function continuationTokenSha256(token) {
  return token ? crypto.createHash("sha256").update(token, "utf8").digest("hex") : "";
}

function candidateItemsFromPage(data, extractSearchItems, options, pageUrl, observedChannel, evidence = {}) {
  const items = [];
  addCandidateItems(items, data, extractSearchItems, options, pageUrl, observedChannel, evidence);
  if (options.candidateOnly) {
    const expected = expectedChannelIdentity(options);
    const ownerIdentities = continuationOwnerIdentitiesByVideoId(data);
    for (const item of items) {
      const owner = ownerIdentities.get(String(item.videoId || ""));
      if (!owner) {
        throw new Error(`candidate initial renderer missing immutable owner identity: ${item.videoId || "unknown"}`);
      }
      const ownerIdentityInherited = owner.identityMissing === true;
      if (ownerIdentityInherited && !verifiedInitialOwnerFallback(options, pageUrl, evidence, observedChannel)) {
        throw new Error(`candidate initial renderer missing immutable owner identity without verified channel page provenance: ${item.videoId || "unknown"}`);
      }
      const ownerChannelId = ownerIdentityInherited ? expected.expectedChannelId : owner.channelId;
      const ownerChannelHandle = ownerIdentityInherited ? expected.expectedChannelHandle : owner.channelHandle;
      if (ownerChannelId !== expected.expectedChannelId) {
        throw new Error(`candidate initial renderer owner channel mismatch: ${item.videoId || "unknown"}`);
      }
      if (ownerChannelHandle && ownerChannelHandle !== expected.expectedChannelHandle) {
        throw new Error(`candidate initial renderer owner handle mismatch: ${item.videoId || "unknown"}`);
      }
      item.rendererChannelId = ownerChannelId;
      item.rendererOwnerChannelId = ownerChannelId;
      item.rendererOwnerChannelHandle = ownerChannelHandle;
      item.rendererOwnerIdentityInherited = ownerIdentityInherited;
    }
  }
  return items;
}

function verifiedInitialOwnerFallback(options, pageUrl, evidence, observedChannel) {
  const expected = expectedChannelIdentity(options);
  const pageResponseUrl = canonicalChannelResponseUrl(pageUrl);
  const pageTab = channelTabFromPageUrl(pageUrl);
  const pageIndex = Number(evidence?.pageIndex);
  return Boolean(
    options.candidateOnly &&
    /^UC[A-Za-z0-9_-]{22}$/u.test(expected.expectedChannelId) &&
    /^@[a-z0-9._-]{3,30}$/u.test(expected.expectedChannelHandle) &&
    expected.expectedChannelUrl &&
    pageResponseUrl &&
    pageTab &&
    canonicalChannelIdentityUrl(pageResponseUrl) === expected.expectedChannelUrl &&
    String(observedChannel?.channelId || "").trim() === expected.expectedChannelId &&
    observedChannel?.channelHandle === expected.expectedChannelHandle &&
    observedChannel?.channelUrl === expected.expectedChannelUrl &&
    canonicalChannelResponseUrl(observedChannel?.responseUrl) === pageResponseUrl &&
    evidence?.kind === "initial-html" &&
    evidence?.apiPath === "" &&
    Number(evidence?.round) === 0 &&
    evidence?.tab === pageTab &&
    Number.isSafeInteger(pageIndex) &&
    pageIndex >= 0 &&
    evidence?.path === `pages/${String(pageIndex).padStart(2, "0")}-${pageTab}.html` &&
    /^[a-f0-9]{64}$/u.test(String(evidence?.sha256 || "")) &&
    Number.isSafeInteger(evidence?.bytes) &&
    evidence.bytes >= 0
  );
}

function verifiedContinuationOwnerFallback(options, pageUrl, evidence, observedChannel) {
  const expected = expectedChannelIdentity(options);
  const pageResponseUrl = canonicalChannelResponseUrl(pageUrl);
  const pageTab = channelTabFromPageUrl(pageUrl);
  const pageIndex = Number(evidence?.pageIndex);
  const round = Number(evidence?.round);
  const requestTokenSha256 = String(evidence?.requestTokenSha256 || "");
  const previousTokenChainSha256 = String(evidence?.previousTokenChainSha256 || "");
  const expectedTokenChainSha256 = crypto
    .createHash("sha256")
    .update(`${previousTokenChainSha256}\n${requestTokenSha256}`, "utf8")
    .digest("hex");
  return Boolean(
    options.candidateOnly &&
    /^UC[A-Za-z0-9_-]{22}$/u.test(expected.expectedChannelId) &&
    /^@[a-z0-9._-]{3,30}$/u.test(expected.expectedChannelHandle) &&
    expected.expectedChannelUrl &&
    pageResponseUrl &&
    pageTab &&
    canonicalChannelIdentityUrl(pageResponseUrl) === expected.expectedChannelUrl &&
    String(observedChannel?.channelId || "").trim() === expected.expectedChannelId &&
    observedChannel?.channelHandle === expected.expectedChannelHandle &&
    observedChannel?.channelUrl === expected.expectedChannelUrl &&
    canonicalChannelResponseUrl(observedChannel?.responseUrl) === pageResponseUrl &&
    evidence?.kind === "youtubei-continuation" &&
    evidence?.apiPath === "/youtubei/v1/browse" &&
    evidence?.tab === pageTab &&
    Number.isSafeInteger(pageIndex) &&
    pageIndex >= 0 &&
    Number.isSafeInteger(round) &&
    round >= 1 &&
    evidence?.path === `pages/${String(pageIndex).padStart(2, "0")}-${pageTab}-continuation-${String(round).padStart(3, "0")}.json` &&
    /^[a-f0-9]{64}$/u.test(String(evidence?.sha256 || "")) &&
    Number.isSafeInteger(evidence?.bytes) &&
    evidence.bytes >= 0 &&
    /^[a-f0-9]{64}$/u.test(requestTokenSha256) &&
    (round === 1 ? previousTokenChainSha256 === "" : /^[a-f0-9]{64}$/u.test(previousTokenChainSha256)) &&
    evidence?.tokenChainSha256 === expectedTokenChainSha256
  );
}

function continuationCandidateItems(data, extractSearchItems, options, pageUrl, evidence, observedChannel) {
  const expected = expectedChannelIdentity(options);
  const ownerIdentities = continuationOwnerIdentitiesByVideoId(data);
  const extracted = extractSearchItems(data);
  return extracted.map((item) => {
    const owner = ownerIdentities.get(String(item.videoId || ""));
    if (!owner) {
      throw new Error(`candidate continuation renderer missing immutable owner identity: ${item.videoId || "unknown"}`);
    }
    const ownerIdentityInherited = owner.identityMissing === true;
    if (ownerIdentityInherited && !verifiedContinuationOwnerFallback(options, pageUrl, evidence, observedChannel)) {
      throw new Error(`candidate continuation renderer missing immutable owner identity without verified continuation provenance: ${item.videoId || "unknown"}`);
    }
    const ownerChannelId = ownerIdentityInherited ? expected.expectedChannelId : owner.channelId;
    const ownerChannelHandle = ownerIdentityInherited ? expected.expectedChannelHandle : owner.channelHandle;
    if (ownerChannelId !== expected.expectedChannelId) {
      throw new Error(`candidate continuation renderer owner channel mismatch: ${item.videoId || "unknown"}`);
    }
    if (ownerChannelHandle && ownerChannelHandle !== expected.expectedChannelHandle) {
      throw new Error(`candidate continuation renderer owner handle mismatch: ${item.videoId || "unknown"}`);
    }
    const responseUrl = `https://www.youtube.com${evidence.apiPath}`;
    return {
      ...item,
      channelId: ownerChannelId,
      channelHandle: expected.expectedChannelHandle,
      observedChannelId: ownerChannelId,
      observedChannelHandle: ownerChannelHandle || expected.expectedChannelHandle,
      observedChannelUrl: expected.expectedChannelUrl,
      observedChannelSourceUrl: pageUrl,
      observedChannelResponseUrl: responseUrl,
      rendererChannelId: ownerChannelId,
      rendererOwnerChannelId: ownerChannelId,
      rendererOwnerChannelHandle: ownerChannelHandle,
      rendererOwnerIdentityInherited: ownerIdentityInherited,
      discoverySourceUrl: pageUrl,
      channelUrl: expected.expectedChannelUrl,
      singerName: options.singerName || "",
      discoveryEvidenceKind: evidence.kind,
      discoveryEvidencePath: evidence.path,
      discoveryEvidenceSha256: evidence.sha256,
      discoveryEvidenceBytes: evidence.bytes,
      continuationRound: evidence.round,
      continuationApiPath: evidence.apiPath,
      continuationRequestTokenSha256: evidence.requestTokenSha256,
      continuationTokenChainSha256: evidence.tokenChainSha256,
    };
  });
}

function continuationOwnerIdentitiesByVideoId(data) {
  const result = new Map();
  for (const node of walkDicts(data)) {
    for (const [key, renderer] of [
      ["videoRenderer", node.videoRenderer],
      ["reelItemRenderer", node.reelItemRenderer],
      ["shortsLockupViewModel", node.shortsLockupViewModel],
      ["lockupViewModel", node.lockupViewModel],
    ]) {
      if (!renderer || typeof renderer !== "object") continue;
      const videoId = key === "lockupViewModel"
        ? String(renderer.contentId || "")
        : String(renderer.videoId || renderer.contentId || "");
      if (!/^[A-Za-z0-9_-]{11}$/u.test(videoId)) continue;
      const endpoints = [];
      const ownerSources = [
        renderer.ownerText,
        renderer.longBylineText,
        renderer.shortBylineText,
        renderer.metadata?.lockupMetadataViewModel?.metadata?.contentMetadataViewModel?.metadataRows,
      ];
      for (const source of ownerSources) {
        for (const ownerNode of walkDicts(source)) {
          const endpoint = ownerNode.navigationEndpoint?.browseEndpoint || ownerNode.browseEndpoint;
          if (endpoint?.browseId || endpoint?.canonicalBaseUrl) endpoints.push(endpoint);
        }
      }
      const channelIds = uniqueStrings(endpoints.map((endpoint) => endpoint.browseId));
      const channelHandles = uniqueStrings(endpoints.map((endpoint) => {
        const normalized = normalizeChannelHandle(endpoint.canonicalBaseUrl || "");
        return normalized ? `@${normalized}` : "";
      }));
      const identityMissing = channelIds.length === 0 && channelHandles.length === 0;
      if (!identityMissing && (channelIds.length !== 1 || channelHandles.length > 1)) {
        throw new Error(`candidate renderer has ambiguous or missing owner identity: ${videoId}`);
      }
      const identity = { channelId: channelIds[0] || "", channelHandle: channelHandles[0] || "", identityMissing };
      const existing = result.get(videoId);
      if (
        existing &&
        !existing.identityMissing &&
        !identity.identityMissing &&
        (existing.channelId !== identity.channelId || (existing.channelHandle && identity.channelHandle && existing.channelHandle !== identity.channelHandle))
      ) {
        throw new Error(`candidate renderer owner identity is ambiguous: ${videoId}`);
      }
      if (!existing || (existing.identityMissing && !identity.identityMissing)) result.set(videoId, identity);
    }
  }
  return result;
}

// Used by the workflow validator against the retained public response body.
// It deliberately repeats the live initial-page parser and filter rather than
// trusting the self-attested summary counts.
function recomputeCandidatePageEvidence(rawBody, summary, options, extractSearchItems, continuationBodies = new Map()) {
  const result = recomputeCandidatePageEvidenceWithItems(rawBody, summary, options, extractSearchItems, continuationBodies);
  return { rawItemCount: result.rawItemCount, candidateCount: result.candidateCount };
}

function recomputeCandidatePageEvidenceWithItems(rawBody, summary, options, extractSearchItems, continuationBodies = new Map()) {
  const bytes = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, "utf8");
  const hash = crypto.createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== summary.bytes || hash !== summary.rawSha256 || Number(summary.status) !== 200) {
    throw new Error("candidate page evidence bytes/hash/status mismatch");
  }
  const page = parseYouTubePage(bytes.toString("utf8"));
  const observed = observedChannelIdentityFromPage(page.initialData, summary.observedChannelResponseUrl, summary.pageUrl);
  const continuationApiPath = continuationApiPathForPage(summary.pageUrl);
  const continuationEvidence = summary.continuationEvidence || [];
  const initialNextToken = findBrowseContinuation(page.initialData, continuationApiPath);
  if (continuationEvidence.length > 0) {
    if (!initialNextToken || continuationTokenSha256(initialNextToken) !== continuationEvidence[0].requestTokenSha256) {
      throw new Error("candidate initial evidence continuation token does not bind round 1");
    }
  }
  const initialEvidence = {
    kind: "initial-html",
    path: summary.evidencePath,
    sha256: summary.rawSha256,
    bytes: summary.bytes,
    pageIndex: summary.pageIndex,
    tab: summary.tab,
    round: 0,
    apiPath: "",
  };
  const items = candidateItemsFromPage(page.initialData, extractSearchItems, options, summary.pageUrl, observed, initialEvidence);
  const replayInheritedInitialOwnerVideoIds = uniqueStrings(items.filter((item) => item.rendererOwnerIdentityInherited).map((item) => item.videoId)).sort();
  if (JSON.stringify(replayInheritedInitialOwnerVideoIds) !== JSON.stringify(summary.inheritedInitialOwnerVideoIds)) {
    throw new Error("candidate initial evidence owner inheritance mismatch");
  }
  let terminalRawNextToken = initialNextToken;
  for (let continuationIndex = 0; continuationIndex < continuationEvidence.length; continuationIndex += 1) {
    const continuation = continuationEvidence[continuationIndex];
    const continuationBody = continuationBodies instanceof Map
      ? continuationBodies.get(continuation.evidencePath)
      : continuationBodies?.[continuation.evidencePath];
    if (continuationBody == null) throw new Error(`candidate continuation evidence body is missing: ${continuation.evidencePath}`);
    const continuationBytes = Buffer.isBuffer(continuationBody) ? continuationBody : Buffer.from(continuationBody, "utf8");
    if (
      continuationBytes.byteLength !== continuation.bytes ||
      crypto.createHash("sha256").update(continuationBytes).digest("hex") !== continuation.sha256
    ) throw new Error(`candidate continuation evidence bytes/hash mismatch: ${continuation.evidencePath}`);
    let continuationData;
    try {
      continuationData = JSON.parse(continuationBytes.toString("utf8"));
    } catch {
      throw new Error(`candidate continuation evidence is not JSON: ${continuation.evidencePath}`);
    }
    const parsedNextToken = findBrowseContinuation(continuationData, continuation.apiPath);
    const parsedNextTokenSha256 = continuationTokenSha256(parsedNextToken);
    if (parsedNextTokenSha256 !== continuation.nextTokenSha256) {
      throw new Error(`candidate continuation raw next token mismatch: ${continuation.evidencePath}`);
    }
    const nextEvidence = continuationEvidence[continuationIndex + 1];
    if (nextEvidence && parsedNextTokenSha256 !== nextEvidence.requestTokenSha256) {
      throw new Error(`candidate continuation raw token does not bind the next round: ${continuation.evidencePath}`);
    }
    terminalRawNextToken = parsedNextToken;
    const replayItems = continuationCandidateItems(continuationData, extractSearchItems, options, summary.pageUrl, {
      kind: "youtubei-continuation",
      path: continuation.evidencePath,
      sha256: continuation.sha256,
      bytes: continuation.bytes,
      pageIndex: summary.pageIndex,
      tab: continuation.tab,
      round: continuation.round,
      apiPath: continuation.apiPath,
      requestTokenSha256: continuation.requestTokenSha256,
      previousTokenChainSha256: continuationIndex > 0 ? continuationEvidence[continuationIndex - 1].tokenChainSha256 : "",
      tokenChainSha256: continuation.tokenChainSha256,
    }, observed);
    const replayVideoIds = uniqueStrings(replayItems.map((item) => item.videoId)).sort();
    const replayOwnerIds = uniqueStrings(replayItems.map((item) => item.rendererOwnerChannelId)).sort();
    const replayOwnerHandles = uniqueStrings(replayItems.map((item) => item.rendererOwnerChannelHandle)).sort();
    const replayInheritedOwnerVideoIds = uniqueStrings(replayItems.filter((item) => item.rendererOwnerIdentityInherited).map((item) => item.videoId)).sort();
    const replayCandidateCount = filterDiscoveryCandidates(replayItems, options.keywords, Number(options.candidateEvidenceNowMs) || Date.now()).length;
    if (
      replayItems.length !== continuation.rawItemCount ||
      replayCandidateCount !== continuation.candidateCount ||
      JSON.stringify(replayVideoIds) !== JSON.stringify(continuation.videoIds) ||
      JSON.stringify(replayOwnerIds) !== JSON.stringify(continuation.ownerChannelIds) ||
      JSON.stringify(replayOwnerHandles) !== JSON.stringify(continuation.ownerChannelHandles) ||
      JSON.stringify(replayInheritedOwnerVideoIds) !== JSON.stringify(continuation.inheritedOwnerVideoIds)
    ) throw new Error(`candidate continuation evidence renderer binding mismatch: ${continuation.evidencePath}`);
    items.push(...replayItems);
  }
  const rawRequiresContinuation = Boolean(terminalRawNextToken);
  if (
    Boolean(summary.reachedEnd) === rawRequiresContinuation ||
    Boolean(summary.requiresContinuation) !== rawRequiresContinuation
  ) {
    throw new Error("candidate raw continuation terminal state mismatch");
  }
  if (
    rawRequiresContinuation &&
    Number(summary.pageCount) < Number(options.maxChannelPages)
  ) {
    throw new Error("candidate raw continuation stopped before the configured page cap");
  }
  const candidateCount = filterDiscoveryCandidates(items, options.keywords, Number(options.candidateEvidenceNowMs) || Date.now()).length;
  if (items.length !== summary.rawItemCount || candidateCount !== summary.candidateCount) {
    throw new Error("candidate page evidence count mismatch");
  }
  return { rawItemCount: items.length, candidateCount, items };
}

// Offline reviewers inject the same production parser interface from a pinned
// source checkout. Counts are derived from retained HTML, never from the
// artifact's self-attested summaries or checksum manifest.
function recomputeCandidateArtifactEvidence(rawPages, source, options, extractSearchItems) {
  if (!Array.isArray(rawPages) || !Array.isArray(source?.pageSummaries)) throw new Error("candidate artifact pages are required");
  const evidenceFiles = Array.isArray(source.pageEvidenceFiles)
    ? source.pageEvidenceFiles
    : source.pageSummaries.map((summary) => ({ path: summary.evidencePath }));
  if (rawPages.length !== evidenceFiles.length) throw new Error("candidate artifact page count mismatch");
  const evidenceBodies = new Map(evidenceFiles.map((file, index) => [file.path, rawPages[index]]));
  const candidatesByVideoId = new Map();
  let rawItemCount = 0;
  let pageCandidateCountSum = 0;
  for (let index = 0; index < source.pageSummaries.length; index += 1) {
    const summary = source.pageSummaries[index];
    const rawBody = evidenceBodies.get(summary.evidencePath);
    const totals = recomputeCandidatePageEvidenceWithItems(rawBody, summary, options, extractSearchItems, evidenceBodies);
    rawItemCount += totals.rawItemCount;
    pageCandidateCountSum += totals.candidateCount;
    const filtered = filterDiscoveryCandidates(
      totals.items,
      options.keywords,
      Number(options.candidateEvidenceNowMs) || Date.now(),
    );
    for (const item of filtered) {
      mergeDiscoveryCandidate(candidatesByVideoId, item, {
        channelUrl: normalizeChannelUrl(options.channelUrl),
        discoverySourceUrl: summary.pageUrl,
        singerName: options.singerName || "",
        keywords: options.keywords,
        fetchedAt: source.generatedAt || "",
      });
    }
  }
  const candidates = [...candidatesByVideoId.values()].sort(candidateSort);
  validateObservedChannelIdentity(candidates, options, validateObservedPageSummaries(source.pageSummaries, options));
  return {
    rawItemCount,
    pageCandidateCountSum,
    uniqueCandidateCount: candidates.length,
    candidateCount: candidates.length,
    rawVideos: candidates.map((candidate) => rawVideoCandidate(candidate, options.singerName || "")),
  };
}

function addCandidateItems(target, data, extractSearchItems, options, pageUrl, observedChannel = observedChannelIdentityFromPage(data, "", pageUrl), evidence = {}) {
  const channel = channelMetadataFromInitialData(data);
  const extracted = extractSearchItems(data).map((item) => ({
    ...item,
    channelName: item.channelName || channel.title || options.singerName || "",
    channelId: observedChannel.channelId,
    channelHandle: observedChannel.channelHandle,
    observedChannelId: observedChannel.channelId,
    observedChannelHandle: observedChannel.channelHandle,
    observedChannelUrl: observedChannel.channelUrl,
    observedChannelSourceUrl: pageUrl,
    observedChannelResponseUrl: observedChannel.responseUrl,
    rendererChannelId: item.channelId || "",
    discoverySourceUrl: pageUrl,
    channelUrl: normalizeChannelUrl(options.channelUrl),
    singerName: options.singerName || "",
    discoveryEvidenceKind: evidence.kind || "initial-html",
    discoveryEvidencePath: evidence.path || "",
    discoveryEvidenceSha256: evidence.sha256 || "",
    discoveryEvidenceBytes: Number(evidence.bytes) || 0,
    continuationRound: Number(evidence.round) || 0,
    continuationApiPath: evidence.apiPath || "",
    continuationRequestTokenSha256: evidence.requestTokenSha256 || "",
    continuationTokenChainSha256: evidence.tokenChainSha256 || "",
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
      handleUrl: metadata.vanityChannelUrl || (metadata.ownerUrls || []).find((url) => /youtube\.com\/@/iu.test(url)) || "",
      thumbnailUrl: bestSourceUrl(metadata.avatar),
    };
  }
  return { title: "", channelId: "", channelUrl: "", handleUrl: "", thumbnailUrl: "" };
}

function observedChannelIdentityFromPage(data, responseUrl = "", pageUrl = "") {
  const metadata = channelMetadataFromInitialData(data);
  const metadataValue = metadata.handleUrl || metadata.channelUrl;
  const metadataUrl = canonicalChannelMetadataIdentityUrl(metadataValue);
  if (metadataValue && !metadataUrl) throw new Error("invalid observed channel metadata URL");
  const canonicalResponseUrl = canonicalChannelResponseUrl(responseUrl);
  if (!canonicalResponseUrl) throw new Error("invalid or missing observed channel response URL");
  const responseIdentityUrl = canonicalChannelIdentityUrl(canonicalResponseUrl);
  if (metadataUrl && responseIdentityUrl && metadataUrl !== responseIdentityUrl) {
    throw new Error(`observed channel redirect differs from page metadata: ${responseIdentityUrl} != ${metadataUrl}`);
  }
  const channelUrl = metadataUrl || responseIdentityUrl;
  return {
    channelId: String(metadata.channelId || "").trim(),
    channelHandle: channelHandleFromCanonicalUrl(channelUrl),
    channelUrl,
    sourceUrl: pageUrl,
    responseUrl: canonicalResponseUrl,
  };
}

async function fetchBrowseContinuation({
  apiKey,
  clientVersion,
  continuation,
  apiPath = "/youtubei/v1/browse",
  fetchImpl = fetch,
  requestIntervalMs = 0,
  requestTimeoutMs = 15000,
  userAgent = "",
  maxAttempts = 3,
  includeRawResponse = false,
}) {
  let lastError = null;
  const attempts = Math.max(1, Number(maxAttempts) || 1);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await maybeDelay(attempt === 1 ? requestIntervalMs : Math.max(250, requestIntervalMs) * attempt);
    let response = null;
    let timeoutHandle = null;
    const endpointPath = apiPath === "/youtubei/v1/search" ? "/youtubei/v1/search" : "/youtubei/v1/browse";
    const requestController = typeof AbortController === "function" ? new AbortController() : null;
    const timeoutMs = Math.max(1, Number(requestTimeoutMs) || 15000);
    try {
      if (requestController) timeoutHandle = setTimeout(() => requestController.abort(), timeoutMs);
      response = await fetchImpl(`https://www.youtube.com${endpointPath}?prettyPrint=false&key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: {
          "user-agent":
            userAgent ||
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
          "accept-language": "ja,en-US;q=0.8,en;q=0.6",
          "content-type": "application/json",
        },
        signal: requestController?.signal,
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
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
    if (response.ok) {
      try {
        let data;
        let rawText;
        if (typeof response.text === "function") {
          rawText = await response.text();
          data = JSON.parse(rawText);
        } else {
          data = await response.json();
          rawText = JSON.stringify(data);
        }
        if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("youtubei continuation JSON object is required");
        return includeRawResponse
          ? { data, rawBody: Buffer.from(rawText, "utf8"), apiPath: endpointPath }
          : data;
      } catch (error) {
        lastError = error;
        if (attempt === attempts) throw lastError;
        continue;
      }
    }
    const endpointName = apiPath === "/youtubei/v1/search" ? "search" : "browse";
    lastError = new Error(`youtubei ${endpointName} continuation HTTP ${response.status}`);
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

function findBrowseContinuation(data, apiPath = "/youtubei/v1/browse", excludedTokens = new Set()) {
  const expectedApiPath = apiPath === "/youtubei/v1/search" ? "/youtubei/v1/search" : "/youtubei/v1/browse";
  let genericToken = "";
  for (const item of walkDicts(data)) {
    const endpoint = item.continuationEndpoint;
    const token = endpoint?.continuationCommand?.token;
    const apiUrl = endpoint?.commandMetadata?.webCommandMetadata?.apiUrl || "";
    if (!token) continue;
    if (excludedTokens.has(token)) continue;
    if (apiUrl && apiUrl.includes(expectedApiPath)) return token;
    if (!apiUrl && !genericToken) genericToken = token;
  }
  for (const item of walkDicts(data)) {
    const endpoint = item.continuationItemRenderer?.continuationEndpoint;
    const token = endpoint?.continuationCommand?.token || item.continuationCommand?.token;
    const apiUrl = endpoint?.commandMetadata?.webCommandMetadata?.apiUrl || "";
    if (!token) continue;
    if (excludedTokens.has(token)) continue;
    if (apiUrl && apiUrl.includes(expectedApiPath)) return token;
    if (!apiUrl && !genericToken) genericToken = token;
  }
  return genericToken;
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
  const itemEvidenceRef = discoveryEvidenceRefFromItem(item);
  const candidate = {
    ...item,
    sourceSystem: SOURCE_SYSTEM,
    channelUrl: context.channelUrl,
    singerName: context.singerName || item.singerName || "",
    matchedKeywords: uniqueStrings([...(item.matchedKeywords || []), ...matchedDiscoveryKeywords(item.title, context.keywords)]),
    sourceUrls: uniqueStrings([...(item.sourceUrls || []), item.discoverySourceUrl || context.discoverySourceUrl]),
    discoverySourceUrls: uniqueStrings([...(item.discoverySourceUrls || []), item.discoverySourceUrl || context.discoverySourceUrl]),
    observedChannelSourceUrls: uniqueStrings([...(item.observedChannelSourceUrls || []), item.observedChannelSourceUrl || item.discoverySourceUrl || context.discoverySourceUrl]),
    observedChannelResponseUrls: uniqueStrings([...(item.observedChannelResponseUrls || []), item.observedChannelResponseUrl || ""]),
    discoveryEvidenceRefs: mergeDiscoveryEvidenceRefs(item.discoveryEvidenceRefs || [], itemEvidenceRef ? [itemEvidenceRef] : []),
    discoverySourceUrl: item.discoverySourceUrl || context.discoverySourceUrl,
    fetchedAt: context.fetchedAt,
    thumbnailUrl: item.thumbnailUrl || (item.videoId ? `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg` : ""),
  };
  const existing = target.get(candidate.videoId);
  if (!existing) {
    assertCandidateIdentityConsistency(candidate, candidate);
    target.set(candidate.videoId, candidate);
    return;
  }
  assertCandidateIdentityConsistency(existing, candidate);
  existing.matchedKeywords = uniqueStrings([...existing.matchedKeywords, ...candidate.matchedKeywords]);
  existing.keywords = uniqueStrings([...(existing.keywords || []), ...(candidate.keywords || [])]);
  existing.sourceGroups = uniqueStrings([...(existing.sourceGroups || []), ...(candidate.sourceGroups || [])]);
  existing.sourceUrls = uniqueStrings([...(existing.sourceUrls || []), ...(candidate.sourceUrls || [])]);
  existing.discoverySourceUrls = uniqueStrings([...(existing.discoverySourceUrls || []), ...(candidate.discoverySourceUrls || [])]);
  existing.observedChannelSourceUrls = uniqueStrings([...(existing.observedChannelSourceUrls || []), ...(candidate.observedChannelSourceUrls || [])]);
  existing.observedChannelResponseUrls = uniqueStrings([...(existing.observedChannelResponseUrls || []), ...(candidate.observedChannelResponseUrls || [])]);
  existing.discoveryEvidenceRefs = mergeDiscoveryEvidenceRefs(existing.discoveryEvidenceRefs || [], candidate.discoveryEvidenceRefs || []);
  for (const key of ["observedChannelId", "observedChannelHandle", "observedChannelUrl"]) {
    if (existing[key] && candidate[key] && existing[key] !== candidate[key]) {
      throw new Error(`ambiguous observed channel identity for ${candidate.videoId}: ${key}`);
    }
  }
  if (!existing.publishedTimestamp && candidate.publishedTimestamp) existing.publishedTimestamp = candidate.publishedTimestamp;
  for (const key of ["publishedText", "durationText", "thumbnailUrl", "viewText", "channelName", "channelId", "channelHandle", "observedChannelId", "observedChannelHandle", "observedChannelUrl", "observedChannelSourceUrl", "observedChannelResponseUrl", "rendererChannelId", "rendererOwnerChannelId", "rendererOwnerChannelHandle", "discoveryEvidenceKind", "discoveryEvidencePath", "discoveryEvidenceSha256", "discoveryEvidenceBytes", "continuationRound", "continuationApiPath", "continuationRequestTokenSha256", "continuationTokenChainSha256"]) {
    if (!existing[key] && candidate[key]) existing[key] = candidate[key];
  }
}

function discoveryEvidenceRefFromItem(item) {
  const pathValue = String(item?.discoveryEvidencePath || "");
  if (!pathValue) return null;
  return {
    kind: String(item.discoveryEvidenceKind || ""),
    path: pathValue,
    sha256: String(item.discoveryEvidenceSha256 || ""),
    bytes: Number(item.discoveryEvidenceBytes) || 0,
    sourceUrl: String(item.discoverySourceUrl || ""),
    responseUrl: String(item.observedChannelResponseUrl || ""),
    continuationRound: Number(item.continuationRound) || 0,
    continuationApiPath: String(item.continuationApiPath || ""),
    requestTokenSha256: String(item.continuationRequestTokenSha256 || ""),
    tokenChainSha256: String(item.continuationTokenChainSha256 || ""),
    rendererOwnerChannelId: String(item.rendererOwnerChannelId || ""),
    rendererOwnerChannelHandle: String(item.rendererOwnerChannelHandle || ""),
    rendererOwnerIdentityInherited: item.rendererOwnerIdentityInherited === true,
  };
}

function mergeDiscoveryEvidenceRefs(...groups) {
  const byPath = new Map();
  for (const ref of groups.flat()) {
    if (!ref?.path) continue;
    const normalized = { ...ref };
    const existing = byPath.get(normalized.path);
    if (existing && JSON.stringify(existing) !== JSON.stringify(normalized)) {
      throw new Error(`ambiguous discovery evidence reference: ${normalized.path}`);
    }
    byPath.set(normalized.path, normalized);
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function assertCandidateIdentityConsistency(existing, candidate) {
  const videoId = candidate.videoId || existing.videoId || "candidate";
  const normalizeId = (value) => String(value || "").trim();
  const normalizeHandle = (value) => normalizeChannelHandle(value) ? `@${normalizeChannelHandle(value)}` : "";
  const normalizeUrl = (value) => canonicalChannelIdentityUrl(value);
  const fields = [
    ["rendererChannelId", normalizeId],
    ["rendererOwnerChannelId", normalizeId],
    ["channelId", normalizeId],
    ["observedChannelId", normalizeId],
    ["channelHandle", normalizeHandle],
    ["observedChannelHandle", normalizeHandle],
    ["observedChannelUrl", normalizeUrl],
  ];
  for (const [field, normalize] of fields) {
    const left = normalize(existing[field]);
    const right = normalize(candidate[field]);
    if (left && right && left !== right) throw new Error(`ambiguous candidate identity for ${videoId}: ${field}`);
  }
  const ids = new Set([normalizeId(existing.rendererChannelId), normalizeId(existing.rendererOwnerChannelId), normalizeId(existing.channelId), normalizeId(existing.observedChannelId), normalizeId(candidate.rendererChannelId), normalizeId(candidate.rendererOwnerChannelId), normalizeId(candidate.channelId), normalizeId(candidate.observedChannelId)].filter(Boolean));
  if (ids.size > 1) throw new Error(`ambiguous candidate identity for ${videoId}: channelId`);
  const handles = new Set([normalizeHandle(existing.channelHandle), normalizeHandle(existing.observedChannelHandle), normalizeHandle(candidate.channelHandle), normalizeHandle(candidate.observedChannelHandle)].filter(Boolean));
  if (handles.size > 1) throw new Error(`ambiguous candidate identity for ${videoId}: channelHandle`);
}

function rawVideoCandidate(candidate, singerName = "") {
  const publishedTimestamp = Number(candidate.publishedTimestamp);
  const hasPublishedTimestamp = Number.isFinite(publishedTimestamp) && publishedTimestamp > 0;
  const publishedText = candidate.publishedText || "";
  const publishedAtMissingReason = hasPublishedTimestamp
    ? ""
    : publishedText
      ? "published text could not be parsed"
      : "discovery renderer omitted published text";
  return {
    sourceSystem: SOURCE_SYSTEM,
    channelUrl: candidate.channelUrl || "",
    channelId: candidate.channelId || "",
    channelHandle: candidate.channelHandle || "",
    observedChannelId: candidate.observedChannelId || "",
    observedChannelHandle: candidate.observedChannelHandle || "",
    observedChannelUrl: candidate.observedChannelUrl || "",
    observedChannelSourceUrl: candidate.observedChannelSourceUrl || "",
    observedChannelResponseUrl: candidate.observedChannelResponseUrl || "",
    singerName: singerName || candidate.singerName || "",
    youtubeVideoId: candidate.videoId,
    youtubeUrl: `https://www.youtube.com/watch?v=${candidate.videoId}`,
    videoTitle: candidate.title || "",
    channelName: candidate.channelName || "",
    thumbnailUrl: candidate.thumbnailUrl || `https://i.ytimg.com/vi/${candidate.videoId}/hqdefault.jpg`,
    streamedAt: timestampToIso(candidate.publishedTimestamp),
    publishedAt: timestampToIso(candidate.publishedTimestamp),
    publishedAtOriginalText: candidate.publishedText || null,
    publishedAtTimestampMs: hasPublishedTimestamp ? publishedTimestamp : null,
    publishedAtMissingReason,
    publishedAtTimezone: candidate.publishedAtTimezone || null,
    publishedAtTimezoneReason: candidate.publishedAtTimezone ? "source-provided" : "published text has no timezone",
    publishedAtEvidence: candidate.publishedAtEvidence || "youtube discovery published text",
    publishedText: candidate.publishedText || "",
    durationText: candidate.durationText || "",
    matchedKeywords: candidate.matchedKeywords || [],
    discoverySourceUrl: candidate.discoverySourceUrl || candidate.sourceUrls?.[0] || "",
    discoverySourceUrls: uniqueStrings([...(candidate.discoverySourceUrls || []), candidate.discoverySourceUrl || candidate.sourceUrls?.[0] || ""]),
    observedChannelSourceUrls: uniqueStrings([...(candidate.observedChannelSourceUrls || []), candidate.observedChannelSourceUrl || ""]),
    observedChannelResponseUrls: uniqueStrings([...(candidate.observedChannelResponseUrls || []), candidate.observedChannelResponseUrl || ""]),
    discoveryEvidenceRefs: mergeDiscoveryEvidenceRefs(candidate.discoveryEvidenceRefs || [], discoveryEvidenceRefFromItem(candidate) ? [discoveryEvidenceRefFromItem(candidate)] : []),
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
  const handle = channelHandleFromCanonicalUrl(canonicalChannelIdentityUrl(value));
  return handle ? `/${handle}` : "";
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

function channelTabFromPageUrl(pageUrl) {
  try {
    const tab = new URL(pageUrl).pathname.split("/").filter(Boolean).at(-1) || "";
    return DEFAULT_TABS.includes(tab) ? tab : "";
  } catch {
    return "";
  }
}

function normalizeDiscoveryUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const url = new URL(text);
  if (!isOfficialYouTubeHost(url.hostname)) throw new Error("Expected an official YouTube discovery URL, got " + value);
  url.protocol = "https:";
  url.hostname = "www.youtube.com";
  url.hash = "";
  return url.toString();
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
  if (!isOfficialYouTubeHost(url.hostname)) throw new Error(`Expected an official YouTube channel URL, got ${value}`);
  url.protocol = "https:";
  url.hostname = "www.youtube.com";
  const canonicalUrl = canonicalChannelResponseUrl(url.toString());
  if (!canonicalUrl) throw new Error(`Expected a canonical YouTube @handle URL with an optional channel tab, got ${value}`);
  return canonicalUrl;
}

function normalizeChannelHandle(value) {
  let handle = String(value || "").normalize("NFKC").trim();
  if (!handle) return "";
  handle = handle.replace(/^\/+|\/+$/gu, "");
  if (handle.startsWith("@")) handle = handle.slice(1);
  return handle.normalize("NFKC").toLocaleLowerCase("en-US");
}

function canonicalChannelIdentityUrl(value) {
  const canonicalResponseUrl = canonicalChannelResponseUrl(value);
  return canonicalResponseUrl ? canonicalResponseUrl.replace(/\/(?:featured|streams|videos|shorts|live|community)$/u, "") : "";
}

function isOfficialYouTubeHost(hostname) {
  return new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]).has(String(hostname || "").toLocaleLowerCase("en-US"));
}

function canonicalChannelMetadataIdentityUrl(value) {
  const text = String(value || "").normalize("NFKC").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !isOfficialYouTubeHost(url.hostname) ||
      url.username ||
      url.password ||
      url.port ||
      url.search ||
      url.hash
    ) return "";
    url.protocol = "https:";
    url.hostname = "www.youtube.com";
    return canonicalChannelIdentityUrl(url.toString());
  } catch {
    return "";
  }
}

function canonicalChannelResponseUrl(value) {
  const text = String(value || "").normalize("NFKC").trim();
  if (!text) return "";
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" || !isOfficialYouTubeHost(url.hostname)) return "";
    const parts = url.pathname.split("/").filter(Boolean);
    const [firstPathPart, tab] = parts;
    const handle = normalizeChannelHandle(firstPathPart || "");
    if (!/^[a-z0-9._-]{3,30}$/u.test(handle) || !firstPathPart?.normalize("NFKC").startsWith("@") || parts.length > 2) return "";
    if (tab && !["featured", "streams", "videos", "shorts", "live", "community"].includes(tab.toLocaleLowerCase("en-US"))) return "";
    return `https://www.youtube.com/@${handle}${tab ? `/${tab.toLocaleLowerCase("en-US")}` : ""}`;
  } catch {
    return "";
  }
}

function channelHandleFromCanonicalUrl(value) {
  const canonicalUrl = canonicalChannelIdentityUrl(value);
  return canonicalUrl ? `@${canonicalUrl.split("/@", 2)[1]}` : "";
}

function expectedChannelIdentity(options) {
  const expectedChannelId = String(options.expectedChannelId || "").trim();
  const normalizedExpectedHandle = normalizeChannelHandle(options.expectedChannelHandle || channelHandleFromCanonicalUrl(options.channelUrl));
  const expectedChannelHandle = normalizedExpectedHandle ? `@${normalizedExpectedHandle}` : "";
  const expectedChannelUrl = canonicalChannelIdentityUrl(options.channelUrl);
  return { expectedChannelId, normalizedExpectedHandle, expectedChannelHandle, expectedChannelUrl };
}

function validateObservedPageSummary(summary, options) {
  const expected = expectedChannelIdentity(options);
  const identityRequired = options.candidateOnly || Boolean(options.expectedChannelId || options.expectedChannelHandle);
  if (!identityRequired) return;
  if (Number(summary?.status) !== 200) throw new Error("candidate discovery page status must be HTTP 200");
  if (!Number.isSafeInteger(summary?.bytes) || summary.bytes < 0 || !/^[a-f0-9]{64}$/u.test(String(summary?.rawSha256 || "")) || !/^pages\/\d{2}-(streams|videos)\.html$/u.test(String(summary?.evidencePath || ""))) {
    throw new Error("candidate discovery page evidence is incomplete");
  }
  const continuationRounds = Number(summary?.continuationRounds || 0);
  if (
    !Number.isSafeInteger(continuationRounds) ||
    continuationRounds < 0 ||
    continuationRounds > Math.max(0, Number(options.maxChannelPages || 0) - 1) ||
    Number(summary?.pageCount) !== continuationRounds + 1 ||
    !Array.isArray(summary?.inheritedInitialOwnerVideoIds) ||
    summary.inheritedInitialOwnerVideoIds.some((videoId) => !/^[A-Za-z0-9_-]{11}$/u.test(String(videoId || ""))) ||
    uniqueStrings(summary.inheritedInitialOwnerVideoIds).length !== summary.inheritedInitialOwnerVideoIds.length ||
    !validContinuationEvidence(summary?.continuationEvidence, summary?.tab, summary?.pageIndex, continuationRounds, false)
  ) {
    throw new Error("candidate discovery continuation evidence is incomplete");
  }
  if (!expected.expectedChannelId || !/^UC[A-Za-z0-9_-]{22}$/u.test(expected.expectedChannelId)) throw new Error("expected immutable channel ID is required for channel discovery");
  if (!expected.normalizedExpectedHandle || !expected.expectedChannelUrl) throw new Error("expected channel handle URL identity is required for channel discovery");
  const sourceUrl = canonicalChannelResponseUrl(summary?.pageUrl);
  const responseUrl = canonicalChannelResponseUrl(summary?.observedChannelResponseUrl);
  if (!sourceUrl || !responseUrl || sourceUrl !== responseUrl) throw new Error("observed channel response URL does not match its discovery page source");
  if (
    String(summary?.observedChannelId || "").trim() !== expected.expectedChannelId ||
    channelHandleFromCanonicalUrl(summary?.observedChannelUrl) !== expected.expectedChannelHandle ||
    canonicalChannelIdentityUrl(summary?.observedChannelUrl) !== expected.expectedChannelUrl ||
    canonicalChannelIdentityUrl(responseUrl) !== expected.expectedChannelUrl
  ) throw new Error("observed discovery page identity mismatch");
}

function validateObservedPageSummaries(pageSummaries, options) {
  if (!Array.isArray(pageSummaries) || pageSummaries.length === 0) {
    if (options.candidateOnly) throw new Error("candidate discovery requires observed page summaries");
    return { sourceUrls: [], responseUrls: [] };
  }
  for (const summary of pageSummaries) validateObservedPageSummary(summary, options);
  if (options.candidateOnly) {
    if (
      pageSummaries.length !== DEFAULT_TABS.length ||
      pageSummaries.some((summary, index) => summary.tab !== DEFAULT_TABS[index])
    ) {
      throw new Error("candidate discovery requires independently observed streams and videos initial pages");
    }
  }
  return {
    sourceUrls: uniqueStrings(pageSummaries.map((summary) => summary.pageUrl)).sort(),
    responseUrls: uniqueStrings(pageSummaries.map((summary) => summary.observedChannelResponseUrl)).sort(),
  };
}

function validContinuationEvidence(evidence, tab, pageIndex, continuationRounds, requireReachedEnd = true) {
  if (!Array.isArray(evidence) || evidence.length !== continuationRounds) return false;
  let previousChain = "";
  const seenRequestTokenHashes = new Set();
  for (let index = 0; index < evidence.length; index += 1) {
    const item = evidence[index];
    const round = index + 1;
    const expectedChain = crypto.createHash("sha256").update(`${previousChain}\n${item?.requestTokenSha256 || ""}`, "utf8").digest("hex");
    if (
      item?.tab !== tab ||
      Number(item?.round) !== round ||
      item?.apiPath !== "/youtubei/v1/browse" ||
      !/^[a-f0-9]{64}$/u.test(String(item?.requestTokenSha256 || "")) ||
      (item?.nextTokenSha256 !== "" && !/^[a-f0-9]{64}$/u.test(String(item?.nextTokenSha256 || ""))) ||
      item?.tokenChainSha256 !== expectedChain ||
      item?.evidencePath !== `pages/${String(pageIndex).padStart(2, "0")}-${tab}-continuation-${String(round).padStart(3, "0")}.json` ||
      !/^[a-f0-9]{64}$/u.test(String(item?.sha256 || "")) ||
      !Number.isSafeInteger(item?.bytes) ||
      item.bytes < 0 ||
      !Number.isSafeInteger(item?.rawItemCount) ||
      item.rawItemCount < 0 ||
      !Number.isSafeInteger(item?.candidateCount) ||
      item.candidateCount < 0 ||
      !Array.isArray(item?.videoIds) ||
      !Array.isArray(item?.ownerChannelIds) ||
      !Array.isArray(item?.ownerChannelHandles) ||
      !Array.isArray(item?.inheritedOwnerVideoIds) ||
      item.inheritedOwnerVideoIds.some((videoId) => !item.videoIds.includes(videoId)) ||
      seenRequestTokenHashes.has(item.requestTokenSha256) ||
      (index > 0 && evidence[index - 1]?.nextTokenSha256 !== item.requestTokenSha256)
    ) return false;
    seenRequestTokenHashes.add(item.requestTokenSha256);
    previousChain = item.tokenChainSha256;
  }
  return !requireReachedEnd || evidence.length === 0 || evidence.at(-1)?.nextTokenSha256 === "";
}

function candidateInitialPagesComplete(pageSummaries, maxChannelPages) {
  return (
    Array.isArray(pageSummaries) &&
    pageSummaries.length === DEFAULT_TABS.length &&
    pageSummaries.every((summary, index) =>
      summary?.tab === DEFAULT_TABS[index] &&
      summary?.pageIndex === index &&
      summary?.status === 200 &&
      Number.isSafeInteger(summary?.bytes) && summary.bytes >= 0 &&
      /^[a-f0-9]{64}$/u.test(String(summary?.rawSha256 || "")) &&
      summary?.evidencePath === `pages/${String(index).padStart(2, "0")}-${DEFAULT_TABS[index]}.html` &&
      summary?.reachedEnd === true &&
      summary?.requiresContinuation !== true &&
      Number.isSafeInteger(summary?.continuationRounds) &&
      summary.continuationRounds >= 0 &&
      summary.continuationRounds <= Math.max(0, Number(maxChannelPages || 0) - 1) &&
      Number(summary?.pageCount) === summary.continuationRounds + 1 &&
      validContinuationEvidence(summary?.continuationEvidence, summary.tab, summary.pageIndex, summary.continuationRounds, true),
    )
  );
}

function validateObservedChannelIdentity(candidates, options, observedPages = { sourceUrls: [], responseUrls: [] }) {
  const { expectedChannelId, normalizedExpectedHandle, expectedChannelHandle, expectedChannelUrl } = expectedChannelIdentity(options);
  if (!options.candidateOnly && !options.expectedChannelId && !options.expectedChannelHandle) {
    const first = candidates[0] || {};
    return {
      expectedChannelId: "",
      expectedChannelHandle: "",
      expectedChannelUrl: "",
      channelId: String(first.observedChannelId || "").trim(),
      channelHandle: channelHandleFromCanonicalUrl(first.observedChannelUrl || "") || (normalizeChannelHandle(first.observedChannelHandle) ? `@${normalizeChannelHandle(first.observedChannelHandle)}` : ""),
      channelUrl: canonicalChannelIdentityUrl(first.observedChannelUrl),
      sourceUrls: observedPages.sourceUrls,
      responseUrls: observedPages.responseUrls,
    };
  }
  if (!expectedChannelId || !/^UC[A-Za-z0-9_-]{22}$/u.test(expectedChannelId)) {
    throw new Error("expected immutable channel ID is required for channel discovery");
  }
  if (!normalizedExpectedHandle || !expectedChannelUrl) {
    throw new Error("expected channel handle URL identity is required for channel discovery");
  }
  if (!Array.isArray(candidates) || candidates.length === 0) throw new Error("observed channel identity requires at least one candidate");
  const sourceUrls = new Set();
  const responseUrls = new Set();
  for (const candidate of candidates) {
    const observedChannelId = String(candidate.observedChannelId || "").trim();
    const observedChannelHandle = channelHandleFromCanonicalUrl(candidate.observedChannelUrl || "") || `@${normalizeChannelHandle(candidate.observedChannelHandle)}`;
    const observedChannelUrl = canonicalChannelIdentityUrl(candidate.observedChannelUrl);
    const sourceResponseUrl = canonicalChannelResponseUrl(candidate.observedChannelSourceUrl || candidate.discoverySourceUrl);
    const rawResponseUrl = String(candidate.observedChannelResponseUrl || "");
    const responseUrl = canonicalChannelResponseUrl(rawResponseUrl);
    const sourceChannelUrl = canonicalChannelIdentityUrl(sourceResponseUrl);
    const continuationRecord = candidate.discoveryEvidenceKind === "youtubei-continuation";
    const continuationResponseOk = rawResponseUrl === `https://www.youtube.com${candidate.continuationApiPath || ""}`;
    if (!observedChannelId || !observedChannelHandle || !observedChannelUrl || !sourceChannelUrl || (!continuationRecord && (!responseUrl || responseUrl !== sourceResponseUrl)) || (continuationRecord && !continuationResponseOk)) {
      throw new Error(`missing observed channel identity for ${candidate.videoId || "candidate"}`);
    }
    if (observedChannelId !== expectedChannelId || observedChannelHandle !== expectedChannelHandle || observedChannelUrl !== expectedChannelUrl || sourceChannelUrl !== expectedChannelUrl) {
      throw new Error(`observed channel identity mismatch for ${candidate.videoId || "candidate"}`);
    }
    if (candidate.rendererChannelId && String(candidate.rendererChannelId).trim() !== observedChannelId) {
      throw new Error(`renderer channel ID differs from observed page identity for ${candidate.videoId || "candidate"}`);
    }
    if (candidate.rendererOwnerChannelId && String(candidate.rendererOwnerChannelId).trim() !== expectedChannelId) {
      throw new Error(`continuation renderer owner channel differs from expected identity for ${candidate.videoId || "candidate"}`);
    }
    if (candidate.rendererOwnerChannelHandle && `@${normalizeChannelHandle(candidate.rendererOwnerChannelHandle)}` !== expectedChannelHandle) {
      throw new Error(`continuation renderer owner handle differs from expected identity for ${candidate.videoId || "candidate"}`);
    }
    validateCandidateDiscoveryEvidenceRefs(candidate, { expectedChannelId, expectedChannelHandle, expectedChannelUrl });
    candidate.channelId = observedChannelId;
    candidate.channelHandle = observedChannelHandle;
    candidate.observedChannelHandle = observedChannelHandle;
    candidate.observedChannelUrl = observedChannelUrl;
    sourceUrls.add(String(candidate.observedChannelSourceUrl || candidate.discoverySourceUrl));
    responseUrls.add(continuationRecord ? rawResponseUrl : responseUrl);
  }
  return {
    expectedChannelId,
    expectedChannelHandle,
    expectedChannelUrl,
    channelId: expectedChannelId,
    channelHandle: expectedChannelHandle,
    channelUrl: expectedChannelUrl,
    sourceUrls: observedPages.sourceUrls.length ? observedPages.sourceUrls : [...sourceUrls].sort(),
    responseUrls: observedPages.responseUrls.length ? observedPages.responseUrls : [...responseUrls].sort(),
  };
}

function validateCandidateDiscoveryEvidenceRefs(candidate, expected) {
  if (!Array.isArray(candidate.discoveryEvidenceRefs) || candidate.discoveryEvidenceRefs.length === 0) {
    throw new Error(`candidate discovery evidence reference is missing for ${candidate.videoId || "candidate"}`);
  }
  for (const ref of candidate.discoveryEvidenceRefs) {
    if (!/^[a-f0-9]{64}$/u.test(String(ref.sha256 || "")) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) {
      throw new Error(`candidate discovery evidence hash is invalid for ${candidate.videoId || "candidate"}`);
    }
    const sourceUrl = canonicalChannelResponseUrl(ref.sourceUrl);
    if (!sourceUrl || canonicalChannelIdentityUrl(sourceUrl) !== expected.expectedChannelUrl) {
      throw new Error(`candidate discovery evidence source identity mismatch for ${candidate.videoId || "candidate"}`);
    }
    if (ref.kind === "initial-html") {
      if (
        !/^pages\/\d{2}-(streams|videos)\.html$/u.test(ref.path) ||
        ref.responseUrl !== sourceUrl ||
        Number(ref.continuationRound) !== 0 ||
        typeof ref.rendererOwnerIdentityInherited !== "boolean"
      ) {
        throw new Error(`candidate initial evidence reference is invalid for ${candidate.videoId || "candidate"}`);
      }
      continue;
    }
    if (
      ref.kind !== "youtubei-continuation" ||
      !/^pages\/\d{2}-(streams|videos)-continuation-\d{3}\.json$/u.test(ref.path) ||
      ref.continuationApiPath !== "/youtubei/v1/browse" ||
      ref.responseUrl !== `https://www.youtube.com${ref.continuationApiPath}` ||
      !Number.isSafeInteger(ref.continuationRound) ||
      ref.continuationRound < 1 ||
      !/^[a-f0-9]{64}$/u.test(String(ref.requestTokenSha256 || "")) ||
      !/^[a-f0-9]{64}$/u.test(String(ref.tokenChainSha256 || "")) ||
      ref.rendererOwnerChannelId !== expected.expectedChannelId ||
      typeof ref.rendererOwnerIdentityInherited !== "boolean" ||
      (ref.rendererOwnerChannelHandle && `@${normalizeChannelHandle(ref.rendererOwnerChannelHandle)}` !== expected.expectedChannelHandle)
    ) {
      throw new Error(`candidate continuation evidence reference is invalid for ${candidate.videoId || "candidate"}`);
    }
  }
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

function candidatePageEvidenceFiles(pageSummaries) {
  return pageSummaries.flatMap((page) => [
    { path: page.evidencePath, sha256: page.rawSha256, bytes: page.bytes },
    ...(page.continuationEvidence || []).map((continuation) => ({
      path: continuation.evidencePath,
      sha256: continuation.sha256,
      bytes: continuation.bytes,
    })),
  ]);
}

function saveCheckpoint(filePath, checkpoint) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  writeJson(filePath, checkpoint);
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function writeNdjson(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : ""), "utf8");
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
  fetchBrowseContinuation,
  filterDiscoveryCandidates,
  findBrowseContinuation,
  keywordList,
  matchedDiscoveryKeywords,
  normalizeChannelUrl,
  normalizeDiscoveryUrl,
  occurrenceRecordsFromDetail,
  parseCliArgs,
  parsePublishedTimestamp,
  parseYouTubePage,
  positiveInteger,
  rawVideoCandidate,
  reportMarkdown,
  runChannelDiscovery,
  candidateItemsFromPage,
  recomputeCandidatePageEvidence,
  recomputeCandidateArtifactEvidence,
  tabList,
};
