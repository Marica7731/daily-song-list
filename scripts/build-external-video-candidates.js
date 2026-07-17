const fs = require("node:fs");
const path = require("node:path");

const { buildVideoCandidates } = require("./lib/external-song-enrichment");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_EXTERNAL_INPUT = path.join(ROOT, "data", "external", "vsinger-moment", "aliases-fixture.json");
const DEFAULT_OUTPUT = path.join(ROOT, "data", "external", "vsinger-moment", "external-video-candidates.json");

function main() {
  const options = parseArgs(process.argv.slice(2));
  const input = readJson(options.externalInput);
  const result = buildVideoCandidates({
    externalSongs: input.externalSongs || input.records || input.songs || input,
    now: options.now || new Date().toISOString(),
  });
  if (!options.dryRun) {
    writeJson(options.output, result);
  }
  process.stdout.write(`${JSON.stringify({ candidateCount: result.candidates.length }, null, 2)}\n`);
  process.stdout.write(
    `CODEX_EXTERNAL_VIDEO_CANDIDATES_OK dryRun=${options.dryRun ? "true" : "false"} candidates=${result.candidates.length}\n`,
  );
}

function parseArgs(args) {
  const options = {
    dryRun: false,
    externalInput: DEFAULT_EXTERNAL_INPUT,
    output: DEFAULT_OUTPUT,
    now: "",
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--external-input") {
      options.externalInput = resolvePath(readValue(args, ++index, arg));
    } else if (arg === "--output") {
      options.output = resolvePath(readValue(args, ++index, arg));
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
  process.stdout.write("Usage: node scripts/build-external-video-candidates.js --external-input <json> --output <json>\n");
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
