const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const latestOnly = args.includes("--latest-only");
const baseUrl = args.find((arg) => !arg.startsWith("--")) || "http://127.0.0.1:8081/";
const viewports = [
  [2560, 1440],
  [1920, 1080],
  [1440, 900],
  [1366, 768],
  [1024, 768],
  [768, 1024],
  [430, 932],
  [390, 844],
  [360, 800],
  [320, 700],
];
const results = [];
const screenshotDir = path.join(process.cwd(), "artifacts", "h5-redesign");
fs.mkdirSync(screenshotDir, { recursive: true });

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

async function waitForRows(page, errors = [], requests = []) {
  try {
    await page.waitForSelector(".rank-row:not(.skeleton-row) .rank-title, .video-card .video-title, .index-row .rank-title, .empty", {
      timeout: baseUrl.startsWith("https://") ? 30000 : 15000,
    });
    await page.waitForFunction(() => document.querySelector("#videoList")?.getAttribute("aria-busy") !== "true", null, {
      timeout: baseUrl.startsWith("https://") ? 30000 : 15000,
    });
  } catch (error) {
    const diagnostics = await page
      .evaluate(() => ({
        status: document.querySelector("#status")?.textContent || "",
        title: document.title,
        bodyText: document.body?.innerText?.slice(0, 1000) || "",
        resources: window.printSongListPerformance?.().resources || [],
      }))
      .catch((diagError) => ({ evaluateError: diagError.message }));
    throw new Error(`${error.message}\nerrors=${errors.join(" | ")}\nrequests=${requests.join(" | ")}\ndiagnostics=${JSON.stringify(diagnostics)}`);
  }
}

async function openFilterSheet(page) {
  await page.locator("#desktopFilterButton").click();
  await page.waitForSelector("#filterDialog:not([hidden])", { timeout: baseUrl.startsWith("https://") ? 15000 : 5000 });
  await page.waitForTimeout(baseUrl.startsWith("https://") ? 100 : 50);
}

async function setCheckbox(page, selector, checked) {
  const checkbox = page.locator(selector);
  await checkbox.waitFor({ state: "visible", timeout: baseUrl.startsWith("https://") ? 15000 : 5000 });
  if ((await checkbox.isChecked()) === checked) return;
  try {
    if (checked) {
      await checkbox.check({ timeout: 5000 });
    } else {
      await checkbox.uncheck({ timeout: 5000 });
    }
  } catch {
    await checkbox.evaluate((input) => input.closest("label")?.click());
  }
  if ((await checkbox.isChecked()) !== checked) throw new Error(`${selector} did not become ${checked ? "checked" : "unchecked"}`);
}

async function waitForPerformanceEntryIdle(page, name, idleMs = 300, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let lastCount = -1;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const count = await page.evaluate((entryName) => performance.getEntriesByName(entryName).length, name);
    if (count !== lastCount) {
      lastCount = count;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= idleMs) {
      return count;
    }
    await page.waitForTimeout(50);
  }
  return page.evaluate((entryName) => performance.getEntriesByName(entryName).length, name);
}

async function assertUiShape(page, viewport, range) {
  const result = await page.evaluate(({ width }) => {
    const rect = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        width: box.width,
        height: box.height,
        top: box.top,
        display: style.display,
        overflowX: style.overflowX,
        text: node.textContent || "",
      };
    };
    const controls = rect("#controls");
    const searchField = rect(".search-field");
    const bottomNav = rect("#mobileBottomNav");
    const summary = rect("#summary");
    const summaryRange = rect("#summary .summary-range");
    const topPagination = rect(".pagination-top");
    const topJump = rect(".pagination-top .page-jump");
    const topPageSize = rect(".pagination-top .page-size-control");
    const topControls = Array.from(document.querySelectorAll(".pagination-top .pagination-button, .pagination-top .pagination-status")).map((node) => node.textContent || "");
    const bottomJump = rect(".pagination-bottom .page-jump");
    const rows = Array.from(document.querySelectorAll(".rank-row:not(.skeleton-row), .index-row, .video-card"));
    const fullyVisibleRows = rows.filter((node) => {
      const box = node.getBoundingClientRect();
      return box.top >= 0 && box.bottom <= window.innerHeight;
    }).length;
    const bottomItems = Array.from(document.querySelectorAll("#mobileBottomNav [data-view]")).map((node) => {
      const box = node.getBoundingClientRect();
      return { text: node.textContent || "", width: box.width, display: getComputedStyle(node).display };
    });
    const rankCount = rect(".rank-count");
    const rankSubline = rect(".rank-subline");
    return {
      width,
      controls,
      searchField,
      bottomNav,
      bottomItems,
      summary,
      summaryRange,
      topPagination,
      topJump,
      topPageSize,
      topControls,
      bottomJump,
      fullyVisibleRows,
      rankCount,
      rankSubline,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  }, { width: viewport[0], range });

  if (result.scrollWidth > result.clientWidth + 1) throw new Error(`horizontal overflow ${JSON.stringify(result)}`);
  if (viewport[0] <= 720) {
    if (!result.controls || result.controls.height > 60) throw new Error(`mobile controls not one row ${JSON.stringify(result.controls)}`);
    if (result.searchField && result.searchField.display !== "none") throw new Error("mobile search field is still resident in toolbar");
    if (!result.bottomNav || result.bottomNav.display === "none") throw new Error("mobile bottom nav missing");
    if (result.bottomItems.length !== 4 || result.bottomItems.some((item) => item.width < 60 || item.display === "none")) {
      throw new Error(`mobile bottom nav items invalid ${JSON.stringify(result.bottomItems)}`);
    }
    if (result.summaryRange && result.summaryRange.display !== "none") {
      throw new Error(`mobile summary repeats range: ${result.summary.text}`);
    }
    if (result.topJump || result.topPageSize) throw new Error(`mobile top pagination includes jump/page size ${JSON.stringify(result)}`);
    if (result.topControls.length && result.topControls.length !== 3) {
      throw new Error(`mobile top pagination should expose prev/status/next only ${JSON.stringify(result.topControls)}`);
    }
    if (result.topPagination && result.topPagination.height > 52) throw new Error(`mobile top pagination too tall ${result.topPagination.height}`);
    if (viewport[0] >= 390 && result.fullyVisibleRows < 5) throw new Error(`mobile visible rows below target: ${result.fullyVisibleRows}`);
    if (viewport[0] <= 360 && result.fullyVisibleRows < 4) throw new Error(`narrow mobile visible rows below target: ${result.fullyVisibleRows}`);
  } else if (viewport[0] >= 1024) {
    if (!result.topJump || !result.bottomJump) throw new Error(`desktop pagination jump missing ${JSON.stringify(result)}`);
    if (result.fullyVisibleRows >= (viewport[0] >= 1600 ? 10 : 7)) return;
    if (viewport[0] < 1600 && result.fullyVisibleRows >= 6) return;
    throw new Error(`desktop visible rows below target: ${result.fullyVisibleRows} viewport=${viewport.join("x")}`);
  }
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
  const url = range === "72h" ? baseUrl : `${baseUrl}?shared=1&range=1m`;
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForRows(page, errors, requests);
  await assertUiShape(page, viewport, range);
  firstRowTime = Date.now();
  const beforeFirstContentRequests = [...requests];
  const perf = await page.evaluate(() => window.printSongListPerformance());
  const activeRuntimePath = perf.runtime?.rangePath || beforeFirstContentRequests.find((item) => runtimePathPattern(range).test(item));
  const linksOk = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".inline-source-time,.song-list a"))
      .slice(0, 12)
      .every((node) => /[?&]t=\d+s/.test(node.href || "")),
  );
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  const longTasks = await page.evaluate(() => window.__longTasks || []);
  const unhandled = await page.evaluate(() => window.__unhandledRejection || "");
  const screenshotPath = path.join(screenshotDir, `${range}-${viewport.join("x")}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  await context.close();

  const forbidden =
    range === "72h"
      ? ["data/latest.json", "data/diff/latest-1m.json", "data/song-search-known-songs.json"]
      : ["data/latest.json", "data/diff/latest-72h.json", "data/song-search-known-songs.json"];
  const inactiveRange = range === "72h" ? "1m" : "72h";
  const seenForbidden = beforeFirstContentRequests.filter(
    (item) => forbidden.includes(item) || runtimePathPattern(inactiveRange).test(item),
  );
  if (seenForbidden.length) {
    throw new Error(`${range} first load requested forbidden resources before first content: ${seenForbidden.join(", ")}`);
  }
  if (!activeRuntimePath || !beforeFirstContentRequests.includes(activeRuntimePath)) {
    throw new Error(`${range} did not request active runtime path before first content: ${activeRuntimePath || "missing"}`);
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
  results.push({ scenario: `first-${range}-${viewport.join("x")}`, requests: beforeFirstContentRequests, measures: perf.measures, longTasks: longTasks.length, screenshotPath });
}

async function interactionFlow(browser) {
  const { context, page, errors } = await newPage(browser, [1366, 768]);
  const requests = [];
  page.on("request", (request) => requests.push(requestPath(request.url())));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForRows(page, errors, requests);
  await page.locator('[data-range="1m"]').click();
  await waitForRows(page, errors, requests);
  if (!requests.some((item) => runtimePathPattern("1m").test(item))) throw new Error("range switch did not load monthly runtime");
  await page.locator('[data-page-size="100"]').first().click();
  await waitForRows(page, errors, requests);
  await page.locator("#filterInput").fill("夜");
  await waitForRows(page, errors, requests);
  await openFilterSheet(page);
  await setCheckbox(page, "#nicheOnlyToggle", true);
  await page.locator("#applyFiltersButton").click();
  await waitForRows(page, errors, requests);
  await openFilterSheet(page);
  await page.locator("#metricFilterGroup label").filter({ hasText: "按视频" }).click();
  await page.locator("#applyFiltersButton").click();
  await waitForRows(page, errors, requests);
  await page.locator("#filterInput").fill("");
  await openFilterSheet(page);
  await setCheckbox(page, "#nicheOnlyToggle", false);
  await page.locator("#metricFilterGroup label").filter({ hasText: "按收录" }).click();
  await page.locator("#applyFiltersButton").click();
  await waitForRows(page, errors, requests);
  const buildSongRecordCountBeforeSource = await waitForPerformanceEntryIdle(page, "song-list:build-song-records");
  await page.locator("[data-toggle-source]").first().click();
  await page.waitForSelector(".rank-row.is-expanded .source-drawer:not([hidden]) .source-video-group, .rank-row.is-expanded .source-drawer:not([hidden]) .source-link", {
    timeout: 15000,
  });
  const sourcePerf = await page.evaluate(() => ({
    buildSongRecordCount: performance.getEntriesByName("song-list:build-song-records").length,
  }));
  if (sourcePerf.buildSongRecordCount !== buildSongRecordCountBeforeSource) {
    throw new Error(`opening source drawer rebuilt song records: ${JSON.stringify(sourcePerf)}`);
  }
  const oversizedTimestampGroup = await page.locator(".rank-row.is-expanded .source-video-group").evaluateAll((groups) =>
    groups.some((group) => group.querySelectorAll(".source-time-link:not([hidden])").length > 10),
  );
  if (oversizedTimestampGroup) throw new Error("source drawer rendered more than 10 timestamps in a collapsed video group");
  await page.locator("[data-toggle-source]").first().click();
  await page.locator('.view-mode [data-view="artistRank"]').click();
  await waitForRows(page, errors, requests);
  await page.locator('.view-mode [data-view="videos"]').click();
  await page.waitForSelector(".video-card .video-title", { timeout: 15000 });
  await page.locator('.view-mode [data-view="songRank"]').click();
  await waitForRows(page, errors, requests);
  if (!latestOnly) {
    const dateOptions = await page
      .locator("#snapshotDateSelect option")
      .evaluateAll((items) => items.map((item) => item.value).filter((value) => value !== "latest"));
    if (!dateOptions.length) throw new Error("no historical snapshot dates");
    let options = [];
    for (const dateOption of dateOptions) {
      await selectSnapshotDate(page, dateOption);
      await sleep(150);
      options = await page
        .locator("#snapshotSelect option")
        .evaluateAll((items) => items.map((item) => item.value).filter((value) => value !== "data/latest.json"));
      if (options.length) break;
    }
    if (!options.length) throw new Error("no historical snapshot options");
    await page.selectOption("#snapshotSelect", options[0]);
    await waitForRows(page, errors, requests);
    const search = await page.evaluate(() => window.location.search);
    if (search) throw new Error(`ordinary snapshot interaction wrote URL state: ${search}`);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  const unhandled = await page.evaluate(() => window.__unhandledRejection || "");
  const perf = await page.evaluate(() => window.printSongListPerformance());
  await context.close();
  if (!overflow) throw new Error("interaction viewport overflow");
  if (errors.length || unhandled) throw new Error(`interaction errors: ${errors.join(" | ")} ${unhandled}`);
  results.push({ scenario: latestOnly ? "interaction-flow-latest" : "interaction-flow", requests: [...new Set(requests)], measures: perf.measures });
}

async function mobileSourceDrawerFlow(browser) {
  const viewport = [390, 844];
  const { context, page, errors } = await newPage(browser, viewport);
  const requests = [];
  page.on("request", (request) => requests.push(requestPath(request.url())));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForRows(page, errors, requests);

  const sourceRows = page.locator(".rank-row:not(.skeleton-row):has([data-toggle-source])");
  const count = await sourceRows.count();
  if (count < 1) throw new Error("no expandable rank rows found for mobile source drawer");
  const row = sourceRows.nth(Math.min(1, count - 1));
  const button = row.locator("[data-toggle-source]").first();
  const beforeExpanded = await button.getAttribute("aria-expanded");
  if (beforeExpanded !== "false") throw new Error(`source toggle initial aria-expanded expected false, got ${beforeExpanded}`);
  await button.click();
  await page.waitForSelector(".rank-row.is-expanded .source-drawer:not([hidden]) .source-video-group, .rank-row.is-expanded .source-drawer:not([hidden]) .source-link", {
    timeout: 15000,
  });
  const afterExpanded = await button.getAttribute("aria-expanded");
  if (afterExpanded !== "true") throw new Error(`source toggle opened aria-expanded expected true, got ${afterExpanded}`);

  const geometry = await row.evaluate((node) => {
    const rectFor = (target) => {
      const box = target.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
    };
    const drawer = node.querySelector(".source-drawer");
    const content = node.querySelector(".rank-content");
    const rank = node.querySelector(".rank-number");
    const countNode = node.querySelector(".rank-count");
    const style = getComputedStyle(node);
    const sourceGroups = Array.from(node.querySelectorAll(".source-video-group")).map((group) => rectFor(group));
    return {
      viewportWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      row: rectFor(node),
      rowBox: {
        paddingLeft: Number.parseFloat(style.paddingLeft) || 0,
        paddingRight: Number.parseFloat(style.paddingRight) || 0,
        borderLeft: Number.parseFloat(style.borderLeftWidth) || 0,
        borderRight: Number.parseFloat(style.borderRightWidth) || 0,
      },
      drawer: drawer ? rectFor(drawer) : null,
      content: content ? rectFor(content) : null,
      rank: rank ? rectFor(rank) : null,
      count: countNode ? rectFor(countNode) : null,
      sourceGroups,
    };
  });
  if (!geometry.drawer) throw new Error(`mobile source drawer missing ${JSON.stringify(geometry)}`);
  if (geometry.scrollWidth > geometry.viewportWidth + 1) throw new Error(`mobile source drawer caused horizontal overflow ${JSON.stringify(geometry)}`);
  const expectedLeft = geometry.row.left + geometry.rowBox.borderLeft + geometry.rowBox.paddingLeft;
  const expectedWidth = geometry.row.width - geometry.rowBox.borderLeft - geometry.rowBox.borderRight - geometry.rowBox.paddingLeft - geometry.rowBox.paddingRight;
  if (Math.abs(geometry.drawer.left - expectedLeft) > 3) {
    throw new Error(`mobile source drawer left offset invalid ${JSON.stringify(geometry)}`);
  }
  if (Math.abs(geometry.drawer.width - expectedWidth) > 4) {
    throw new Error(`mobile source drawer width invalid ${JSON.stringify(geometry)}`);
  }
  if (geometry.content && geometry.drawer.top - geometry.content.bottom > 18) {
    throw new Error(`mobile source drawer has excessive blank gap ${JSON.stringify(geometry)}`);
  }
  if (geometry.sourceGroups.some((group) => group.width > geometry.drawer.width + 1 || group.left < geometry.drawer.left - 1 || group.right > geometry.drawer.right + 1)) {
    throw new Error(`mobile source group shifted out of drawer ${JSON.stringify(geometry)}`);
  }

  const moreGroups = row.locator("[data-toggle-source-groups]");
  if ((await moreGroups.count()) > 0) {
    const beforeGroupCount = await countVisibleInRow(row, ".source-video-group");
    await moreGroups.first().click();
    const afterGroupCount = await waitForVisibleCountAbove(row, ".source-video-group", beforeGroupCount);
    if (afterGroupCount <= beforeGroupCount) throw new Error("source group expander did not add visible groups");
  }

  const moreTimes = row.locator("[data-toggle-source-times]");
  if ((await moreTimes.count()) > 0) {
    const beforeVisibleTimes = await countVisibleInRow(row, ".source-time-link");
    await moreTimes.first().click();
    const afterVisibleTimes = await waitForVisibleCountAbove(row, ".source-time-link", beforeVisibleTimes);
    if (afterVisibleTimes <= beforeVisibleTimes) throw new Error("source timestamp expander did not add visible timestamps");
  }

  await button.click();
  const closedExpanded = await button.getAttribute("aria-expanded");
  if (closedExpanded !== "false") throw new Error(`source toggle closed aria-expanded expected false, got ${closedExpanded}`);

  const screenshotPath = path.join(screenshotDir, `source-drawer-${viewport.join("x")}.png`);
  await button.click();
  await page.waitForSelector(".rank-row.is-expanded .source-drawer:not([hidden])", { timeout: 15000 });
  await page.screenshot({ path: screenshotPath, fullPage: false });
  const unhandled = await page.evaluate(() => window.__unhandledRejection || "");
  await context.close();
  if (errors.length || unhandled) throw new Error(`mobile source drawer errors: ${errors.join(" | ")} ${unhandled}`);
  results.push({ scenario: "mobile-source-drawer-390x844", requests: [...new Set(requests)], screenshotPath });
}

async function countVisibleInRow(row, selector) {
  return row.locator(selector).evaluateAll((nodes) =>
    nodes.filter((node) => {
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return !node.hidden && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    }).length,
  );
}

async function waitForVisibleCountAbove(row, selector, minimum) {
  const deadline = Date.now() + 3000;
  let latest = await countVisibleInRow(row, selector);
  while (latest <= minimum && Date.now() < deadline) {
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    latest = await countVisibleInRow(row, selector);
  }
  return latest;
}

async function selectSnapshotDate(page, value) {
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await page.waitForFunction(() => document.querySelector("#snapshotDateSelect")?.disabled === false, null, { timeout: 30000 });
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        status: document.querySelector("#status")?.textContent || "",
        busy: document.querySelector("#videoList")?.getAttribute("aria-busy") || "",
        dateDisabled: document.querySelector("#snapshotDateSelect")?.disabled ?? null,
        timeDisabled: document.querySelector("#snapshotSelect")?.disabled ?? null,
        activeView: document.querySelector("[data-view].is-active")?.textContent || "",
        resources: window.printSongListPerformance?.().resources || [],
      }));
      throw new Error(`${error.message}\nsnapshot diagnostics=${JSON.stringify(diagnostics)}`);
    }
    try {
      await page.selectOption("#snapshotDateSelect", value, { timeout: 5000 });
      return;
    } catch (error) {
      lastError = error;
      await sleep(300);
    }
  }
  throw lastError;
}

async function monthlyFallbackScenarios(browser) {
  for (const scenario of [
    {
      label: "404",
      handler: (route) => route.fulfill({ status: 404, contentType: "text/plain", body: "missing" }),
    },
    {
      label: "empty",
      handler: (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            schemaVersion: 1,
            id: "1m",
            title: "月度",
            generatedAt: "2026-07-13T15:56:10.026Z",
            capturedAt: "2026-07-13T15:56:10.026Z",
            dataVersion: "0".repeat(64),
            filterVersion: 3,
            nicheAnnotated: true,
            items: [],
          }),
        }),
    },
    {
      label: "truncated-json",
      handler: (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{\"schemaVersion\":" }),
    },
  ]) {
    const { context, page, errors } = await newPage(browser, [1366, 768]);
    await page.route(/\/data\/ui\/1m\.[0-9a-f]{12}\.json$/u, scenario.handler);
    await page.goto(`${baseUrl}?shared=1&range=1m&debug=1`, { waitUntil: "domcontentloaded" });
    await waitForRows(page, errors);
    const summary = await page.locator("#summary").textContent();
    const status = await page.locator("#status").textContent();
    const alerts = await page.locator("#statusAlerts").textContent();
    const debug = await page.locator("#debugPanel").textContent();
    await context.close();
    if (!summary.includes("备用数据") && !status.includes("备用数据") && !alerts.includes("备用数据")) {
      throw new Error(`fallback ${scenario.label} did not expose fallback state`);
    }
    if (!debug.includes("data/1m.json") && !debug.includes("data/latest.json")) {
      throw new Error(`fallback ${scenario.label} did not record fallback path`);
    }
    const unexpectedErrors =
      scenario.label === "404" ? errors.filter((error) => !/status of 404|HTTP 404/u.test(error)) : errors;
    if (unexpectedErrors.length) throw new Error(`fallback ${scenario.label} errors: ${unexpectedErrors.join(" | ")}`);
    results.push({ scenario: `fallback-${scenario.label}` });
  }
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
    await waitForRows(page, errors, requests);
    await sleep(2500);
    await context.close();
    if (requests.some((item) => runtimePathPattern("1m").test(item))) throw new Error(`${label} prefetched inactive range`);
    if (errors.length) throw new Error(`${label} errors: ${errors.join(" | ")}`);
    results.push({ scenario: `prefetch-${label}`, requests: [...new Set(requests)] });
  }
}

async function review404Scenario(browser) {
  const viewport = [390, 844];
  const { context, page, errors } = await newPage(browser, viewport);
  const response = await page.goto(new URL("review.html", baseUrl).toString(), { waitUntil: "domcontentloaded" });
  const status = response?.status() || 0;
  const screenshotPath = path.join(screenshotDir, `review-404-${viewport.join("x")}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  await context.close();
  if (status !== 404) throw new Error(`review.html expected 404, got ${status}`);
  const unexpectedErrors = errors.filter((error) => !/status of 404|HTTP 404|File not found/u.test(error));
  if (unexpectedErrors.length) throw new Error(`review 404 errors: ${unexpectedErrors.join(" | ")}`);
  results.push({ scenario: "review-404", status, screenshotPath });
}

function runtimePathPattern(range) {
  return new RegExp(`^data/ui/${range}(?:\\.[0-9a-f]{12})?\\.json$`, "u");
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    for (const viewport of viewports) {
      await firstLoad(browser, "72h", viewport);
    }
    await firstLoad(browser, "1m", [1366, 768]);
    await interactionFlow(browser);
    await mobileSourceDrawerFlow(browser);
    await monthlyFallbackScenarios(browser);
    await prefetchGuards(browser);
    await review404Scenario(browser);
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(results, null, 2));
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
