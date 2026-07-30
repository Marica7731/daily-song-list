import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const isolatedRoot = process.env.D_GATE_ROOT || ".";
const deployWorkflow = fs.readFileSync(
  path.resolve(isolatedRoot, ".github/workflows/deploy-pg-incremental.yml"),
  "utf8",
);
const acceptedWorkflow = fs.readFileSync(
  path.resolve(".github/workflows/deploy-pg-accepted-increment.yml"),
  "utf8",
);
const recoveryWorkflow = fs.readFileSync(
  path.resolve(".github/workflows/recover-urameshi-source.yml"),
  "utf8",
);

function workflowRunBlocks(workflow) {
  const lines = workflow.split(/\r?\n/u);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)run:\s*\|\s*$/u.exec(lines[index]);
    if (!match) continue;
    const contentIndent = match[1].length + 2;
    const body = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() && line.search(/\S/u) < contentIndent) {
        index -= 1;
        break;
      }
      body.push(line.slice(Math.min(contentIndent, line.length)));
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

function workflowJob(workflow, jobName, nextJobName) {
  const pattern = new RegExp(
    `^  ${jobName}:\\n([\\s\\S]*?)^  ${nextJobName}:`,
    "mu",
  );
  const match = pattern.exec(workflow);
  assert.ok(match, `missing ${jobName} job`);
  return match[1];
}

function workflowHeredoc(workflow, destination) {
  const escaped = destination.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`cat > "${escaped}" <<'PY'\\n([\\s\\S]*?)\\n          PY`, "u").exec(workflow);
  assert.ok(match, `missing ${destination} heredoc`);
  return match[1].replace(/^          /gmu, "");
}

function sourceIdentityGate(payload, {
  channelId = "UC7cZJOAJZD1W4aOfqnRgWiA",
  channelHandle = "/@MunMosh",
} = {}) {
  const predicate = `
    def normalize_handle:
      if type == "string" then ltrimstr("/") else "" end;
    ([
      .record.occurrences[]? |
      select(
        (.videoId == $video_id) and
        (.song.title == $title) and
        ((.song.artist // null) == $artist) and
        ((.song.seconds // null) == $seconds)
      )
    ] | length) as $tuple_match_count |
    (.found == true) and
    (($expected_channel_id == "") or
      ((.record.channelId // "") == $expected_channel_id)) and
    (($expected_channel_handle == "") or
      (((.record.channelHandle // "") | normalize_handle) ==
        ($expected_channel_handle | normalize_handle))) and
    ($tuple_match_count == 1)
  `;
  return spawnSync(
    "jq",
    [
      "-e",
      "--arg", "expected_channel_id", channelId,
      "--arg", "expected_channel_handle", channelHandle,
      "--arg", "video_id", "G7cNtd_Gy9c",
      "--argjson", "title", JSON.stringify("song"),
      "--argjson", "artist", JSON.stringify("artist"),
      "--argjson", "seconds", "770",
      predicate,
    ],
    { input: JSON.stringify(payload), encoding: "utf8" },
  ).status;
}

function rankingsMetrics(payload, {
  channelId = "UCA",
  channelHandle = "/@source-a",
} = {}) {
  const program = `
    def normalize_handle:
      if type == "string" then ltrimstr("/") else "" end;
    [.records[]?.occurrences[]?] as $occurrences |
    {
      totalCount,
      totalOccurrenceCount,
      identityMismatchCount:([
        $occurrences[] |
        select(
          (
            (($expected_channel_id == "") or
              ((.video.channelId // "") == $expected_channel_id)) and
            (($expected_channel_handle == "") or
              (((.video.channelHandle // "") | normalize_handle) ==
                ($expected_channel_handle | normalize_handle)))
          ) | not
        )
      ] | length),
      tupleMatchCount:([
        $occurrences[] |
        select(
          (.videoId == $video_id) and
          (.song.title == $title) and
          ((.song.artist // null) == $artist) and
          ((.song.seconds // null) == $seconds)
        )
      ] | length)
    }
  `;
  const result = spawnSync(
    "jq",
    [
      "-c",
      "--arg", "expected_channel_id", channelId,
      "--arg", "expected_channel_handle", channelHandle,
      "--arg", "video_id", "video-a",
      "--argjson", "title", JSON.stringify("Song"),
      "--argjson", "artist", JSON.stringify("Artist"),
      "--argjson", "seconds", "42",
      program,
    ],
    { input: JSON.stringify(payload), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function aliasManifestGate(manifest) {
  if (!Object.hasOwn(manifest, "aliasSourceGroups")) return 0;
  const schema = `
    (.aliasSourceGroups | type == "array") and
    (.aliasSourceGroupCount | type == "number" and floor == . and . >= 0 and . <= 64) and
    (.aliasSourceGroupCount == (.aliasSourceGroups | length)) and
    (.aliasSourceGroupsSha256 | type == "string" and test("^[0-9a-f]{64}$")) and
    all(.aliasSourceGroups[];
      type == "object" and
      ((keys | sort) == ["count","originalGroupKey","originalSourceDetailKey","rangeId","replacementGroupKey","replacementSourceDetailKey"]) and
      (.rangeId == "all" or .rangeId == "7d") and
      (.originalGroupKey | type == "string" and length > 0) and
      (.replacementGroupKey | type == "string" and length > 0) and
      (.originalSourceDetailKey | type == "string" and test("^[0-9a-f]{16}$")) and
      (.replacementSourceDetailKey | type == "string" and test("^[0-9a-f]{16}$")) and
      (.originalSourceDetailKey != .replacementSourceDetailKey) and
      (.count | type == "number" and floor == . and . > 0)
    ) and
    (([.aliasSourceGroups[] | [.rangeId,.originalGroupKey,.originalSourceDetailKey] | @json] | length) ==
      ([.aliasSourceGroups[] | [.rangeId,.originalGroupKey,.originalSourceDetailKey] | @json] | unique | length)) and
    (([.aliasSourceGroups[] | [.rangeId,.replacementGroupKey,.replacementSourceDetailKey] | @json] | length) ==
      ([.aliasSourceGroups[] | [.rangeId,.replacementGroupKey,.replacementSourceDetailKey] | @json] | unique | length))
  `;
  const validation = spawnSync("jq", ["-e", schema], {
    input: JSON.stringify(manifest), encoding: "utf8",
  });
  if (validation.status !== 0) return validation.status || 1;
  const canonical = spawnSync("jq", ["-cS", ".aliasSourceGroups"], {
    input: JSON.stringify(manifest), encoding: "utf8",
  });
  if (canonical.status !== 0) return canonical.status || 1;
  const actualHash = crypto.createHash("sha256").update(canonical.stdout).digest("hex");
  if (actualHash !== manifest.aliasSourceGroupsSha256) return 1;
  const tuples = manifest.aliasSourceReview?.selectedIdentities;
  if (!Array.isArray(tuples) || tuples.length === 0) return 1;
  if (!Number.isInteger(manifest.aliasSourceReview?.selectedIdentityCount)
    || manifest.aliasSourceReview.selectedIdentityCount !== tuples.length
    || tuples.length > 50000) return 1;
  const canonicalTuples = `${JSON.stringify(tuples.map((tuple) => Object.fromEntries(
    Object.entries(tuple).sort(([a], [b]) => a.localeCompare(b)),
  )))}\n`;
  if (crypto.createHash("sha256").update(canonicalTuples).digest("hex")
    !== manifest.aliasSourceReview.selectedIdentitiesSha256) return 1;
  const ordered = [...tuples].sort((left, right) => [left.rangeId === "all" ? 0 : 1, left.originalGroupKey, left.originalSourceDetailKey, left.replacementGroupKey, left.replacementSourceDetailKey, left.videoId, left.occurrenceId].join("\u0000").localeCompare([right.rangeId === "all" ? 0 : 1, right.originalGroupKey, right.originalSourceDetailKey, right.replacementGroupKey, right.replacementSourceDetailKey, right.videoId, right.occurrenceId].join("\u0000")));
  if (ordered.some((tuple, index) => tuple !== tuples[index])) return 1;
  const expected = manifest.aliasSourceGroups.reduce((sum, group) => sum + group.count, 0);
  if (tuples.length !== expected) return 1;
  const seen = new Set();
  for (const tuple of tuples) {
    if (!tuple || typeof tuple !== "object") return 1;
    const keys = Object.keys(tuple).sort();
    if (JSON.stringify(keys) !== JSON.stringify([
      "occurrenceId", "originalArtist", "originalGroupKey", "originalSourceDetailKey", "originalTitle",
      "rangeId", "replacementArtist", "replacementGroupKey", "replacementSourceDetailKey", "replacementTitle", "seconds", "sourceId", "storedRangeId", "videoId",
    ])) return 1;
    if (!["all", "7d"].includes(tuple.rangeId)) return 1;
    if (![tuple.videoId, tuple.occurrenceId, tuple.originalTitle, tuple.originalArtist,
      tuple.replacementTitle, tuple.replacementArtist, tuple.originalGroupKey, tuple.replacementGroupKey]
      .every((value) => typeof value === "string" && value.length > 0)) return 1;
    if (!/^[0-9a-f]{16}$/u.test(tuple.originalSourceDetailKey) || !/^[0-9a-f]{16}$/u.test(tuple.replacementSourceDetailKey)) return 1;
    if (!Number.isInteger(tuple.seconds) || tuple.seconds < 0 || !["", "all", "7d"].includes(tuple.storedRangeId)
      || (tuple.storedRangeId && tuple.storedRangeId !== tuple.rangeId) || typeof tuple.sourceId !== "string") return 1;
    const identity = [tuple.rangeId, tuple.originalSourceDetailKey, tuple.replacementSourceDetailKey, tuple.videoId, tuple.occurrenceId].join("\\u0000");
    if (seen.has(identity)) return 1;
    seen.add(identity);
  }
  for (const group of manifest.aliasSourceGroups) {
    const members = tuples.filter((tuple) => tuple.rangeId === group.rangeId
      && tuple.originalGroupKey === group.originalGroupKey
      && tuple.originalSourceDetailKey === group.originalSourceDetailKey
      && tuple.replacementGroupKey === group.replacementGroupKey
      && tuple.replacementSourceDetailKey === group.replacementSourceDetailKey);
    if (members.length !== group.count) return 1;
  }
  return 0;
}

function aliasManifest(groups, tuples) {
  const canonical = `${JSON.stringify(groups.map((group) => Object.fromEntries(
    Object.entries(group).sort(([a], [b]) => a.localeCompare(b)),
  )))}\n`;
  return {
    kind: "curation-accepted-increment",
    aliasSourceGroups: groups,
    aliasSourceGroupCount: groups.length,
    aliasSourceGroupsSha256: crypto.createHash("sha256").update(canonical).digest("hex"),
    aliasSourceReview: {
      schemaVersion: 1,
      selectedIdentityCount: tuples.length,
      selectedIdentitiesSha256: crypto.createHash("sha256").update(`${JSON.stringify(tuples.map((tuple) => Object.fromEntries(
        Object.entries(tuple).sort(([a], [b]) => a.localeCompare(b)),
      )))}\n`).digest("hex"),
      selectedIdentities: tuples,
    },
  };
}

test("workflow YAML parses and every run block has valid bash syntax", () => {
  for (const [name, workflow] of [
    ["deploy-pg-incremental", deployWorkflow],
    ["deploy-pg-accepted-increment", acceptedWorkflow],
  ]) {
    assert.ok(workflowRunBlocks(workflow).length > 0);
    for (const [index, script] of workflowRunBlocks(workflow).entries()) {
      assert.doesNotMatch(
        script,
        /\$\{\{/u,
        `${name} run block ${index + 1} must keep Actions expressions in env to avoid GitHub's expression-length limit`,
      );
      const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
      assert.equal(
        result.status,
        0,
        `${name} run block ${index + 1}: ${result.stderr}`,
      );
    }
  }
});

test("rankings metrics bind occurrence identity and tuple without trusting channelUrl", () => {
  const matchingOccurrence = {
    videoId: "video-a",
    song: { title: "Song", artist: "Artist", seconds: 42 },
    video: {
      channelId: "UCA",
      channelHandle: "/@source-a",
      channelUrl: "https://www.youtube.com/@polluted-other-source",
    },
  };
  assert.deepEqual(
    rankingsMetrics({
      totalCount: 1,
      totalOccurrenceCount: 1,
      records: [{ occurrences: [matchingOccurrence] }],
    }),
    {
      totalCount: 1,
      totalOccurrenceCount: 1,
      identityMismatchCount: 0,
      tupleMatchCount: 1,
    },
  );
  assert.equal(
    rankingsMetrics({
      totalCount: 1,
      totalOccurrenceCount: 1,
      records: [{
        occurrences: [{
          ...matchingOccurrence,
          video: {
            ...matchingOccurrence.video,
            channelId: "WRONG",
          },
        }],
      }],
    }).identityMismatchCount,
    1,
  );
});

test("source identity gate uses the API-visible tuple and fails closed on ambiguity", () => {
  const matchingOccurrence = {
    videoId: "G7cNtd_Gy9c",
    song: { title: "song", artist: "artist", seconds: 770 },
  };
  assert.equal(
    sourceIdentityGate({
      found: true,
      record: {
        channelId: "UC7cZJOAJZD1W4aOfqnRgWiA",
        channelHandle: "/@MunMosh",
        occurrences: [matchingOccurrence],
      },
    }),
    0,
  );
  assert.equal(
    sourceIdentityGate({
      found: true,
      record: {
        channelId: "UC7cZJOAJZD1W4aOfqnRgWiA",
        channelHandle: "@MunMosh",
        occurrences: [matchingOccurrence],
      },
    }),
    0,
    "source identity accepts only the benign leading-slash handle variant",
  );
  assert.notEqual(
    sourceIdentityGate({
      found: true,
      record: {
        channelId: "UC7cZJOAJZD1W4aOfqnRgWiA",
        channelHandle: "/@MunMosh",
        occurrences: [matchingOccurrence, matchingOccurrence],
      },
    }),
    0,
  );
  assert.notEqual(
    sourceIdentityGate({
      found: true,
      record: {
        channelId: "UC7cZJOAJZD1W4aOfqnRgWiA",
        channelHandle: "/@MunMosh",
        occurrences: [{
          ...matchingOccurrence,
          videoId: "wrong-video",
        }],
      },
    }),
    0,
  );
  assert.notEqual(
    sourceIdentityGate({
      found: true,
      record: {
        channelId: "UC8VlcljjGFb4-Ny2Heb0-ew",
        channelHandle: "/@urameshi_conta",
        occurrences: [matchingOccurrence],
      },
    }),
    0,
    "a fuzzy source lookup must not pass using an unrelated record identity",
  );
});

test("alias source manifests are canonically hashed, bounded, and require compact reviewed tuples", () => {
  const allGroup = {
    rangeId: "all",
    originalGroupKey: "old::artist",
    originalSourceDetailKey: "1111111111111111",
    replacementGroupKey: "new::artist",
    replacementSourceDetailKey: "2222222222222222",
    count: 1,
  };
  const allTuple = {
    rangeId: "all",
    originalSourceDetailKey: allGroup.originalSourceDetailKey,
    replacementSourceDetailKey: allGroup.replacementSourceDetailKey,
    originalGroupKey: allGroup.originalGroupKey,
    replacementGroupKey: allGroup.replacementGroupKey,
    videoId: "video-1",
    occurrenceId: "occ-1",
    sourceId: "channel-1",
    seconds: 42,
    storedRangeId: "all",
    originalTitle: "old",
    originalArtist: "artist",
    replacementTitle: "new",
    replacementArtist: "artist",
  };
  const manifest = aliasManifest([allGroup], [allTuple]);
  assert.equal(aliasManifestGate(manifest), 0);
  assert.equal(aliasManifestGate({ kind: "accepted-increment" }), 0, "legacy manifests must not opt into the alias gate");
  assert.notEqual(aliasManifestGate({ ...manifest, aliasSourceGroupsSha256: "0".repeat(64) }), 0, "hash tampering must fail");
  assert.notEqual(aliasManifestGate({ ...manifest, aliasSourceReview: { ...manifest.aliasSourceReview, selectedIdentitiesSha256: "0".repeat(64) } }), 0, "tuple hash tampering must fail");
  assert.notEqual(aliasManifestGate({ ...manifest, aliasSourceReview: undefined }), 0, "the producer review must be delivered with the deploy artifact");
  assert.notEqual(aliasManifestGate(aliasManifest([allGroup, { ...allGroup }], [allTuple, { ...allTuple, occurrenceId: "occ-2" }])), 0, "ambiguous duplicate original projections must fail");
  const sevenDayGroup = {
    ...allGroup,
    rangeId: "7d",
    originalSourceDetailKey: "3333333333333333",
    replacementSourceDetailKey: "4444444444444444",
  };
  const sevenDayTuple = {
    ...allTuple,
    rangeId: "7d",
    originalSourceDetailKey: sevenDayGroup.originalSourceDetailKey,
    replacementSourceDetailKey: sevenDayGroup.replacementSourceDetailKey,
    originalGroupKey: sevenDayGroup.originalGroupKey,
    replacementGroupKey: sevenDayGroup.replacementGroupKey,
    storedRangeId: "7d",
  };
  assert.equal(aliasManifestGate(aliasManifest([allGroup, sevenDayGroup], [allTuple, sevenDayTuple])), 0,
    "a legacy occurrence may project to all and 7d without equating the two projections to aliasMutationCount");
  assert.notEqual(aliasManifestGate(aliasManifest([allGroup], [{ ...allTuple, occurrenceId: "occ-1" }, { ...allTuple, occurrenceId: "occ-2" }])), 0,
    "tuple count must equal the source-group delta ledger");
  assert.notEqual(aliasManifestGate(aliasManifest([allGroup], [{ ...allTuple, replacementGroupKey: "other::artist" }])), 0,
    "each compact tuple must be bound to exactly one declared source group");
  const unordered = aliasManifest([allGroup, sevenDayGroup], [sevenDayTuple, allTuple]);
  assert.notEqual(aliasManifestGate(unordered), 0, "a valid hash cannot bless an unstable tuple order");
});

test("workflow fails closed when an alias aggregate lacks reviewed candidate tuples", () => {
  for (const requiredGate of [
    "alias-source-groups-schema",
    "alias-source-groups-sha256-mismatch",
    "alias-source-review-contract-missing",
    "alias-source-review-tuples-mismatch",
    "PG_INCREMENT_ALIAS_SOURCE_MANIFEST_OK",
  ]) assert.match(deployWorkflow, new RegExp(requiredGate, "u"));
  assert.match(deployWorkflow, /\.aliasSourceGroupCount == \(\.aliasSourceGroups \| length\)/u);
  assert.match(deployWorkflow, /\.aliasSourceGroupsSha256 \| type == "string" and test\("\^\[0-9a-f\]\{64\}\$"\)/u);
  assert.match(deployWorkflow, /\.aliasSourceReview\.selectedIdentities \| type == "array" and length > 0/u);
  assert.match(deployWorkflow, /legacy rows deliberately project into both all and 7d ranges/u);
  assert.doesNotMatch(deployWorkflow, /aliasMutationCount.*alias_expected_projection_count/u,
    "legacy dual-range projections must not be equated to physical mutation count");
});

test("alias ledger verifier is syntactically executable and separates parent, candidate, and public probes", () => {
  const verifier = workflowHeredoc(deployWorkflow, "$INPUT_ROOT/verify-alias-source-ledger.py");
  const result = spawnSync("python3", ["-c", "import sys; compile(sys.stdin.read(), 'alias-ledger', 'exec')"], {
    input: verifier,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  for (const required of [
    "http://127.0.0.1:8765",
    "http://127.0.0.1:18766",
    "https://ytb-song-rank.culua.com",
    "old-source-present",
    "replacement-source-count",
    "replacement-card-count",
    "curation-provenance",
    "source-pagination-total",
    "PG_INCREMENT_ALIAS_SOURCE_LEDGER_OK",
  ]) assert.match(verifier, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(deployWorkflow, /--phase candidate --ledger "\$alias_ledger" --remote/u);
  assert.match(deployWorkflow, /--phase public --ledger "\$alias_ledger"/u);
});

test("alias ledger executes parent-to-candidate and public source/card checks", async () => {
  const verifier = workflowHeredoc(deployWorkflow, "$INPUT_ROOT/verify-alias-source-ledger.py");
  const group = {
    rangeId: "all", originalGroupKey: "old::artist", originalSourceDetailKey: "1111111111111111",
    replacementGroupKey: "new::artist", replacementSourceDetailKey: "2222222222222222", count: 1,
  };
  const group2 = {
    rangeId: "all", originalGroupKey: "old-2::artist", originalSourceDetailKey: "3333333333333333",
    replacementGroupKey: group.replacementGroupKey, replacementSourceDetailKey: group.replacementSourceDetailKey, count: 1,
  };
  const tuple = {
    rangeId: "all", storedRangeId: "all", videoId: "video-1", occurrenceId: "occ-1", sourceId: "channel-1", seconds: 42,
    originalTitle: "old", originalArtist: "artist", originalGroupKey: group.originalGroupKey,
    originalSourceDetailKey: group.originalSourceDetailKey, replacementTitle: "new", replacementArtist: "artist",
    replacementGroupKey: group.replacementGroupKey, replacementSourceDetailKey: group.replacementSourceDetailKey,
  };
  const tuple2 = {
    rangeId: "all", storedRangeId: "all", videoId: "video-2", occurrenceId: "occ-2", sourceId: "", seconds: 43,
    originalTitle: "old-2", originalArtist: "artist", originalGroupKey: group2.originalGroupKey,
    originalSourceDetailKey: group2.originalSourceDetailKey, replacementTitle: "new", replacementArtist: "artist",
    replacementGroupKey: group2.replacementGroupKey, replacementSourceDetailKey: group2.replacementSourceDetailKey,
  };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "daily-song-list-alias-ledger-"));
  const verifierPath = path.join(temp, "verify.py");
  const manifestPath = path.join(temp, "manifest.json");
  const ledgerPath = path.join(temp, "ledger.json");
  fs.writeFileSync(verifierPath, verifier);
  fs.writeFileSync(manifestPath, JSON.stringify({ ...aliasManifest([group, group2], [tuple, tuple2]), aliasMutationCount: 2 }));
  let badCandidateCount = false;
  let oldSourcePresent = false;
  let badCardCount = false;
  let badSourcePath = false;
  const source = (key, total, occurrences) => ({
    found: true, sourceKey: key, page: 1, pageCount: 1, totalOccurrenceCount: total,
    record: { sourceDetailKey: key, sourceDetailPath: badSourcePath ? "/unexpected" : "", count: total, timestampCount: total, key: group.replacementGroupKey, title: "new", displayArtist: "artist", occurrences },
  });
  const originalSource = (key, original, occurrences) => ({
    found: true, sourceKey: key, page: 1, pageCount: 1, totalOccurrenceCount: 1,
    record: { sourceDetailKey: key, sourceDetailPath: "", count: 1, timestampCount: 1, key: original.originalGroupKey, title: original.originalTitle, displayArtist: original.originalArtist, occurrences },
  });
  const old = (key) => ({ found: false, sourceKey: key });
  const row = (videoId, sourceId, seconds = 42) => ({ videoId, seconds, channelId: "UCfixture", channelHandle: "/@fixture", channelUrl: "https://youtube.example/@fixture", item: { videoId, channelId: "UCfixture", channelHandle: "/@fixture", channelUrl: "https://youtube.example/@fixture" }, song: { title: "new", artist: "artist", seconds, sourceId } });
  const selected = row("video-1", "channel-1");
  const selected2 = row("video-2", "", 43);
  const inherited = row("video-parent", "channel-parent");
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://fixture");
    const phase = url.pathname.split("/")[1];
    const key = decodeURIComponent(url.pathname.split("/").at(-1));
    let payload;
    if (url.pathname.includes("/api/sources/")) {
      if (key === group.originalSourceDetailKey || key === group2.originalSourceDetailKey) payload = phase === "parent" ? originalSource(key, key === group.originalSourceDetailKey ? tuple : tuple2, [key === group.originalSourceDetailKey ? row("video-1", "channel-1") : row("video-2", "", 43)]) : (oldSourcePresent ? source(key, 0, []) : old(key));
      else if (phase === "parent") payload = source(key, 1, [inherited]);
      else payload = source(key, badCandidateCount && phase === "candidate" ? 2 : 3,
        badCandidateCount && phase === "candidate" ? [selected, selected2] : [selected, selected2, inherited]);
    } else if (url.pathname.endsWith("/api/rankings")) {
      const isOld = url.searchParams.get("q") === "old";
      payload = { page: 1, pageCount: 1, records: isOld ? [] : [{
        title: "new", displayArtist: "artist", key: group.replacementGroupKey, sourceDetailKey: group.replacementSourceDetailKey, sourceDetailPath: "",
        count: phase === "parent" ? 1 : (badCardCount && phase === "candidate" ? 2 : 3),
      }] };
    } else payload = { error: "unexpected" };
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(payload));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const runVerifier = (args, env = {}) => new Promise((resolve) => {
    const child = spawn("python3", args, { env: { ...process.env, ...env } });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stderr }));
  });
  try {
    const candidate = await runVerifier([verifierPath, "--manifest", manifestPath, "--phase", "candidate", "--ledger", ledgerPath, "--test-fixture", "--parent-base", `${base}/parent`, "--candidate-base", `${base}/candidate`]);
    assert.equal(candidate.status, 0, candidate.stderr);
    const publicRun = await runVerifier([verifierPath, "--manifest", manifestPath, "--phase", "public", "--ledger", ledgerPath, "--public-base", `${base}/public`]);
    assert.equal(publicRun.status, 0, publicRun.stderr);
    const sshPath = path.join(temp, "ssh");
    fs.writeFileSync(sshPath, "#!/bin/sh\nlast=\"\"\nfor arg in \"$@\"; do last=\"$arg\"; done\ncase \"$last\" in *psql*) if [ \"$PG_BAD\" = 1 ]; then echo 2\|1\|2; else echo 2\|0\|2; fi ;; *) sh -c \"$last\" ;; esac\n");
    fs.chmodSync(sshPath, 0o700);
    const batchEnv = { PATH: `${temp}:${process.env.PATH}` };
    const missingRevision = await runVerifier([verifierPath, "--manifest", manifestPath, "--phase", "candidate", "--ledger", ledgerPath, "--remote", "fixture", "--parent-base", `${base}/parent`, "--candidate-base", `${base}/candidate`], batchEnv);
    assert.notEqual(missingRevision.status, 0, "candidate ledger requires an explicit revision for the PG batch join");
    const pgMismatch = await runVerifier([verifierPath, "--manifest", manifestPath, "--phase", "candidate", "--ledger", ledgerPath, "--remote", "fixture", "--candidate-revision", "candidate-1", "--parent-base", `${base}/parent`, "--candidate-base", `${base}/candidate`], { ...batchEnv, PG_BAD: "1" });
    assert.notEqual(pgMismatch.status, 0, "a single bounded PG batch mismatch blocks candidate verification");
    oldSourcePresent = true;
    const staleOld = await runVerifier([verifierPath, "--manifest", manifestPath, "--phase", "candidate", "--ledger", ledgerPath, "--test-fixture", "--parent-base", `${base}/parent`, "--candidate-base", `${base}/candidate`]);
    assert.notEqual(staleOld.status, 0, "an old source must never survive candidate projection");
    oldSourcePresent = false;
    badCandidateCount = true;
    const mismatched = await runVerifier([verifierPath, "--manifest", manifestPath, "--phase", "candidate", "--ledger", ledgerPath, "--test-fixture", "--parent-base", `${base}/parent`, "--candidate-base", `${base}/candidate`]);
    assert.notEqual(mismatched.status, 0, "replacement source total must equal parent plus delta");
    badCandidateCount = false;
    badCardCount = true;
    const cardMismatch = await runVerifier([verifierPath, "--manifest", manifestPath, "--phase", "candidate", "--ledger", ledgerPath, "--test-fixture", "--parent-base", `${base}/parent`, "--candidate-base", `${base}/candidate`]);
    assert.notEqual(cardMismatch.status, 0, "replacement ranking card count must equal source total");
    badCardCount = false;
    badSourcePath = true;
    const pathMismatch = await runVerifier([verifierPath, "--manifest", manifestPath, "--phase", "candidate", "--ledger", ledgerPath, "--test-fixture", "--parent-base", `${base}/parent`, "--candidate-base", `${base}/candidate`]);
    assert.notEqual(pathMismatch.status, 0, "replacement source detail path must remain the public empty-path contract");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("PG incremental dispatch can resume only an explicit same-repository artifact run", () => {
  assert.match(deployWorkflow, /artifact_run_id:/u);
  assert.match(
    deployWorkflow,
    /run-id: \$\{\{ inputs\.artifact_run_id \|\| github\.run_id \}\}/u,
  );
  assert.match(deployWorkflow, /repository: \$\{\{ github\.repository \}\}/u);
  assert.match(deployWorkflow, /github-token: \$\{\{ github\.token \}\}/u);
  assert.match(deployWorkflow, /if: \$\{\{ inputs\.artifact_name != '' \}\}/u);
});

test("rollback-only is a dispatch-time locked artifact-free CAS restore with exact online gates", () => {
  const rollbackJob = workflowJob(deployWorkflow, "rollback", "candidate");
  assert.match(deployWorkflow, /rollback_only:/u);
  for (const input of [
    "rollback_expected_current_revision",
    "rollback_target_parent_revision",
    "rollback_target_content_sha256",
    "rollback_source_key",
    "rollback_source_channel_id",
    "rollback_source_channel_handle",
    "rollback_source_occurrence_count",
    "rollback_source_video_count",
    "rollback_source_tuple_json",
  ]) {
    assert.match(deployWorkflow, new RegExp(`\\n      ${input}:\\n`, "u"));
  }
  assert.match(deployWorkflow, /EXPECTED_CURRENT_REVISION: \$\{\{ inputs\.rollback_expected_current_revision \|\| '' \}\}/u);
  assert.match(deployWorkflow, /EXPECTED_TARGET_REVISION: \$\{\{ inputs\.rollback_target_parent_revision \|\| '' \}\}/u);
  assert.match(deployWorkflow, /EXPECTED_TARGET_CONTENT_SHA256: \$\{\{ inputs\.rollback_target_content_sha256 \|\| '' \}\}/u);
  for (const staleRollbackValue of [
    "accepted_30389564789_1",
    "accepted_30347149376_1",
    "5d8a123075e2de5d0221a935004d74fe7e7daf18d0aa90f1f071ebdb3f104b6c",
    "d24ec2cab8f7f564",
  ]) {
    assert.doesNotMatch(rollbackJob, new RegExp(staleRollbackValue, "u"));
  }
  assert.doesNotMatch(
    rollbackJob,
    /EXPECTED_SOURCE_CHANNEL_ID: "UC8VlcljjGFb4-Ny2Heb0-ew"/u,
    "the source identity must be dispatch input, not a rollback default",
  );
  assert.match(
    rollbackJob,
    /github\.event_name == 'workflow_dispatch' && inputs\.rollback_only == true/u,
  );
  assert.doesNotMatch(rollbackJob, /download-artifact|ARTIFACT_NAME|import-pg-incremental|activate-pg-candidate/u);
  assert.match(rollbackJob, /missing-\$\{required_rollback_input,,\}/u);
  assert.match(rollbackJob, /invalid-current-revision/u);
  assert.match(rollbackJob, /invalid-target-revision/u);
  assert.match(rollbackJob, /invalid-target-content-sha256/u);
  assert.match(rollbackJob, /invalid-source-key/u);
  assert.match(rollbackJob, /invalid-source-channel-id/u);
  assert.match(rollbackJob, /invalid-source-channel-handle/u);
  assert.match(rollbackJob, /invalid-source-occurrence-count/u);
  assert.match(rollbackJob, /invalid-source-video-count/u);
  assert.match(rollbackJob, /invalid-source-tuple-json/u);
  assert.match(rollbackJob, /exit 78/u);
  assert.match(rollbackJob, /PG_ROLLBACK_WAIT concurrent-release/u);
  assert.match(rollbackJob, /pg_advisory_xact_lock\(hashtext\('daily-song-list\/active'\)\)/u);
  assert.match(rollbackJob, /WHERE state_key='active_revision_id'\s+FOR UPDATE/u);
  assert.match(rollbackJob, /current_revision IS DISTINCT FROM '\$EXPECTED_CURRENT_REVISION'/u);
  assert.match(rollbackJob, /current_parent IS DISTINCT FROM '\$EXPECTED_TARGET_REVISION'/u);
  assert.match(rollbackJob, /target_status IS DISTINCT FROM 'superseded'/u);
  assert.match(rollbackJob, /target_content_sha256 IS DISTINCT FROM '\$EXPECTED_TARGET_CONTENT_SHA256'/u);
  assert.match(rollbackJob, /target_status IS DISTINCT FROM 'active'/u);
  assert.match(rollbackJob, /SET status='rolled_back'/u);
  assert.match(rollbackJob, /SET status='active', activated_at=CURRENT_TIMESTAMP/u);
  assert.match(rollbackJob, /SET state_value='\$EXPECTED_TARGET_REVISION'/u);
  assert.equal(
    rollbackJob.match(/GET DIAGNOSTICS affected_rows = ROW_COUNT/gu)?.length,
    3,
    "all three rollback updates must assert exactly one affected row",
  );
  assert.match(rollbackJob, /systemctl restart song-rank-pg-api/u);
  assert.match(rollbackJob, /api\/sources\/\$source_key_path\?page=\$source_page&pageSize=100/u);
  assert.match(rollbackJob, /source_returned_occurrences.*EXPECTED_SOURCE_OCCURRENCE_COUNT/u);
  assert.match(rollbackJob, /public-source-pagination-video-mismatch/u);
  assert.match(rollbackJob, /public-source-tuple-mismatch/u);
  assert.match(rollbackJob, /occurrenceIdentityMismatchCount/u);
  assert.match(rollbackJob, /source_tuple_matches.*-eq 1/u);
  assert.match(rollbackJob, /audit-ranking-source-identities\.py/u);
  assert.match(rollbackJob, /timeout --signal=TERM --kill-after=15s 12m/u);
  for (const requiredAuditArgument of [
    "--range all --range 7d",
    "--metric count --metric songs --metric videos",
    "--page-size 200 --max-pages 20 --timeout 60",
    "--channel-probe '@shingames7857=UC5zO6IFsWSUHMYgJMv81XKg'",
    "--channel-probe '@MEDAzcd=UC0HX1e5jJnhN5Xn0epV2wzA'",
    "--channel-probe '@mikoto_songs=UCkZif4byA067Xl_c199w3BQ'",
    "--channel-probe '@urameshi_conta=UC8VlcljjGFb4-Ny2Heb0-ew'",
  ]) {
    assert.ok(rollbackJob.includes(requiredAuditArgument), `missing P0 audit argument: ${requiredAuditArgument}`);
  }
  assert.doesNotMatch(rollbackJob, /--negative-query\s+''/u);
  assert.match(rollbackJob, /IDENTITY_AUDIT_COMPLETE/u);
  assert.match(rollbackJob, /PG_ROLLBACK_PUBLIC_OK/u);
  assert.match(rollbackJob, /PG_ROLLBACK_CLEANUP/u);
  assert.match(
    rollbackJob,
    /TASK_ROOT=.*?[\s\S]*?trap cleanup EXIT INT TERM\s+baseline_free_bytes=/u,
    "cleanup trap must be installed before Mac storage probing",
  );
  const cleanupBody = /cleanup\(\) \{([\s\S]*?)^\s+\}\s+trap cleanup/mu.exec(rollbackJob)?.[1];
  assert.ok(cleanupBody, "missing rollback cleanup body");
  assert.doesNotMatch(
    cleanupBody,
    /UPDATE migration_(?:state|revisions)/u,
    "rollback cleanup must never perform a second pointer mutation",
  );
  assert.match(
    deployWorkflow,
    /github\.event_name != 'workflow_dispatch' \|\| inputs\.rollback_only != true/u,
    "normal candidate work must be skipped in rollback-only mode",
  );
  assert.match(deployWorkflow, /group: daily-song-list-pg-increment/u);
  assert.match(deployWorkflow, /cancel-in-progress: false/u);
});

test("accepted commits prepare a deterministic hashed artifact before the reusable deploy", () => {
  assert.match(acceptedWorkflow, /push:\s+branches: \[main\]/u);
  assert.match(
    acceptedWorkflow,
    /data\/external\/youtube-channel-discovery\/accepted\/\*\.json/u,
  );
  assert.match(acceptedWorkflow, /handoffKind:"github-accepted-paths"/u);
  assert.match(acceptedWorkflow, /source_commit_sha:\$source_commit_sha/u);
  assert.match(acceptedWorkflow, /source_base_sha:\$source_base_sha/u);
  assert.match(acceptedWorkflow, /patch_sha256:\$patch_sha256/u);
  assert.match(acceptedWorkflow, /accepted_files_sha256:\$accepted_files_sha256/u);
  assert.match(acceptedWorkflow, /--reviewed-at "\$source_committed_at"/u);
  assert.match(acceptedWorkflow, /duplicate-video-across-accepted-files/u);
  assert.match(acceptedWorkflow, /missing-source-detail-identity/u);
  assert.match(acceptedWorkflow, /accepted-source-identities\.py/u);
  assert.match(acceptedWorkflow, /\.sourceIdentityCount/u);
  assert.match(acceptedWorkflow, /\.sourceIdentityEvidence/u);
  assert.match(
    acceptedWorkflow,
    /sort \| first \/\/ ""/u,
    "the compatibility source key must use the same deterministic ordering as the evidence helper",
  );
  assert.match(
    acceptedWorkflow,
    /\.identityEvidence == \.sourceIdentityEvidence\[0\]/u,
  );
  assert.match(acceptedWorkflow, /repository_root="\$TASK_ROOT\/repository"/u);
  assert.match(acceptedWorkflow, /destination="\$repository_root\/\$repo_path"/u);
  assert.match(acceptedWorkflow, /--source-root "\$repository_root"/u);
  assert.match(
    acceptedWorkflow,
    /uses: \.\/\.github\/workflows\/deploy-pg-incremental\.yml/u,
  );
  assert.match(
    acceptedWorkflow,
    /artifact_run_id: \$\{\{ github\.run_id \}\}/u,
  );
});

test("accepted handoff manifest validation keeps root scope for source identity counts", () => {
  const match = /jq -e '\n(?<program>\s+\(\.status == "ready"\)[\s\S]*?)\n\s+' "\$TASK_ROOT\/artifact\/manifest\.json"/u.exec(acceptedWorkflow);
  assert.ok(match?.groups?.program, "accepted manifest jq validation block missing");
  const identity = {
    sourceDetailKey: "UCahlYbdb3AHrNQdojztSMvQ",
    acceptedVideoCount: 2,
    acceptedOccurrenceCount: 22,
    acceptedSongGroupCount: 22,
  };
  const manifest = {
    status: "ready",
    handoffKind: "github-accepted-paths",
    acceptedVideoCount: 2,
    acceptedOccurrenceCount: 22,
    source_commit_sha: "a".repeat(40),
    source_base_sha: "b".repeat(40),
    patch_sha256: "c".repeat(64),
    accepted_files_sha256: "d".repeat(64),
    acceptedFiles: [{ path: "accepted.json" }],
    sourceIdentityCount: 1,
    sourceIdentityEvidence: [identity],
    identityEvidence: identity,
  };
  const validate = (value) => spawnSync(
    "jq",
    ["-e", match.groups.program],
    {
      input: JSON.stringify(value),
      encoding: "utf8",
    },
  );
  for (const compatible of [
    manifest,
    { ...manifest, identityResetCount: null, identityResets: null },
    { ...manifest, identityResetCount: 0, identityResets: [] },
  ]) {
    const validation = validate(compatible);
    assert.equal(validation.status, 0, validation.stderr);
  }
  const completeResets = [
    [117, 1240],
    [103, 2569],
    [100, 1006],
    [95, 798],
  ].map(([parentVideoCount, parentOccurrenceCount]) => ({
    parentVideoCount,
    parentOccurrenceCount,
    complete: true,
    sourceReachedEnd: true,
    unresolvedParentVideoIds: [],
    unexpectedResetVideoIds: [],
  }));
  const completeValidation = validate({
    ...manifest,
    identityResetCount: completeResets.length,
    identityResets: completeResets,
  });
  assert.equal(completeValidation.status, 0, completeValidation.stderr);
  const incompleteValidation = validate({
    ...manifest,
    identityResetCount: completeResets.length,
    identityResets: [
      { ...completeResets[0], complete: false },
      ...completeResets.slice(1),
    ],
  });
  assert.notEqual(incompleteValidation.status, 0);
});

test("GitHub accepted handoffs bind and verify every distinct source probe", () => {
  assert.match(
    deployWorkflow,
    /fetch_input "scripts\/migration\/accepted-source-identities\.py"/u,
  );
  assert.match(deployWorkflow, /workflow-run-source-identities-invalid/u);
  assert.match(deployWorkflow, /sort \| first \/\/ ""/u);
  assert.match(
    deployWorkflow,
    /--verify-manifest "\$MANIFEST_INPUT"/u,
  );
  assert.match(
    deployWorkflow,
    /accepted-source-identities-mismatch/u,
  );
  assert.match(
    deployWorkflow,
    /jq -ce '\.sourceIdentityEvidence\[\]' "\$SOURCE_IDENTITIES_JSON"/u,
  );
  assert.match(deployWorkflow, /source_identity_probe_count/u);
  assert.match(deployWorkflow, /while IFS= read -r probe_identity; do/u);
  assert.match(deployWorkflow, /candidate-source-\$probe_index-\$source_page\.json/u);
  assert.match(deployWorkflow, /public-source-\$probe_index-\$source_page\.json/u);
  assert.equal(
    deployWorkflow.match(/pageSize=100&q=\$probe_video_path/gu)?.length,
    2,
    "candidate and public gates must filter before pagination by the exact probe video",
  );
  assert.match(deployWorkflow, /PG_INCREMENT_CANDIDATE_SOURCES_OK/u);
  assert.match(deployWorkflow, /PG_INCREMENT_PUBLIC_SOURCES_OK/u);
  assert.match(acceptedWorkflow, /\.acceptedSongGroupCount/u);
  assert.match(
    acceptedWorkflow,
    /\(\[\.sourceIdentityEvidence\[\]\.acceptedOccurrenceCount\] \| add\) == \.acceptedOccurrenceCount/u,
  );
  assert.match(deployWorkflow, /\.acceptedSongGroupCount/u);
  assert.match(
    deployWorkflow,
    /\.kind == "accepted-increment"/u,
    "all accepted increments must recompute source evidence from the actual patch",
  );
  assert.match(
    deployWorkflow,
    /\.identityEvidence\.sourceDetailKey \/\/ empty/u,
    "legacy single-source artifacts retain their exact compatibility path",
  );
});

test("PG release fails closed, verifies its real source, and rolls back post-activation failures", () => {
  assert.match(deployWorkflow, /PG_INCREMENT_WAIT concurrent-release/u);
  assert.match(deployWorkflow, /existing-ready-source/u);
  assert.match(deployWorkflow, /\.activeSnapshotRevisionId/u);
  assert.match(deployWorkflow, /curation-active-snapshot-mismatch/u);
  assert.match(deployWorkflow, /PG_INCREMENT_CURATION_SOURCE_GATE/u);
  assert.match(deployWorkflow, /candidate-parent-changed/u);
  assert.match(deployWorkflow, /video-count-mismatch/u);
  assert.match(deployWorkflow, /occurrence-count-mismatch/u);
  assert.match(deployWorkflow, /candidate-source-commit-mismatch/u);
  assert.match(deployWorkflow, /candidate-meta-stream-sha-mismatch/u);
  assert.match(
    deployWorkflow,
    /\.identityEvidence\.sourceDetailKey \/\/ empty/u,
  );
  assert.match(deployWorkflow, /source-detail-identity-unparseable/u);
  assert.doesNotMatch(
    deployWorkflow,
    /\.song\.occurrenceId/u,
    "the source API does not expose occurrenceId inside song",
  );
  assert.match(deployWorkflow, /\.record\.occurrences\[\]\? \|/u);
  assert.match(deployWorkflow, /identityMatch:/u);
  assert.match(deployWorkflow, /videoMatchCount:\$video_match_count/u);
  assert.match(deployWorkflow, /tupleMatchCount:\$tuple_match_count/u);
  assert.match(deployWorkflow, /PG_INCREMENT_SOURCE_PAGE/u);
  assert.match(deployWorkflow, /PG_INCREMENT_PUBLIC_SOURCE_PAGE/u);
  assert.doesNotMatch(
    deployWorkflow,
    /source_detail_matches_probe/u,
    "candidate and public gates must both use the defined metrics helper",
  );
  assert.match(deployWorkflow, /candidate-source-identity-mismatch/u);
  assert.match(deployWorkflow, /public-source-identity-mismatch/u);
  assert.match(deployWorkflow, /source-detail-key-missing/u);
  assert.match(deployWorkflow, /rankings_probe_metrics\(\)/u);
  assert.match(deployWorkflow, /fetch_rankings_probe\(\)/u);
  assert.match(deployWorkflow, /verify_rankings_probe\(\)/u);
  assert.match(
    deployWorkflow,
    /pageSize=30&q=\$rank_query_path&searchFields=title%2Cchannel/u,
    "the source rankings gate must use the reviewed channel-search contract",
  );
  assert.match(
    deployWorkflow,
    /pageSize=50&q=\$probe_video_path&searchFields=video/u,
    "a second rankings query must bind an exact patch tuple",
  );
  assert.match(deployWorkflow, /\.totalOccurrenceCount == \$occurrences/u);
  assert.match(deployWorkflow, /\.totalCount == \$groups/u);
  assert.match(deployWorkflow, /\.identityMismatchCount == 0/u);
  assert.match(deployWorkflow, /tuple_matches.*-eq 1/u);
  assert.match(
    deployWorkflow,
    /verify_rankings_probe candidate "http:\/\/127\.0\.0\.1:18766"/u,
  );
  assert.match(
    deployWorkflow,
    /verify_rankings_probe public "https:\/\/ytb-song-rank\.culua\.com"/u,
  );
  assert.match(
    deployWorkflow,
    /test "\$http_code" = 200/u,
    "candidate and public rankings probes must require exact HTTP 200",
  );
  assert.doesNotMatch(
    deployWorkflow.match(/rankings_probe_metrics\(\) \{[\s\S]*?\n            \}/u)?.[0] ?? "",
    /channelUrl/u,
    "historically polluted channel URLs must not participate in rankings identity",
  );
  assert.doesNotMatch(
    deployWorkflow,
    /api\/sources\/Naraetan/u,
    "source detail must never fall back to an unrelated known channel",
  );
  assert.match(deployWorkflow, /rollback guard failed current=/u);
  assert.match(
    deployWorkflow,
    /cleanup\(\) \{\s+status=\$\?\s+set \+e/u,
    "cleanup must preserve the original status and disable errexit before rollback",
  );
  assert.match(deployWorkflow, /pg_adapter\.py\.bak/u);
  assert.match(deployWorkflow, /systemctl disable --now song-rank-api/u);
  assert.match(deployWorkflow, /https:\/\/ytb-song-rank\.culua\.com\/healthz/u);
});

test("workflow-run accepted conversion sorts repository paths and uses a stable source root", () => {
  assert.match(deployWorkflow, /\] \| sort\[\]/u);
  assert.match(deployWorkflow, /ACCEPTED_ROOT="\$TASK_ROOT\/repository"/u);
  assert.match(deployWorkflow, /destination="\$ACCEPTED_ROOT\/\$source_path"/u);
  assert.match(deployWorkflow, /--source-root "\$ACCEPTED_ROOT"/u);
});

test("VPS host is a required reusable secret injected into both release jobs", () => {
  const reusableSecretBlock =
    /^    secrets:\n      VPS2_HOST:\n        required: true\n      VPS2_PASSWORD:\n        required: true\n      VPS2_KNOWN_HOSTS:\n        required: true$/mu;
  const secretHostInjection =
    /^\s{6}VPS2_HOST: \$\{\{ secrets\.VPS2_HOST \}\}$/gmu;
  const publicHostInjection =
    /^\s{6}VPS2_HOST: \$\{\{ vars\.VPS2_HOST \}\}$/mu;
  const secretHostContractHolds = (candidateText) => (
    reusableSecretBlock.test(candidateText)
    && (candidateText.match(secretHostInjection) ?? []).length === 2
    && !publicHostInjection.test(candidateText)
  );
  assert.equal(secretHostContractHolds(deployWorkflow), true);
  const publicVariableReintroduced = deployWorkflow.replaceAll(
    "VPS2_HOST: ${{ secrets.VPS2_HOST }}",
    "VPS2_HOST: ${{ vars.VPS2_HOST }}",
  );
  const requiredSecretRelaxed = deployWorkflow.replace(
    "      VPS2_HOST:\n        required: true",
    "      VPS2_HOST:\n        required: false",
  );
  assert.equal(secretHostContractHolds(publicVariableReintroduced), false);
  assert.equal(secretHostContractHolds(requiredSecretRelaxed), false);
  const inheritedReusableCall =
    /^\s{4}uses: \.\/\.github\/workflows\/deploy-pg-incremental\.yml\n[\s\S]*?^\s{4}secrets: inherit$/mu;
  for (const caller of [acceptedWorkflow, recoveryWorkflow]) {
    assert.match(caller, inheritedReusableCall);
  }
});
