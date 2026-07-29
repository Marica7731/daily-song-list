import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function resolvePython() {
  const defaults = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  for (const executable of [...new Set([process.env.PYTHON, ...defaults].filter(Boolean))]) {
    try {
      execFileSync(executable, ["--version"], { stdio: "ignore" });
      return executable;
    } catch {
      // Try the next interpreter name; Windows commonly has python but not python3.
    }
  }
  throw new Error("Python interpreter not found; set PYTHON or install python3/python");
}

const python = resolvePython();
const script = path.resolve(process.env.CURATION_CONVERTER_SCRIPT || "scripts/migration/curation-overrides-to-patch.py");
const minimalRulesManifest = path.resolve(process.env.CURATION_RULES_MANIFEST || "artifacts/migration/curation-global-singleton-minimal.json");

function canonicalJson(value) {
  const sort = (item) => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sort(child)]));
    }
    return item;
  };
  return `${JSON.stringify(sort(value))}\n`;
}

function jqCanonical(manifest, selector) {
  const result = spawnSync("jq", ["-cS", selector], { input: JSON.stringify(manifest), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("curation converter maps audited rules to immutable occurrence keys", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-test-"));
  try {
    const overrides = path.join(root, "overrides.json");
    const snapshot = path.join(root, "snapshot.ndjson");
    const output = path.join(root, "patch.ndjson");
    const manifest = path.join(root, "manifest.json");
    const review = path.join(root, "review.json");
    fs.writeFileSync(overrides, JSON.stringify({ schemaVersion: 1, records: [
      { action: "drop_entry", videoId: "video-1", seconds: 12, title: "chat", artist: "", sourceId: "comment-1", reason: "confirmed_chat", reviewedAt: "2026-07-27T00:00:00Z", reviewedBy: "test" },
      { action: "replace_entry", videoId: "video-1", seconds: 24, sourceId: "comment-2", replacement: { title: "Real Song", artist: "Artist" }, reason: "confirmed_title", reviewedAt: "2026-07-27T00:00:00Z", reviewedBy: "test" },
      { action: "replace_entry", videoId: "video-1", seconds: 36, sourceId: "comment-3", replacement: { artist: "Artist Only" }, reason: "confirmed_artist", reviewedAt: "2026-07-27T00:00:00Z", reviewedBy: "test" },
      { action: "drop_video", videoId: "video-2", reason: "confirmed_noise", reviewedAt: "2026-07-27T00:00:00Z", reviewedBy: "test" },
    ] }), "utf8");
    fs.writeFileSync(snapshot, [
      { kind: "video", videoId: "video-1" },
      { kind: "video", videoId: "video-2" },
      { videoId: "video-1", occurrenceId: "occ-1", position: 0, seconds: 12, title: "chat", artist: "", sourceId: "comment-1", rangeId: "all", sourceSystem: "latest_json" },
      { videoId: "video-1", occurrenceId: "occ-2", position: 1, seconds: 24, title: "Old", artist: "Unknown", sourceId: "comment-2", rangeId: "all", sourceSystem: "latest_json" },
      { videoId: "video-1", occurrenceId: "occ-3", position: 2, seconds: 36, title: "Same", artist: "Old Artist", sourceId: "comment-3", rangeId: "all", sourceSystem: "latest_json" },
    ].map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
    const result = spawnSync(python, [script, "--overrides", overrides, "--snapshot", snapshot, "--output", output, "--manifest-output", manifest, "--review-output", review], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || fs.readFileSync(review, "utf8"));
    const rows = fs.readFileSync(output, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(rows.length, 4);
    assert.equal(rows[0].entityKey, "occ-1");
    assert.equal(rows[0].tombstone, true);
    assert.equal(rows[1].entityKey, "occ-2");
    assert.equal(rows[1].tombstone, false);
    assert.equal(rows[1].payload.title, "Real Song");
    assert.equal(rows[2].payload.artist, "Artist Only");
    assert.equal(rows[3].entityType, "videos");
    const resultManifest = JSON.parse(fs.readFileSync(manifest, "utf8"));
    assert.equal(resultManifest.status, "ready");
    assert.equal(resultManifest.curationMutationCount, 4);
    assert.equal(resultManifest.reviewAudit.accepted, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("curation converter blocks ambiguous or missing identity instead of guessing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-review-test-"));
  try {
    const overrides = path.join(root, "overrides.json");
    const snapshot = path.join(root, "snapshot.ndjson");
    const output = path.join(root, "patch.ndjson");
    const manifest = path.join(root, "manifest.json");
    const review = path.join(root, "review.json");
    fs.writeFileSync(overrides, JSON.stringify({ records: [
      { action: "replace_entry", videoId: "video-1", seconds: 12, replacement: { title: "new" }, reason: "test" },
      { action: "drop_entry", videoId: "missing", seconds: 1, title: "x", artist: "y", reason: "test" },
    ] }), "utf8");
    fs.writeFileSync(snapshot, [
      { kind: "video", videoId: "video-1" },
      { videoId: "video-1", occurrenceId: "occ-1", position: 0, seconds: 12, title: "a", artist: "b" },
      { videoId: "video-1", occurrenceId: "occ-2", position: 1, seconds: 12, title: "c", artist: "d" },
    ].map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");
    const result = spawnSync(python, [script, "--overrides", overrides, "--snapshot", snapshot, "--output", output, "--manifest-output", manifest, "--review-output", review], { encoding: "utf8" });
    assert.equal(result.status, 78, result.stderr);
    const resultManifest = JSON.parse(fs.readFileSync(manifest, "utf8"));
    assert.equal(resultManifest.status, "needs_review");
    assert.equal(resultManifest.reviewAudit.ambiguous, 1);
    assert.equal(resultManifest.reviewAudit.already_applied_absent, 1);
    assert.equal(fs.readFileSync(output, "utf8"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exact selector rejects a different sourceHash even when seconds sourceId and rawHash match", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-source-hash-test-"));
  try {
    const overrides = path.join(root, "overrides.json");
    const snapshot = path.join(root, "snapshot.ndjson");
    const output = path.join(root, "patch.ndjson");
    const manifest = path.join(root, "manifest.json");
    const review = path.join(root, "review.json");
    fs.writeFileSync(overrides, JSON.stringify({ records: [{
      action: "drop_entry",
      videoId: "video-1",
      seconds: 12,
      sourceId: "comment-1",
      sourceHash: "expected-source-hash",
      rawHash: "same-raw-hash",
      expectedMatchCount: 1,
      reason: "verified_commentary",
    }] }), "utf8");
    fs.writeFileSync(snapshot, JSON.stringify({
      videoId: "video-1",
      occurrenceId: "occ-1",
      position: 0,
      seconds: 12,
      title: "commentary",
      artist: "",
      sourceId: "comment-1",
      sourceHash: "different-source-hash",
      rawHash: "same-raw-hash",
    }) + "\n", "utf8");

    const result = spawnSync(python, [
      script,
      "--overrides", overrides,
      "--snapshot", snapshot,
      "--output", output,
      "--manifest-output", manifest,
      "--review-output", review,
    ], { encoding: "utf8" });
    assert.equal(result.status, 78, result.stderr);
    assert.equal(fs.readFileSync(output, "utf8"), "");
    const resultManifest = JSON.parse(fs.readFileSync(manifest, "utf8"));
    const resultReview = JSON.parse(fs.readFileSync(review, "utf8"));
    assert.equal(resultManifest.status, "needs_review");
    assert.equal(resultManifest.reviewAudit.count_mismatch, 1);
    assert.equal(resultReview.results[0].matchCount, 0);
    assert.equal(resultReview.results[0].expectedMatchCount, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("every supplied provenance selector is fail-closed when the same-second row is missing or different", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-provenance-test-"));
  try {
    for (const [field, expected, actual] of [
      ["sourceId", "wanted-source", "other-source"],
      ["sourceId", "wanted-source", ""],
      ["sourceHash", "wanted-source-hash", ""],
      ["rawHash", "wanted-raw-hash", ""],
    ]) {
      const base = path.join(root, field + expected.replaceAll("-", ""));
      const overrides = base + ".overrides.json";
      const snapshot = base + ".snapshot.ndjson";
      const output = base + ".patch.ndjson";
      const manifest = base + ".manifest.json";
      const review = base + ".review.json";
      fs.writeFileSync(overrides, JSON.stringify({ records: [{
        action: "drop_entry", videoId: "video-1", seconds: 12,
        [field]: expected, expectedMatchCount: 1, reason: "exact-provenance",
      }] }), "utf8");
      fs.writeFileSync(snapshot, JSON.stringify({
        videoId: "video-1", occurrenceId: "occ-1", seconds: 12,
        title: "same second", artist: "Artist", [field]: actual,
      }) + "\n", "utf8");
      const result = spawnSync(python, [script, "--overrides", overrides, "--snapshot", snapshot, "--output", output, "--manifest-output", manifest, "--review-output", review], { encoding: "utf8" });
      assert.equal(result.status, 78, `${field}: ${result.stderr}`);
      assert.equal(JSON.parse(fs.readFileSync(manifest, "utf8")).status, "needs_review");
      assert.equal(fs.readFileSync(output, "utf8"), "");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("exact selector treats a missing audited time as an explicit no-op", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-absent-test-"));
  try {
    const overrides = path.join(root, "overrides.json");
    const snapshot = path.join(root, "snapshot.ndjson");
    const output = path.join(root, "patch.ndjson");
    const manifest = path.join(root, "manifest.json");
    const review = path.join(root, "review.json");
    fs.writeFileSync(overrides, JSON.stringify({ records: [{
      action: "drop_entry", videoId: "lUDCE3zZmuQ", seconds: 9463,
      sourceId: "Ugxw2-DEUVx0aNsvVyR4AaABAg", expectedMatchCount: 1,
    }] }), "utf8");
    fs.writeFileSync(snapshot, JSON.stringify({
      videoId: "lUDCE3zZmuQ", occurrenceId: "occ-official", position: 1,
      seconds: 8336, title: "花に亡霊", artist: "ヨルシカ",
    }) + "\n", "utf8");
    const result = spawnSync(python, [
      script, "--overrides", overrides, "--snapshot", snapshot, "--output", output,
      "--manifest-output", manifest, "--review-output", review,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const resultManifest = JSON.parse(fs.readFileSync(manifest, "utf8"));
    const resultReview = JSON.parse(fs.readFileSync(review, "utf8"));
    assert.equal(resultManifest.status, "ready");
    assert.equal(resultManifest.selectorMutationCount, 0);
    assert.equal(resultManifest.reviewAudit.already_applied_absent, 1);
    assert.equal(resultReview.results[0].status, "already_applied_absent");
    assert.equal(fs.readFileSync(output, "utf8"), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("minimal singleton manifest emits exactly Naraetan 1 plus Ado 14 and protects excluded scopes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-minimal-test-"));
  try {
    const snapshot = path.join(root, "snapshot.ndjson");
    const output = path.join(root, "patch.ndjson");
    const manifest = path.join(root, "manifest.json");
    const review = path.join(root, "review.json");
    const rules = JSON.parse(fs.readFileSync(minimalRulesManifest, "utf8"));
    assert.equal(rules.records.length, 1);
    assert.equal(rules.records[0].expectedMatchCount, 1);
    assert.equal(rules.artistScopedAliases.length, 1);
    assert.equal(rules.artistScopedAliases[0].expectedMatchCount, 14, "frozen candidate fixture has 14 physical Ado identities");
    assert.equal(rules.safetyAssertions.find((item) => item.assertionId === "exclude-urameshi-legacy-rules").auditedLegacyRuleCount, 27);
    const fixtureRules = path.join(root, "rules.json");
    fs.writeFileSync(fixtureRules, JSON.stringify(rules), "utf8");

    const aliasVariants = rules.artistScopedAliases[0].aliases.filter((title) => title !== "逆光");
    const snapshotRows = [
      { kind: "video", videoId: "lUDCE3zZmuQ" },
      {
        videoId: "lUDCE3zZmuQ",
        occurrenceId: "occ-naraetan-9463",
        position: 24,
        seconds: 9463,
        title: "Even in a life full of hardships...",
        artist: "",
        sourceId: "Ugxw2-DEUVx0aNsvVyR4AaABAg",
        sourceHash: "5a84ddcb0ff7c6f66409f9d5b93f1c0c258769dbe6ad300a6b27a1907a37c07f",
        rawHash: "66cb9e129f135600d5b881595110822a7e7bb01175eeb5d7d138763768188f1e",
        rangeId: "all",
        sourceSystem: "accepted",
      },
      ...Array.from({ length: 14 }, (_, index) => ({
        videoId: `ado-video-${index}`,
        occurrenceId: `occ-ado-${index}`,
        position: index,
        seconds: 100 + index,
        title: aliasVariants[index % aliasVariants.length],
        artist: "Ado",
        sourceId: `ado-source-${index}`,
        sourceHash: `ado-source-hash-${index}`,
        rawHash: `ado-raw-hash-${index}`,
        rangeId: "all",
        sourceSystem: "accepted",
      })),
      {
        videoId: "ado-canonical",
        occurrenceId: "occ-ado-canonical",
        position: 0,
        seconds: 1,
        title: "逆光",
        artist: "Ado",
      },
      {
        videoId: "protected-vaundy",
        occurrenceId: "occ-protected-vaundy",
        position: 0,
        seconds: 2,
        title: "逆光 - replica",
        artist: "Vaundy",
      },
      {
        videoId: "protected-flugel",
        occurrenceId: "occ-protected-flugel",
        position: 0,
        seconds: 3,
        title: "逆光のフリューゲル",
        artist: "ツヴァイウィング",
      },
      ...Array.from({ length: 27 }, (_, index) => ({
        videoId: `urameshi-video-${index}`,
        occurrenceId: `occ-urameshi-${index}`,
        position: index,
        seconds: 200 + index,
        title: `legacy commentary ${index}`,
        artist: "",
        channelHandle: "@urameshi_conta",
      })),
    ];
    const safetyAssertion = (assertionId) => rules.safetyAssertions.find(
      (item) => item.assertionId === assertionId,
    );
    const vaundyScope = safetyAssertion("protect-vaundy-gyakko-replica");
    const flugelScope = safetyAssertion("protect-gyakko-no-flugel");
    const lunaScope = safetyAssertion("protect-luna-8-32");
    const adoScope = safetyAssertion("protect-ado-gyakko-canonical");
    snapshotRows.push(
      ...Array.from({ length: 2 }, (_, index) => ({
        videoId: `protected-vaundy-extra-${index}`,
        occurrenceId: `occ-protected-vaundy-extra-${index}`,
        position: index,
        seconds: 300 + index,
        title: vaundyScope.equals.title,
        artist: vaundyScope.equals.artist,
      })),
      ...Array.from({ length: 122 }, (_, index) => ({
        videoId: `protected-flugel-extra-${index}`,
        occurrenceId: `occ-protected-flugel-extra-${index}`,
        position: index,
        seconds: 400 + index,
        title: `${flugelScope.startsWith.title} ${index}`,
        artist: "protected",
      })),
      ...Array.from({ length: 17 }, (_, index) => ({
        videoId: `protected-luna-${index}`,
        occurrenceId: `occ-protected-luna-${index}`,
        position: index,
        seconds: 600 + index,
        title: lunaScope.equals.title,
        artist: lunaScope.equals.artist,
      })),
      ...Array.from({ length: 400 }, (_, index) => ({
        videoId: `protected-ado-${index}`,
        occurrenceId: `occ-protected-ado-${index}`,
        position: index,
        seconds: 700 + index,
        title: adoScope.equals.title,
        artist: adoScope.equals.artist,
      })),
      ...Array.from({ length: 3892 }, (_, index) => ({
        videoId: `urameshi-extra-${index}`,
        occurrenceId: `occ-urameshi-extra-${index}`,
        position: index,
        seconds: 1200 + index,
        title: `legacy commentary extra ${index}`,
        artist: "",
        channelHandle: "/@urameshi_conta",
      })),
    );
    fs.writeFileSync(snapshot, snapshotRows.map((item) => JSON.stringify(item)).join("\n") + "\n", "utf8");

    const result = spawnSync(python, [
      script,
      "--rules-manifest", fixtureRules,
      "--snapshot", snapshot,
      "--output", output,
      "--manifest-output", manifest,
      "--review-output", review,
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || fs.readFileSync(review, "utf8"));

    const rows = fs.readFileSync(output, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(rows.length, 15);
    assert.equal(rows.filter((row) => row.tombstone).length, 1);
    assert.equal(rows.filter((row) => !row.tombstone && row.payload.title === "逆光" && row.payload.artist === "Ado").length, 14);
    assert.equal(rows.some((row) => row.entityKey === "occ-protected-vaundy"), false);
    assert.equal(rows.some((row) => row.entityKey === "occ-protected-flugel"), false);
    assert.equal(rows.some((row) => row.payload.originalIdentity.channelHandle === "@urameshi_conta"), false);
    for (const row of rows) {
      assert.ok(row.payload.originalIdentity.occurrenceId);
      assert.ok(row.payload.curationReason);
      assert.ok(row.payload.curationProvenance.ruleId);
      assert.ok(Array.isArray(row.payload.curationProvenance.evidenceUrls));
    }

    const resultManifest = JSON.parse(fs.readFileSync(manifest, "utf8"));
    assert.equal(resultManifest.status, "ready");
    assert.equal(resultManifest.curationMutationCount, 15);
    assert.equal(resultManifest.selectorMutationCount, 1);
    assert.equal(resultManifest.aliasMutationCount, 14);
    assert.equal(resultManifest.aliasSourceGroups.reduce((sum, group) => sum + group.count, 0), 14);
    assert.ok(resultManifest.aliasSourceGroups.every((group) => group.rangeId === "all" && /^[0-9a-f]{16}$/.test(group.originalSourceDetailKey) && /^[0-9a-f]{16}$/.test(group.replacementSourceDetailKey)));
    assert.equal(
      resultManifest.aliasSourceGroupsSha256,
      crypto.createHash("sha256").update(canonicalJson(resultManifest.aliasSourceGroups)).digest("hex"),
    );
    assert.equal(resultManifest.aliasSourceReview.schemaVersion, 1);
    assert.equal(resultManifest.aliasSourceReview.selectedIdentityCount, 14);
    assert.equal(resultManifest.aliasSourceReview.selectedIdentities.length, 14);
    assert.equal(
      resultManifest.aliasSourceReview.selectedIdentitiesSha256,
      crypto.createHash("sha256").update(canonicalJson(resultManifest.aliasSourceReview.selectedIdentities)).digest("hex"),
    );
    assert.equal(jqCanonical(resultManifest, ".aliasSourceGroups"), canonicalJson(resultManifest.aliasSourceGroups), "Python group bytes match jq -cS including its LF");
    assert.equal(jqCanonical(resultManifest, ".aliasSourceReview.selectedIdentities"), canonicalJson(resultManifest.aliasSourceReview.selectedIdentities), "Python identity bytes match jq -cS including its LF");
    assert.ok(resultManifest.aliasSourceReview.selectedIdentities.every((identity) => (
      identity.rangeId === "all"
      && identity.sourceId
      && Number.isInteger(identity.seconds) && identity.seconds >= 0
      && identity.storedRangeId === "all"
      && identity.originalTitle
      && identity.originalArtist === "Ado"
      && identity.replacementTitle === "逆光"
      && identity.replacementArtist === "Ado"
      && /^[0-9a-f]{16}$/.test(identity.originalSourceDetailKey)
      && /^[0-9a-f]{16}$/.test(identity.replacementSourceDetailKey)
    )));

    const resultReview = JSON.parse(fs.readFileSync(review, "utf8"));
    const naraetan = resultReview.results.find((item) => item.ruleId === "naraetan-lUDCE3zZmuQ-9463-translated-commentary");
    const ado = resultReview.results.find((item) => item.ruleId === "ado-gyakko-official-album-title");
    const vaundy = resultReview.results.find((item) => item.assertionId === "protect-vaundy-gyakko-replica");
    const flugel = resultReview.results.find((item) => item.assertionId === "protect-gyakko-no-flugel");
    const luna = resultReview.results.find((item) => item.assertionId === "protect-luna-8-32");
    const adoCanonical = resultReview.results.find((item) => item.assertionId === "protect-ado-gyakko-canonical");
    const urameshi = resultReview.results.find((item) => item.assertionId === "exclude-urameshi-legacy-rules");
    assert.equal(naraetan.matchCount, 1);
    assert.equal(ado.matchCount, 14);
    assert.equal(ado.selectedIdentities.length, 14);
    assert.deepEqual([...new Set(ado.selectedIdentities.map((item) => item.rangeId))], ["all"]);
    assert.deepEqual([vaundy.scopeRowCount, vaundy.mutationCount], [3, 0]);
    assert.deepEqual([flugel.scopeRowCount, flugel.mutationCount], [123, 0]);
    assert.deepEqual([luna.scopeRowCount, luna.mutationCount], [17, 0]);
    assert.deepEqual([adoCanonical.scopeRowCount, adoCanonical.mutationCount], [401, 0]);
    assert.deepEqual([urameshi.scopeRowCount, urameshi.mutationCount, urameshi.auditedLegacyRuleCount], [3919, 0, 27]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("alias source review distinguishes physical mutations from all/7d projections and is deterministic", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-alias-review-"));
  try {
    const rules = path.join(root, "rules.json");
    const snapshot = path.join(root, "snapshot.ndjson");
    const secondSnapshot = path.join(root, "snapshot-reordered.ndjson");
    const inputRows = [
      { videoId: "legacy", occurrenceId: "legacy-occ", position: 3, seconds: 3, title: "old", artist: "Artist", sourceId: "legacy-source" },
      { videoId: "all", occurrenceId: "all-occ", position: 2, seconds: 2, title: "old", artist: "Artist", sourceId: "all-source", rangeId: "all" },
      { videoId: "seven", occurrenceId: "seven-occ", position: 1, seconds: 1, title: "old", artist: "Artist", sourceId: "seven-source", rangeId: "7d" },
    ];
    fs.writeFileSync(rules, JSON.stringify({ artistScopedAliases: [{
      ruleId: "range-split", artist: "Artist", canonicalTitle: "new", aliases: ["old"], expectedMatchCount: 3,
    }], records: [] }), "utf8");
    fs.writeFileSync(snapshot, inputRows.map(JSON.stringify).join("\n") + "\n", "utf8");
    fs.writeFileSync(secondSnapshot, [...inputRows].reverse().map(JSON.stringify).join("\n") + "\n", "utf8");
    const invoke = (name, snapshotPath) => {
      const output = path.join(root, `${name}.ndjson`);
      const manifest = path.join(root, `${name}.json`);
      const review = path.join(root, `${name}.review.json`);
      const result = spawnSync(python, [script, "--rules-manifest", rules, "--snapshot", snapshotPath, "--output", output, "--manifest-output", manifest, "--review-output", review], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(fs.readFileSync(manifest, "utf8"));
    };
    const manifest = invoke("first", snapshot);
    const reordered = invoke("second", secondSnapshot);
    assert.equal(manifest.aliasMutationCount, 3, "one mutation per physical occurrence");
    assert.equal(manifest.aliasSourceReview.selectedIdentityCount, 4, "legacy row explicitly projects all plus 7d");
    assert.deepEqual(manifest.aliasSourceReview.selectedIdentities.map((item) => [item.videoId, item.rangeId]), [
      ["all", "all"], ["legacy", "all"], ["legacy", "7d"], ["seven", "7d"],
    ]);
    assert.deepEqual(manifest.aliasSourceReview.selectedIdentities.map((item) => [item.videoId, item.rangeId, item.storedRangeId, item.seconds]), [
      ["all", "all", "all", 2], ["legacy", "all", "", 3], ["legacy", "7d", "", 3], ["seven", "7d", "7d", 1],
    ]);
    const physical = new Set(manifest.aliasSourceReview.selectedIdentities.map((item) => `${item.videoId}:${item.occurrenceId}:${item.storedRangeId}`));
    assert.equal(physical.size, manifest.aliasMutationCount, "physical identity count must remain separate from projections");
    assert.equal(manifest.aliasSourceGroups.reduce((total, group) => total + group.count, 0), 4);
    assert.deepEqual(reordered.aliasSourceReview, manifest.aliasSourceReview);
    assert.equal(reordered.aliasSourceGroupsSha256, manifest.aliasSourceGroupsSha256);
    const tampered = structuredClone(manifest.aliasSourceReview.selectedIdentities);
    tampered[0].sourceId = "tampered";
    assert.notEqual(
      crypto.createHash("sha256").update(canonicalJson(tampered)).digest("hex"),
      manifest.aliasSourceReview.selectedIdentitiesSha256,
      "canonical SHA detects identity tampering",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("alias source review fails closed for missing, duplicate, conflicting, or over-cap identities", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-alias-reject-"));
  try {
    const run = (name, rows, aliases) => {
      const rules = path.join(root, `${name}.rules.json`);
      const snapshot = path.join(root, `${name}.snapshot.ndjson`);
      fs.writeFileSync(rules, JSON.stringify({ records: [], artistScopedAliases: aliases }), "utf8");
      fs.writeFileSync(snapshot, rows.map(JSON.stringify).join("\n") + "\n", "utf8");
      return spawnSync(python, [script, "--rules-manifest", rules, "--snapshot", snapshot, "--output", path.join(root, `${name}.ndjson`), "--manifest-output", path.join(root, `${name}.json`), "--review-output", path.join(root, `${name}.review.json`)], { encoding: "utf8" });
    };
    const base = { videoId: "video", occurrenceId: "occ", seconds: 1, title: "old", artist: "Artist", sourceId: "source", rangeId: "all" };
    const oneAlias = (canonicalTitle) => ({ artist: "Artist", canonicalTitle, aliases: ["old"], expectedMatchCount: 1 });
    const sourceOptional = run("empty-source", [{ ...base, sourceId: "" }], [oneAlias("new")]);
    assert.equal(sourceOptional.status, 0, sourceOptional.stderr);
    const withoutSeconds = { ...base };
    delete withoutSeconds.seconds;
    assert.notEqual(run("missing-seconds", [withoutSeconds], [oneAlias("new")]).status, 0, "seconds is required by the source review");
    assert.notEqual(run("string-seconds", [{ ...base, seconds: "1" }], [oneAlias("new")]).status, 0, "seconds must remain an integer");
    assert.notEqual(run("duplicate", [base], [oneAlias("new"), oneAlias("new")]).status, 0, "duplicate tuple is rejected");
    assert.notEqual(run("conflict", [base], [oneAlias("new-a"), oneAlias("new-b")]).status, 0, "conflicting physical projection is rejected");

    const overCapRows = Array.from({ length: 50_001 }, (_, index) => ({
      videoId: `cap-${index}`, occurrenceId: `occ-${index}`, seconds: index, title: "old", artist: "Cap Artist", sourceId: `source-${index}`, rangeId: "all",
    }));
    const overCap = run("cap", overCapRows, [{ artist: "Cap Artist", canonicalTitle: "new", aliases: ["old"], expectedMatchCount: 50_001 }]);
    assert.notEqual(overCap.status, 0, "selected identities above 50000 are rejected");
    assert.match(overCap.stderr, /selected identity cap/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("direct alias review validator enforces sorted physical projections and group caps", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "curation-patch-direct-validator-"));
  try {
    const harness = path.join(root, "validate.py");
    fs.writeFileSync(harness, String.raw`import importlib.util
import json
import sys

spec = importlib.util.spec_from_file_location("curation_converter", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
try:
    selected, groups = module.validated_alias_source_review(json.load(open(sys.argv[2], encoding="utf-8")))
    print(json.dumps({"selected": selected, "groups": groups}, ensure_ascii=False))
except Exception as exc:
    print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
    raise SystemExit(1)
`, "utf8");
    const identity = (overrides = {}) => ({
      rangeId: "all", videoId: "video", occurrenceId: "occ", seconds: 1, sourceId: "",
      storedRangeId: "all", originalGroupKey: "old::artist", originalSourceDetailKey: "1111111111111111",
      replacementGroupKey: "new::artist", replacementSourceDetailKey: "2222222222222222",
      originalTitle: "old display", originalArtist: "Artist", replacementTitle: "new display", replacementArtist: "Artist",
      ...overrides,
    });
    const validate = (name, identities) => {
      const input = path.join(root, `${name}.json`);
      fs.writeFileSync(input, JSON.stringify(identities), "utf8");
      return spawnSync(python, [harness, script, input], { encoding: "utf8" });
    };
    const legacyAll = identity({ videoId: "legacy", occurrenceId: "legacy-occ", storedRangeId: "", rangeId: "all", originalSourceDetailKey: "3333333333333333", replacementSourceDetailKey: "4444444444444444" });
    const legacySeven = identity({ ...legacyAll, rangeId: "7d", originalSourceDetailKey: "5555555555555555", replacementSourceDetailKey: "6666666666666666" });
    const unordered = [
      identity({ videoId: "z", occurrenceId: "z-occ", originalSourceDetailKey: "ffffffffffffffff", replacementSourceDetailKey: "eeeeeeeeeeeeeeee" }),
      legacySeven,
      legacyAll,
    ];
    const valid = validate("valid", unordered);
    assert.equal(valid.status, 0, valid.stderr);
    const selected = JSON.parse(valid.stdout).selected;
    assert.deepEqual(selected.map((item) => [item.rangeId, item.videoId]), [["all", "legacy"], ["all", "z"], ["7d", "legacy"]], "validator writes identities in identity_sort_key order");
    assert.notEqual(validate("incomplete-legacy", [legacyAll]).status, 0, "legacy physical identity must project exactly all plus 7d");
    assert.match(validate("display-conflict", [legacyAll, { ...legacySeven, replacementTitle: "different display" }]).stderr, /conflicting identity projection/u, "display fields participate in physical consistency");

    const tooManyGroups = Array.from({ length: 65 }, (_, index) => identity({
      videoId: `cap-${index}`, occurrenceId: `cap-occ-${index}`,
      originalTitle: `old ${index}`, replacementTitle: `new ${index}`,
      originalGroupKey: `old-${index}::artist`, replacementGroupKey: `new-${index}::artist`,
      originalSourceDetailKey: (index + 1).toString(16).padStart(16, "0"),
      replacementSourceDetailKey: (index + 1000).toString(16).padStart(16, "0"),
    }));
    const groupCap = validate("group-cap", tooManyGroups);
    assert.notEqual(groupCap.status, 0);
    assert.match(groupCap.stderr, /source group cap/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
