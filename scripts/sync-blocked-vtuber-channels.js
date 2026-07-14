#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const { DEFAULT_BLOCKLIST_PATH, blocklistHash, loadBlocklist, validateBlocklist } = require("./blocked-vtuber-utils");

const ROOT_DIR = path.resolve(__dirname, "..");

function main() {
  const sourceArg = parseArg("--source");
  if (!sourceArg) fail("missing required --source path");
  const sourcePath = path.resolve(process.cwd(), sourceArg);
  const targetPath = path.resolve(ROOT_DIR, parseArg("--out") || DEFAULT_BLOCKLIST_PATH);
  if (!fs.existsSync(sourcePath)) fail(`source file not found: ${sourcePath}`);

  const source = loadBlocklist(sourcePath);
  const validation = validateBlocklist(source);
  if (!validation.ok) fail(validation.errors.join("\n"));

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
  const hash = blocklistHash(source);
  console.log(`BLOCKLIST_SYNC_COPY_OK hash=${hash} target=${path.relative(ROOT_DIR, targetPath)}`);
}

function parseArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function fail(message) {
  console.error(`BLOCKLIST_SYNC_COPY_FAIL ${message}`);
  process.exit(1);
}

if (require.main === module) main();
