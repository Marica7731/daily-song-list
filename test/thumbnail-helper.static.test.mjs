import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = path.join(ROOT, "assets", "app.js");
const INDEX = path.join(ROOT, "index.html");

test("thumbnail relay is first choice and the public index loads its exact content-hashed asset", () => {
  assert(existsSync(APP), "repo assets/app.js must exist");
  assert(existsSync(INDEX), "repo index.html must exist");
  const appBytes = readFileSync(APP);
  const source = appBytes.toString("utf8");
  const appSha256 = createHash("sha256").update(appBytes).digest("hex");
  const versionedRelative = `assets/app-h${appSha256.slice(0, 12)}.js`;
  const versionedAbsolute = path.join(ROOT, versionedRelative);
  assert(existsSync(versionedAbsolute), `missing versioned app asset: ${versionedRelative}`);
  assert.deepEqual(readFileSync(versionedAbsolute), appBytes, "versioned app asset must equal assets/app.js byte-for-byte");
  assert.match(readFileSync(INDEX, "utf8"), new RegExp(`<script src="${versionedRelative}" defer></script>`, "u"));

  const helperStart = source.indexOf("function sameOriginThumbnailUrl");
  assert(helperStart >= 0, "same-origin helper missing");
  const helperEnd = source.indexOf("\n}\n", helperStart);
  assert(helperEnd > helperStart, "same-origin helper body missing");
  const helper = Function("cleanText", `return (${source.slice(helperStart, helperEnd + 2)});`)(
    (value) => String(value ?? "").trim(),
  );
  assert.equal(helper("dQw4w9WgXcQ"), "/api/thumbnails/dQw4w9WgXcQ/hqdefault.jpg");
  assert.equal(helper("dQw4w9WgXcQ", "mqdefault"), "/api/thumbnails/dQw4w9WgXcQ/mqdefault.jpg");
  assert.equal(helper("dQw4w9WgXcQ", "default"), "");
  assert.equal(helper("dQw4w9WgXcQ", "sddefault"), "");
  assert.equal(helper("dQw4w9WgXcQ", "maxresdefault"), "");
  assert.equal(helper("short-id"), "");
  assert.equal(helper("dQw4w9WgXcQ", "../../etc"), "");

  const candidatesStart = source.indexOf("function videoThumbnailCandidates");
  const candidatesEnd = source.indexOf("\n}\n", candidatesStart);
  const candidates = source.slice(candidatesStart, candidatesEnd);
  assert(candidates.indexOf("sameOriginThumbnailUrl(videoId, relayQuality)") < candidates.indexOf("item.thumbnailUrl"));
  assert.match(source, /item\.thumbnailUrl/u);
  assert.match(source, /item\.videoThumbnailUrl/u);
  assert.match(source, /img\.className = className/u);
  assert.match(source, /thumb\.href = youtubeTimeUrl\(videoId, firstSeconds\)/u);
  assert.match(source, /img\.src = thumbnailCandidates\[thumbnailIndex\]/u);
  assert.match(source, /img\.addEventListener\("error"/u);
  assert.doesNotMatch(source, /data:image\/(?:png|gif|jpeg);base64,/u);
  assert.doesNotMatch(source, /maxresdefault/u);
});

test("runtime source detail requests are scoped to the active range", () => {
  const source = readFileSync(APP, "utf8");
  const helperStart = source.indexOf("function sourceDetailPathWithRange");
  assert(helperStart >= 0, "source-detail range helper missing");
  const helperEnd = source.indexOf("\n}\n", helperStart);
  assert(helperEnd > helperStart, "source-detail range helper body missing");
  const helper = Function(
    "state",
    "isRuntimeSourceDetailPath",
    "cleanText",
    "URLSearchParams",
    `return (${source.slice(helperStart, helperEnd + 2)});`,
  )(
    { range: "7d" },
    (value) => String(value || "").includes("/api/sources/"),
    (value) => String(value ?? "").trim(),
    URLSearchParams,
  );

  assert.equal(helper("/api/sources/c246e336b14376e1a9d20f45"), "/api/sources/c246e336b14376e1a9d20f45?range=7d");
  assert.equal(helper("/api/sources/key?range=all&page=2"), "/api/sources/key?range=7d&page=2");
  assert.equal(helper("data/sources/key.json"), "data/sources/key.json");
  assert.match(source, /async function loadSourceDetailOccurrences[\s\S]+const requestPath = sourceDetailPathWithRange\(path\)/u);
  assert.match(source, /function sourceDetailPagePath[\s\S]+const requestPath = sourceDetailPathWithRange\(path\)/u);
});

console.log("THUMBNAIL_STATIC_RELEASE_CHECK_OK");
