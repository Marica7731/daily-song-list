const { chromium } = require("playwright");

const baseUrl = process.argv[2] || "http://127.0.0.1:8081/";
const viewports = [
  [1920, 1080],
  [1366, 768],
  [768, 1024],
  [414, 896],
  [390, 844],
  [320, 700],
];
const results = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function requestPath(url) {
  try {
    return new URL(url).pathname.replace(/^\//, "");
  } catch {
    return url;
  }
}

async function newPage(browser, viewport, options = {}) {
  const context = await browser.newContext({ viewport: { width: viewport[0], height: viewport[1] } });
  if (options.connection) {
    await context.addInitScript((connection) => {
      Object.defineProperty(navigator, "connection", { configurable: true, value: connection });
    }, options.connection);
  }
  const page = await context.newPage();
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("requestfailed", (request) => errors.push(`request failed ${request.url()} ${request.failure()?.errorText || ""}`));
  await page.addInitScript(() => {
    window.__longTasks = [];
    window.addEventListener("unhandledrejection", (event) => {
      window.__unhandledRejection = String(event.reason && (event.reason.message || event.reason));
    });
    try {
      new PerformanceObserver((list) => {
        window.__longTasks.push(...list.getEntries().map((entry) => ({ name: entry.name, duration: entry.duration })));
      }).observe({ entryTypes: ["longtask"] });
    } catch {}
  });
  return { context, page, errors };
}

async function waitForRows(page) {
  await page.waitForSelector(".rank-row:not(.skeleton-row) .rank-title, .video-card .video-title, .index-row .rank-title, .empty", {
    timeout: 15000,
  });
}

async function firstLoad(browser, range, viewport) {
  const { context, page, errors } = await newPage(browser, viewport);
  const requests = [];
  let firstRowTime = 0;
  let diffContinueTime = 0;
  const diffPath = `data/diff/latest-${range}.json`;
  await page.route(`**/${diffPath}`, async (route) => {
    await sleep(1200);
    diffContinueTime = Date.now();
    await route.continue();
  });
  page.on("request", (request) => requests.push(requestPath(request.url())));
  const url = range === "72h" ? baseUrl : `${baseUrl}?range=1m`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForRows(page);
  firstRowTime = Date.now();
  const beforeFirstContentRequests = [...requests];
  const perf = await page.evaluate(() => window.printSongListPerformance());
  const linksOk = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".inline-source-time,.song-list a"))
      .slice(0, 12)
      .every((node) => /[?&]t=\d+s/.test(node.href || "")),
  );
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  const longTasks = await page.evaluate(() => window.__longTasks || []);
  const unhandled = await page.evaluate(() => window.__unhandledRejection || "");
  await context.close();

  const forbidden =
    range === "72h"
      ? ["data/latest.json", "data/ui/1m.json", "data/diff/latest-1m.json", "data/song-search-known-songs.json"]
      : ["data/latest.json", "data/ui/72h.json", "data/diff/latest-72h.json", "data/song-search-known-songs.json"];
  const seenForbidden = forbidden.filter((item) => beforeFirstContentRequests.includes(item));
  if (seenForbidden.length) {
    throw new Error(`${range} first load requested forbidden resources before first content: ${seenForbidden.join(", ")}`);
  }
  if (!beforeFirstContentRequests.includes(`data/ui/${range}.json`)) {
    throw new Error(`${range} did not request active range runtime before first content`);
  }
  if (diffContinueTime && firstRowTime >= diffContinueTime) throw new Error(`${range} first row waited for delayed diff`);
  if (!linksOk) throw new Error(`${range} timestamp links missing t=seconds`);
  if (!overflow) throw new Error(`${range} viewport overflow ${viewport.join("x")}`);
  if (errors.length || unhandled) throw new Error(`${range} console/page errors: ${errors.join(" | ")} ${unhandled}`);
  if (longTasks.some((entry) => entry.duration > 300)) {
    throw new Error(
      `${range} long task >300ms: ${JSON.stringify({
        longTasks,
        measures: perf.measures,
        resources: perf.resources,
        requests: beforeFirstContentRequests,
      })}`,
    );
  }
  results.push({ scenario: `first-${range}-${viewport.join("x")}`, requests: beforeFirstContentRequests, measures: perf.measures, longTasks: longTasks.length });
}

async function interactionFlow(browser) {
  const { context, page, errors } = await newPage(browser, [1366, 768]);
  const requests = [];
  page.on("request", (request) => requests.push(requestPath(request.url())));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForRows(page);
  await page.locator('[data-range="1m"]').click();
  await waitForRows(page);
  if (!requests.includes("data/ui/1m.json")) throw new Error("range switch did not load monthly runtime");
  await page.locator('[data-page-size="100"]').first().click();
  await waitForRows(page);
  await page.locator("#filterInput").fill("夜");
  await waitForRows(page);
  await page.locator("#nicheOnlyToggle").check();
  await waitForRows(page);
  await page.locator('[data-rank-metric="videos"]').first().click();
  await waitForRows(page);
  await page.locator("#filterInput").fill("");
  await page.locator("#nicheOnlyToggle").uncheck();
  await waitForRows(page);
  await page.getByRole("button", { name: "歌手榜" }).click();
  await waitForRows(page);
  await page.locator('[data-view="videos"]').click();
  await page.waitForSelector(".video-card .video-title", { timeout: 15000 });
  await page.getByRole("button", { name: "歌曲榜" }).click();
  await waitForRows(page);
  const dateOptions = await page
    .locator("#snapshotDateSelect option")
    .evaluateAll((items) => items.map((item) => item.value).filter((value) => value !== "latest"));
  if (!dateOptions.length) throw new Error("no historical snapshot dates");
  await page.selectOption("#snapshotDateSelect", dateOptions[0]);
  await page.waitForFunction(() => Array.from(document.querySelectorAll("#snapshotSelect option")).some((item) => item.value !== "data/latest.json"), null, {
    timeout: 10000,
  });
  const options = await page
    .locator("#snapshotSelect option")
    .evaluateAll((items) => items.map((item) => item.value).filter((value) => value !== "data/latest.json"));
  if (!options.length) throw new Error("no historical snapshot options");
  await page.selectOption("#snapshotSelect", options[0]);
  await waitForRows(page);
  await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => null);
  await waitForRows(page);
  await page.goForward({ waitUntil: "domcontentloaded" }).catch(() => null);
  await waitForRows(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  const unhandled = await page.evaluate(() => window.__unhandledRejection || "");
  const perf = await page.evaluate(() => window.printSongListPerformance());
  await context.close();
  if (!overflow) throw new Error("interaction viewport overflow");
  if (errors.length || unhandled) throw new Error(`interaction errors: ${errors.join(" | ")} ${unhandled}`);
  results.push({ scenario: "interaction-flow", requests: [...new Set(requests)], measures: perf.measures });
}

async function prefetchGuards(browser) {
  for (const [label, connection] of [
    ["saveData", { saveData: true, effectiveType: "4g" }],
    ["slow-2g", { saveData: false, effectiveType: "slow-2g" }],
  ]) {
    const { context, page, errors } = await newPage(browser, [390, 844], { connection });
    const requests = [];
    page.on("request", (request) => requests.push(requestPath(request.url())));
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await waitForRows(page);
    await sleep(2500);
    await context.close();
    if (requests.includes("data/ui/1m.json")) throw new Error(`${label} prefetched inactive range`);
    if (errors.length) throw new Error(`${label} errors: ${errors.join(" | ")}`);
    results.push({ scenario: `prefetch-${label}`, requests: [...new Set(requests)] });
  }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of viewports) {
      await firstLoad(browser, "72h", viewport);
    }
    await firstLoad(browser, "1m", [1366, 768]);
    await interactionFlow(browser);
    await prefetchGuards(browser);
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(results, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
