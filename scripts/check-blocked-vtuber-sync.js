#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_BLOCKLIST_PATH, blocklistHash, loadBlocklist, validateBlocklist } = require("./blocked-vtuber-utils");

const ROOT_DIR = path.resolve(__dirname, "..");

function main() {
  const sourcePath = path.resolve(ROOT_DIR, parseArg("--source") || DEFAULT_BLOCKLIST_PATH);
  const mirrorPathArg = parseArg("--mirror");
  const source = loadAndValidate(sourcePath, "source");
  const sourceHash = blocklistHash(source);

  if (mirrorPathArg) {
    const mirrorPath = path.resolve(ROOT_DIR, mirrorPathArg);
    const mirror = loadAndValidate(mirrorPath, "mirror");
    const mirrorHash = blocklistHash(mirror);
    if (sourceHash !== mirrorHash) fail(`BLOCKLIST_SYNC_FAIL sourceHash=${sourceHash} mirrorHash=${mirrorHash}`);
    console.log(`BLOCKLIST_SYNC_OK sourceHash=${sourceHash} mirror=${path.relative(ROOT_DIR, mirrorPath)}`);
    return;
  }

  console.log(`BLOCKLIST_SYNC_OK sourceHash=${sourceHash}`);
}

function loadAndValidate(filePath, label) {
  if (!fs.existsSync(filePath)) fail(`BLOCKLIST_SYNC_FAIL ${label} missing: ${filePath}`);
  const blocklist = loadBlocklist(filePath);
  const validation = validateBlocklist(blocklist);
  if (!validation.ok) fail(`BLOCKLIST_SYNC_FAIL ${label} invalid:\n${validation.errors.join("\n")}`);
  return blocklist;
}

function parseArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (require.main === module) main();
