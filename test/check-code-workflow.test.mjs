import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const candidateRoot = resolve(testDirectory, "..");
const workflowPath = resolve(testDirectory, "..", ".github", "workflows", "check-code.yml");
const checkSourcePath = ".codex-check-source";

function checkJob(workflow) {
  const start = workflow.indexOf("  check:\n");
  const end = workflow.indexOf("\n  curation_audit:\n", start);
  assert.notEqual(start, -1, "check job must exist");
  assert.notEqual(end, -1, "curation audit job must follow check job");
  return workflow.slice(start, end);
}

function runBlocks(workflow) {
  const blocks = [];
  for (const match of workflow.matchAll(/^ {8}run: \|\n([\s\S]*?)(?=^ {6}- name:|^  [A-Za-z_][^:\n]*:|(?![\s\S]))/gm)) {
    blocks.push(match[1]);
  }
  for (const match of workflow.matchAll(/^ {8}run: ([^|\n].*)$/gm)) {
    blocks.push(`${match[1]}\n`);
  }
  return blocks;
}

function precleanRunBlock(workflow) {
  const job = checkJob(workflow);
  const match = job.match(/- name: Prepare clean Check code source\n        working-directory: \$\{\{ github\.workspace \}\}\n        run: \|\n([\s\S]*?)\n\n      - name: Checkout/);
  assert.ok(match, "preclean must run from the workspace before Checkout");
  return match[1].replace(/^ {10}/gm, "");
}

function postcleanRunBlock(workflow) {
  const job = checkJob(workflow);
  const match = job.match(/- name: Remove Check code source\n        if: always\(\)\n        working-directory: \$\{\{ github\.workspace \}\}\n        run: \|\n([\s\S]*?)\s*$/);
  assert.ok(match, "postclean must always run from the workspace after checks");
  return match[1].replace(/^ {10}/gm, "");
}

function baseGateRunBlock(workflow) {
  const job = checkJob(workflow);
  const match = job.match(/- name: Run checks[\s\S]*?run: \|\n([\s\S]*?)\n          run_ui_proof=1/);
  assert.ok(match, "Run checks base gate must exist");
  return match[1].replace(/^ {10}/gm, "");
}

function gateDecisionRunBlock(workflow) {
  const job = checkJob(workflow);
  const match = job.match(/          run_ui_proof=1\n([\s\S]*?)\n          node scripts\/check-js-syntax\.js/);
  assert.ok(match, "Run checks gate decisions must exist");
  return `run_ui_proof=1\n${match[1].replace(/^ {10}/gm, "")}`;
}

function pushPathPatterns(workflow) {
  const match = workflow.match(/  push:\n    branches:\n      - main\n    paths:\n([\s\S]*?)  workflow_dispatch:/);
  assert.ok(match, "Check code push paths must exist");
  return [...match[1].matchAll(/^      - "([^"]+)"$/gm)].map((entry) => entry[1]);
}

function workflowTriggersPush(patterns, filePath) {
  return patterns.some((pattern) => pattern.endsWith("/**") ? filePath.startsWith(pattern.slice(0, -2)) : pattern === filePath);
}

function runGateDecisions(script, fixtureRoot, base) {
  const output = execFileSync("bash", ["-c", 'base="${CHECK_BASE:-}"\n' + script + '\nprintf "GATES ui=%s data=%s budget=%s\\n" "$run_ui_proof" "$run_data_validate" "$run_budget"\n'], {
    cwd: fixtureRoot,
    env: { ...process.env, CHECK_BASE: base },
  }).toString("utf8");
  const match = output.match(/GATES ui=(\d+) data=(\d+) budget=(\d+)/);
  assert.ok(match, "gate decision script must report all gates");
  return { ui: Number(match[1]), data: Number(match[2]), budget: Number(match[3]) };
}

function primarySparsePatterns(workflow) {
  const job = checkJob(workflow);
  const checkout = job.match(/- name: Checkout\n        uses: actions\/checkout@v4\n        with:\n([\s\S]*?)\n\n      - name: Configure Mac toolchain/);
  assert.ok(checkout, "primary checkout must exist");
  const sparse = checkout[1].match(/sparse-checkout: \|\n([\s\S]*?)\n          sparse-checkout-cone-mode/);
  assert.ok(sparse, "primary sparse patterns must exist");
  return sparse[1].split("\n").map((line) => line.trim()).filter(Boolean);
}

function validateSparseAddPatterns(workflow) {
  const job = checkJob(workflow);
  const match = job.match(/if \[ "\$\{run_data_validate\}" = "1" \]; then\n            git sparse-checkout add \\\n([\s\S]*?)\n            npm run validate/);
  assert.ok(match, "validate must materialize sparse data before npm run validate");
  return match[1].split("\n").map((line) => line.trim().replace(/ \\$/, "")).filter(Boolean);
}

function dataGatePathspecs(workflow) {
  const job = checkJob(workflow);
  const match = job.match(/data_changes="\$\(git diff --name-only "\$\{base\}" HEAD -- \\\n([\s\S]*?)\)"/);
  assert.ok(match, "data validate gate must use explicit diff pathspecs");
  return match[1].split("\n").map((line) => line.trim().replace(/ \\$/, "")).filter(Boolean);
}

async function validateRequireClosure() {
  const pending = [resolve(candidateRoot, "scripts", "validate-data.js")];
  const visited = new Set();
  while (pending.length) {
    const filePath = pending.pop();
    if (visited.has(filePath)) continue;
    visited.add(filePath);
    const source = await readFile(filePath, "utf8");
    for (const match of source.matchAll(/require\(["'](\.{1,2}\/[^"']+)["']\)/g)) {
      const target = resolve(dirname(filePath), `${match[1]}.js`);
      if (target.startsWith(`${candidateRoot}/`)) pending.push(target);
    }
  }
  return [...visited].map((filePath) => relative(candidateRoot, filePath).replaceAll("\\", "/")).sort();
}

async function validatorTrackedDataRoots() {
  const source = await readFile(resolve(candidateRoot, "scripts", "validate-data.js"), "utf8");
  const roots = [
    ["data/latest.json", /const LATEST_PATH = path\.join\(DATA_DIR, "latest\.json"\)/],
    ["data/snapshots", /const INDEX_PATH = path\.join\(DATA_DIR, "snapshots", "index\.json"\)/],
    ["data/diff", /path\.join\(DATA_DIR, "diff", range\.file\)/],
    ["data/ui", /const UI_META_PATH = path\.join\(DATA_DIR, "ui", "meta\.json"\)/],
    ["data/video-catalog.json", /VIDEO_CATALOG_PATH/],
    ["data/review", /const reviewDir = path\.join\(DATA_DIR, "review"\)/],
    ["data/song-search-known-songs.json", /const SONG_SEARCH_INDEX_PATH = path\.join\(DATA_DIR, "song-search-known-songs\.json"\)/],
  ];
  for (const [, matcher] of roots) assert.match(source, matcher);
  return roots.map(([root]) => root);
}

async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value)}\n`);
}

async function assertValidateDataDependencyProbe(root) {
  const validateSource = await readFile(resolve(candidateRoot, "scripts", "validate-data.js"), "utf8");
  for (const dependency of [
    "LATEST_PATH",
    "INDEX_PATH",
    "UI_META_PATH",
    "VIDEO_CATALOG_PATH",
    "SONG_SEARCH_INDEX_PATH",
    "entry.path",
    "rangeMeta.legacyPath",
    "manifestPath",
    "pageMeta.path",
  ]) {
    assert.match(validateSource, new RegExp(dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  const readJson = async (relativePath) => JSON.parse(await readFile(join(root, relativePath), "utf8"));
  await readJson("data/latest.json");
  await readJson("data/video-catalog.json");
  await readJson("data/song-search-known-songs.json");
  await readJson("data/review/queue.json");
  await readJson("data/review/manifest.json");
  for (const entry of (await readJson("data/snapshots/index.json")).snapshots) await readJson(entry.path);
  await readJson("data/diff/latest-7d.json");
  await readJson("data/diff/latest-all.json");
  const meta = await readJson("data/ui/meta.json");
  for (const range of Object.values(meta.ranges)) {
    await readJson(range.path);
    await readJson(range.legacyPath);
    for (const shard of Object.values(range.shards || {})) {
      const manifest = await readJson(shard.manifestPath);
      for (const page of manifest.pages) await readJson(page.path);
    }
  }
}

test("non-UI Check code selection is tracked-only, NUL-safe, complete, and fail-closed", async () => {
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /git ls-files -z --/);
  assert.match(workflow, /'test\/\*\.test\.js'/);
  assert.match(workflow, /'test\/\*\*\/\*\.test\.js'/);
  assert.match(workflow, /'test\/\*\.test\.mjs'/);
  assert.match(workflow, /'test\/\*\*\/\*\.test\.mjs'/);
  assert.match(workflow, /while IFS= read -r -d '' test_file; do/);
  assert.match(workflow, /test\/ui-proof\.test\.js\|test\/ui-proof\.test\.mjs\) continue ;;/);
  assert.match(workflow, /test_files\+=\("\$\{test_file\}"\)/);
  assert.match(workflow, /\[ "\$\{#test_files\[@\]\}" -eq 0 \]/);
  assert.match(workflow, /node --test "\$\{test_files\[@\]\}"/);
  assert.match(workflow, /npm test/);
  assert.doesNotMatch(workflow, /\beval\b/);
});

test("the checked-in pathspecs include tracked JS and MJS only, including unusual names", async () => {
  const fixtureRoot = await mkdtemp(join(candidateRoot, ".selector-fixture-"));
  try {
    await mkdir(join(fixtureRoot, "test"), { recursive: true });
    await writeFile(join(fixtureRoot, ".gitignore"), "test/ignored.test.mjs\n");
    await writeFile(join(fixtureRoot, "test", "root.test.js"), "");
    await writeFile(join(fixtureRoot, "test", "root.test.mjs"), "");
    await writeFile(join(fixtureRoot, "test", "nested name.test.mjs"), "");
    await writeFile(join(fixtureRoot, "test", "ui-proof.test.js"), "");
    await writeFile(join(fixtureRoot, "test", "untracked.test.js"), "");
    await writeFile(join(fixtureRoot, "test", "ignored.test.mjs"), "");
    execFileSync("git", ["init", "--quiet", fixtureRoot]);
    execFileSync("git", ["-C", fixtureRoot, "add", ".gitignore", "test/root.test.js", "test/root.test.mjs", "test/nested name.test.mjs", "test/ui-proof.test.js"]);

    const selected = execFileSync("git", ["-C", fixtureRoot, "ls-files", "-z", "--", "test/*.test.js", "test/**/*.test.js", "test/*.test.mjs", "test/**/*.test.mjs"])
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .filter((file) => file !== "test/ui-proof.test.js" && file !== "test/ui-proof.test.mjs");

    assert.deepEqual(selected, ["test/nested name.test.mjs", "test/root.test.js", "test/root.test.mjs"]);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("Check code starts in a fixed sparse source tree with every initial dependency", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const job = checkJob(workflow);
  const checkout = job.match(/- name: Checkout\n        uses: actions\/checkout@v4\n        with:\n([\s\S]*?)\n\n      - name: Configure Mac toolchain/);

  assert.ok(checkout, "primary checkout must retain its YAML with block");
  assert.match(job, new RegExp(`defaults:\\n      run:\\n        working-directory: ${checkSourcePath}`));
  assert.match(checkout[1], new RegExp(`path: ${checkSourcePath}`));
  assert.match(checkout[1], /fetch-depth: 50/);
  assert.match(checkout[1], /filter: blob:none/);
  assert.match(checkout[1], /sparse-checkout-cone-mode: false/);

  const sparse = primarySparsePatterns(workflow);
  for (const dependency of [
    ".github",
    "/artifacts/migration/curation-global-singleton-minimal.json",
    "assets",
    "config",
    "data/review",
    "deploy",
    "docs",
    "scripts",
    "server",
    "test",
    "/package.json",
    "/index.html",
    "/README.md",
  ]) {
    assert.ok(sparse.includes(dependency), `initial sparse checkout must include ${dependency}`);
  }
  assert.equal(sparse.some((dependency) => dependency.startsWith("data/external/")), false);
  assert.equal(sparse.some((dependency) => dependency === "data/ui" || dependency === "data/diff"), false);
  assert.match(job, new RegExp(`path: ${checkSourcePath}/\\.tmp/check-code-mygit`));
  assert.match(job, /--source \.tmp\/check-code-mygit\/config\/blocked-vtuber-channels\.json/);
  assert.ok(job.indexOf("- name: Prepare clean Check code source") < job.indexOf("- name: Checkout"));
});

test("Check code conditionally materializes the complete validate closure before large data gates", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const job = checkJob(workflow);

  assert.doesNotMatch(job, /git sparse-checkout disable/);
  assert.doesNotMatch(job, /git checkout --force/);
  assert.match(job, /run_budget=1/);
  assert.match(job, /index\.html \\\n+              assets \\\n+              data\/ui \\\n+              data\/diff \\\n+              scripts\/check-runtime-budgets\.js/);
  const validateAdd = validateSparseAddPatterns(workflow);
  const expectedAdd = (await validatorTrackedDataRoots())
    .filter((root) => root !== "data/review")
    .map((root) => root.endsWith(".json") ? `/${root}` : `/${root}/`)
    .sort();
  assert.deepEqual([...validateAdd].sort(), expectedAdd, "sparse add must be derived only from validator data roots absent from initial sparse");
  assert.equal(validateAdd.some((dependency) => dependency.includes("status") || dependency.includes("external")), false);
  assert.match(job, /git sparse-checkout add \\\n+              \/data\/ui\/ \\\n+              \/data\/diff\//);
  assert.match(job, /CODEX_DATA_VALIDATE_SKIPPED reason=no-data-input-changes/);
  assert.match(job, /CODEX_BUDGET_SKIPPED reason=no-budget-input-changes/);
  assert.match(job, /npm run validate/);
  assert.match(job, /npm run check:budget/);
  assert.doesNotMatch(job, /git sparse-checkout add --no-cone/);
});

test("push paths and base diff gate cover the exact validate closure without accepting discovery", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const job = checkJob(workflow);
  const patterns = pushPathPatterns(workflow);
  const gateScript = gateDecisionRunBlock(workflow);
  const dataRoots = await validatorTrackedDataRoots();
  const dataDependencies = dataRoots.map((root) => root.endsWith(".json") ? root : `${root}/fixture.json`);
  const requireClosure = await validateRequireClosure();
  assert.equal(requireClosure.filter((filePath) => filePath.startsWith("scripts/")).length, 9);
  assert.equal(requireClosure.filter((filePath) => filePath.startsWith("assets/")).length, 3);
  const codeDependencies = ["config/validator-fixture.json", "package.json", ...requireClosure];
  assert.deepEqual([...dataGatePathspecs(workflow)].sort(), ["config", "package.json", ...requireClosure, ...dataRoots].sort());
  for (const dependency of dataDependencies) assert.equal(workflowTriggersPush(patterns, dependency), true, `${dependency} must trigger Check code`);
  for (const dependency of codeDependencies) assert.equal(workflowTriggersPush(patterns, dependency), true, `${dependency} must trigger Check code`);
  assert.equal(workflowTriggersPush(patterns, "data/external/youtube-channel-discovery/accepted/fixture.json"), false);
  assert.equal(workflowTriggersPush(patterns, "data/status.json"), false);
  assert.equal(dataGatePathspecs(workflow).some((pathspec) => pathspec.includes("status") || pathspec.includes("external")), false);

  const fixtureRoot = await mkdtemp(join(candidateRoot, ".validate-gate-fixture-"));
  try {
    const trackedPaths = [...dataDependencies, ...codeDependencies, "data/external/youtube-channel-discovery/accepted/fixture.json", "data/status.json"];
    for (const relativePath of trackedPaths) {
      await mkdir(dirname(join(fixtureRoot, relativePath)), { recursive: true });
      await writeFile(join(fixtureRoot, relativePath), "base\n");
    }
    execFileSync("git", ["init", "--quiet", fixtureRoot]);
    execFileSync("git", ["-C", fixtureRoot, "add", "."]);
    execFileSync("git", ["-C", fixtureRoot, "-c", "user.name=Codex", "-c", "user.email=codex@example.invalid", "commit", "--quiet", "-m", "base"]);
    const multiCommitBase = execFileSync("git", ["-C", fixtureRoot, "rev-parse", "HEAD"]).toString("utf8").trim();
    let previous = multiCommitBase;
    for (const relativePath of [...dataDependencies, ...codeDependencies]) {
      await writeFile(join(fixtureRoot, relativePath), `changed ${relativePath}\n`);
      execFileSync("git", ["-C", fixtureRoot, "add", relativePath]);
      execFileSync("git", ["-C", fixtureRoot, "-c", "user.name=Codex", "-c", "user.email=codex@example.invalid", "commit", "--quiet", "-m", `change ${relativePath}`]);
      assert.equal(runGateDecisions(gateScript, fixtureRoot, previous).data, 1, `${relativePath} must run validate`);
      previous = execFileSync("git", ["-C", fixtureRoot, "rev-parse", "HEAD"]).toString("utf8").trim();
    }
    assert.equal(runGateDecisions(gateScript, fixtureRoot, multiCommitBase).data, 1, "before..HEAD must retain every intermediate validate input");
    await writeFile(join(fixtureRoot, "data/external/youtube-channel-discovery/accepted/fixture.json"), "accepted-only\n");
    execFileSync("git", ["-C", fixtureRoot, "add", "data/external/youtube-channel-discovery/accepted/fixture.json"]);
    execFileSync("git", ["-C", fixtureRoot, "-c", "user.name=Codex", "-c", "user.email=codex@example.invalid", "commit", "--quiet", "-m", "accepted discovery"]);
    assert.equal(runGateDecisions(gateScript, fixtureRoot, previous).data, 0, "accepted discovery must not materialize validate data");
    assert.deepEqual(runGateDecisions(gateScript, fixtureRoot, ""), { ui: 1, data: 1, budget: 1 }, "workflow_dispatch must run every gate");
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("push base diff is fail-closed while workflow dispatch runs every gate", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const job = checkJob(workflow);
  const script = baseGateRunBlock(workflow);
  const fixtureRoot = await mkdtemp(join(candidateRoot, ".base-gate-fixture-"));
  try {
    await writeFile(join(fixtureRoot, "commit.txt"), "base\n");
    execFileSync("git", ["init", "--quiet", fixtureRoot]);
    execFileSync("git", ["-C", fixtureRoot, "add", "commit.txt"]);
    execFileSync("git", ["-C", fixtureRoot, "-c", "user.name=Codex", "-c", "user.email=codex@example.invalid", "commit", "--quiet", "-m", "base"]);
    const base = execFileSync("git", ["-C", fixtureRoot, "rev-parse", "HEAD"]).toString("utf8").trim();
    await writeFile(join(fixtureRoot, "commit.txt"), "head\n");
    execFileSync("git", ["-C", fixtureRoot, "add", "commit.txt"]);
    execFileSync("git", ["-C", fixtureRoot, "-c", "user.name=Codex", "-c", "user.email=codex@example.invalid", "commit", "--quiet", "-m", "head"]);

    const pushOutput = execFileSync("bash", ["-c", script], {
      cwd: fixtureRoot,
      env: { ...process.env, CHECK_EVENT_NAME: "push", CHECK_BASE_SHA: base },
    }).toString("utf8");
    assert.match(pushOutput, new RegExp(`CODEX_CHECK_BASE_OK event=push base=${base}`));
    assert.throws(() => execFileSync("bash", ["-c", script], {
      cwd: fixtureRoot,
      env: { ...process.env, CHECK_EVENT_NAME: "push", CHECK_BASE_SHA: "not-a-sha" },
    }));
    assert.throws(() => execFileSync("bash", ["-c", script], {
      cwd: fixtureRoot,
      env: { ...process.env, CHECK_EVENT_NAME: "push", CHECK_BASE_SHA: "0".repeat(40) },
    }));
    const dispatchOutput = execFileSync("bash", ["-c", script], {
      cwd: fixtureRoot,
      env: { ...process.env, CHECK_EVENT_NAME: "workflow_dispatch", CHECK_BASE_SHA: "" },
    }).toString("utf8");
    assert.match(dispatchOutput, /CODEX_CHECK_BASE_FULL_GATES event=workflow_dispatch/);

    const fakeBin = join(fixtureRoot, "fake-bin");
    await mkdir(fakeBin);
    const fakeGit = join(fakeBin, "git");
    await writeFile(fakeGit, `#!/usr/bin/env bash
if [ "\${1:-}" = "cat-file" ]; then
  test -e "\${FAKE_OBJECT_PRESENT:?}" && exit 0
  exit 1
fi
case " $* " in
  *" fetch "*)
    case "\${FAKE_FETCH_MODE:-success}" in
      fail) exit 1 ;;
      missing) exit 0 ;;
      hang)
        trap '' TERM
        (trap '' TERM; while :; do sleep 1; done) &
        child=$!
        printf '%s %s\\n' "$$" "$child" > "\${FAKE_PID_FILE:?}"
        while :; do sleep 1; done
        ;;
      hang-parent-exits)
        trap 'exit 0' TERM
        (trap '' TERM; while :; do sleep 1; done) &
        child=$!
        printf '%s %s\\n' "$$" "$child" > "\${FAKE_PID_FILE:?}"
        while :; do sleep 1; done
        ;;
      *) : > "\${FAKE_OBJECT_PRESENT:?}"; exit 0 ;;
    esac
    ;;
esac
exit 0
`);
    await chmod(fakeGit, 0o755);
    const fakeBase = "a".repeat(40);
    const objectMarker = join(fixtureRoot, "fake-object");
    const fakeEnv = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, CHECK_EVENT_NAME: "push", CHECK_BASE_SHA: fakeBase, FAKE_OBJECT_PRESENT: objectMarker };
    const fetchFailure = spawnSync("bash", ["-c", script], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: { ...fakeEnv, FAKE_FETCH_MODE: "fail" },
    });
    assert.equal(fetchFailure.status, 1);
    assert.match(fetchFailure.stderr, new RegExp(`CODEX_CHECK_BASE_FETCH_FAILED base=${fakeBase}`));
    const missingAfterFetch = spawnSync("bash", ["-c", script], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: { ...fakeEnv, FAKE_FETCH_MODE: "missing" },
    });
    assert.equal(missingAfterFetch.status, 1);
    assert.match(missingAfterFetch.stderr, new RegExp(`CODEX_CHECK_BASE_MISSING_AFTER_FETCH base=${fakeBase}`));
    const normalFetch = spawnSync("bash", ["-c", script], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: { ...fakeEnv, FAKE_FETCH_MODE: "success" },
    });
    assert.equal(normalFetch.status, 0);
    assert.match(normalFetch.stdout, new RegExp(`CODEX_CHECK_BASE_OK event=push base=${fakeBase}`));
    await rm(objectMarker, { force: true });
    const pidFile = join(fixtureRoot, "fake-fetch-pids");
    const shortDeadlineScript = script.replace("fetch_deadline_seconds=90", "fetch_deadline_seconds=1");
    const timeoutStartedAt = Date.now();
    const forcedTimeout = spawnSync("bash", ["-c", shortDeadlineScript], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: { ...fakeEnv, FAKE_FETCH_MODE: "hang", FAKE_PID_FILE: pidFile },
    });
    assert.equal(forcedTimeout.status, 1);
    assert.ok(Date.now() - timeoutStartedAt < 8000, "fetch process-group timeout must remain bounded");
    assert.match(forcedTimeout.stderr, new RegExp(`CODEX_CHECK_BASE_FETCH_TIMEOUT seconds=1 base=${fakeBase}`));
    assert.match(forcedTimeout.stderr, new RegExp(`CODEX_CHECK_BASE_FETCH_FAILED base=${fakeBase}`));
    const forcedPids = (await readFile(pidFile, "utf8")).trim().split(/\s+/).map(Number);
    for (const pid of forcedPids) assert.throws(() => process.kill(pid, 0), /ESRCH/);
    const parentExitsPidFile = join(fixtureRoot, "fake-fetch-parent-exits-pids");
    const parentExitsStartedAt = Date.now();
    const parentExitsTimeout = spawnSync("bash", ["-c", shortDeadlineScript], {
      cwd: fixtureRoot,
      encoding: "utf8",
      env: { ...fakeEnv, FAKE_FETCH_MODE: "hang-parent-exits", FAKE_PID_FILE: parentExitsPidFile },
    });
    assert.equal(parentExitsTimeout.status, 1);
    assert.ok(Date.now() - parentExitsStartedAt < 8000, "TERM-responsive parent timeout must remain bounded");
    assert.match(parentExitsTimeout.stderr, new RegExp(`CODEX_CHECK_BASE_FETCH_TIMEOUT seconds=1 base=${fakeBase}`));
    const parentExitsPids = (await readFile(parentExitsPidFile, "utf8")).trim().split(/\s+/).map(Number);
    for (const pid of parentExitsPids) assert.throws(() => process.kill(pid, 0), /ESRCH/);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }

  assert.match(job, /fetch_deadline_seconds=90/);
  assert.match(job, /python3 - "\$fetch_deadline_seconds" "\$fetch_log" "\$base" <<'PY'/);
  assert.match(job, /start_new_session=True/);
  assert.match(job, /os\.killpg\(process\.pid, sig\)/);
  assert.match(job, /signal_group\(signal\.SIGTERM\)/);
  assert.match(job, /signal_group\(signal\.SIGKILL\)/);
  assert.match(job, /process\.wait\(timeout=2\)/);
  assert.match(job, /process\.wait\(timeout=2\)[\s\S]*?signal_group\(signal\.SIGKILL\)/);
  assert.match(job, /finally:\n +if process is not None:\n +signal_group\(signal\.SIGKILL\)/);
  assert.match(job, /trap cleanup_fetch_log EXIT/);
  assert.match(job, /CODEX_CHECK_BASE_FETCH_TIMEOUT seconds=\$fetch_deadline_seconds base=\$base/);
  assert.match(job, /CODEX_CHECK_BASE_FETCH_FAILED base=\$base/);
  assert.match(job, /CODEX_CHECK_BASE_MISSING_AFTER_FETCH base=\$base/);
  assert.doesNotMatch(job, /HEAD\^/);
  assert.match(job, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(job, /\^0\{40\}\$/);
});

test("Check code preclean removes only the fixed isolated source and rejects unsafe roots", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const script = precleanRunBlock(workflow);
  const fixtureRoot = await mkdtemp(join(candidateRoot, ".preclean-fixture-"));
  const home = join(fixtureRoot, "Users", "be");
  const workspace = join(home, "actions-runner-work", "daily-song-list", "daily-song-list");
  const source = join(workspace, checkSourcePath);
  try {
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "stale.txt"), "stale");
    const output = execFileSync("bash", ["-c", script], {
      cwd: fixtureRoot,
      env: { ...process.env, GITHUB_WORKSPACE: workspace, HOME: home },
    }).toString("utf8");

    assert.match(output, /CODEX_CHECK_SOURCE_PRECLEAN before_bytes=\d+ path=.*\.codex-check-source/);
    assert.deepEqual(await readdir(source), []);
    assert.throws(
      () => execFileSync("bash", ["-c", script], { env: { ...process.env, GITHUB_WORKSPACE: "/", HOME: home } }),
    );
    assert.throws(
      () => execFileSync("bash", ["-c", script], { env: { ...process.env, GITHUB_WORKSPACE: home, HOME: home } }),
    );
    await rm(source, { force: true, recursive: true });
    await writeFile(source, "not-a-directory");
    assert.throws(() => execFileSync("bash", ["-c", script], { env: { ...process.env, GITHUB_WORKSPACE: workspace, HOME: home } }));
    await rm(source, { force: true });
    const outside = join(fixtureRoot, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "must-survive.txt"), "outside");
    await symlink(outside, source);
    assert.throws(() => execFileSync("bash", ["-c", script], { env: { ...process.env, GITHUB_WORKSPACE: workspace, HOME: home } }));
    assert.equal(await readFile(join(outside, "must-survive.txt"), "utf8"), "outside");
    assert.match(script, /source="\$source_parent\/\.codex-check-source"/);
    assert.match(script, /\[ -L "\$source" \]/);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("a real non-cone sparse checkout materializes every validate-data tracked dependency before validation", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const fixtureRoot = await mkdtemp(join(candidateRoot, ".sparse-add-fixture-"));
  try {
    for (const relativePath of [
      ".github/workflows/check-code.yml",
      "artifacts/migration/curation-global-singleton-minimal.json",
      "assets/fixture.txt",
      "config/fixture.json",
      "deploy/fixture.txt",
      "docs/fixture.md",
      "scripts/fixture.js",
      "server/fixture.js",
      "test/fixture.test.mjs",
      "package.json",
      "index.html",
      "README.md",
    ]) {
      await mkdir(dirname(join(fixtureRoot, relativePath)), { recursive: true });
      await writeFile(join(fixtureRoot, relativePath), "fixture\n");
    }
    await writeJson(join(fixtureRoot, "data/latest.json"), { schemaVersion: 1 });
    await writeJson(join(fixtureRoot, "data/status.json"), { status: "fixture" });
    await writeJson(join(fixtureRoot, "data/external/youtube-channel-discovery/fixture.json"), { sources: [] });
    await writeJson(join(fixtureRoot, "data/review/queue.json"), { schemaVersion: 1, items: [] });
    await writeJson(join(fixtureRoot, "data/review/manifest.json"), { schemaVersion: 1 });
    await writeJson(join(fixtureRoot, "data/snapshots/index.json"), {
      snapshots: [{ id: "20260729T000000Z", path: "data/snapshots/20260729T000000Z.json" }],
    });
    await writeJson(join(fixtureRoot, "data/snapshots/20260729T000000Z.json"), { schemaVersion: 1 });
    await writeJson(join(fixtureRoot, "data/diff/latest-7d.json"), { range: "7d" });
    await writeJson(join(fixtureRoot, "data/diff/latest-all.json"), { range: "all" });
    await writeJson(join(fixtureRoot, "data/video-catalog.json"), { schemaVersion: 1, videos: [] });
    await writeJson(join(fixtureRoot, "data/song-search-known-songs.json"), { schemaVersion: 1, titleKeys: [], titleArtistKeys: [] });
    await writeJson(join(fixtureRoot, "data/unrelated.json"), { mustRemainSparse: true });
    const shardKinds = ["runtime", "sourceDetails", "search"];
    const shards = {};
    for (const shardKind of shardKinds) {
      const manifestPath = `data/ui/ranges/7d/${shardKind}.manifest.json`;
      const pagePath = `data/ui/ranges/7d/${shardKind}.page-001.json`;
      shards[shardKind] = { manifestPath };
      await writeJson(join(fixtureRoot, pagePath), { page: shardKind });
      await writeJson(join(fixtureRoot, manifestPath), { pages: [{ path: pagePath }] });
    }
    await writeJson(join(fixtureRoot, "data/ui/meta.json"), {
      ranges: {
        "7d": {
          path: "data/ui/7d.0123456789ab.json",
          legacyPath: "data/ui/7d.json",
          shards,
        },
      },
    });
    await writeJson(join(fixtureRoot, "data/ui/7d.0123456789ab.json"), { id: "7d" });
    await writeJson(join(fixtureRoot, "data/ui/7d.json"), { id: "7d" });
    execFileSync("git", ["init", "--quiet", fixtureRoot]);
    execFileSync("git", ["-C", fixtureRoot, "add", "."]);
    execFileSync("git", ["-C", fixtureRoot, "-c", "user.name=Codex", "-c", "user.email=codex@example.invalid", "commit", "--quiet", "-m", "fixture"]);
    execFileSync("git", ["-C", fixtureRoot, "sparse-checkout", "init", "--no-cone"]);
    execFileSync("git", ["-C", fixtureRoot, "sparse-checkout", "set", "--no-cone", ...primarySparsePatterns(workflow)]);
    await assert.rejects(readFile(join(fixtureRoot, "data/ui/meta.json"), "utf8"));
    await assert.rejects(readFile(join(fixtureRoot, "data/snapshots/index.json"), "utf8"));
    await assert.rejects(readFile(join(fixtureRoot, "data/external/youtube-channel-discovery/fixture.json"), "utf8"));
    execFileSync("git", ["-C", fixtureRoot, "sparse-checkout", "add", ...validateSparseAddPatterns(workflow)]);
    await assertValidateDataDependencyProbe(fixtureRoot);
    await assert.rejects(readFile(join(fixtureRoot, "data/status.json"), "utf8"));
    await assert.rejects(readFile(join(fixtureRoot, "data/external/youtube-channel-discovery/fixture.json"), "utf8"));
    await assert.rejects(readFile(join(fixtureRoot, "data/unrelated.json"), "utf8"));
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("Check code postclean always removes only the isolated source and reports zero residue", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const script = postcleanRunBlock(workflow);
  const fixtureRoot = await mkdtemp(join(candidateRoot, ".postclean-fixture-"));
  const home = join(fixtureRoot, "Users", "be");
  const workspace = join(home, "actions-runner-work", "daily-song-list", "daily-song-list");
  const source = join(workspace, checkSourcePath);
  try {
    await mkdir(source, { recursive: true });
    await writeFile(join(source, "stale.txt"), "stale");
    const output = execFileSync("bash", ["-c", script], {
      cwd: fixtureRoot,
      env: { ...process.env, GITHUB_WORKSPACE: workspace, HOME: home },
    }).toString("utf8");

    assert.match(output, /CODEX_CHECK_SOURCE_POSTCLEAN before_bytes=\d+ after_bytes=0 path=.*\.codex-check-source/);
    await assert.rejects(readFile(join(source, "stale.txt"), "utf8"));
    assert.throws(() => execFileSync("bash", ["-c", script], { env: { ...process.env, GITHUB_WORKSPACE: home, HOME: home } }));
    assert.match(workflow, /- name: Remove Check code source\n        if: always\(\)/);
    assert.match(script, /after_bytes=0/);
    assert.match(script, /\[ "\$after_bytes" != "0" \]/);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("curation audit retains its independent full-workspace preparation", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const audit = workflow.slice(workflow.indexOf("  curation_audit:\n"));

  assert.match(audit, /- name: Ensure full audit workspace checkout/);
  assert.match(audit, /git sparse-checkout disable \|\| true/);
  assert.match(audit, /git checkout --force/);
});

test("every Check code workflow run block has valid Bash syntax", async () => {
  const workflow = await readFile(workflowPath, "utf8");
  const blocks = runBlocks(workflow);

  assert.ok(blocks.length >= 10, "expected every scalar and block run command to be checked");
  for (const [index, block] of blocks.entries()) {
    const bash = block.replace(/\$\{\{[\s\S]*?\}\}/g, "github_expression").replace(/^ {10}/gm, "");
    assert.doesNotThrow(
      () => execFileSync("bash", ["-n"], { input: bash, stdio: ["pipe", "pipe", "pipe"] }),
      `run block ${index + 1} must parse as Bash`,
    );
  }
});
