#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_TARGETS_PATH = path.join(ROOT, "config", "youtube-channel-backfill-targets.json");
const DEFAULT_OUTPUT_ROOT = path.join(ROOT, "artifacts", "channel-discovery", "source-rescan");
const DEFAULT_ACCEPTED_OUTPUT = path.join(
  ROOT,
  "data",
  "external",
  "youtube-channel-discovery",
  "accepted",
  `${new Date().toISOString().slice(0, 10)}-source-rescan.json`,
);
const DISCOVERY_SCRIPT = path.join(ROOT, "scripts", "youtube-channel-discovery.js");
const EXPORT_SCRIPT = path.join(ROOT, "scripts", "export-channel-discovery-increment.js");

if (require.main === module) {
  main().catch((error) => {
    console.error(`CODEX_YOUTUBE_CHANNEL_BACKFILL_BATCH_ERROR ${error.name}: ${error.message}`);
    process.exitCode = 1;
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targets = selectTargets(loadTargets(args.targetsPath), args.channels);
  if (!targets.length) throw new Error("no targets selected");

  if (args.cleanOutputRoot) {
    assertSafeCleanOutputRoot(args.outputRoot);
    fs.rmSync(args.outputRoot, { recursive: true, force: true });
  }

  fs.mkdirSync(args.outputRoot, { recursive: true });
  const manifestPath = path.join(args.outputRoot, "batch-manifest.json");
  const manifest = args.fresh ? createBatchManifest(args, targets) : loadOrCreateBatchManifest(manifestPath, args, targets);
  manifest.disk.before = manifest.disk.before || diskSnapshot(args.outputRoot);
  saveBatchManifest(manifestPath, manifest);

  for (const batch of chunkArray(targets, args.batchSize)) {
    const batchRecord = startBatchRecord(manifest, batch);
    saveBatchManifest(manifestPath, manifest);
    for (const target of batch) {
      const existing = manifest.channels[target.slug];
      if (!args.rerunCompleted && existing?.status === "completed") {
        continue;
      }
      const channelRecord = await runDiscoveryTarget(target, args);
      manifest.channels[target.slug] = channelRecord;
      batchRecord.channels[target.slug] = {
        status: channelRecord.status,
        elapsedMs: channelRecord.elapsedMs,
        candidateCount: channelRecord.discovery.candidateCount,
        usableVideoCount: channelRecord.discovery.usableVideoCount,
        occurrenceCount: channelRecord.discovery.occurrenceCount,
      };
      manifest.summary = summarizeManifest(manifest);
      saveBatchManifest(manifestPath, manifest);
      console.log(channelMarker(channelRecord));
    }
    batchRecord.completedAt = new Date().toISOString();
  }

  if (!args.noExport) {
    const exportRecord = await runAcceptedExport(manifest, args);
    manifest.export = exportRecord;
    applyExportSummariesToChannels(manifest, exportRecord);
    manifest.summary = summarizeManifest(manifest);
    saveBatchManifest(manifestPath, manifest);
  }

  manifest.disk.after = diskSnapshot(args.outputRoot);
  manifest.completedAt = new Date().toISOString();
  manifest.summary = summarizeManifest(manifest);
  saveBatchManifest(manifestPath, manifest);
  console.log(
    [
      "CODEX_YOUTUBE_CHANNEL_BACKFILL_BATCH_OK",
      `targets=${targets.length}`,
      `completed=${manifest.summary.completed}`,
      `failed=${manifest.summary.failed}`,
      `timedOut=${manifest.summary.timedOut}`,
      `imported=${manifest.summary.imported}`,
      `skipped=${manifest.summary.skipped}`,
      `occurrences=${manifest.summary.importedOccurrences}`,
      `manifest=${quoteForMarker(manifestPath)}`,
      `accepted=${quoteForMarker(manifest.export?.output || "")}`,
    ].join(" "),
  );
}

function parseArgs(argv) {
  const raw = { channels: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--target" || name === "--channel") raw.channels.push(requireValue(argv, ++index, name));
    else if (name === "--targets") raw.targetsPath = requireValue(argv, ++index, name);
    else if (name === "--output-root") raw.outputRoot = requireValue(argv, ++index, name);
    else if (name === "--accepted-output" || name === "--output") raw.acceptedOutput = requireValue(argv, ++index, name);
    else if (name === "--max-channel-pages") raw.maxChannelPages = positiveInteger(requireValue(argv, ++index, name), 100);
    else if (name === "--max-candidates") raw.maxCandidates = nonNegativeInteger(requireValue(argv, ++index, name), 0);
    else if (name === "--max-inspect") raw.maxInspect = nonNegativeInteger(requireValue(argv, ++index, name), 1000);
    else if (name === "--request-interval-ms") raw.requestIntervalMs = nonNegativeInteger(requireValue(argv, ++index, name), 3000);
    else if (name === "--request-jitter-ms") raw.requestJitterMs = nonNegativeInteger(requireValue(argv, ++index, name), 1500);
    else if (name === "--per-channel-timeout-ms") raw.perChannelTimeoutMs = positiveInteger(requireValue(argv, ++index, name), 20 * 60 * 1000);
    else if (name === "--export-timeout-ms") raw.exportTimeoutMs = positiveInteger(requireValue(argv, ++index, name), 5 * 60 * 1000);
    else if (name === "--batch-size") raw.batchSize = positiveInteger(requireValue(argv, ++index, name), 1);
    else if (name === "--fresh") raw.fresh = true;
    else if (name === "--rerun-completed") raw.rerunCompleted = true;
    else if (name === "--candidate-only") raw.candidateOnly = true;
    else if (name === "--clean-output-root") raw.cleanOutputRoot = true;
    else if (name === "--no-export") raw.noExport = true;
    else throw new Error(`unknown argument: ${name}`);
  }
  return {
    channels: raw.channels,
    targetsPath: path.resolve(ROOT, raw.targetsPath || DEFAULT_TARGETS_PATH),
    outputRoot: path.resolve(ROOT, raw.outputRoot || DEFAULT_OUTPUT_ROOT),
    acceptedOutput: path.resolve(ROOT, raw.acceptedOutput || DEFAULT_ACCEPTED_OUTPUT),
    maxChannelPages: raw.maxChannelPages ?? 100,
    maxCandidates: raw.maxCandidates ?? 0,
    maxInspect: raw.maxInspect ?? 1000,
    requestIntervalMs: raw.requestIntervalMs ?? 3000,
    requestJitterMs: raw.requestJitterMs ?? 1500,
    perChannelTimeoutMs: raw.perChannelTimeoutMs ?? 20 * 60 * 1000,
    exportTimeoutMs: raw.exportTimeoutMs ?? 5 * 60 * 1000,
    batchSize: raw.batchSize ?? 1,
    fresh: raw.fresh === true,
    rerunCompleted: raw.rerunCompleted === true,
    candidateOnly: raw.candidateOnly === true,
    cleanOutputRoot: raw.cleanOutputRoot === true,
    noExport: raw.noExport === true,
  };
}

function requireValue(argv, index, name) {
  const value = argv[index];
  if (value == null || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function loadTargets(targetsPath) {
  const payload = readJson(targetsPath);
  const targets = Array.isArray(payload) ? payload : payload.targets;
  if (!Array.isArray(targets)) throw new Error(`targets file must contain a targets array: ${targetsPath}`);
  return targets.map(normalizeTarget);
}

function normalizeTarget(target) {
  const channelUrl = stringValue(target.channelUrl || target.url);
  if (!channelUrl) throw new Error("target channelUrl is required");
  const slug = safeSlug(target.slug || target.id || target.handle || channelUrl);
  return {
    slug,
    channelUrl,
    singerName: stringValue(target.singerName || target.name || slug),
    tabs: listValues(target.tabs).length ? listValues(target.tabs) : [],
    notes: stringValue(target.notes),
  };
}

function selectTargets(targets, channels) {
  if (!channels.length) return targets;
  const requested = new Set(channels.map((value) => normalizeSelector(value)));
  return targets.filter((target) => requested.has(normalizeSelector(target.slug)) || requested.has(normalizeSelector(target.channelUrl)));
}

async function runDiscoveryTarget(target, args) {
  const startedAt = new Date();
  const outputDir = path.join(args.outputRoot, target.slug);
  const logPath = path.join(outputDir, "run.log");
  fs.mkdirSync(outputDir, { recursive: true });
  const commandArgs = discoveryArgs(target, args, outputDir);
  console.log(
    [
      "CODEX_YOUTUBE_CHANNEL_BACKFILL_START",
      `slug=${quoteForMarker(target.slug)}`,
      `channel=${quoteForMarker(target.channelUrl)}`,
      `timeoutMs=${args.perChannelTimeoutMs}`,
      `outputDir=${quoteForMarker(projectRelativePath(outputDir))}`,
    ].join(" "),
  );
  const result = await runCommand(process.execPath, commandArgs, {
    cwd: ROOT,
    timeoutMs: args.perChannelTimeoutMs,
    logPath,
  });
  const manifest = readJsonIfExists(path.join(outputDir, "manifest.json")) || {};
  const audits = readJsonArrayIfExists(path.join(outputDir, "audits.json"));
  const failures = summarizeFailedAudits(audits);
  const completed = result.exitCode === 0 && !result.timedOut && /CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK/u.test(result.stdout);
  return {
    slug: target.slug,
    channelUrl: target.channelUrl,
    singerName: target.singerName,
    status: completed ? "completed" : "failed",
    startedAt: startedAt.toISOString(),
    completedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt.getTime(),
    outputDir: projectRelativePath(outputDir),
    logPath: projectRelativePath(logPath),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    marker: extractMarker(result.stdout, "CODEX_YOUTUBE_CHANNEL_DISCOVERY_OK"),
    error: completed ? "" : result.error || firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout) || lastNonEmptyLine(result.stderr) || lastNonEmptyLine(result.stdout),
    discovery: {
      candidateCount: Number(manifest.candidateCount) || 0,
      inspectedInLatestRun: Number(manifest.inspectedInLatestRun) || 0,
      usableVideoCount: Number(manifest.usableVideoCount) || 0,
      occurrenceCount: Number(manifest.occurrenceCount) || 0,
      generatedAt: stringValue(manifest.generatedAt),
      coverage: manifest.coverage || null,
      requestStats: manifest.requestStats || null,
    },
    import: null,
    failed: failures.total,
    failedReasons: failures.byResult,
  };
}

function discoveryArgs(target, args, outputDir) {
  const result = [
    DISCOVERY_SCRIPT,
    "--channel-url",
    target.channelUrl,
    "--singer-name",
    target.singerName,
    "--output-dir",
    outputDir,
    "--max-channel-pages",
    String(args.maxChannelPages),
    "--max-candidates",
    String(args.maxCandidates),
    "--max-inspect",
    String(args.maxInspect),
    "--request-interval-ms",
    String(args.requestIntervalMs),
    "--request-jitter-ms",
    String(args.requestJitterMs),
  ];
  for (const tab of target.tabs) {
    result.push("--tab", tab);
  }
  if (args.fresh) result.push("--fresh");
  if (args.candidateOnly) result.push("--candidate-only");
  return result;
}

async function runAcceptedExport(manifest, args) {
  const inputDirs = Object.values(manifest.channels)
    .filter((channel) => channel.status === "completed")
    .map((channel) => path.resolve(ROOT, channel.outputDir));
  if (!inputDirs.length) {
    return {
      status: "skipped",
      reason: "no completed discovery outputs",
      output: projectRelativePath(args.acceptedOutput),
      inputSummaries: [],
    };
  }
  const commandArgs = [EXPORT_SCRIPT];
  for (const inputDir of inputDirs) commandArgs.push("--input-dir", inputDir);
  commandArgs.push("--output", args.acceptedOutput);
  const logPath = path.join(args.outputRoot, "export.log");
  const result = await runCommand(process.execPath, commandArgs, {
    cwd: ROOT,
    timeoutMs: args.exportTimeoutMs,
    logPath,
  });
  const payload = readJsonIfExists(args.acceptedOutput) || {};
  const completed = result.exitCode === 0 && !result.timedOut && /CODEX_CHANNEL_DISCOVERY_INCREMENT_OK/u.test(result.stdout);
  return {
    status: completed ? "completed" : "failed",
    output: projectRelativePath(args.acceptedOutput),
    logPath: projectRelativePath(logPath),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    marker: extractMarker(result.stdout, "CODEX_CHANNEL_DISCOVERY_INCREMENT_OK"),
    error: completed ? "" : result.error || firstNonEmptyLine(result.stderr) || firstNonEmptyLine(result.stdout) || lastNonEmptyLine(result.stderr) || lastNonEmptyLine(result.stdout),
    videoCount: Number(payload.videoCount) || 0,
    occurrenceCount: Number(payload.occurrenceCount) || 0,
    inputSummaries: Array.isArray(payload.inputSummaries) ? payload.inputSummaries : [],
  };
}

function applyExportSummariesToChannels(manifest, exportRecord) {
  const summariesByInput = new Map((exportRecord.inputSummaries || []).map((summary) => [summary.inputDir, summary]));
  for (const channel of Object.values(manifest.channels)) {
    const summary = summariesByInput.get(channel.outputDir);
    if (!summary) continue;
    channel.import = summary;
    channel.failed = summary.failed;
    channel.failedReasons = summary.failedReasons;
  }
}

function runCommand(command, args, options) {
  return new Promise((resolve) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let timedOut = false;
    let settled = false;
    const logStream = fs.createWriteStream(options.logPath, { flags: "a", encoding: "utf8" });
    logStream.write(`[codex] startedAt=${new Date().toISOString()} command=${JSON.stringify([command, ...args])}\n`);
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdoutChunks.push(text);
      logStream.write(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderrChunks.push(text);
      logStream.write(text);
    });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      logStream.write(`\n[codex] error=${error.message}\n`);
      logStream.end();
      resolve({ exitCode: null, timedOut, stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), error: error.message });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      logStream.write(`\n[codex] completedAt=${new Date().toISOString()} exitCode=${exitCode} timedOut=${timedOut}\n`);
      logStream.end();
      resolve({ exitCode, timedOut, stdout: stdoutChunks.join(""), stderr: stderrChunks.join(""), error: "" });
    });
  });
}

function createBatchManifest(args, targets) {
  return {
    schemaVersion: 1,
    kind: "youtube-channel-backfill-batch",
    generatedAt: new Date().toISOString(),
    options: manifestOptions(args),
    targetCount: targets.length,
    channels: {},
    batches: [],
    export: null,
    disk: {},
    summary: {},
  };
}

function loadOrCreateBatchManifest(manifestPath, args, targets) {
  const existing = readJsonIfExists(manifestPath);
  if (existing?.kind === "youtube-channel-backfill-batch") {
    return {
      ...existing,
      options: manifestOptions(args),
      targetCount: targets.length,
      channels: existing.channels || {},
      batches: existing.batches || [],
      disk: existing.disk || {},
    };
  }
  return createBatchManifest(args, targets);
}

function startBatchRecord(manifest, batch) {
  const record = {
    index: manifest.batches.length + 1,
    startedAt: new Date().toISOString(),
    targetSlugs: batch.map((target) => target.slug),
    channels: {},
    completedAt: "",
  };
  manifest.batches.push(record);
  return record;
}

function manifestOptions(args) {
  return {
    targetsPath: projectRelativePath(args.targetsPath),
    outputRoot: projectRelativePath(args.outputRoot),
    acceptedOutput: projectRelativePath(args.acceptedOutput),
    maxChannelPages: args.maxChannelPages,
    maxCandidates: args.maxCandidates,
    maxInspect: args.maxInspect,
    requestIntervalMs: args.requestIntervalMs,
    requestJitterMs: args.requestJitterMs,
    perChannelTimeoutMs: args.perChannelTimeoutMs,
    exportTimeoutMs: args.exportTimeoutMs,
    batchSize: args.batchSize,
    candidateOnly: args.candidateOnly,
    noExport: args.noExport,
  };
}

function summarizeManifest(manifest) {
  const channels = Object.values(manifest.channels || {});
  const imports = channels.map((channel) => channel.import).filter(Boolean);
  return {
    completed: channels.filter((channel) => channel.status === "completed").length,
    failed: channels.filter((channel) => channel.status === "failed").length,
    timedOut: channels.filter((channel) => channel.timedOut).length,
    candidates: sumBy(channels, (channel) => channel.discovery?.candidateCount),
    inspected: sumBy(channels, (channel) => channel.discovery?.inspectedInLatestRun),
    usableVideos: sumBy(channels, (channel) => channel.discovery?.usableVideoCount),
    discoveredOccurrences: sumBy(channels, (channel) => channel.discovery?.occurrenceCount),
    imported: sumBy(imports, (item) => item.imported),
    skipped: sumBy(imports, (item) => item.skipped),
    importFailed: sumBy(imports, (item) => item.failed),
    importedVideos: sumBy(imports, (item) => item.increments?.videos),
    importedSongs: sumBy(imports, (item) => item.increments?.songs),
    importedOccurrences: sumBy(imports, (item) => item.increments?.occurrences),
  };
}

function diskSnapshot(targetPath) {
  const result = {
    recordedAt: new Date().toISOString(),
    platform: process.platform,
    command: "df -h",
    targetPath: projectRelativePath(targetPath),
    exitCode: null,
    stdout: "",
    stderr: "",
    statfs: null,
  };
  const completed = spawnSync("df", ["-h", targetPath], {
    cwd: ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  if (completed.error) {
    result.stderr = completed.error.message;
  } else {
    result.exitCode = completed.status;
    result.stdout = stringValue(completed.stdout);
    result.stderr = stringValue(completed.stderr);
  }
  if (typeof fs.statfsSync === "function") {
    try {
      const stats = fs.statfsSync(targetPath);
      result.statfs = {
        bsize: stats.bsize,
        blocks: stats.blocks,
        bfree: stats.bfree,
        bavail: stats.bavail,
      };
    } catch (error) {
      result.statfsError = error.message;
    }
  }
  return result;
}

function assertSafeCleanOutputRoot(outputRoot) {
  const root = path.resolve(ROOT, "artifacts", "channel-discovery");
  const target = path.resolve(outputRoot);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`refusing to clean output root outside artifacts/channel-discovery child directory: ${target}`);
  }
}

function summarizeFailedAudits(audits) {
  const byResult = {};
  let total = 0;
  for (const audit of audits || []) {
    const result = stringValue(audit.result) || "unknown";
    if (result === "selected") continue;
    total += 1;
    byResult[result] = (byResult[result] || 0) + 1;
  }
  return { total, byResult };
}

function channelMarker(channel) {
  return [
    "CODEX_YOUTUBE_CHANNEL_BACKFILL_CHANNEL",
    `slug=${quoteForMarker(channel.slug)}`,
    `status=${channel.status}`,
    `candidates=${channel.discovery.candidateCount}`,
    `videos=${channel.discovery.usableVideoCount}`,
    `occurrences=${channel.discovery.occurrenceCount}`,
    `failed=${channel.failed}`,
    `timedOut=${channel.timedOut ? 1 : 0}`,
    `outputDir=${quoteForMarker(channel.outputDir)}`,
  ].join(" ");
}

function extractMarker(text, name) {
  return String(text || "")
    .split(/\r?\n/u)
    .find((line) => line.includes(name)) || "";
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonIfExists(filePath) {
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function readJsonArrayIfExists(filePath) {
  const value = readJsonIfExists(filePath);
  return Array.isArray(value) ? value : [];
}

function saveBatchManifest(manifestPath, manifest) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function projectRelativePath(value) {
  const absolutePath = path.resolve(ROOT, String(value || ""));
  const relativePath = path.relative(ROOT, absolutePath);
  if (relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath)) return relativePath.replace(/\\/gu, "/");
  return absolutePath.replace(/\\/gu, "/");
}

function chunkArray(items, size) {
  const chunks = [];
  const chunkSize = Math.max(1, Number(size) || 1);
  for (let index = 0; index < items.length; index += chunkSize) chunks.push(items.slice(index, index + chunkSize));
  return chunks;
}

function listValues(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (value == null || value === false) return [];
  return [String(value)];
}

function normalizeSelector(value) {
  return stringValue(value).toLocaleLowerCase();
}

function safeSlug(value) {
  return stringValue(value)
    .replace(/^https?:\/\//iu, "")
    .replace(/[^A-Za-z0-9_.@-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
}

function lastNonEmptyLine(value) {
  const lines = String(value || "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return lines[lines.length - 1] || "";
}

function firstNonEmptyLine(value) {
  return String(value || "").split(/\r?\n/u).map((line) => line.trim()).find(Boolean) || "";
}

function quoteForMarker(value) {
  return JSON.stringify(String(value || ""));
}

function sumBy(items, selector) {
  return (items || []).reduce((total, item) => total + (Number(selector(item)) || 0), 0);
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function stringValue(value) {
  return String(value || "").trim();
}

module.exports = {
  assertSafeCleanOutputRoot,
  discoveryArgs,
  loadTargets,
  parseArgs,
  projectRelativePath,
  safeSlug,
  selectTargets,
  summarizeManifest,
};
