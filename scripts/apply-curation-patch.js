const fs = require("node:fs");
const path = require("node:path");
const { OVERRIDES_PATH, mergeCurationPatch } = require("./curation");

if (require.main === module) {
  main();
}

function main() {
  const patchPath = process.argv[2];
  if (!patchPath) {
    console.error("Usage: node scripts/apply-curation-patch.js path/to/curation_patch.json");
    process.exit(2);
  }

  const resolvedPatchPath = path.resolve(process.cwd(), patchPath);
  if (!fs.existsSync(resolvedPatchPath)) {
    console.error(`[curation-patch] patch not found: ${patchPath}`);
    process.exit(2);
  }

  const existing = readJsonIfExists(OVERRIDES_PATH) || { schemaVersion: 1, records: [] };
  const patch = readJson(resolvedPatchPath);
  const result = mergeCurationPatch(existing, patch);
  if (!result.ok) {
    for (const error of result.errors) console.error(`[curation-patch] ${error}`);
    console.error(
      `[curation-patch] added=${result.counts.added} updated=${result.counts.updated} ignored=${result.counts.ignored} conflicts=${result.counts.conflicts}`,
    );
    process.exit(1);
  }

  writeJson(OVERRIDES_PATH, {
    ...result.merged,
    updatedAt: new Date().toISOString(),
    audit: [
      ...listValues(existing.audit),
      {
        appliedAt: new Date().toISOString(),
        patchPath: path.relative(path.dirname(OVERRIDES_PATH), resolvedPatchPath).replace(/\\/g, "/"),
        counts: result.counts,
      },
    ].slice(-50),
  });
  console.log(
    `[curation-patch] added=${result.counts.added} updated=${result.counts.updated} ignored=${result.counts.ignored} conflicts=${result.counts.conflicts}`,
  );
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readJsonIfExists(filePath) {
  try {
    return readJson(filePath);
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function listValues(value) {
  return Array.isArray(value) ? value : [];
}
