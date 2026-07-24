const fs = require("node:fs");

const inputPath = process.argv[2];
if (!inputPath) {
  throw new Error("usage: node scripts/compact-static-index.js <index-path>");
}

let html = fs.readFileSync(inputPath, "utf8");
html = html.replace(/<!--[\s\S]*?-->/gu, "");
html = html.replace(/<svg\b[\s\S]*?<\/svg>/gu, "");
html = html.replace(
  /<section class="content-shell rank-panel skeleton-panel" id="videoList"[\s\S]*?<\/section>/u,
  '<section class="content-shell rank-panel" id="videoList" aria-busy="true"></section>',
);
html = html.replace(/>\s+</gu, "><");
html = html.replace(/\s{2,}/gu, " ");
fs.writeFileSync(inputPath, html, "utf8");

const bytes = fs.statSync(inputPath).size;
if (bytes >= 10000 || !html.includes("assets/app-h95090fdb1212.js")) {
  throw new Error(`rollback index is not compact or does not reference the previous app asset: ${bytes} bytes`);
}
console.log(`CODEX_STATIC_INDEX_COMPACT_OK bytes=${bytes}`);
