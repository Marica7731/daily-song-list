"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { expectedScreenshots, proofInputPaths } = require("./ui-proof-config");

const repoRoot = path.join(__dirname, "..");
const screenshotDir = path.join(repoRoot, "docs", "assets", "screenshots");
const manifestPath = path.join(screenshotDir, "manifest.json");

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function fileSha256(relativePath) {
  return sha256Buffer(fs.readFileSync(path.join(repoRoot, relativePath)));
}

function proofInputEntries() {
  return proofInputPaths.map((inputPath) => {
    const absolute = path.join(repoRoot, inputPath);
    if (!fs.existsSync(absolute)) throw new Error(`UI proof input missing: ${inputPath}`);
    return { path: inputPath.replace(/\\/g, "/"), sha256: fileSha256(inputPath) };
  });
}

function proofInputHash(entries = proofInputEntries()) {
  return sha256Buffer(Buffer.from(JSON.stringify(entries), "utf8"));
}

function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") throw new Error("not a PNG");
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function markdownScreenshotRefs(relativePath) {
  const source = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
  const baseDir = path.dirname(relativePath).replace(/\\/g, "/");
  return [...source.matchAll(/(?:src="|\]\()((?:docs\/)?assets\/screenshots\/[^")]+\.png|docs\/assets\/screenshots\/[^")]+\.png)/gu)].map((match) => {
    const ref = match[1];
    if (ref.startsWith("docs/assets/")) return ref;
    return path.posix.normalize(path.posix.join(baseDir === "." ? "" : baseDir, ref));
  });
}

function validateUiProof(options = {}) {
  const errors = [];
  const expectedPaths = expectedScreenshots.map((name) => `docs/assets/screenshots/${name}`);
  if (!fs.existsSync(manifestPath)) {
    errors.push("UI proof manifest missing: docs/assets/screenshots/manifest.json");
  }

  let manifest = null;
  if (fs.existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (error) {
      errors.push(`UI proof manifest is invalid JSON: ${error.message}`);
    }
  }

  const currentInputs = proofInputEntries();
  const currentProofHash = proofInputHash(currentInputs);
  if (manifest) {
    if (manifest.schemaVersion !== 1) errors.push("UI proof manifest schemaVersion must be 1");
    if (!Number.isFinite(Date.parse(manifest.generatedAt))) errors.push("UI proof manifest generatedAt must be ISO time");
    if (manifest.proofInputHash !== currentProofHash) {
      errors.push("UI 验收截图已过期，请运行 npm run screenshots:readme");
    }
    const manifestInputPaths = new Set((manifest.proofInputs || []).map((entry) => entry.path));
    for (const entry of currentInputs) {
      if (!manifestInputPaths.has(entry.path)) errors.push(`UI proof manifest missing input: ${entry.path}`);
    }
  }

  const manifestScreenshots = new Map((manifest?.screenshots || []).map((entry) => [entry.path, entry]));
  for (const screenshotPath of expectedPaths) {
    const absolute = path.join(repoRoot, screenshotPath);
    if (!fs.existsSync(absolute)) {
      errors.push(`UI proof screenshot missing: ${screenshotPath}`);
      continue;
    }
    const buffer = fs.readFileSync(absolute);
    if (buffer.length < 1024) errors.push(`UI proof screenshot looks empty: ${screenshotPath}`);
    const entry = manifestScreenshots.get(screenshotPath);
    if (!entry) {
      errors.push(`UI proof manifest missing screenshot: ${screenshotPath}`);
      continue;
    }
    const actualHash = sha256Buffer(buffer);
    if (entry.sha256 !== actualHash) errors.push(`UI proof screenshot hash mismatch: ${screenshotPath}`);
    if (entry.size !== buffer.length) errors.push(`UI proof screenshot size mismatch: ${screenshotPath}`);
    try {
      const dimensions = pngDimensions(buffer);
      if (entry.width !== dimensions.width || entry.height !== dimensions.height) {
        errors.push(`UI proof screenshot dimensions mismatch: ${screenshotPath}`);
      }
    } catch (error) {
      errors.push(`UI proof screenshot is not a valid PNG: ${screenshotPath} ${error.message}`);
    }
  }

  for (const entry of manifestScreenshots.keys()) {
    if (!expectedPaths.includes(entry)) errors.push(`UI proof manifest has unexpected screenshot: ${entry}`);
  }

  const markdownRefs = [...new Set([...markdownScreenshotRefs("README.md"), ...markdownScreenshotRefs("docs/ui-proof.md")])];
  for (const ref of markdownRefs) {
    if (!fs.existsSync(path.join(repoRoot, ref))) errors.push(`UI proof markdown references missing screenshot: ${ref}`);
    if (!manifestScreenshots.has(ref)) errors.push(`UI proof markdown reference not in manifest: ${ref}`);
  }

  if (errors.length) {
    if (!options.silent) {
      for (const error of errors) console.error(error);
    }
    return { ok: false, errors, proofInputHash: currentProofHash };
  }
  return { ok: true, errors: [], proofInputHash: currentProofHash };
}

if (require.main === module) {
  const result = validateUiProof();
  if (!result.ok) process.exit(1);
  console.log(`UI_PROOF_OK screenshots=${expectedScreenshots.length} proofInputHash=${result.proofInputHash}`);
}

module.exports = {
  expectedScreenshots,
  fileSha256,
  markdownScreenshotRefs,
  pngDimensions,
  proofInputEntries,
  proofInputHash,
  sha256Buffer,
  validateUiProof,
};
