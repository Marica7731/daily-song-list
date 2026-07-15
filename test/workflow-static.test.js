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

  assert.match(core, /name:\s*Update core song-list data/u);
  assert.match(core, /group:\s*daily-song-list-core/u);
  assert.match(core, /cancel-in-progress:\s*false/u);
  assert.match(core, /cron:\s*"37 \* \* \* \*"/u);
  assert.match(core, /timeout-minutes:\s*35/u);
  assert.match(core, /DAILY_SONG_MONTH_BACKFILL_TARGET:\s*"3000"/u);
  assert.match(core, /node scripts\/run-core-update\.js/u);
  assert.doesNotMatch(core, /review:build|build-review-queue|export-dirty-candidates/u);
  assert.match(core, /npm run mark:failure/u);
  assert.match(core, /git restore --worktree -- data\/latest\.json/u);
  assert.match(core, /git clean -fd -- data\/snapshots data\/diff data\/ui/u);
  assert.match(core, /git add data\/latest\.json/u);
  assert.match(core, /git pull --rebase origin main/u);
  assert.match(core, /npm run check:published -- https:\/\/ytb-song-rank\.culua\.com\//u);
  assert.match(core, /if:\s*always\(\) && steps\.core\.outcome != 'success'/u);

  assert.match(review, /name:\s*Build review reports/u);
  assert.match(review, /group:\s*daily-song-list-review/u);
  assert.match(review, /cancel-in-progress:\s*true/u);
  assert.match(review, /npm run review:build/u);
  assert.match(review, /continue-on-error:\s*true/u);

  assert.match(check, /name:\s*Check code/u);
  assert.match(check, /group:\s*daily-song-list-check-\$\{\{ github\.ref \}\}/u);
  assert.match(check, /npm run check/u);
});

test("legacy combined update workflow is removed", () => {
  assert.equal(fs.existsSync(path.join(workflowsDir, "update-songlist.yml")), false);
});

test("README screenshot gallery is refreshable and references committed images", () => {
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  assert.match(readme, /npm run screenshots:readme -- https:\/\/ytb-song-rank\.culua\.com\//u);
  assert.match(readme, /docs\/assets\/screenshots\/desktop-song-rank\.png/u);
  assert.match(readme, /docs\/assets\/screenshots\/mobile-query-suggestions\.png/u);

  const screenshotRefs = [...readme.matchAll(/src="(docs\/assets\/screenshots\/[^"]+\.png)"/gu)].map((match) => match[1]);
  assert.ok(screenshotRefs.length >= 12, `expected broad screenshot coverage, found ${screenshotRefs.length}`);
  for (const ref of screenshotRefs) {
    assert.equal(fs.existsSync(path.join(repoRoot, ref)), true, `missing README screenshot: ${ref}`);
  }
});

function readWorkflow(name) {
  return fs.readFileSync(path.join(workflowsDir, name), "utf8");
}
