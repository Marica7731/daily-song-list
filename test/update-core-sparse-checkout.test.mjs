import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW = fs.readFileSync(path.join(ROOT, ".github/workflows/update-core.yml"), "utf8");

test("update-core checks out controlled Git inputs without an application manifest binder", () => {
  for (const required of [
    "/data/external/youtube-channel-discovery/accepted/**",
    "/data/external/vsinger-http/backfill/**",
    "/data/snapshots/**",
    "/data/catalog-segments/**",
    "/data/diff/**",
  ]) {
    assert.match(WORKFLOW, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  for (const removed of [
    "Bind and materialize exact core inputs",
    "CORE_INPUT_MANIFEST",
    "CORE_OUTPUT_MANIFEST",
    "validate_manifest_content",
    "validate_vsinger_json_batch",
    "CORE_INPUT_MANIFEST_OK",
    "CORE_OUTPUT_MANIFEST_OK",
    "--compare-ref",
  ]) {
    assert.doesNotMatch(WORKFLOW, new RegExp(removed, "u"));
  }
});

test("update-core runs producers without business validation commands", () => {
  for (const command of [
    "node scripts/update-songlist.js",
    "node scripts/apply-song-search-niche.js",
    "node scripts/fetch-channel-avatar-cache.js --daily",
    "node scripts/build-runtime-data.js",
  ]) {
    assert.match(WORKFLOW, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
  assert.doesNotMatch(WORKFLOW, /validate:core|scripts\/validate-data\.js|check:published:api/u);
});

test("update-core retains only path scope and ordinary non-force Git publication", () => {
  assert.match(WORKFLOW, /path_allowed\(\)/u);
  assert.match(WORKFLOW, /CORE_PATH_SCOPE_BLOCKED/u);
  assert.match(WORKFLOW, /git push origin HEAD:main/u);
  assert.doesNotMatch(WORKFLOW, /git push[^\n]*(?:--force|-f\b)/u);
  assert.match(WORKFLOW, /name: Observe public health[\s\S]*?continue-on-error: true/u);
  assert.match(WORKFLOW, /name: Fail only when core program failed/u);
});
