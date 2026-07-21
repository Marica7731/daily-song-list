const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const cssSource = fs.readFileSync(path.join(__dirname, "..", "assets", "styles.css"), "utf8");

function cssBlock(selector, source = cssSource) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`, "u"));
  assert.ok(match, `CSS block not found: ${selector}`);
  return match[0];
}

test("desktop source preview cards keep consistent rails across one, two, and many sources", () => {
  const desktopSource = cssSource.split("@media (max-width: 720px)")[0];
  const stripBlock = cssBlock(".source-inline-strip", desktopSource);
  const actionBlock = cssBlock(".source-inline-actions", desktopSource);

  assert.match(stripBlock, /grid-template-columns:\s*minmax\(0,\s*1fr\) 92px;/u);
  assert.doesNotMatch(desktopSource, /\.source-inline-strip\[data-source-video-count="1"\]\s+\.source-inline-preview-list/u);
  assert.match(actionBlock, /justify-content:\s*flex-end;/u);
  assert.match(actionBlock, /width:\s*100%;/u);
});

test("mobile source preview uses compact two-column cards while single source remains full width", () => {
  const mobileSource = cssSource.slice(cssSource.indexOf("@media (max-width: 720px)"));

  assert.match(mobileSource, /\.source-inline-strip\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\);/u);
  assert.match(mobileSource, /\.source-inline-preview-list\s*\{[\s\S]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/u);
  assert.match(mobileSource, /\.source-inline-strip\[data-source-video-count="1"\]\s+\.source-inline-preview-list\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*1fr\);/u);
  assert.match(mobileSource, /\.source-inline-item\s*\{[\s\S]*grid-template-columns:\s*44px minmax\(0,\s*1fr\) 24px;/u);
});
