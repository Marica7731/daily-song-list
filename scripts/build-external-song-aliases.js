const fs = require("node:fs");
const path = require("node:path");

const { buildSongEnrichment } = require("./lib/external-song-enrichment");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_EXTERNAL_INPUT = path.join(ROOT, "data", "external", "vsinger-moment", "aliases-fixture.json");
const DEFAULT_LOCAL_INPUT = path.join(ROOT, "data", "latest.json");
const DEFAULT_ALIAS_OUTPUT = path.join(ROOT, "data", "external", "vsinger-moment", "external-song-alias-candidates.json");
const DEFAULT_KNOWN_OUTPUT = path.join(ROOT, "data", "external", "vsinger-moment", "external-known-song-candidates.json");
const DEFAULT_CONFLICT_OUTPUT = path.join(ROOT, "data", "external", "vsinger-moment", "external-song-conflicts.json");
const DEFAULT_REVIEW_OUTPUT = path.join(ROOT, "data", "review", "external-song-identity-candidates.json");

function main() {
  const options = parseArgs(process.argv.slice(2));
  const externalInput = readJson(options.externalInput);
  const localInput = readJson(options.localInput);
  const manualCuration = options.manualCurationInput ? readJson(options.manualCurationInput) : [];
  const result = buildSongEnrichment({
    externalSongs: externalInput.externalSongs || externalInput.records || externalInput.songs || externalInput,
    localSongs: localInput.localSongs || localInput.songs || localInput.records || localInput,
    manualCuration: manualCuration.manualCuration || manualCuration.records || manualCuration,
    now: options.now || new Date().toISOString(),
  });

  const aliasPayload = {
    schemaVersion: "external-song-alias-candidates.v1",
    generatedAt: result.generatedAt,
    externalSystem: result.externalSystem,
    adapterVersion: result.adapterVersion,
    matchingVersion: result.matchingVersion,
    candidates: result.automaticAliases,
  };
  const knownPayload = {
    schemaVersion: "external-known-song-candidates.v1",
    generatedAt: result.generatedAt,
    externalSystem: result.externalSystem,
    adapterVersion: result.adapterVersion,
    matchingVersion: result.matchingVersion,
    candidates: result.knownSongCandidates,
  };
  const reviewPayload = {
    schemaVersion: "external-song-identity-review-candidates.v1",
    generatedAt: result.generatedAt,
    externalSystem: result.externalSystem,
    adapterVersion: result.adapterVersion,
    matchingVersion: result.matchingVersion,
    candidates: result.reviewCandidates,
  };
  const conflictPayload = {
    schemaVersion: "external-song-conflict-report.v1",
    generatedAt: result.generatedAt,
    externalSystem: result.externalSystem,
    adapterVersion: result.adapterVersion,
    matchingVersion: result.matchingVersion,
    conflicts: result.conflictReport,
  };

  if (!options.dryRun) {
    writeJson(options.aliasOutput, aliasPayload);
    writeJson(options.knownOutput, knownPayload);
    writeJson(options.reviewOutput, reviewPayload);
    writeJson(options.conflictOutput, conflictPayload);
  }

  process.stdout.write(`${JSON.stringify(result.summary, null, 2)}\n`);
  process.stdout.write(
    `CODEX_EXTERNAL_SONG_ALIASES_OK dryRun=${options.dryRun ? "true" : "false"} automatic=${result.summary.automaticAliasCount} review=${result.summary.reviewCandidateCount} known=${result.summary.knownSongCandidateCount}\n`,
  );
}

function parseArgs(args) {
  const options = {
    dryRun: false,
    externalInput: DEFAULT_EXTERNAL_INPUT,
    localInput: DEFAULT_LOCAL_INPUT,
    manualCurationInput: null,
    aliasOutput: DEFAULT_ALIAS_OUTPUT,
    knownOutput: DEFAULT_KNOWN_OUTPUT,
    reviewOutput: DEFAULT_REVIEW_OUTPUT,
    conflictOutput: DEFAULT_CONFLICT_OUTPUT,
    now: "",
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--external-input") {
      options.externalInput = resolvePath(readValue(args, ++index, arg));
    } else if (arg === "--local-input") {
      options.localInput = resolvePath(readValue(args, ++index, arg));
    } else if (arg === "--manual-curation-input") {
      options.manualCurationInput = resolvePath(readValue(args, ++index, arg));
    } else if (arg === "--alias-output") {
      options.aliasOutput = resolvePath(readValue(args, ++index, arg));
    } else if (arg === "--known-output") {
      options.knownOutput = resolvePath(readValue(args, ++index, arg));
    } else if (arg === "--review-output") {
      options.reviewOutput = resolvePath(readValue(args, ++index, arg));
    } else if (arg === "--conflict-output") {
      options.conflictOutput = resolvePath(readValue(args, ++index, arg));
    } else if (arg === "--now") {
      options.now = readValue(args, ++index, arg);
    } else if (arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readValue(args, index, name) {
  if (index >= args.length || args[index].startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return args[index];
}

function resolvePath(value) {
  return path.resolve(ROOT, value);
}

function printHelp() {
  process.stdout.write("Usage: node scripts/build-external-song-aliases.js --external-input <json> --local-input <json>\n");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  parseArgs,
};
