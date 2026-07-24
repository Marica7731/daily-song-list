const assert = require("node:assert/strict");
const test = require("node:test");

const { collectStaticPaths } = require("../scripts/resolve-static-deploy-paths.js");

test("static deploy paths follow current range metadata", () => {
  const paths = collectStaticPaths({
    ranges: {
      "7d": {
        path: "data/ui/7d.current.json",
        shards: { runtime: { manifestPath: "data/ui/ranges/7d/manifest.current.json" } },
      },
      all: { path: "data/ui/all.current.json", legacyPath: "data/ui/all.json" },
    },
  });

  assert.deepEqual(paths, [
    "data/ui/7d.current.json",
    "data/ui/all.current.json",
    "data/ui/meta.json",
    "data/ui/ranges/7d/manifest.current.json",
  ]);
});
