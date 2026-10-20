const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const files = [];
collect(ROOT);

for (const file of files) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}
console.log(`[check-js-syntax] checked ${files.length} JavaScript file(s).`);

function collect(dir) {
  for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
    if ([".git", "node_modules"].includes(dirent.name)) continue;
    const fullPath = path.join(dir, dirent.name);
    if (dirent.isDirectory()) collect(fullPath);
    else if (dirent.isFile() && dirent.name.endsWith(".js")) files.push(fullPath);
  }
}
