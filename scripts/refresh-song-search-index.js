const fs = require("node:fs");
const path = require("node:path");
const { fetchSongSearchIndex } = require("./song-search-index");

const ROOT = path.resolve(__dirname, "..");
const OUTPUT_PATH = path.join(ROOT, "data", "song-search-known-songs.json");

if (require.main === module) {
  main().catch((error) => {
    console.error(`[song-search-index] ${error.stack || error.message}`);
    process.exit(1);
  });
}

async function main() {
  const index = await fetchSongSearchIndex();
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  console.log(
    `[song-search-index] files=${index.fileCount}/${index.manifestFileCount} skipped=${index.skippedFileCount} records=${index.recordCount} titleKeys=${index.titleKeyCount} titleArtistKeys=${index.titleArtistKeyCount}`,
  );
}
