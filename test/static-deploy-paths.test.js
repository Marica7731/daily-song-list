const assert = require("node:assert/strict");
const test = require("node:test");

const { collectStaticPaths } = require("../scripts/resolve-static-deploy-paths.js");

test("static deploy paths follow current range metadata", () => {
  const paths = collectStaticPaths({
    ranges: {
      "7d": {
        shards: {
          runtime: { manifestPath: "data/ui/ranges/7d/manifest.current.json" },
          request: { summary: { path: "data/ui/ranges/7d/request/summary.json" } },
        },
      },
      all: { path: "data/ui/all.current.json", legacyPath: "data/ui/all.json" },
    },
  });

  assert.deepEqual(paths, [
    "data/ui/meta.json",
    "data/ui/ranges/7d/manifest.current.json",
  ]);

  assert.throws(
    () => collectStaticPaths({ ranges: { all: { shards: { runtime: { manifestPath: "data/ui/all.current.json" } } } } }),
    /full range JSON is forbidden/u,
  );
});
