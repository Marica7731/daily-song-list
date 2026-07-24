const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.join(__dirname, "..");
const workflowsDir = path.join(repoRoot, ".github", "workflows");

test("core, review, and code checks use separate workflow files and concurrency groups", () => {
  const core = readWorkflow("update-core.yml");
  const review = readWorkflow("build-review.yml");
  const check = readWorkflow("check-code.yml");
  const watchdog = readWorkflow("update-watchdog.yml");
  const backfill = readWorkflow("update-backfill.yml");
  const staticDeploy = readWorkflow("deploy-vps-static.yml");
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

  assert.match(core, /name:\s*Update core song-list data/u);
  assert.match(core, /group:\s*daily-song-list-core/u);
  assert.match(core, /cancel-in-progress:\s*false/u);
  assert.doesNotMatch(core, /cron:\s*"37 \* \* \* \*"/u);
  assert.match(core, /timeout-minutes:\s*100/u);
  assert.match(core, /timeout-minutes:\s*90/u);
  assert.match(core, /DAILY_SONG_UPDATE_MODE:\s*\$\{\{ inputs\.mode \|\| 'fast' \}\}/u);
  assert.match(core, /DAILY_SONG_MONTH_BACKFILL_TARGET:\s*"0"/u);
  assert.match(core, /git pull --ff-only origin main/u);
  assert.match(core, /node scripts\/run-core-update\.js/u);
  assert.doesNotMatch(core, /review:build|build-review-queue|export-dirty-candidates/u);
  assert.match(core, /npm run mark:failure/u);
  assert.match(core, /git restore --worktree -- data\/latest\.json/u);
  assert.match(core, /git clean -fd -- data\/snapshots data\/diff data\/ui/u);
  assert.match(core, /git add --sparse data\/latest\.json/u);
  assert.match(core, /git pull --rebase origin main/u);
  assert.match(core, /sleep 300/u);
  assert.match(core, /for attempt in 1 2 3 4 5 6 7 8 9 10 11 12/u);
  assert.match(core, /sleep 60/u);
  assert.match(core, /npm run check:published -- https:\/\/ytb-song-rank\.culua\.com\/ --expected-meta data\/ui\/meta\.json/u);
  assert.match(core, /if:\s*always\(\) && steps\.core\.outcome != 'success'/u);

  assert.match(watchdog, /name:\s*Watch published song-list freshness/u);
  assert.match(watchdog, /cron:\s*"37 \* \* \* \*"/u);
  assert.match(watchdog, /group:\s*daily-song-list-watchdog/u);
  assert.match(watchdog, /actions:\s*write/u);
  assert.match(watchdog, /node scripts\/watchdog-update\.js/u);

  assert.match(backfill, /name:\s*Prepare backfill inbox bundle/u);
  assert.match(backfill, /group:\s*daily-song-list-backfill/u);
  assert.match(backfill, /DAILY_SONG_UPDATE_MODE:\s*"backfill"/u);
  assert.match(backfill, /node scripts\/run-backfill-update\.js/u);
  assert.match(backfill, /git add data\/backfill-inbox/u);
  assert.doesNotMatch(backfill, /data\/latest\.json|data\/ui\/meta\.json/u);

  assert.match(review, /name:\s*Build review reports/u);
  assert.match(review, /group:\s*daily-song-list-review/u);
  assert.match(review, /cancel-in-progress:\s*true/u);
  assert.match(review, /npm run review:build/u);
  assert.match(review, /continue-on-error:\s*true/u);

  assert.match(check, /name:\s*Check code/u);
  assert.match(check, /group:\s*daily-song-list-check-\$\{\{ github\.ref \}\}/u);
  assert.match(check, /npm run check/u);
  assert.match(check, /"docs\/\*\*"/u);
  assert.equal(pkg.scripts["check:ui-proof"], "node scripts/validate-ui-proof.js");
  assert.equal(pkg.scripts["health:update"], "node scripts/analyze-update-health.js");
  assert.equal(pkg.scripts["watchdog:update"], "node scripts/watchdog-update.js");
  assert.equal(pkg.scripts["backfill:inbox"], "node scripts/run-backfill-update.js");
  assert.match(pkg.scripts.check, /npm run check:ui-proof/u);
  assert.match(staticDeploy, /git fetch --depth=1 --filter=blob:none --no-tags origin main --prune/u);
  assert.match(staticDeploy, /git fetch --quiet --filter=blob:none --no-tags origin main --prune/u);
});

test("legacy combined update workflow is removed", () => {
  assert.equal(fs.existsSync(path.join(workflowsDir, "update-songlist.yml")), false);
});

test("README screenshot gallery is refreshable and references committed images", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  const uiProof = fs.readFileSync(path.join(repoRoot, "docs", "ui-proof.md"), "utf8");
  const manifestPath = path.join(repoRoot, "docs", "assets", "screenshots", "manifest.json");
  assert.match(readme, /npm run screenshots:readme -- https:\/\/ytb-song-rank\.culua\.com\//u);
  assert.match(readme, /docs\/ui-proof\.md/u);
  assert.match(readme, /docs\/assets\/screenshots\/desktop-song-rank\.png/u);
  assert.match(readme, /docs\/assets\/screenshots\/mobile-query-suggestions\.png/u);
  assert.match(readme, /docs\/assets\/screenshots\/mobile-source-inline-2\.png/u);

  const screenshotRefs = [...readme.matchAll(/src="(docs\/assets\/screenshots\/[^"]+\.png)"/gu)].map((match) => match[1]);
  assert.ok(screenshotRefs.length >= 12, `expected broad screenshot coverage, found ${screenshotRefs.length}`);
  for (const ref of screenshotRefs) {
    assert.equal(fs.existsSync(path.join(repoRoot, ref)), true, `missing README screenshot: ${ref}`);
  }

  const proofRefs = [...uiProof.matchAll(/\]\((assets\/screenshots\/[^)]+\.png)\)/gu)].map((match) => `docs/${match[1]}`);
  assert.ok(proofRefs.length >= 20, `expected full UI proof coverage, found ${proofRefs.length}`);
  for (const ref of proofRefs) {
    assert.equal(fs.existsSync(path.join(repoRoot, ref)), true, `missing UI proof screenshot: ${ref}`);
  }
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const manifestRefs = new Set((manifest.screenshots || []).map((entry) => entry.path));
    for (const ref of [...screenshotRefs, ...proofRefs]) {
      assert.equal(manifestRefs.has(ref), true, `manifest missing screenshot ref: ${ref}`);
    }
  }
});

function readWorkflow(name) {
  return fs.readFileSync(path.join(workflowsDir, name), "utf8");
}
