import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const updateCore = readFileSync(join(ROOT, ".github/workflows/update-core.yml"), "utf8");
const deployIncremental = readFileSync(join(ROOT, ".github/workflows/deploy-pg-incremental.yml"), "utf8");

assert.match(updateCore, /name: Prepare authoritative 7D producer artifact/u);
assert.match(updateCore, /if: steps\.publish\.outputs\.pushed == 'true'/u);
assert.match(updateCore, /daily-song-list-authoritative-7d-\$\{GITHUB_RUN_ID\}-\$\{GITHUB_RUN_ATTEMPT\}/u);
assert.match(updateCore, /source_blob_sha="\$\(git rev-parse "\$\{source_sha\}:data\/7d\.json"\)"/u);
assert.match(updateCore, /actions\/upload-artifact@v4/u);

assert.match(deployIncremental, /artifact_blob_sha="\$\(git hash-object "\$WORKFLOW_RUN_DATA_PATH"\)"/u);
assert.match(deployIncremental, /\.sourceBlobSha == \$blob_sha/u);
assert.doesNotMatch(deployIncremental, /\.sourceSha == \$head/u);
assert.match(deployIncremental, /SOURCE_SHA="\$\(jq -er '\.sourceSha/u);
assert.match(deployIncremental, /source-commit-7d-blob-mismatch/u);
assert.match(deployIncremental, /WORKFLOW_RUN_ROUTE=authoritative-7d/u);

const bytes = Buffer.from('{"range":"7d","items":[]}\n', "utf8");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const gitBlobSha = createHash("sha1")
  .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, "utf8"), bytes]))
  .digest("hex");
assert.match(sha256, /^[0-9a-f]{64}$/u);
assert.match(gitBlobSha, /^[0-9a-f]{40}$/u);
assert.notEqual(sha256, gitBlobSha);

console.log("AUTHORITATIVE_7D_HANDOFF_PRODUCT_TEST_OK");
