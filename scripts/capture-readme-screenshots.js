const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const baseUrl = args.find((arg) => !arg.startsWith("--")) || "http://127.0.0.1:8080/";
const outputDir = path.join(process.cwd(), "docs", "assets", "screenshots");
const recentSearches = ["少女レイ", "HOT LIMIT", "夏祭り"];

fs.mkdirSync(outputDir, { recursive: true });

function screenshotPath(name) {
  return path.join(outputDir, name);
}

function appUrl(params = {}) {
  const url = new URL(baseUrl);
  url.search = "";
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function newPage(browser, viewport) {
  const page = await browser.newPage({
    viewport,
    deviceScaleFactor: 1,
    isMobile: viewport.width <= 720,
  });
  await page.addInitScript((items) => {
    window.localStorage.setItem("dailySongList.recentSearches", JSON.stringify(items));
  }, recentSearches);
  return page;
}

async function waitForApp(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(
    () => {
      const content = document.querySelector("#videoList");
      if (!content || content.getAttribute("aria-busy") === "true") return false;
      return Boolean(content.querySelector(".rank-row, .video-card, .index-section, .empty-state"));
    },
    null,
    { timeout: 45_000 },
  );
  await sleep(250);
}

async function assertNoPageOverflow(page, label) {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.body.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  if (metrics.scrollWidth > metrics.clientWidth) {
    throw new Error(`${label} overflow: scrollWidth=${metrics.scrollWidth} clientWidth=${metrics.clientWidth}`);
  }
}

async function save(page, name, options = {}) {
  await assertNoPageOverflow(page, name);
  const file = screenshotPath(name);
  await page.screenshot({
    path: file,
    fullPage: Boolean(options.fullPage),
  });
  console.log(`README_SCREENSHOT ${name}`);
  return file;
}

async function openPage(browser, viewport, params, name, options = {}) {
  const page = await newPage(browser, viewport);
  await page.goto(appUrl(params), { waitUntil: "networkidle" });
  await waitForApp(page);
  await save(page, name, options);
  await page.close();
}

async function captureQueryPanel(browser, viewport, name, options = {}) {
  const page = await newPage(browser, viewport);
  await page.goto(appUrl(options.params || {}), { waitUntil: "networkidle" });
  await waitForApp(page);
  await page.click("#queryTrigger");
  await page.waitForSelector("#queryDialog:not([hidden]) .query-panel", { timeout: 15_000 });
  if (options.searchText) {
    await page.fill("#queryInput", options.searchText);
    await page.waitForSelector(".suggestion-item", { timeout: 15_000 });
    await sleep(250);
  }
  if (options.scrollBottom) {
    await page.locator(".query-panel-body").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await sleep(250);
  }
  await save(page, name);
  await page.close();
}

async function captureExpandedSource(browser, viewport, params, name) {
  const page = await newPage(browser, viewport);
  await page.goto(appUrl(params), { waitUntil: "networkidle" });
  await waitForApp(page);
  const toggle = page.locator("[data-toggle-source]").first();
  await toggle.click();
  await page.waitForSelector(".source-drawer:not([hidden]) .source-video-group", { timeout: 20_000 });
  await sleep(500);
  await save(page, name);
  await page.close();
}

async function captureExpandedVideo(browser, viewport, name) {
  const page = await newPage(browser, viewport);
  await page.goto(appUrl({ view: "videos" }), { waitUntil: "networkidle" });
  await waitForApp(page);
  const more = page.locator(".video-more").first();
  if ((await more.count()) > 0) {
    await more.click();
    await sleep(350);
  }
  await save(page, name);
  await page.close();
}

async function main() {
  const browser = await chromium.launch();
  const desktop = { width: 1440, height: 900 };
  const desktopWide = { width: 1366, height: 768 };
  const mobile = { width: 390, height: 844 };

  try {
    await openPage(browser, desktop, {}, "desktop-song-rank.png");
    await openPage(browser, desktopWide, { range: "1m", pageSize: 100 }, "desktop-monthly-song-rank.png");
    await openPage(browser, desktopWide, { view: "videos" }, "desktop-video-view.png");
    await captureQueryPanel(browser, desktop, "desktop-query-panel.png");
    await captureExpandedSource(browser, desktop, {}, "desktop-source-expanded.png");

    await openPage(browser, mobile, {}, "mobile-song-rank.png");
    await openPage(browser, mobile, { view: "artistRank" }, "mobile-artist-rank.png");
    await openPage(browser, mobile, { view: "songAz" }, "mobile-song-index.png");
    await openPage(browser, mobile, { view: "videos" }, "mobile-video-view.png");
    await captureExpandedVideo(browser, mobile, "mobile-video-expanded.png");
    await openPage(
      browser,
      mobile,
      { q: "少女レイ", metric: "videos", minCount: 2, showUnknown: 1 },
      "mobile-active-query-strip.png",
    );
    await captureQueryPanel(browser, mobile, "mobile-query-recent.png");
    await captureQueryPanel(browser, mobile, "mobile-query-suggestions.png", { searchText: "少女レイ" });
    await captureQueryPanel(browser, mobile, "mobile-query-history.png", { scrollBottom: true });
    await captureExpandedSource(browser, mobile, {}, "mobile-source-expanded.png");
  } finally {
    await browser.close();
  }

  const count = fs.readdirSync(outputDir).filter((file) => file.endsWith(".png")).length;
  console.log(`README_SCREENSHOTS_OK count=${count} output=${outputDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
