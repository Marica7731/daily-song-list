const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const workflowsDir = path.join(__dirname, "..", ".github", "workflows");

test("core, review, and code checks use separate workflow files and concurrency groups", () => {
  const core = readWorkflow("update-core.yml");
  const review = readWorkflow("build-review.yml");
  const check = readWorkflow("check-code.yml");

  assert.match(core, /name:\s*Update core song-list data/u);
  assert.match(core, /group:\s*daily-song-list-core/u);
  assert.match(core, /cancel-in-progress:\s*true/u);
  assert.match(core, /npm run update:core/u);
  assert.doesNotMatch(core, /review:build|build-review-queue|export-dirty-candidates/u);
  assert.match(core, /npm run mark:failure/u);
  assert.match(core, /git add data\/latest\.json/u);
  assert.match(core, /git pull --rebase origin main/u);

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

function readWorkflow(name) {
  return fs.readFileSync(path.join(workflowsDir, name), "utf8");
}
