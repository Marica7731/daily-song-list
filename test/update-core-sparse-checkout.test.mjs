import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_PATH = process.env.UPDATE_CORE_WORKFLOW_PATH
  ? resolve(process.env.UPDATE_CORE_WORKFLOW_PATH)
  : join(ROOT, ".github/workflows/update-core.yml");
const WORKFLOW = readFileSync(WORKFLOW_PATH, "utf8");

function runGit(cwd, args, input = undefined) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    windowsHide: true,
  });
}

function assertGitOk(result, label) {
  assert.equal(
    result.status,
    0,
    `${label} failed\nstdout=${result.stdout}\nstderr=${result.stderr}`,
  );
}

test("update-core uses sparse-checkout add --stdin without the invalid add --no-cone option", () => {
  assert.match(
    WORKFLOW,
    /\["git", "sparse-checkout", "add", "--stdin"\]/u,
  );
  assert.doesNotMatch(
    WORKFLOW,
    /\["git", "sparse-checkout", "add", "--no-cone"/u,
  );
  assert.match(
    WORKFLOW,
    /input=""\.join\(f"\{path\}\\n" for path in paths\)/u,
  );
  assert.match(WORKFLOW, /or "\\r" in value or "\\n" in value or "\\x00" in value/u);
});

test("non-cone sparse checkout accepts additional exact paths through stdin", () => {
  const repo = mkdtempSync(join(tmpdir(), "daily-song-p1-sparse-"));
  try {
    assertGitOk(runGit(repo, ["init", "-q"]), "git init");
    assertGitOk(runGit(repo, ["config", "user.email", "test@example.invalid"]), "git config email");
    assertGitOk(runGit(repo, ["config", "user.name", "P1 sparse test"]), "git config name");

    mkdirSync(join(repo, "nested"));
    writeFileSync(join(repo, "root.txt"), "root\n", "utf8");
    writeFileSync(join(repo, "nested", "kept.txt"), "kept\n", "utf8");
    writeFileSync(join(repo, "nested", "other.txt"), "other\n", "utf8");
    assertGitOk(runGit(repo, ["add", "."]), "git add fixture");
    assertGitOk(runGit(repo, ["commit", "-qm", "fixture"]), "git commit fixture");

    assertGitOk(runGit(repo, ["sparse-checkout", "init", "--no-cone"]), "sparse init");
    assertGitOk(runGit(repo, ["sparse-checkout", "set", "--stdin"], "root.txt\n"), "sparse set");
    assert.equal(existsSync(join(repo, "nested", "kept.txt")), false);

    assertGitOk(
      runGit(repo, ["sparse-checkout", "add", "--stdin"], "nested/kept.txt\n"),
      "sparse add stdin",
    );
    assert.equal(existsSync(join(repo, "nested", "kept.txt")), true);
    assert.equal(existsSync(join(repo, "nested", "other.txt")), false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("binder failure skips manifest consumers while the final failure gate remains blocking", () => {
  assert.match(
    WORKFLOW,
    /- name: Bind and materialize exact core inputs\n\s+id: inputs/u,
  );
  assert.match(
    WORKFLOW,
    /- name: Validate generated output paths\n\s+id: outputs\n\s+if: always\(\) && steps\.inputs\.outcome == 'success'/u,
  );
  assert.match(
    WORKFLOW,
    /- name: Restore verified core outputs after core failure\n\s+if: always\(\) && steps\.inputs\.outcome == 'success' && steps\.outputs\.outcome == 'success' && steps\.core\.outcome != 'success'/u,
  );
  assert.match(
    WORKFLOW,
    /- name: Revalidate persisted outputs after transient cleanup\n\s+id: finaloutputs\n\s+if: always\(\) && steps\.inputs\.outcome == 'success' && steps\.outputs\.outcome == 'success' && steps\.transient_cleanup\.outcome == 'success'/u,
  );
  assert.match(
    WORKFLOW,
    /- name: Fail when core update failed\n\s+if: always\(\) && steps\.core\.outcome != 'success'\n\s+run: exit 1/u,
  );
});
