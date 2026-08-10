import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(TEST_DIR, "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "sync-wdc-release.yml");

test("WDC workflow exports one database snapshot and records only verified deployments", () => {
  const source = fs.readFileSync(WORKFLOW, "utf8");
  assert.match(source, /materialize-pg-release-snapshot\.py/);
  assert.match(source, /--expected-revision "\$expected_active"/);
  assert.match(source, /--property=MemoryMax=700M/);
  assert.match(source, /--property=Nice=15/);
  assert.match(source, /--property=CPUWeight=10/);
  assert.match(source, /--property=IOWeight=10/);
  assert.match(source, /test -s \/tmp\/dsl-wdc-meta\.json/);
  assert.match(source, /test "\$actual_pages" = "\$snapshot_pages"/);
  assert.match(source, /WDC_DOMAIN_VERIFIED/);
  assert.match(source, /health\["currentRelease"\] == expected_bundle/);
  assert.match(source, /bundle_sha="\$\{2:-\}"/);
  assert.doesNotMatch(source, /urllib\.request/);

  const materialize = source.indexOf("Materialize + build bundle");
  const verify = source.indexOf("Verify new domain");
  const record = source.indexOf("Record deployed active revision");
  assert(materialize >= 0 && verify > materialize && record > verify);
  assert.equal(source.slice(materialize, verify).includes("dsl-wdc-last-active"), false);
  assert.equal(source.slice(record).includes("dsl-wdc-last-active"), true);
});
