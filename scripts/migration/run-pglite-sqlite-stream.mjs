import { writeFile } from "node:fs/promises";
import { activateCandidate, ensureSchema, health } from "./pg-incremental.mjs";
import { streamSqliteToPostgres } from "./stream-sqlite-to-pg.mjs";

function option(name, fallback = "") {
  const prefix = `--${name}=`;
  const value = process.argv.find((arg) => arg.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
}

const sourcePath = option("source");
const exporterPath = option("exporter");
const pgliteModule = option("pglite-module");
const dataDir = option("data-dir", "memory://daily-song-list-pglite");
const outputManifest = option("manifest");
const revisionId = option("revision", `rev_stream_${Date.now()}`);
if (!sourcePath || !exporterPath || !pgliteModule || !outputManifest) {
  throw new Error("required options: --source= --exporter= --pglite-module= --manifest=");
}

const startedAt = new Date().toISOString();
const { PGlite } = await import(pgliteModule);
const db = new PGlite(dataDir);
const client = { query: (sql, values) => db.query(sql, values) };
try {
  await ensureSchema(client);
  const candidate = await streamSqliteToPostgres({
    client,
    sourcePath,
    exporterPath,
    manifest: { sourceKind: "sqlite-stream", startedAt },
    revisionId,
  });
  const active = await activateCandidate(client, candidate.revisionId, candidate.candidate.contentSha256);
  const report = {
    schemaVersion: 1,
    status: "success",
    startedAt,
    finishedAt: new Date().toISOString(),
    sourcePath,
    revisionId: candidate.revisionId,
    candidateDigest: candidate.candidate.contentSha256,
    changedVideoIds: candidate.changedVideoIds,
    videoCount: active.videoCount,
    occurrenceCount: active.occurrenceCount,
    activeRevisionId: active.activeRevisionId,
  };
  await writeFile(outputManifest, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`PGLITE_STREAM_OK revision=${report.activeRevisionId} videos=${report.videoCount} occurrences=${report.occurrenceCount} manifest=${outputManifest}`);
} finally {
  await db.close();
}
