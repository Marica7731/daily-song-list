import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { activateCandidate, ensureSchema, openNodePostgres, prepareCandidate, resolveDsnFromEnv } from "./pg-incremental.mjs";

function option(name, fallback = "") {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

async function* readNdjson(path) {
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.trim()) yield JSON.parse(line);
  }
}

async function requestJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: "application/json" } });
    const body = await response.text();
    let json;
    try { json = JSON.parse(body); } catch { throw new Error(`API contract invalid JSON status=${response.status}`); }
    if (!response.ok) throw new Error(`API contract HTTP ${response.status} url=${new URL(url).pathname}`);
    return json;
  } finally {
    clearTimeout(timeout);
  }
}

export async function verifyApiContract(apiBaseUrl) {
  const base = new URL(apiBaseUrl.endsWith("/") ? apiBaseUrl : `${apiBaseUrl}/`);
  const healthPayload = await requestJson(new URL("healthz", base));
  if (healthPayload.status !== "ok") throw new Error("API contract healthz status is not ok");
  const metaPayload = await requestJson(new URL("api/meta", base));
  if (!metaPayload || typeof metaPayload.meta !== "object" || typeof metaPayload.counts !== "object") {
    throw new Error("API contract meta missing meta/counts");
  }
  const rankingsUrl = new URL("api/rankings", base);
  rankingsUrl.search = new URLSearchParams({ range: "all", view: "songs", metric: "occurrences", page: "1", pageSize: "1" }).toString();
  const rankingsPayload = await requestJson(rankingsUrl);
  for (const key of ["rangeId", "view", "metric", "totalCount", "records"]) {
    if (!(key in rankingsPayload)) throw new Error(`API contract rankings missing ${key}`);
  }
  return {
    health: healthPayload,
    meta: { counts: metaPayload.counts, metaKeys: Object.keys(metaPayload.meta).sort() },
    rankings: { rangeId: rankingsPayload.rangeId, view: rankingsPayload.view, metric: rankingsPayload.metric, totalCount: rankingsPayload.totalCount },
  };
}

const patchPath = option("patch");
const manifestPath = option("manifest");
const apiBaseUrl = option("api-url", process.env.DAILY_SONG_PG_API_BASE_URL || "");
const reportPath = option("report");
const revisionId = option("revision", `rev_increment_${Date.now()}`);
const pgModule = option("pg-module", process.env.DAILY_SONG_PG_MODULE || "pg");
const dsn = process.env.DAILY_SONG_POSTGRES_DSN || process.env.DATABASE_URL || process.env.PG_DSN || "";
if (!patchPath || !manifestPath || !apiBaseUrl || !reportPath) {
  throw new Error("required options: --patch= --manifest= --api-url= --report=");
}
if (!resolveDsnFromEnv(process.env).present) {
  throw new Error("PRODUCTION_PG_BLOCKED missing DAILY_SONG_POSTGRES_DSN/DATABASE_URL/PG_DSN");
}

const startedAt = new Date().toISOString();
const client = await openNodePostgres(dsn, pgModule);
try {
  await ensureSchema(client);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const candidate = await prepareCandidate(
    client,
    readNdjson(patchPath),
    { ...manifest, runtimeProjection: true, incrementalOverlay: true },
    { revisionId },
  );
  const candidateHealth = {
    status: "ok",
    activeRevisionId: candidate.candidateRevisionId,
    videoCount: candidate.candidate.videoCount,
    occurrenceCount: candidate.candidate.occurrenceCount,
    contentSha256: candidate.candidate.contentSha256,
  };
  const api = await verifyApiContract(apiBaseUrl);
  const active = await activateCandidate(client, candidate.revisionId, candidate.candidate.contentSha256);
  const report = {
    schemaVersion: 1,
    status: "success",
    startedAt,
    finishedAt: new Date().toISOString(),
    revisionId: candidate.revisionId,
    candidateHealth,
    compare: { changedVideoIds: candidate.changedVideoIds, activeRevisionId: candidate.activeRevisionId },
    api,
    active,
  };
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`PG_INCREMENTAL_RELEASE_OK revision=${active.activeRevisionId} videos=${active.videoCount} occurrences=${active.occurrenceCount} report=${reportPath}`);
} finally {
  await client.close();
}
