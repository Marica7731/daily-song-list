import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const candidateRoot = resolve(testDirectory, "..");
const workflowPath = resolve(testDirectory, "..", ".github", "workflows", "check-code.yml");

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
