const fs = require("node:fs");
const path = require("node:path");

const { sha256 } = require("./html-utils");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeShardedBundle(outputDir, bundle, options = {}) {
  const shardSize = options.shardSize || 1000;
  fs.mkdirSync(outputDir, { recursive: true });
  const manifest = {
    schemaVersion: 1,
    sourceSystem: bundle.sourceSystem,
    generatedAt: bundle.generatedAt,
    shardSize,
    counts: bundle.counts,
    shards: {},
  };

  for (const key of ["songs", "videos", "occurrences", "conflicts", "coverage", "failures"]) {
    const value = bundle[key];
    if (Array.isArray(value)) {
      manifest.shards[key] = writeArrayShards(outputDir, key, value, shardSize);
    } else if (value && typeof value === "object") {
      const fileName = `${key}.json`;
      writeJson(path.join(outputDir, fileName), value);
      manifest.shards[key] = [{ file: fileName, count: 1, sha256: sha256(JSON.stringify(value)) }];
    }
  }

  writeJson(path.join(outputDir, "manifest.json"), manifest);
  return manifest;
}

function writeArrayShards(outputDir, key, items, shardSize) {
  const shards = [];
  for (let index = 0; index < items.length; index += shardSize) {
    const shardItems = items.slice(index, index + shardSize);
    const fileName = `${key}-${String(shards.length + 1).padStart(4, "0")}.json`;
    const filePath = path.join(outputDir, fileName);
    writeJson(filePath, shardItems);
    shards.push({
      file: fileName,
      count: shardItems.length,
      sha256: sha256(JSON.stringify(shardItems)),
    });
  }
  return shards;
}

module.exports = {
  readJson,
  writeJson,
  writeShardedBundle,
};
