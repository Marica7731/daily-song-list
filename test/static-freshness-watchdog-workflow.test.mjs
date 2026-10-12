import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workflowPath = new URL(
  "../.github/workflows/static-freshness-watchdog.yml",
  import.meta.url,
);

test("heartbeat trigger provides a freshness watchdog fallback", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(
    workflow,
    /push:\s+branches:\s+- main\s+paths:[\s\S]*?\.github\/workflows\/static-freshness-watchdog\.yml[\s\S]*?\.github\/dirty-heartbeat\.trigger/,
    "heartbeat trigger must start the freshness watchdog",
  );
  assert.match(workflow, /cron:\s+"\*\/15 \* \* \* \*"/, "scheduled cadence must remain configured");
  assert.match(workflow, /workflow_dispatch:/, "manual recovery entry point must remain available");
});
