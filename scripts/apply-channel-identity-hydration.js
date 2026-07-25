#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  loadChannelMetadataCache,
  normalizeChannelMetadata,
} = require("./channel-metadata-cache");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_METADATA_PATH = path.join(
  ROOT,
  "data",
  "external",
  "youtube-channel-discovery",
  "channel-metadata.json",
);
const DEFAULT_OUTPUT_DIR = path.join(
  ROOT,
  "artifacts",
  "channel-identity-hydration",
);
const APPLY_CONFIRMATION = "WRITE_CHANNEL_METADATA";
const FELICIA_CHANNEL_ID = "UClHap4tvcYZnyiqgAyEs0BQ";
const FELICIA_HANDLE = "/@felicialulufleur";
const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{20,}$/u;
const HANDLE_PATTERN = /^\/?@[A-Za-z0-9._%~-]+$/u;

function main() {
  const options = parseArgs(process.argv.slice(2));
  validateOptions(options);
  const audit = readJson(options.candidatesPath);
  const metadata = loadChannelMetadataCache(options.metadataPath);
  options.now = options.now || new Date();
  const planned = planChannelMetadataHydration(audit, metadata, {
    expectedDeliverableCount: options.expectedDeliverableCount,
    now: options.now,
  });
  const report = buildApplicationReport(planned, options);
  const generatedEntries = buildGeneratedEntriesPayload(
    planned,
    options,
  );
  writeJsonAtomic(options.reportJsonPath, report);
  writeMarkdown(options.reportMarkdownPath, renderApplicationMarkdown(report));
  writeJsonAtomic(options.entriesJsonPath, generatedEntries);

  if (options.applyMetadata && planned.stats.changed > 0) {
    writeJsonAtomic(options.metadataPath, planned.metadataAfter);
  }

  console.log(
    [
      "CODEX_CHANNEL_IDENTITY_HYDRATION_OK",
      `dryRun=${!options.applyMetadata}`,
      `eligible=${planned.stats.eligible}`,
      `added=${planned.stats.added}`,
      `filled=${planned.stats.filled}`,
      `unchanged=${planned.stats.unchanged}`,
      `conflicts=${planned.stats.conflicts}`,
      `excluded=${planned.stats.excluded}`,
      `ambiguous=${planned.stats.ambiguous}`,
      `unresolved=${planned.stats.unresolved}`,
      `changed=${planned.stats.changed}`,
    ].join(" "),
  );
}

function parseArgs(args) {
  const options = {
    candidatesPath: "",
    metadataPath: DEFAULT_METADATA_PATH,
    outputDir: DEFAULT_OUTPUT_DIR,
    reportJsonPath: "",
    reportMarkdownPath: "",
    entriesJsonPath: "",
    applyMetadata: false,
    confirmation: "",
    expectedDeliverableCount: null,
    now: null,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--candidates") {
      options.candidatesPath = path.resolve(requiredValue(args, ++index, arg));
    } else if (arg === "--metadata") {
      options.metadataPath = path.resolve(requiredValue(args, ++index, arg));
    } else if (arg === "--output-dir") {
      options.outputDir = path.resolve(requiredValue(args, ++index, arg));
    } else if (arg === "--report-json") {
      options.reportJsonPath = path.resolve(requiredValue(args, ++index, arg));
    } else if (arg === "--report-markdown") {
      options.reportMarkdownPath = path.resolve(requiredValue(args, ++index, arg));
    } else if (arg === "--entries-json") {
      options.entriesJsonPath = path.resolve(requiredValue(args, ++index, arg));
    } else if (arg === "--expected-deliverable-count") {
      options.expectedDeliverableCount = positiveInt(
        requiredValue(args, ++index, arg),
        arg,
      );
    } else if (arg === "--apply-metadata") {
      options.applyMetadata = true;
    } else if (arg === "--confirm-apply") {
      options.confirmation = requiredValue(args, ++index, arg);
    } else if (arg === "--dry-run") {
      options.applyMetadata = false;
    } else if (arg === "--apply" || arg === "--import" || arg === "--merge") {
      throw new Error(
        `${arg} is unsupported; use --apply-metadata with --confirm-apply ${APPLY_CONFIRMATION}`,
      );
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  options.reportJsonPath ||= path.join(options.outputDir, "apply-report.json");
  options.reportMarkdownPath ||= path.join(
    options.outputDir,
    "apply-report.md",
  );
  options.entriesJsonPath ||= path.join(
    options.outputDir,
    "generated-entries.json",
  );
  return options;
}

function validateOptions(options) {
  if (!options.candidatesPath) {
    throw new Error("--candidates is required");
  }
  if (options.applyMetadata) {
    if (options.confirmation !== APPLY_CONFIRMATION) {
      throw new Error(
        `--apply-metadata requires --confirm-apply ${APPLY_CONFIRMATION}`,
      );
    }
    if (!Number.isInteger(options.expectedDeliverableCount)) {
      throw new Error(
        "--apply-metadata requires --expected-deliverable-count to prevent partial input",
      );
    }
  } else if (options.confirmation) {
    throw new Error("--confirm-apply is only valid with --apply-metadata");
  }
}

function planChannelMetadataHydration(audit, metadata, options = {}) {
  const envelope = validateAuditEnvelope(
    audit,
    options.expectedDeliverableCount,
  );
  const metadataBefore = clone(metadata);
  const working = clone(metadata);
  working.channels = Array.isArray(working.channels)
    ? working.channels
    : [];

  const stats = {
    inputHighConfidence: audit.highConfidence.length,
    eligible: envelope.eligible.length,
    excluded: envelope.excluded.length,
    ambiguous: audit.ambiguous.length,
    unresolved: audit.unresolved.length,
    added: 0,
    filled: 0,
    fieldsFilled: 0,
    unchanged: 0,
    conflicts: 0,
    duplicateCandidates: 0,
    invalidCandidates: 0,
    nameCollisionWarnings: 0,
    changed: 0,
    skipped: 0,
  };
  const results = [
    ...envelope.excluded.map((candidate) =>
      resultForCandidate(candidate, "excluded", "excluded_known_positive"),
    ),
    ...audit.ambiguous.map((candidate) =>
      resultForCandidate(candidate, "ambiguous", "manual_review"),
    ),
    ...audit.unresolved.map((candidate) =>
      resultForCandidate(candidate, "unresolved", "manual_review"),
    ),
  ];

  const candidateIdentity = buildCandidateIdentityIndex();
  let existingIndex = buildExistingIdentityIndex(working.channels);

  for (const candidate of envelope.eligible) {
    const proposed = normalizeCandidateIdentity(candidate);
    if (!proposed.valid) {
      stats.invalidCandidates += 1;
      stats.conflicts += 1;
      results.push(
        resultForCandidate(
          candidate,
          "conflict",
          proposed.reason,
          proposed,
        ),
      );
      continue;
    }

    const candidateConflict = registerCandidateIdentity(
      candidateIdentity,
      proposed,
      candidate,
    );
    if (candidateConflict.kind === "duplicate") {
      stats.duplicateCandidates += 1;
      results.push(
        resultForCandidate(
          candidate,
          "duplicate_candidate",
          candidateConflict.reason,
          proposed,
        ),
      );
      continue;
    }
    if (candidateConflict.kind === "conflict") {
      stats.conflicts += 1;
      results.push(
        resultForCandidate(
          candidate,
          "conflict",
          candidateConflict.reason,
          proposed,
        ),
      );
      continue;
    }

    const resolution = resolveExistingTarget(
      existingIndex,
      working.channels,
      proposed,
    );
    if (resolution.kind === "conflict") {
      stats.conflicts += 1;
      results.push(
        resultForCandidate(
          candidate,
          "conflict",
          resolution.reason,
          proposed,
          {
            existingIndexes: resolution.indexes,
          },
        ),
      );
      continue;
    }

    if (resolution.kind === "existing") {
      const target = working.channels[resolution.index];
      const fieldsFilled = fillMissingIdentityFields(target, proposed);
      if (fieldsFilled.length) {
        stats.filled += 1;
        stats.fieldsFilled += fieldsFilled.length;
        results.push(
          resultForCandidate(
            candidate,
            "filled",
            "filled_missing_identity_fields",
            proposed,
            {
              existingIndex: resolution.index,
              fieldsFilled,
            },
          ),
        );
        existingIndex = buildExistingIdentityIndex(working.channels);
      } else {
        stats.unchanged += 1;
        results.push(
          resultForCandidate(
            candidate,
            "unchanged",
            "existing_complete_identity_preserved",
            proposed,
            {
              existingIndex: resolution.index,
            },
          ),
        );
      }
      continue;
    }

    const nameCollisions = findNameCollisions(
      working.channels,
      proposed.displayName,
    );
    if (nameCollisions.length) stats.nameCollisionWarnings += 1;
    working.channels.push(newMetadataEntry(proposed));
    stats.added += 1;
    results.push(
      resultForCandidate(
        candidate,
        "added",
        "new_strong_identity",
        proposed,
        {
          nameCollisionIndexes: nameCollisions,
        },
      ),
    );
    existingIndex = buildExistingIdentityIndex(working.channels);
  }

  stats.changed = stats.added + stats.filled;
  stats.skipped =
    stats.excluded +
    stats.ambiguous +
    stats.unresolved +
    stats.unchanged +
    stats.conflicts +
    stats.duplicateCandidates;

  if (stats.changed > 0) {
    working.schemaVersion = working.schemaVersion || 1;
    working.sourceSystem =
      working.sourceSystem || "youtube_channel_discovery";
    working.generatedAt = timestamp(options.now);
    working.channels.sort(compareMetadataEntries);
  }

  const beforeSerialized = serializeJson(metadataBefore);
  const afterSerialized = serializeJson(working);
  return {
    audit,
    metadataBefore,
    metadataAfter: working,
    stats,
    results,
    before: {
      ...metadataStats(metadataBefore.channels),
      sha256: sha256(beforeSerialized),
    },
    after: {
      ...metadataStats(working.channels),
      sha256: sha256(afterSerialized),
    },
  };
}

function validateAuditEnvelope(audit, expectedDeliverableCount) {
  if (!audit || typeof audit !== "object") {
    throw new Error("Candidate audit must be a JSON object");
  }
  if (!audit.shard?.merged) {
    throw new Error(
      "Candidate audit must be a merged full-run report; partial shards are rejected",
    );
  }
  for (const field of ["highConfidence", "ambiguous", "unresolved"]) {
    if (!Array.isArray(audit[field])) {
      throw new Error(`Candidate audit is missing ${field}`);
    }
  }
  const eligible = [];
  const excluded = [];
  for (const candidate of audit.highConfidence) {
    if (
      candidate.deliveryDisposition === "excluded_known_positive" ||
      isFelicia(candidate)
    ) {
      excluded.push(candidate);
    } else if (
      candidate.classification === "high-confidence" &&
      candidate.deliveryDisposition === "review_then_hydrate"
    ) {
      eligible.push(candidate);
    } else {
      throw new Error(
        `Unexpected high-confidence disposition for ${candidate.groupKey || "unknown"}`,
      );
    }
  }
  const declared = nonNegativeInt(
    audit.summary?.deliverableHighConfidenceCount,
  );
  if (declared !== eligible.length) {
    throw new Error(
      `Deliverable count mismatch: summary=${declared} actual=${eligible.length}`,
    );
  }
  if (
    Number.isInteger(expectedDeliverableCount) &&
    expectedDeliverableCount !== eligible.length
  ) {
    throw new Error(
      `Expected ${expectedDeliverableCount} deliverable candidates, got ${eligible.length}`,
    );
  }
  if (
    nonNegativeInt(audit.summary?.ambiguousCount) !== audit.ambiguous.length ||
    nonNegativeInt(audit.summary?.unresolvedCount) !== audit.unresolved.length
  ) {
    throw new Error("Manual queue counts do not match the merged report");
  }
  return { eligible, excluded };
}

function normalizeCandidateIdentity(candidate) {
  const proposed = candidate?.proposed || {};
  const channelId = validChannelId(proposed.channelId);
  const handle = normalizeHandle(proposed.channelHandle);
  const channelUrl = canonicalChannelUrl(
    proposed.channelUrl,
    channelId,
  );
  const sourceUrl =
    canonicalHandleUrl(proposed.sourceUrl, handle) ||
    (handle ? `https://www.youtube.com${handle}` : channelUrl);
  const displayName =
    stringValue(proposed.displayName) ||
    stringValue(candidate?.sourceNames?.[0]);
  const sampledVideoId = (candidate?.sampledVideoIds || []).find((value) =>
    /^[A-Za-z0-9_-]{11}$/u.test(stringValue(value)),
  );
  const thumbnailUrl = sampledVideoId
    ? `https://i.ytimg.com/vi/${sampledVideoId}/hqdefault.jpg`
    : "";
  const strongEvidence = (candidate?.evidence?.direct || []).some((item) =>
    [
      "runtime_channel_id",
      "runtime_handle",
      "metadata_cache_strong_identity",
      "metadata_cache_video_thumbnail",
      "youtube_watch",
      "youtube_oembed",
    ].includes(item?.kind),
  );
  const officialConfirmation = /^official_identity_confirmed/u.test(
    stringValue(candidate?.confidenceReason),
  );
  const valid = Boolean(
    channelId &&
      handle &&
      channelUrl === `https://www.youtube.com/channel/${channelId}` &&
      sourceUrl &&
      displayName &&
      strongEvidence &&
      officialConfirmation,
  );
  return {
    valid,
    reason: valid
      ? ""
      : !strongEvidence || !officialConfirmation
        ? "candidate_missing_official_confirmation_evidence"
        : "incomplete_or_noncanonical_candidate_identity",
    channelId,
    handle,
    channelUrl,
    sourceUrl,
    displayName,
    thumbnailUrl,
  };
}

function buildCandidateIdentityIndex() {
  return {
    byId: new Map(),
    byHandle: new Map(),
  };
}

function registerCandidateIdentity(index, proposed, candidate) {
  const handleKey = normalizeHandleKey(proposed.handle);
  const byId = index.byId.get(proposed.channelId);
  const byHandle = index.byHandle.get(handleKey);
  if (byId) {
    if (
      byId.proposed.channelId === proposed.channelId &&
      normalizeHandleKey(byId.proposed.handle) === handleKey
    ) {
      return {
        kind: "duplicate",
        reason: `duplicate_strong_identity:${byId.candidate.groupKey}`,
      };
    }
    return {
      kind: "conflict",
      reason: `candidate_channel_id_conflict:${byId.candidate.groupKey}`,
    };
  }
  if (byHandle) {
    if (byHandle.proposed.channelId === proposed.channelId) {
      return {
        kind: "duplicate",
        reason: `duplicate_strong_identity:${byHandle.candidate.groupKey}`,
      };
    }
    return {
      kind: "conflict",
      reason: `candidate_handle_conflict:${byHandle.candidate.groupKey}`,
    };
  }
  const value = { proposed, candidate };
  index.byId.set(proposed.channelId, value);
  index.byHandle.set(handleKey, value);
  return { kind: "registered", reason: "" };
}

function buildExistingIdentityIndex(channels) {
  const byId = new Map();
  const byHandle = new Map();
  channels.forEach((channel, index) => {
    const normalized = normalizeChannelMetadata(channel);
    addIndexValue(byId, validChannelId(normalized.channelId), index);
    addIndexValue(
      byHandle,
      normalizeHandleKey(normalized.channelHandle),
      index,
    );
  });
  return { byId, byHandle };
}

function addIndexValue(map, key, index) {
  if (!key) return;
  const values = map.get(key) || [];
  values.push(index);
  map.set(key, values);
}

function resolveExistingTarget(index, channels, proposed) {
  const idMatches = index.byId.get(proposed.channelId) || [];
  const handleMatches =
    index.byHandle.get(normalizeHandleKey(proposed.handle)) || [];
  const allMatches = [...new Set([...idMatches, ...handleMatches])];
  if (idMatches.length > 1 || handleMatches.length > 1) {
    return {
      kind: "conflict",
      reason: "existing_duplicate_strong_identity",
      indexes: allMatches,
    };
  }
  if (allMatches.length > 1) {
    return {
      kind: "conflict",
      reason: "existing_split_channel_id_and_handle",
      indexes: allMatches,
    };
  }
  if (!allMatches.length) return { kind: "new" };

  const targetIndex = allMatches[0];
  const target = channels[targetIndex];
  const normalized = normalizeChannelMetadata(target);
  const linkedHandles = [
    normalizeHandle(target.sourceUrl),
    normalizeHandle(target.channelUrl),
  ].filter(Boolean);
  if (
    (normalized.channelId &&
      normalized.channelId !== proposed.channelId) ||
    (normalized.channelHandle &&
      normalizeHandleKey(normalized.channelHandle) !==
        normalizeHandleKey(proposed.handle)) ||
    channelUrlConflicts(normalized.channelUrl, proposed.channelId) ||
    linkedHandles.some(
      (handle) =>
        normalizeHandleKey(handle) !==
        normalizeHandleKey(proposed.handle),
    )
  ) {
    return {
      kind: "conflict",
      reason: "existing_strong_identity_conflict",
      indexes: [targetIndex],
    };
  }
  return { kind: "existing", index: targetIndex };
}

function fillMissingIdentityFields(target, proposed) {
  const fieldsFilled = [];
  for (const [field, value] of [
    ["handle", proposed.handle],
    ["displayName", proposed.displayName],
    ["channelId", proposed.channelId],
    ["channelUrl", proposed.channelUrl],
    ["sourceUrl", proposed.sourceUrl],
  ]) {
    if (!stringValue(target[field]) && value) {
      target[field] = value;
      fieldsFilled.push(field);
    }
  }
  return fieldsFilled;
}

function newMetadataEntry(proposed) {
  return {
    handle: proposed.handle,
    displayName: proposed.displayName,
    channelId: proposed.channelId,
    channelUrl: proposed.channelUrl,
    sourceUrl: proposed.sourceUrl,
    avatarUrl: "",
    thumbnailUrl: proposed.thumbnailUrl,
  };
}

function findNameCollisions(channels, displayName) {
  const key = normalizeText(displayName);
  if (!key) return [];
  const matches = [];
  channels.forEach((channel, index) => {
    if (
      normalizeText(
        channel.displayName || channel.channelName || channel.name,
      ) === key
    ) {
      matches.push(index);
    }
  });
  return matches;
}

function buildApplicationReport(planned, options) {
  return {
    schemaVersion: 1,
    generatedAt: timestamp(options.now),
    dryRun: !options.applyMetadata,
    input: {
      candidatesPath: portablePath(options.candidatesPath),
      metadataPath: portablePath(options.metadataPath),
      sourceCommitSha:
        planned.audit.source?.meta?.sourceCommitSha || "",
      expectedDeliverableCount: options.expectedDeliverableCount,
      merged: Boolean(planned.audit.shard?.merged),
    },
    outputs: {
      generatedEntriesPath: portablePath(options.entriesJsonPath),
    },
    confirmation: {
      applyRequested: options.applyMetadata,
      explicitConfirmationAccepted:
        options.applyMetadata &&
        options.confirmation === APPLY_CONFIRMATION,
    },
    before: planned.before,
    after: planned.after,
    stats: planned.stats,
    conflicts: planned.results.filter(
      (result) => result.status === "conflict",
    ),
    skipped: planned.results.filter((result) =>
      [
        "excluded",
        "ambiguous",
        "unresolved",
        "unchanged",
        "duplicate_candidate",
      ].includes(result.status),
    ),
    changes: planned.results.filter((result) =>
      ["added", "filled"].includes(result.status),
    ),
  };
}

function buildGeneratedEntriesPayload(planned, options = {}) {
  const channels = planned.results
    .filter((result) => result.status === "added")
    .map((result) => newMetadataEntry(result.proposed))
    .sort(compareMetadataEntries);
  return {
    schemaVersion: 1,
    sourceSystem: "youtube_channel_discovery",
    generatedAt: timestamp(options.now),
    source: {
      kind: "channel_identity_hydration_audit",
      sourceCommitSha:
        planned.audit.source?.meta?.sourceCommitSha || "",
      candidateCount: planned.stats.eligible,
      note: "Canonical metadata entries generated from merged high-confidence audit candidates; excluded/manual/conflicting candidates are absent.",
    },
    entryCount: channels.length,
    channels,
  };
}

function renderApplicationMarkdown(report) {
  const stats = report.stats;
  const lines = [
    "# Channel identity metadata hydration",
    "",
    `- Generated: \`${report.generatedAt}\``,
    `- Dry-run: \`${report.dryRun}\``,
    `- Full merged input: \`${report.input.merged}\``,
    `- Expected deliverable candidates: ${report.input.expectedDeliverableCount ?? "not asserted"}`,
    `- Metadata SHA-256: \`${report.before.sha256}\` -> \`${report.after.sha256}\``,
    "",
    "## Summary",
    "",
    "| Metric | Count |",
    "| --- | ---: |",
    `| high-confidence input | ${stats.inputHighConfidence} |`,
    `| eligible | ${stats.eligible} |`,
    `| added | ${stats.added} |`,
    `| filled existing | ${stats.filled} |`,
    `| identity fields filled | ${stats.fieldsFilled} |`,
    `| unchanged complete | ${stats.unchanged} |`,
    `| conflicts | ${stats.conflicts} |`,
    `| duplicate candidates | ${stats.duplicateCandidates} |`,
    `| excluded known-positive | ${stats.excluded} |`,
    `| ambiguous | ${stats.ambiguous} |`,
    `| unresolved | ${stats.unresolved} |`,
    `| changed entries | ${stats.changed} |`,
    "",
    "## Before / after",
    "",
    "| Metric | Before | After |",
    "| --- | ---: | ---: |",
    `| channels | ${report.before.channelCount} | ${report.after.channelCount} |`,
    `| complete identity | ${report.before.completeIdentityCount} | ${report.after.completeIdentityCount} |`,
    `| channelId present | ${report.before.channelIdPresent} | ${report.after.channelIdPresent} |`,
    `| handle present | ${report.before.handlePresent} | ${report.after.handlePresent} |`,
    `| channelUrl present | ${report.before.channelUrlPresent} | ${report.after.channelUrlPresent} |`,
    "",
  ];
  appendResultTable(lines, "Conflicts", report.conflicts);
  appendResultTable(lines, "Skipped", report.skipped);
  appendResultTable(lines, "Changes", report.changes);
  lines.push(
    "",
    "## Safety",
    "",
    "- Metadata is written only with `--apply-metadata --confirm-apply WRITE_CHANNEL_METADATA`.",
    "- Apply mode also requires `--expected-deliverable-count`; partial shard reports are rejected.",
    "- Felicia, ambiguous, unresolved, invalid, and strong-identity conflicts are never written.",
    "- Display names are not identity keys and never cause an overwrite.",
    "",
  );
  return `${lines.join("\n")}\n`;
}

function appendResultTable(lines, title, results) {
  lines.push(`## ${title}`, "");
  lines.push("| Group | Status | Reason | Channel ID | Handle |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const result of results.slice(0, 100)) {
    lines.push(
      `| ${markdownCell(result.groupKey)} | ${result.status} | ${markdownCell(result.reason)} | ${result.proposed?.channelId || ""} | ${result.proposed?.handle || ""} |`,
    );
  }
  if (results.length > 100) {
    lines.push("", `_JSON contains ${results.length - 100} additional rows._`);
  }
  lines.push("");
}

function resultForCandidate(
  candidate,
  status,
  reason,
  proposed = null,
  extra = {},
) {
  return {
    groupKey: stringValue(candidate?.groupKey),
    sourceNames: Array.isArray(candidate?.sourceNames)
      ? candidate.sourceNames
      : [],
    classification: stringValue(candidate?.classification),
    deliveryDisposition: stringValue(
      candidate?.deliveryDisposition,
    ),
    status,
    reason,
    proposed,
    ...extra,
  };
}

function metadataStats(channels) {
  const values = Array.isArray(channels) ? channels : [];
  const normalized = values.map(normalizeChannelMetadata);
  return {
    channelCount: values.length,
    completeIdentityCount: normalized.filter(
      (channel) =>
        validChannelId(channel.channelId) &&
        normalizeHandle(channel.channelHandle) &&
        canonicalChannelUrl(
          channel.channelUrl,
          channel.channelId,
        ),
    ).length,
    channelIdPresent: normalized.filter((channel) =>
      validChannelId(channel.channelId),
    ).length,
    handlePresent: normalized.filter((channel) =>
      normalizeHandle(channel.channelHandle),
    ).length,
    channelUrlPresent: normalized.filter((channel) =>
      canonicalChannelUrl(
        channel.channelUrl,
        channel.channelId,
      ),
    ).length,
  };
}

function isFelicia(candidate) {
  const channelId = validChannelId(candidate?.proposed?.channelId);
  const handle = normalizeHandleKey(
    candidate?.proposed?.channelHandle,
  );
  return (
    channelId === FELICIA_CHANNEL_ID ||
    handle === FELICIA_HANDLE
  );
}

function canonicalHandleUrl(value, fallbackHandle = "") {
  const handle =
    normalizeHandle(value) || normalizeHandle(fallbackHandle);
  return handle ? `https://www.youtube.com${handle}` : "";
}

function canonicalChannelUrl(value, fallbackChannelId = "") {
  const text = stringValue(value);
  const fromUrl = text.match(
    /^https?:\/\/(?:www\.)?youtube\.com\/channel\/([^/?#]+)(?:[/?#]|$)/iu,
  )?.[1];
  const channelId =
    validChannelId(fromUrl) || validChannelId(fallbackChannelId);
  return channelId
    ? `https://www.youtube.com/channel/${channelId}`
    : "";
}

function channelUrlConflicts(value, expectedChannelId) {
  const text = stringValue(value);
  if (!text) return false;
  const match = text.match(
    /youtube\.com\/channel\/([^/?#]+)/iu,
  )?.[1];
  return Boolean(match && validChannelId(match) !== expectedChannelId);
}

function validChannelId(value) {
  const text = stringValue(value);
  return CHANNEL_ID_PATTERN.test(text) ? text : "";
}

function normalizeHandle(value) {
  const text = stringValue(value);
  if (!text) return "";
  const match = text.match(
    /^(?:https?:\/\/(?:www\.)?youtube\.com)?(\/?@[A-Za-z0-9._%~-]+)(?:[/?#]|$)/iu,
  );
  if (!match) {
    return HANDLE_PATTERN.test(text)
      ? text.startsWith("/")
        ? text
        : `/${text}`
      : "";
  }
  const handle = match[1].startsWith("/")
    ? match[1]
    : `/${match[1]}`;
  return HANDLE_PATTERN.test(handle) ? handle : "";
}

function normalizeHandleKey(value) {
  return normalizeHandle(value).toLocaleLowerCase();
}

function normalizeText(value) {
  return stringValue(value).normalize("NFKC").toLocaleLowerCase();
}

function compareMetadataEntries(left, right) {
  const leftNormalized = normalizeChannelMetadata(left);
  const rightNormalized = normalizeChannelMetadata(right);
  const leftKey = (
    leftNormalized.channelHandle ||
    leftNormalized.channelId ||
    leftNormalized.displayName
  ).toLocaleLowerCase();
  const rightKey = (
    rightNormalized.channelHandle ||
    rightNormalized.channelId ||
    rightNormalized.displayName
  ).toLocaleLowerCase();
  return (
    leftKey.localeCompare(rightKey) ||
    leftNormalized.channelId.localeCompare(
      rightNormalized.channelId,
    )
  );
}

function requiredValue(args, index, flag) {
  const value = args[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function positiveInt(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}

function nonNegativeInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, serializeJson(payload), "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function writeMarkdown(filePath, contents) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, contents, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function serializeJson(payload) {
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function timestamp(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "function") return timestamp(value());
  return new Date().toISOString();
}

function portablePath(filePath) {
  const relative = path.relative(ROOT, filePath);
  return relative && !relative.startsWith("..")
    ? relative.replace(/\\/gu, "/")
    : filePath.replace(/\\/gu, "/");
}

function markdownCell(value) {
  return stringValue(value)
    .replace(/\|/gu, "\\|")
    .replace(/\r?\n/gu, " ");
}

function stringValue(value) {
  return String(value || "").trim();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(
      `CODEX_CHANNEL_IDENTITY_HYDRATION_ERROR ${String(error?.message || error).slice(0, 500)}`,
    );
    process.exitCode = 1;
  }
}

module.exports = {
  APPLY_CONFIRMATION,
  buildApplicationReport,
  buildGeneratedEntriesPayload,
  isFelicia,
  normalizeCandidateIdentity,
  parseArgs,
  planChannelMetadataHydration,
  renderApplicationMarkdown,
  validateAuditEnvelope,
  validateOptions,
};
