import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { prepareCandidate } from "./pg-incremental.mjs";

function streamSqliteRecords({ sourcePath, rangeId = "all", python = "python3", exporterPath }) {
  const child = spawn(python, [exporterPath, "--db", sourcePath, "--range", rangeId], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const errors = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => errors.push(chunk));
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  async function* records() {
    for await (const line of lines) {
      if (!line.trim()) continue;
      yield JSON.parse(line);
    }
  }
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, records: records(), exited, errors };
}

/**
 * Read one SQLite video at a time and write only changed rows to a PG
 * candidate revision. The SQLite file is never copied or opened read/write.
 */
export async function streamSqliteToPostgres({
  client,
  sourcePath,
  rangeId = "all",
  manifest = {},
  python = "python3",
  exporterPath,
  revisionId,
}) {
  if (!exporterPath) throw new Error("exporterPath is required");
  const stream = streamSqliteRecords({ sourcePath, rangeId, python, exporterPath });
  try {
    const candidate = await prepareCandidate(client, stream.records, {
      ...manifest,
      sourceKind: "sqlite-stream",
      sourcePath,
      rangeId,
    }, { revisionId });
    const exit = await stream.exited;
    if (exit.code !== 0) {
      throw new Error(`SQLite exporter failed code=${exit.code} signal=${exit.signal} ${stream.errors.join("")}`.trim());
    }
    return candidate;
  } catch (error) {
    stream.child.kill("SIGTERM");
    await stream.exited.catch(() => undefined);
    throw error;
  }
}
