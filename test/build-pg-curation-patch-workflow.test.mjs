import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const workflowPath = path.resolve(".github/workflows/build-pg-curation-patch.yml");
const workflow = fs.readFileSync(workflowPath, "utf8");
const convertStep = workflow.slice(
  workflow.indexOf("- name: Convert and finalize compact curation artifact"),
  workflow.indexOf("- name: Prepare bounded producer failure evidence"),
);

function workflowRunBlocks(source) {
  const lines = source.split(/\r?\n/u);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*\|\s*$/u.exec(lines[index]);
    if (!match) continue;
    const contentIndent = match[1].length + 2;
    const body = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() && line.search(/\S/u) < contentIndent) {
        index -= 1;
        break;
      }
      body.push(line.slice(Math.min(contentIndent, line.length)));
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

test("all workflow run blocks have valid Bash syntax", () => {
  const blocks = workflowRunBlocks(workflow);
  assert.ok(blocks.length > 0);
  for (const [index, script] of blocks.entries()) {
    const result = spawnSync("bash", ["-n"], {
      input: script,
      encoding: "utf8",
    });
    assert.equal(
      result.status,
      0,
      `run block ${index + 1}: ${result.stderr}`,
    );
  }
});

test("both converter invocations use an enforcing 2 GiB RSS watchdog on macOS", () => {
  assert.doesNotMatch(convertStep, /\bulimit\s+-v\b/);
  assert.match(convertStep, /readonly MAC_CONVERTER_RSS_LIMIT_BYTES=2147483648/);
  assert.match(convertStep, /run_with_rss_watchdog\(\) \{/);
  assert.match(convertStep, /"\$@" &\n\s+local child_pid=\$!/);
  assert.match(convertStep, /ps -o rss= -p "\$child_pid"/);
  assert.match(convertStep, /rss_bytes=\$\(\( rss_kib \* 1024 \)\)/);
  assert.match(convertStep, /if \(\( rss_bytes > limit_bytes \)\)/);
  assert.match(convertStep, /kill -TERM "\$child_pid"/);
  assert.match(convertStep, /kill -KILL "\$child_pid"/);
  assert.match(convertStep, /if wait "\$child_pid"; then/);

  const wrappedInvocations =
    convertStep.match(
      /run_with_rss_watchdog "\$MAC_CONVERTER_RSS_LIMIT_BYTES"/g,
    ) ?? [];
  assert.equal(wrappedInvocations.length, 2);
  assert.match(
    convertStep,
    /run_with_rss_watchdog "\$MAC_CONVERTER_RSS_LIMIT_BYTES" bind-current-active[\s\S]*--bind-current-active-evidence/,
  );
  assert.match(
    convertStep,
    /run_with_rss_watchdog "\$MAC_CONVERTER_RSS_LIMIT_BYTES" build-candidate[\s\S]*--manifest-output "\$TASK_ROOT\/converter-manifest\.json"/,
  );
  assert.doesNotMatch(
    convertStep,
    /run_with_rss_watchdog[^\n]*export-pg-active-curation-snapshot\.py/,
  );
});

test("watchdog terminates a process whose RSS exceeds the supplied limit", () => {
  const helperStart = convertStep.indexOf("run_with_rss_watchdog() {");
  const firstInvocation = convertStep.indexOf(
    '\n          run_with_rss_watchdog "$MAC_CONVERTER_RSS_LIMIT_BYTES"',
    helperStart,
  );
  assert.notEqual(helperStart, -1);
  assert.notEqual(firstInvocation, -1);

  const helper = convertStep
    .slice(helperStart, firstInvocation)
    .replace(/^ {10}/gm, "");
  const probe = spawnSync(
    "bash",
    [
      "-lc",
      [
        "set -uo pipefail",
        helper,
        'run_with_rss_watchdog 1 fixture python3 -c "import time; time.sleep(30)"',
      ].join("\n"),
    ],
    {
      encoding: "utf8",
      timeout: 10_000,
    },
  );

  assert.equal(probe.error, undefined);
  assert.equal(probe.signal, null);
  assert.equal(probe.status, 137);
  assert.match(`${probe.stdout}${probe.stderr}`, /RSS_LIMIT_EXCEEDED/);
});
