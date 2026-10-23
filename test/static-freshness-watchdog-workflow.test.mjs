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

test("freshness probe never follows the custom-domain redirect through Cloudflare", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(
    workflow,
    /PAGES_DEPLOYMENTS_API: \/repos\/\$\{\{ github\.repository \}\}\/deployments\?environment=github-pages/u,
    "site freshness must use GitHub's Pages deployment state",
  );
  assert.match(workflow, /select\(\.state == "success"\)/u);
  assert.match(workflow, /\.status == "requested"/u, "requested runs must count as active");
  const activeDeploysIndex = workflow.indexOf('active_deploys="$(');
  const deploymentEpochIndex = workflow.indexOf('site_deployed_epoch="$(fetch_pages_deployment_epoch)"');
  assert.ok(activeDeploysIndex >= 0, "active Pages deployments must be probed");
  assert.ok(
    deploymentEpochIndex > activeDeploysIndex,
    "an in-progress deployment must be detected before reading its successful status",
  );
  assert.doesNotMatch(workflow, /SITE_META_URL|marica7731\.github\.io/u);
  assert.doesNotMatch(workflow, /fetch_generated_at/u);
});
