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
  [1280, 800],
  [1279, 800],
  [1100, 800],
  [1024, 768],
  [920, 768],
  [919, 900],
  [768, 1024],
  [721, 900],
  [430, 932],
  [390, 844],
  [360, 800],
  [320, 700],
];
const results = [];
const screenshotDir = path.join(process.cwd(), "artifacts", "h5-redesign");
const screenshotTag = (process.env.CODEX_SCREENSHOT_TAG || "local").replace(/[^a-zA-Z0-9._-]/g, "-");
fs.mkdirSync(screenshotDir, { recursive: true });

function shotPath(name) {
  return path.join(screenshotDir, `${screenshotTag}-${name}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function verifyTimeout(localMs, remoteMs) {
  return baseUrl.startsWith("https://") ? remoteMs : localMs;
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
      timeout: verifyTimeout(15000, 120000),
    });
    await page.waitForFunction(() => document.querySelector("#videoList")?.getAttribute("aria-busy") !== "true", null, {
      timeout: verifyTimeout(15000, 300000),
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

async function openMobileFilterSheet(page) {
  await page.locator("#openFilterButton").click();
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

async function retryDetachedAction(action, label, attempts = 5) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await action();
      return;
    } catch (error) {
      lastError = error;
      if (!/not attached|detached|Element is not attached/u.test(error.message || "")) throw error;
      await sleep(150);
    }
  }
  throw new Error(`${label} failed after detached retries: ${lastError?.message || lastError}`);
}

async function readFilterBadgeState(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("#filterCountBadge, #mobileFilterCountBadge")).map((node) => ({
      id: node.id,
      hidden: node.hidden,
      display: getComputedStyle(node).display,
      text: node.textContent || "",
    })),
  );
}

function assertBadgesHidden(badges, label) {
  if (badges.some((badge) => !badge.hidden || badge.display !== "none" || badge.text === "0")) {
    throw new Error(`${label} filter badges should be hidden when count is zero: ${JSON.stringify(badges)}`);
  }
}

function assertBadgesVisible(badges, label) {
  if (badges.some((badge) => badge.hidden || badge.display === "none" || !/^[1-9]\d*$/u.test(badge.text))) {
    throw new Error(`${label} filter badges should show active count: ${JSON.stringify(badges)}`);
  }
}

async function installSourceDrawerBuildGuard(page) {
  return page.evaluate(() => {
    const button = document.querySelector("[data-toggle-source]");
    const utils = window.RankingUtils;
    if (!button || !utils || typeof utils.buildSongRecords !== "function") return false;
    window.__sourceDrawerBuildGuard = { active: false, calls: 0 };
    if (!utils.__sourceDrawerOriginalBuildSongRecords) {
      utils.__sourceDrawerOriginalBuildSongRecords = utils.buildSongRecords;
      utils.buildSongRecords = function guardedBuildSongRecords(...args) {
        if (window.__sourceDrawerBuildGuard?.active) window.__sourceDrawerBuildGuard.calls += 1;
        return utils.__sourceDrawerOriginalBuildSongRecords.apply(this, args);
      };
    }
    button.addEventListener(
      "click",
      () => {
        if (!window.__sourceDrawerBuildGuard) return;
        window.__sourceDrawerBuildGuard.active = true;
        window.requestAnimationFrame(() => {
          if (window.__sourceDrawerBuildGuard) window.__sourceDrawerBuildGuard.active = false;
        });
      },
      { capture: true, once: true },
    );
    return true;
  });
}

async function readSourceDrawerBuildGuard(page) {
  return page.evaluate(() => ({
    buildSongRecordCount: window.__sourceDrawerBuildGuard?.calls || 0,
  }));
}

async function removeSourceDrawerBuildGuard(page) {
  await page.evaluate(() => {
    const utils = window.RankingUtils;
    if (utils?.__sourceDrawerOriginalBuildSongRecords) {
      utils.buildSongRecords = utils.__sourceDrawerOriginalBuildSongRecords;
      delete utils.__sourceDrawerOriginalBuildSongRecords;
    }
    delete window.__sourceDrawerBuildGuard;
  });
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
        bottom: box.bottom,
        left: box.left,
        right: box.right,
        display: style.display,
        overflowX: style.overflowX,
        text: node.textContent || "",
      };
    };
    const controls = rect("#controls");
    const topbar = rect(".topbar");
    const topbarInner = rect(".topbar-inner");
    const searchField = rect(".search-field");
    const bottomNav = rect("#mobileBottomNav");
    const summary = rect("#summary");
    const summaryRange = rect("#summary .summary-range");
    const topPagination = rect(".pagination-top");
    const topJump = rect(".pagination-top .page-jump");
    const topPageSize = rect(".pagination-top .page-size-control");
    const topControls = Array.from(document.querySelectorAll(".pagination-top .pagination-button, .pagination-top .pagination-status")).map((node) => ({
      text: node.textContent || "",
      ariaLabel: node.getAttribute("aria-label") || "",
      className: node.className || "",
    }));
    const bottomJump = rect(".pagination-bottom .page-jump");
    const filterBadges = Array.from(document.querySelectorAll("#filterCountBadge, #mobileFilterCountBadge")).map((node) => ({
      id: node.id,
      hidden: node.hidden,
      display: getComputedStyle(node).display,
      text: node.textContent || "",
    }));
    const rows = Array.from(document.querySelectorAll(".rank-row:not(.skeleton-row), .index-row, .video-card"));
    const firstRow = rows[0] || null;
    const secondRow = rows[1] || null;
    const firstTitle = firstRow?.querySelector(".rank-title, .index-heading, .video-title") || null;
    const firstButton =
      Array.from(firstRow?.querySelectorAll("button") || []).find((node) => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return !node.hidden && style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
      }) || null;
    const rowRect = (node) => {
      if (!node) return null;
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        top: box.top,
        bottom: box.bottom,
        left: box.left,
        right: box.right,
        width: box.width,
        height: box.height,
        fontSize: Number.parseFloat(style.fontSize) || 0,
        display: style.display,
      };
    };
    const bottomItems = Array.from(document.querySelectorAll("#mobileBottomNav [data-view]")).map((node) => {
      const box = node.getBoundingClientRect();
      return { text: node.textContent || "", width: box.width, display: getComputedStyle(node).display };
    });
    const rankCount = rect(".rank-count");
    const strongCount = document.querySelector(".rank-count.is-strong") || document.querySelector(".rank-count");
    const rankCountStyle = strongCount
      ? {
          backgroundColor: getComputedStyle(strongCount).backgroundColor,
          color: getComputedStyle(strongCount).color,
          borderRadius: getComputedStyle(strongCount).borderRadius,
        }
      : null;
    const rankSubline = rect(".rank-subline");
    const visibleShareLabels = Array.from(document.querySelectorAll("button, a"))
      .filter((node) => {
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        return !node.hidden && style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
      })
      .map((node) => node.textContent.trim())
      .filter((text) => text === "分享" || text === "复制链接");
    const visible = (node) => {
      if (!node) return false;
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return !node.hidden && style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    const segmentedControls = Array.from(document.querySelectorAll("#controls .segmented"))
      .filter(visible)
      .map((node) => {
        const box = node.getBoundingClientRect();
        return {
          className: node.className || "",
          width: box.width,
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
          overflowX: getComputedStyle(node).overflowX,
          buttons: Array.from(node.querySelectorAll("button"))
            .filter(visible)
            .map((button) => ({ text: button.textContent || "", width: button.getBoundingClientRect().width })),
        };
      });
    return {
      width,
      topbar,
      topbarInner,
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
      filterBadges,
      firstRow: rowRect(firstRow),
      firstTitle: rowRect(firstTitle),
      firstButton: rowRect(firstButton),
      secondRow: rowRect(secondRow),
      rankCount,
      rankCountStyle,
      rankSubline,
      segmentedControls,
      shareButtonExists: Boolean(document.querySelector("#shareButton")),
      copyLinkExists: Boolean(document.querySelector("[data-copy-link]")),
      visibleShareLabels,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  }, { width: viewport[0], range });

  if (result.scrollWidth > result.clientWidth + 1) throw new Error(`horizontal overflow ${JSON.stringify(result)}`);
  if (result.topbarInner && (result.topbarInner.left < -1 || result.topbarInner.right > result.clientWidth + 1)) {
    throw new Error(`topbar inner is not aligned to viewport ${JSON.stringify(result.topbarInner)}`);
  }
  const overflowingSegment = result.segmentedControls.find((control) => control.scrollWidth > control.clientWidth + 1);
  if (overflowingSegment) throw new Error(`segmented control overflowed inside toolbar ${JSON.stringify(overflowingSegment)}`);
  if (result.shareButtonExists || result.copyLinkExists || result.visibleShareLabels.length) {
    throw new Error(`visible share/copy-current-link entry remains ${JSON.stringify(result)}`);
  }
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
    if (
      result.topControls.length === 3 &&
      (result.topControls[0].text.trim() ||
        result.topControls[2].text.trim() ||
        result.topControls[0].ariaLabel !== "上一页" ||
        result.topControls[2].ariaLabel !== "下一页" ||
        !/^\d+\/\d+$/u.test(result.topControls[1].text.trim()))
    ) {
      throw new Error(`mobile top pagination should use icon buttons plus compact status ${JSON.stringify(result.topControls)}`);
    }
    if (result.filterBadges.some((badge) => !badge.hidden || badge.display !== "none" || badge.text === "0")) {
      throw new Error(`inactive filter badge is visible ${JSON.stringify(result.filterBadges)}`);
    }
    if (result.rankCountStyle && !/rgba\(0,\s*0,\s*0,\s*0\)|transparent/u.test(result.rankCountStyle.backgroundColor)) {
      throw new Error(`mobile rank count should not use a filled pill ${JSON.stringify(result.rankCountStyle)}`);
    }
    if (result.topPagination && result.topPagination.height > 52) throw new Error(`mobile top pagination too tall ${result.topPagination.height}`);
    if (!result.firstRow || result.firstRow.bottom > viewport[1]) throw new Error(`first mobile row is not visible ${JSON.stringify(result)}`);
    if (!result.firstTitle || result.firstTitle.top < (result.topPagination?.bottom || 0) - 1) {
      throw new Error(`first mobile title is covered ${JSON.stringify(result)}`);
    }
    if (result.firstTitle.fontSize < 14) throw new Error(`first mobile title font too small ${JSON.stringify(result.firstTitle)}`);
    if (result.firstButton && result.firstButton.height < 36) throw new Error(`mobile first action touch target too small ${JSON.stringify(result.firstButton)}`);
    if (!result.secondRow || result.secondRow.top >= viewport[1]) throw new Error(`next mobile row entry is not visible ${JSON.stringify(result.secondRow)}`);
  } else if (viewport[0] <= 919) {
    if (result.topJump || result.topPageSize) throw new Error(`tablet top pagination includes jump/page size ${JSON.stringify(result)}`);
    if (!result.firstRow || result.firstRow.bottom > viewport[1]) throw new Error(`first tablet row is not visible ${JSON.stringify(result)}`);
    if (!result.firstTitle || result.firstTitle.fontSize < 14) throw new Error(`first tablet title invalid ${JSON.stringify(result.firstTitle)}`);
  } else if (viewport[0] >= 1024) {
    if (result.topJump || !result.bottomJump) throw new Error(`desktop pagination scope invalid ${JSON.stringify(result)}`);
    if (!result.firstRow || !result.firstTitle) throw new Error(`desktop first row missing ${JSON.stringify(result)}`);
    if (result.firstTitle.top < (result.topPagination?.bottom || 0) - 1) throw new Error(`desktop first title is covered ${JSON.stringify(result)}`);
    if (result.firstTitle.fontSize < 14) throw new Error(`desktop first title font too small ${JSON.stringify(result.firstTitle)}`);
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
  const screenshotPath = shotPath(`${range}-${viewport.join("x")}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  await context.close();

  const forbidden =
    range === "72h"
      ? ["data/latest.json", "data/diff/latest-1m.json", "data/song-search-known-songs.json"]
      : ["data/latest.json", "data/diff/latest-72h.json", "data/song-search-known-songs.json"];
  const seenForbidden = beforeFirstContentRequests.filter((item) => forbidden.includes(item));
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

async function desktopRankVisualGeometry(browser) {
  for (const viewport of [
    [1440, 900],
    [1920, 1080],
  ]) {
    const { context, page, errors } = await newPage(browser, viewport);
    const requests = [];
    page.on("request", (request) => requests.push(requestPath(request.url())));
    const url = new URL(baseUrl);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("showUnknown", "1");
    await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
    await waitForRows(page, errors, requests);
    await page.waitForSelector(".rank-trend .trend-badge", { timeout: verifyTimeout(15000, 30000) });

    const geometry = await page.evaluate(() => {
      const rectFor = (node) => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
          position: style.position,
          display: style.display,
          backgroundColor: style.backgroundColor,
        };
      };
      const visible = (node) => {
        if (!node) return false;
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        return !node.hidden && style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
      };
      const header = document.querySelector(".rank-header");
      const headerCells = Array.from(document.querySelectorAll(".rank-header > span")).map(rectFor);
      const firstRow = document.querySelector(".rank-row:not(.skeleton-row)");
      const rowCells = [
        firstRow?.querySelector(".rank-number"),
        firstRow?.querySelector(".rank-content"),
        firstRow?.querySelector(".rank-trend"),
        firstRow?.querySelector(".rank-count"),
      ].map((node) => (node ? rectFor(node) : null));
      const title = firstRow?.querySelector(".rank-title");
      const trendCounts = Array.from(document.querySelectorAll(".rank-row:not(.skeleton-row)")).slice(0, 40).map((row) => ({
        visibleBadges: Array.from(row.querySelectorAll(".trend-badge")).filter(visible).length,
        visibleInline: Array.from(row.querySelectorAll(".rank-trend-inline")).filter(visible).length,
        visibleDesktop: Array.from(row.querySelectorAll(".rank-trend .trend-badge")).filter(visible).length,
      }));
      const controls = Array.from(document.querySelectorAll("#controls .segmented, #controls .toolbar-button, #controls select, #controls input:not([type='checkbox']):not([type='radio'])"))
        .filter(visible)
        .map((node) => ({ className: node.className || node.tagName, ...rectFor(node) }));
      return {
        viewportWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        header: header ? rectFor(header) : null,
        headerCells,
        firstRow: firstRow ? rectFor(firstRow) : null,
        rowCells,
        title: title ? rectFor(title) : null,
        titleText: title?.textContent?.trim() || "",
        trendCounts,
        controls,
        shareButtonExists: Boolean(document.querySelector("#shareButton")),
        copyLinkExists: Boolean(document.querySelector("[data-copy-link]")),
      };
    });
    if (geometry.scrollWidth > geometry.viewportWidth + 1) throw new Error(`desktop rank overflow ${JSON.stringify(geometry)}`);
    if (geometry.shareButtonExists || geometry.copyLinkExists) throw new Error(`desktop share entry remains ${JSON.stringify(geometry)}`);
    if (!geometry.header || !geometry.firstRow || !geometry.title) throw new Error(`desktop rank geometry missing ${JSON.stringify(geometry)}`);
    if (geometry.header.position === "sticky") throw new Error(`desktop rank header should not be sticky ${JSON.stringify(geometry.header)}`);
    if (geometry.title.top < geometry.header.bottom - 1) throw new Error(`first rank title is covered by header ${JSON.stringify(geometry)}`);
    if (geometry.title.height < 16) throw new Error(`first rank title height too small ${JSON.stringify(geometry)}`);
    if (geometry.trendCounts.some((row) => row.visibleBadges > 1 || row.visibleInline > 0)) {
      throw new Error(`desktop trend visibility invalid ${JSON.stringify(geometry.trendCounts.slice(0, 10))}`);
    }
    if (!geometry.trendCounts.some((row) => row.visibleDesktop > 0)) throw new Error("desktop trend column did not render any trend badge");
    for (let index = 0; index < 4; index += 1) {
      const headerCell = geometry.headerCells[index];
      const rowCell = geometry.rowCells[index];
      if (!headerCell || !rowCell) throw new Error(`desktop rank columns missing ${JSON.stringify(geometry)}`);
      assertClose(headerCell.left, rowCell.left, 4, `desktop column ${index} left`, geometry);
      assertClose(headerCell.right, rowCell.right, 8, `desktop column ${index} right`, geometry);
    }
    if (geometry.controls.some((control) => Math.abs(control.height - 44) > 3)) {
      throw new Error(`desktop toolbar control height mismatch ${JSON.stringify(geometry.controls)}`);
    }

    const row = page.locator(".rank-row:not(.skeleton-row):has([data-toggle-source])").first();
    await row.locator("[data-toggle-source]").first().click();
    await page.waitForSelector(".rank-row.is-expanded .source-drawer:not([hidden]) .source-video-group", { timeout: 15000 });
    const sourceGeometry = await row.evaluate((node) => {
      const rectFor = (target) => {
        const box = target.getBoundingClientRect();
        const style = getComputedStyle(target);
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
          fontSize: Number.parseFloat(style.fontSize) || 0,
          fontWeight: Number.parseInt(style.fontWeight, 10) || 0,
        };
      };
      const drawer = node.querySelector(".source-drawer");
      const toolbar = node.querySelector(".source-drawer-toolbar");
      const firstGroup = node.querySelector(".source-video-group");
      const channel = node.querySelector(".source-video-channel");
      const sourceTitle = node.querySelector(".source-video-title");
      const groups = Array.from(node.querySelectorAll(".source-video-group")).map(rectFor);
      const top = groups[0]?.top || 0;
      const firstRowGroups = groups.filter((group) => Math.abs(group.top - top) < 3);
      const firstRowBottom = firstRowGroups.reduce((bottom, group) => Math.max(bottom, group.bottom), 0);
      const copyButtons = Array.from(node.querySelectorAll(".source-video-group .source-copy"))
        .map(rectFor)
        .filter((button) => button.top >= top - 2 && button.top <= firstRowBottom);
      return {
        drawer: drawer ? rectFor(drawer) : null,
        toolbar: toolbar ? rectFor(toolbar) : null,
        firstGroup: firstGroup ? rectFor(firstGroup) : null,
        channel: channel ? rectFor(channel) : null,
        sourceTitle: sourceTitle ? rectFor(sourceTitle) : null,
        channelHref: channel?.href || "",
        sourceTitleHref: sourceTitle?.href || "",
        copyAllButtons: node.querySelectorAll("[data-copy-song-links]").length,
        copyAllInToolbar: node.querySelectorAll(".source-drawer-toolbar [data-copy-song-links]").length,
        copyAllInsideCards: node.querySelectorAll(".source-video-group [data-copy-song-links]").length,
        moreButtons: node.querySelectorAll("[data-toggle-source-groups]").length,
        collapseButtons: node.querySelectorAll("[data-collapse-source]").length,
        countText: node.querySelector(".source-drawer-count")?.textContent?.trim() || "",
        groups,
        firstRowGroups,
        copyButtons,
      };
    });
    if (!sourceGeometry.drawer || !sourceGeometry.toolbar || !sourceGeometry.firstGroup || !sourceGeometry.channel || !sourceGeometry.sourceTitle) {
      throw new Error(`desktop source geometry missing ${JSON.stringify(sourceGeometry)}`);
    }
    if (sourceGeometry.copyAllButtons !== 1 || sourceGeometry.copyAllInToolbar !== 1 || sourceGeometry.copyAllInsideCards !== 0) {
      throw new Error(`desktop copy-all placement invalid ${JSON.stringify(sourceGeometry)}`);
    }
    if (sourceGeometry.groups.length > 9) throw new Error(`desktop source drawer rendered more than initial batch ${JSON.stringify(sourceGeometry)}`);
    if (sourceGeometry.moreButtons && !/^已显示9\/\d+个来源$/u.test(sourceGeometry.countText)) {
      throw new Error(`desktop source count should expose visible progress ${JSON.stringify(sourceGeometry)}`);
    }
    if (sourceGeometry.collapseButtons !== 0) throw new Error(`desktop source drawer should not render duplicate collapse actions ${JSON.stringify(sourceGeometry)}`);
    if (sourceGeometry.toolbar.bottom > sourceGeometry.firstGroup.top + 8) {
      throw new Error(`desktop source toolbar not before cards ${JSON.stringify(sourceGeometry)}`);
    }
    if (sourceGeometry.channel.fontSize <= sourceGeometry.sourceTitle.fontSize || sourceGeometry.channel.fontWeight < sourceGeometry.sourceTitle.fontWeight) {
      throw new Error(`desktop source hierarchy invalid ${JSON.stringify(sourceGeometry)}`);
    }
    if (!sourceGeometry.channelHref || !sourceGeometry.sourceTitleHref) throw new Error(`desktop source links missing ${JSON.stringify(sourceGeometry)}`);
    if (sourceGeometry.firstRowGroups.length > 1) {
      const width = sourceGeometry.firstRowGroups[0].width;
      for (const group of sourceGeometry.firstRowGroups) {
        assertClose(group.width, width, 2, "desktop source group width", sourceGeometry);
        assertClose(group.top, sourceGeometry.firstRowGroups[0].top, 2, "desktop source group top", sourceGeometry);
      }
    }
    if (sourceGeometry.copyButtons.length > 1) {
      const top = sourceGeometry.copyButtons[0].top;
      for (const button of sourceGeometry.copyButtons) assertClose(button.top, top, 3, "desktop source copy button top", sourceGeometry);
    }
    if (sourceGeometry.moreButtons) {
      const beforeGroupCount = await countVisibleInRow(row, ".source-video-group");
      const expectedTotal = sourceCountFromText(sourceGeometry.countText);
      const preservedBefore = await row.locator(".source-video-group").first().evaluate((node) => {
        node.dataset.codexPreserve = "1";
        const image = node.querySelector("img");
        if (image) image.dataset.codexPreserve = "1";
        return {
          text: node.textContent || "",
          imageSrc: image?.currentSrc || image?.src || "",
        };
      });
      await row.locator("[data-toggle-source-groups]").first().click();
      const afterGroupCount = await waitForVisibleCountAbove(row, ".source-video-group", beforeGroupCount);
      if (afterGroupCount <= beforeGroupCount) throw new Error("desktop source group expander did not add visible groups");
      if (expectedTotal && afterGroupCount !== expectedTotal) {
        throw new Error(`desktop source group expander should reveal all remaining groups: before=${beforeGroupCount} after=${afterGroupCount} total=${expectedTotal}`);
      }
      if ((await row.locator("[data-toggle-source-groups]").count()) !== 0) throw new Error("desktop source group expander remained after revealing all sources");
      const preservedAfter = await row.locator(".source-video-group").first().evaluate((node) => ({
        preserved: node.dataset.codexPreserve === "1",
        imagePreserved: node.querySelector("img")?.dataset.codexPreserve === "1",
        text: node.textContent || "",
        imageSrc: node.querySelector("img")?.currentSrc || node.querySelector("img")?.src || "",
      }));
      if (!preservedAfter.preserved || !preservedAfter.imagePreserved || preservedAfter.text !== preservedBefore.text || preservedAfter.imageSrc !== preservedBefore.imageSrc) {
        throw new Error(`desktop source group expander rebuilt existing source cards ${JSON.stringify({ preservedBefore, preservedAfter })}`);
      }
    }
    const secondRow = page.locator(".rank-row:not(.skeleton-row):has([data-toggle-source])").nth(1);
    if ((await secondRow.count()) === 1) {
      await secondRow.locator("[data-toggle-source]").first().click();
      const expandedCount = await page.locator(".rank-row.is-expanded").count();
      if (expandedCount < 2) throw new Error(`desktop should allow multiple expanded rows, got ${expandedCount}`);
    }
    let expandedScreenshotPath = null;
    if (viewport[0] === 1440) {
      expandedScreenshotPath = shotPath(`desktop-source-expanded-${viewport.join("x")}.png`);
      await page.screenshot({ path: expandedScreenshotPath, fullPage: false });
    }
    const unhandled = await page.evaluate(() => window.__unhandledRejection || "");
    await context.close();
    if (errors.length || unhandled) throw new Error(`desktop rank visual geometry errors: ${errors.join(" | ")} ${unhandled}`);
    results.push({ scenario: `desktop-rank-geometry-${viewport.join("x")}`, requests: [...new Set(requests)], expandedScreenshotPath });
  }
}

async function interactionFlow(browser) {
  const { context, page, errors } = await newPage(browser, [1366, 768]);
  const requests = [];
  page.on("request", (request) => requests.push(requestPath(request.url())));
  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await waitForRows(page, errors, requests);
  assertBadgesHidden(await readFilterBadgeState(page), "initial");
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
  assertBadgesVisible(await readFilterBadgeState(page), "filtered");
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
  assertBadgesHidden(await readFilterBadgeState(page), "reset");
  const searchAfterOrdinaryInteractions = await page.evaluate(() => window.location.search);
  if (searchAfterOrdinaryInteractions) throw new Error(`ordinary interactions should not persist filters to URL: ${searchAfterOrdinaryInteractions}`);
  await page.waitForFunction(
    () => Boolean(window.RankingUtils?.buildSongRecords && document.querySelector("[data-toggle-source]")),
    null,
    { timeout: baseUrl.startsWith("https://") ? 30000 : 15000 },
  );
  const buildGuardInstalled = await installSourceDrawerBuildGuard(page);
  if (!buildGuardInstalled) throw new Error("could not install source drawer build guard");
  let sourcePerf = null;
  try {
    await page.locator("[data-toggle-source]").first().click();
    await page.waitForSelector(".rank-row.is-expanded .source-drawer:not([hidden]) .source-video-group, .rank-row.is-expanded .source-drawer:not([hidden]) .source-link", {
      timeout: 15000,
    });
    sourcePerf = await readSourceDrawerBuildGuard(page);
  } finally {
    await removeSourceDrawerBuildGuard(page);
  }
  if (sourcePerf.buildSongRecordCount > 0) {
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
      await waitForRows(page, errors, requests);
      options = await page
        .locator("#snapshotSelect option")
        .evaluateAll((items) => items.map((item) => item.value).filter((value) => value !== "data/latest.json"));
      if (options.length) break;
    }
    if (!options.length) throw new Error("no historical snapshot options");
    await page.waitForFunction(() => document.querySelector("#snapshotSelect")?.disabled === false, null, { timeout: verifyTimeout(30000, 120000) });
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

function assertClose(actual, expected, tolerance, label, details = {}) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label}: actual=${actual} expected=${expected} tolerance=${tolerance} details=${JSON.stringify(details)}`);
  }
}

async function mobileFilterSheetFlow(browser) {
  for (const viewport of [
    [390, 844],
    [320, 700],
  ]) {
    const { context, page, errors } = await newPage(browser, viewport);
    const requests = [];
    page.on("request", (request) => requests.push(requestPath(request.url())));
    await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    await waitForRows(page, errors, requests);
    await openMobileFilterSheet(page);

    const topScreenshotPath = shotPath(`filter-sheet-top-${viewport.join("x")}.png`);
    await page.screenshot({ path: topScreenshotPath, fullPage: false });

    const topGeometry = await page.evaluate(() => {
      const rectFor = (node) => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
          centerY: box.top + box.height / 2,
          borderRadius: Number.parseFloat(style.borderTopLeftRadius) || 0,
          paddingLeft: Number.parseFloat(style.paddingLeft) || 0,
        };
      };
      const dialog = document.querySelector("#filterDialog");
      const sheet = document.querySelector("#filterDialog .filter-sheet");
      const toggles = ["#nicheOnlyToggle", "#hideUnknownToggle"].map((selector) => {
        const input = document.querySelector(selector);
        const label = input?.closest(".sheet-toggle");
        const text = label?.querySelector("span:not(.sr-only)");
        return {
          label: label ? rectFor(label) : null,
          input: input ? rectFor(input) : null,
          text: text ? rectFor(text) : null,
        };
      });
      const segmented = Array.from(document.querySelectorAll("#metricFilterGroup .sheet-segmented label")).map(rectFor);
      const selects = Array.from(document.querySelectorAll("#filterDialog select")).map(rectFor);
      const footerButtons = Array.from(document.querySelectorAll("#filterDialog .sheet-actions button")).map(rectFor);
      const sheetBox = sheet ? rectFor(sheet) : null;
      return {
        toggles,
        segmented,
        selects,
        footerButtons,
        sheet: sheetBox,
        dialogOverflow: dialog ? dialog.scrollWidth - dialog.clientWidth : 0,
        sheetOverflow: sheet ? sheet.scrollWidth - sheet.clientWidth : 0,
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    if (topGeometry.documentOverflow > 1 || topGeometry.dialogOverflow > 1 || topGeometry.sheetOverflow > 1) {
      throw new Error(`mobile filter sheet overflow ${JSON.stringify(topGeometry)}`);
    }
    const [nicheToggle, unknownToggle] = topGeometry.toggles;
    if (!nicheToggle?.label || !unknownToggle?.label || !nicheToggle.input || !unknownToggle.input || !nicheToggle.text || !unknownToggle.text) {
      throw new Error(`mobile filter toggles missing ${JSON.stringify(topGeometry)}`);
    }
    assertClose(nicheToggle.label.left, unknownToggle.label.left, 1, "sheet toggle left", topGeometry);
    assertClose(nicheToggle.label.right, unknownToggle.label.right, 1, "sheet toggle right", topGeometry);
    assertClose(nicheToggle.label.width, unknownToggle.label.width, 1, "sheet toggle width", topGeometry);
    assertClose(nicheToggle.label.height, unknownToggle.label.height, 1, "sheet toggle height", topGeometry);
    if (!nicheToggle.label.borderRadius || !unknownToggle.label.borderRadius) throw new Error(`sheet toggle border radius missing ${JSON.stringify(topGeometry)}`);
    assertClose(nicheToggle.label.borderRadius, unknownToggle.label.borderRadius, 1, "sheet toggle radius", topGeometry);
    assertClose(nicheToggle.input.centerY - nicheToggle.label.centerY, unknownToggle.input.centerY - unknownToggle.label.centerY, 1, "sheet checkbox center offset", topGeometry);
    assertClose(nicheToggle.text.centerY - nicheToggle.label.centerY, unknownToggle.text.centerY - unknownToggle.label.centerY, 1, "sheet toggle text center offset", topGeometry);
    assertClose(nicheToggle.input.centerY, nicheToggle.label.centerY, 1, "niche checkbox row center", topGeometry);
    assertClose(unknownToggle.input.centerY, unknownToggle.label.centerY, 1, "unknown checkbox row center", topGeometry);
    assertClose(nicheToggle.label.paddingLeft, unknownToggle.label.paddingLeft, 1, "sheet toggle left padding", topGeometry);
    if (topGeometry.segmented.length !== 2) throw new Error(`metric segmented controls missing ${JSON.stringify(topGeometry)}`);
    assertClose(topGeometry.segmented[0].height, topGeometry.segmented[1].height, 1, "metric segmented height", topGeometry);
    if (!topGeometry.selects.length) throw new Error(`mobile filter select controls missing ${JSON.stringify(topGeometry)}`);
    for (const select of topGeometry.selects) {
      assertClose(select.height, 44, 1, "filter select height", topGeometry);
    }
    const selectHeights = topGeometry.selects.map((item) => item.height);
    if (Math.max(...selectHeights) - Math.min(...selectHeights) > 1) throw new Error(`filter select heights differ ${JSON.stringify(topGeometry)}`);
    if (topGeometry.footerButtons.length !== 2) throw new Error(`filter footer buttons missing ${JSON.stringify(topGeometry)}`);
    const [resetButton, applyButton] = topGeometry.footerButtons;
    assertClose(resetButton.height, applyButton.height, 1, "filter footer button height", topGeometry);
    assertClose(resetButton.width, applyButton.width, 2, "filter footer button width", topGeometry);
    assertClose(resetButton.top, applyButton.top, 1, "filter footer button top", topGeometry);
    assertClose(resetButton.bottom, applyButton.bottom, 1, "filter footer button bottom", topGeometry);

    await page.locator("#filterDialog .filter-sheet").evaluate((sheet) => {
      sheet.scrollTop = sheet.scrollHeight;
    });
    await page.waitForTimeout(50);
    const bottomGeometry = await page.evaluate(() => {
      const rectFor = (node) => {
        const box = node.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, height: box.height };
      };
      const selects = Array.from(document.querySelectorAll("#filterDialog select"));
      const footer = document.querySelector("#filterDialog .sheet-actions");
      return {
        lastSelect: selects.length ? rectFor(selects[selects.length - 1]) : null,
        footer: footer ? rectFor(footer) : null,
      };
    });
    if (!bottomGeometry.lastSelect || !bottomGeometry.footer) throw new Error(`filter bottom geometry missing ${JSON.stringify(bottomGeometry)}`);
    if (bottomGeometry.lastSelect.bottom > bottomGeometry.footer.top - 12) {
      throw new Error(`filter footer overlaps last select ${JSON.stringify(bottomGeometry)}`);
    }
    const bottomScreenshotPath = shotPath(`filter-sheet-bottom-${viewport.join("x")}.png`);
    await page.screenshot({ path: bottomScreenshotPath, fullPage: false });

    await page.locator("#cancelFilterButton").click();
    await page.locator("#filterDialog").waitFor({ state: "hidden", timeout: 5000 });
    const unhandled = await page.evaluate(() => window.__unhandledRejection || "");
    await context.close();
    if (errors.length || unhandled) throw new Error(`mobile filter sheet errors: ${errors.join(" | ")} ${unhandled}`);
    results.push({ scenario: `mobile-filter-sheet-${viewport.join("x")}`, requests: [...new Set(requests)], topScreenshotPath, bottomScreenshotPath });
  }
}

async function mobileRankVisualGeometry(browser) {
  for (const viewport of [
    [320, 700],
    [360, 800],
    [390, 844],
    [430, 932],
    [768, 1024],
  ]) {
    const { context, page, errors } = await newPage(browser, viewport);
    const requests = [];
    page.on("request", (request) => requests.push(requestPath(request.url())));
    const url = new URL(baseUrl);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("showUnknown", "1");
    await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
    await waitForRows(page, errors, requests);
    await page.waitForFunction(
      () => document.querySelector(".rank-row:not(.skeleton-row)") && document.querySelector(".rank-trend-inline"),
      null,
      { timeout: baseUrl.startsWith("https://") ? 30000 : 15000 },
    );

    const closedGeometry = await page.evaluate(() => {
      const rectFor = (node) => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
          centerY: box.top + box.height / 2,
          display: style.display,
          backgroundColor: style.backgroundColor,
        };
      };
      const rows = Array.from(document.querySelectorAll(".rank-row:not(.skeleton-row)"));
      const trendRow = rows.find((row) => row.querySelector(".rank-trend-inline") && row.querySelector(".rank-expand")) || rows.find((row) => row.querySelector(".rank-trend-inline"));
      const trend = trendRow?.querySelector(".rank-trend-inline");
      const content = trendRow?.querySelector(".rank-content");
      const button = trendRow?.querySelector(".rank-expand");
      const rank = trendRow?.querySelector(".rank-number");
      const title = trendRow?.querySelector(".rank-title");
      const count = trendRow?.querySelector(".rank-count");
      return {
        viewportWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        rowText: trendRow?.textContent?.slice(0, 200) || "",
        trend: trend ? rectFor(trend) : null,
        content: content ? rectFor(content) : null,
        button: button ? rectFor(button) : null,
        rank: rank ? rectFor(rank) : null,
        title: title ? rectFor(title) : null,
        count: count ? rectFor(count) : null,
      };
    });
    if (closedGeometry.scrollWidth > closedGeometry.viewportWidth + 1) throw new Error(`mobile rank overflow ${JSON.stringify(closedGeometry)}`);
    if (!closedGeometry.trend || !closedGeometry.content) throw new Error(`mobile trend geometry missing ${JSON.stringify(closedGeometry)}`);
    if (closedGeometry.trend.width > 120) throw new Error(`trend badge too wide ${JSON.stringify(closedGeometry)}`);
    if (closedGeometry.trend.width > closedGeometry.content.width * 0.5) throw new Error(`trend badge exceeds half content width ${JSON.stringify(closedGeometry)}`);
    if (closedGeometry.trend.width > closedGeometry.content.width - 8) throw new Error(`trend badge spans rank content ${JSON.stringify(closedGeometry)}`);
    if (closedGeometry.trend.height > 28) throw new Error(`trend badge too tall ${JSON.stringify(closedGeometry)}`);
    if (closedGeometry.button) assertClose(closedGeometry.trend.centerY, closedGeometry.button.centerY, 2, "trend and source button center", closedGeometry);
    if (closedGeometry.rank && closedGeometry.title) assertClose(closedGeometry.rank.top, closedGeometry.title.top, 3, "rank and title top", closedGeometry);
    if (closedGeometry.title && closedGeometry.count) assertClose(closedGeometry.title.top, closedGeometry.count.top, 3, "title and count top", closedGeometry);

    const expandableRows = page.locator(".rank-row:not(.skeleton-row):has([data-toggle-source])");
    if ((await expandableRows.count()) < 1) throw new Error("no expandable row for mobile rank visual geometry");
    const expandedRow = expandableRows.first();
    await expandedRow.locator("[data-toggle-source]").first().click();
    await page.waitForSelector(".rank-row.is-expanded .source-drawer:not([hidden]) .source-video-group", { timeout: 15000 });

    const expandedGeometry = await expandedRow.evaluate((node) => {
      const rectFor = (target) => {
        const box = target.getBoundingClientRect();
        const style = getComputedStyle(target);
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
          rowGap: style.rowGap,
          paddingTop: Number.parseFloat(style.paddingTop) || 0,
          paddingBottom: Number.parseFloat(style.paddingBottom) || 0,
        };
      };
      const drawer = node.querySelector(".source-drawer");
      const firstGroup = node.querySelector(".source-video-group");
      const title = node.querySelector(".rank-title");
      const sourceTime = node.querySelector(".source-time-primary");
      const sourceChannel = node.querySelector(".source-video-channel");
      const sourceVideoTitle = node.querySelector(".source-video-title");
      const sourceMoreTimes = node.querySelector(".source-time-extra-toggle");
      const copyButtons = Array.from(node.querySelectorAll(".source-copy")).map(rectFor);
      const timeLinks = Array.from(node.querySelectorAll(".source-time-primary, .source-time-extra")).map(rectFor);
      return {
        title: title ? rectFor(title) : null,
        sourceTime: sourceTime ? rectFor(sourceTime) : null,
        sourceChannel: sourceChannel ? rectFor(sourceChannel) : null,
        sourceVideoTitle: sourceVideoTitle ? rectFor(sourceVideoTitle) : null,
        sourceMoreTimes: sourceMoreTimes ? rectFor(sourceMoreTimes) : null,
        drawer: drawer ? rectFor(drawer) : null,
        firstGroup: firstGroup ? rectFor(firstGroup) : null,
        copyButtons,
        timeLinks,
        sourceLinkButtonCount: node.querySelectorAll("[data-copy-song-links]").length,
      };
    });
    if (!expandedGeometry.title || !expandedGeometry.sourceTime || !expandedGeometry.sourceChannel || !expandedGeometry.sourceVideoTitle || !expandedGeometry.drawer || !expandedGeometry.firstGroup) {
      throw new Error(`expanded source geometry missing ${JSON.stringify(expandedGeometry)}`);
    }
    assertClose(expandedGeometry.sourceVideoTitle.left, expandedGeometry.sourceTime.left, 3, "source time aligns with source title", expandedGeometry);
    if (expandedGeometry.sourceChannel.left <= expandedGeometry.sourceTime.right) {
      throw new Error(`source channel should sit after primary timestamp ${JSON.stringify(expandedGeometry)}`);
    }
    if (expandedGeometry.drawer.rowGap !== "0px") throw new Error(`mobile source drawer should have no grid row gap ${JSON.stringify(expandedGeometry)}`);
    assertClose(expandedGeometry.firstGroup.paddingTop, 8, 1, "source group top padding", expandedGeometry);
    assertClose(expandedGeometry.firstGroup.paddingBottom, 8, 1, "source group bottom padding", expandedGeometry);
    if (!expandedGeometry.copyButtons.length || expandedGeometry.copyButtons.some((button) => button.height < 36)) {
      throw new Error(`source copy button height invalid ${JSON.stringify(expandedGeometry)}`);
    }
    if (expandedGeometry.sourceLinkButtonCount !== 1) throw new Error(`copy same-song links button should render once ${JSON.stringify(expandedGeometry)}`);
    if (!expandedGeometry.timeLinks.length || expandedGeometry.timeLinks.some((link) => link.height < 32)) {
      throw new Error(`source timestamp hit area invalid ${JSON.stringify(expandedGeometry)}`);
    }
    if (expandedGeometry.sourceMoreTimes && expandedGeometry.sourceMoreTimes.height < 32) {
      throw new Error(`source extra timestamp toggle hit area invalid ${JSON.stringify(expandedGeometry)}`);
    }

    let expandedScreenshotPath = null;
    if (viewport[0] === 390) {
      expandedScreenshotPath = shotPath(`rank-expanded-trend-${viewport.join("x")}.png`);
      await page.screenshot({ path: expandedScreenshotPath, fullPage: false });
    }

    const unhandled = await page.evaluate(() => window.__unhandledRejection || "");
    await context.close();
    if (errors.length || unhandled) throw new Error(`mobile rank visual geometry errors: ${errors.join(" | ")} ${unhandled}`);
    results.push({ scenario: `mobile-rank-geometry-${viewport.join("x")}`, requests: [...new Set(requests)], expandedScreenshotPath });
  }
}

async function mobileCopyAllLinksFlow(browser) {
  for (const viewport of [
    [390, 844],
    [1440, 900],
  ]) {
    const { context, page, errors } = await newPage(browser, viewport);
    await page.addInitScript(() => {
      window.__clipboardWrites = [];
      const clipboard = {
        writeText: async (text) => {
          window.__clipboardWrites.push(String(text));
        },
      };
      try {
        Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
      } catch {
        navigator.clipboard = clipboard;
      }
    });
    const requests = [];
    page.on("request", (request) => requests.push(requestPath(request.url())));
    const url = new URL(baseUrl);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("showUnknown", "1");
    await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
    await waitForRows(page, errors, requests);

    const row = page.locator(".rank-row:not(.skeleton-row):has([data-toggle-source])").first();
    if ((await row.count()) !== 1) throw new Error("no expandable row for copy all links flow");
    await row.locator("[data-toggle-source]").first().click();
    await page.waitForSelector(".rank-row.is-expanded .source-drawer:not([hidden]) [data-copy-song-links]", { timeout: 15000 });
    const copyAllButtons = await row.locator("[data-copy-song-links]").count();
    if (copyAllButtons !== 1) throw new Error(`copy all links button should appear once, got ${copyAllButtons}`);

    const totalSources = await row.locator(".source-drawer-count").first().textContent();
    const expectedCount = sourceCountFromText(totalSources || "");
    await row.locator("[data-copy-song-links]").first().click();
    await page.waitForFunction(() => (window.__clipboardWrites || []).length > 0, null, { timeout: 5000 });

    const copyResult = await page.evaluate(() => {
      const text = window.__clipboardWrites[0] || "";
      const lines = text ? text.split("\n") : [];
      const videoIds = lines.map((line) => {
        const match = line.match(/https:\/\/www\.youtube\.com\/watch\?v=([^&\s]+)&t=(\d+)s/u);
        return match?.[1] || "";
      });
      const invalidLines = lines.filter((line) => {
        const urlIndex = line.lastIndexOf(" https://www.youtube.com/watch?v=");
        const channel = urlIndex >= 0 ? line.slice(0, urlIndex) : "";
        const url = urlIndex >= 0 ? line.slice(urlIndex + 1) : "";
        return !channel || !/^https:\/\/www\.youtube\.com\/watch\?v=[^&\s]+&t=\d+s$/u.test(url);
      });
      return {
        text,
        lines,
        videoIds,
        invalidLines,
        duplicateVideoIds: videoIds.filter((id, index) => id && videoIds.indexOf(id) !== index),
        missingTimestamp: lines.some((line) => !/[?&]t=\d+s$/u.test(line)),
        hasMarkdown: /\[[^\]]+\]\(|^[-*]\s|^\d+\./um.test(text),
        toast: document.querySelector("#toast")?.textContent || "",
      };
    });
    if (!expectedCount || copyResult.lines.length !== expectedCount) {
      throw new Error(`copy all links line count mismatch expected=${expectedCount} ${JSON.stringify(copyResult)}`);
    }
    if (copyResult.invalidLines.length || copyResult.duplicateVideoIds.length || copyResult.missingTimestamp || copyResult.hasMarkdown) {
      throw new Error(`copy all links format invalid ${JSON.stringify(copyResult)}`);
    }
    if (copyResult.toast !== `已复制 ${expectedCount} 个来源链接`) {
      throw new Error(`copy all links toast invalid ${JSON.stringify(copyResult)}`);
    }

    await row.locator("[data-copy-setlist]").first().click();
    await page.waitForFunction(() => (window.__clipboardWrites || []).length > 1, null, { timeout: 5000 });
    const setlistCopied = await page.evaluate(() => (window.__clipboardWrites[1] || "").split("\n").filter(Boolean).length);
    if (!setlistCopied) throw new Error("copy setlist did not write clipboard text");

    let screenshotPath = null;
    if (viewport[0] === 390) {
      screenshotPath = shotPath(`source-drawer-toolbar-${viewport.join("x")}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });
    }
    const unhandled = await page.evaluate(() => window.__unhandledRejection || "");
    await context.close();
    if (errors.length || unhandled) throw new Error(`copy all links flow errors: ${errors.join(" | ")} ${unhandled}`);
    results.push({ scenario: `copy-all-links-${viewport.join("x")}`, requests: [...new Set(requests)], screenshotPath });
  }
}

async function compactSourceDrawerFlow(browser) {
  for (const scenario of [
    { label: "mobile", viewport: [390, 844], initial: 3 },
    { label: "tablet", viewport: [768, 1024], initial: 6 },
  ]) {
    const viewport = scenario.viewport;
    const { context, page, errors } = await newPage(browser, viewport);
    const requests = [];
    page.on("request", (request) => requests.push(requestPath(request.url())));
    const url = new URL(baseUrl);
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("showUnknown", "1");
    await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
    await waitForRows(page, errors, requests);
    await page.waitForLoadState("networkidle", { timeout: baseUrl.startsWith("https://") ? 10000 : 3000 }).catch(() => {});
    await page.waitForTimeout(baseUrl.startsWith("https://") ? 500 : 100);

    const sourceRows = page.locator(".rank-row:not(.skeleton-row):has([data-toggle-source])");
    const count = await sourceRows.count();
    if (count < 1) throw new Error("no expandable rank rows found for compact source drawer");

    const selectedIndex = 0;
    const row = sourceRows.first();
    const button = row.locator("[data-toggle-source]").first();
    const beforeExpanded = await button.getAttribute("aria-expanded");
    if (beforeExpanded !== "false") throw new Error(`first source toggle initial aria-expanded expected false, got ${beforeExpanded}`);
    await button.click();

    await page.waitForSelector(
      ".rank-row.is-expanded .source-drawer:not([hidden]) .source-video-group, .rank-row.is-expanded .source-drawer:not([hidden]) .source-link",
      { timeout: 15000 },
    );
    const afterExpanded = await button.getAttribute("aria-expanded");
    if (afterExpanded !== "true") throw new Error(`source toggle opened aria-expanded expected true, got ${afterExpanded}`);
    if ((await page.locator(".rank-row.is-expanded, .index-row.is-expanded").count()) !== 1) {
      throw new Error(`${scenario.label} source drawer should keep exactly one row expanded`);
    }
    if ((await row.locator("[data-toggle-source-groups]").count()) < 1) throw new Error("first rank row should expose batched source groups");
    if ((await countVisibleInRow(row, ".source-video-group")) !== scenario.initial) {
      throw new Error(`${scenario.label} source drawer should start with exactly ${scenario.initial} visible source video groups when more are available`);
    }

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
          borderLeftColor: style.borderLeftColor,
          borderRight: Number.parseFloat(style.borderRightWidth) || 0,
        },
        drawer: drawer ? rectFor(drawer) : null,
        content: content ? rectFor(content) : null,
        rank: rank ? rectFor(rank) : null,
        count: countNode ? rectFor(countNode) : null,
        sourceGroups,
      };
    });
    if (!geometry.drawer) throw new Error(`${scenario.label} source drawer missing ${JSON.stringify(geometry)}`);
    if (geometry.scrollWidth > geometry.viewportWidth + 1) throw new Error(`${scenario.label} source drawer caused horizontal overflow ${JSON.stringify(geometry)}`);
    if (geometry.rowBox.borderLeft > 0 && !/rgba\(0,\s*0,\s*0,\s*0\)|transparent/u.test(geometry.rowBox.borderLeftColor)) {
      throw new Error(`top rank accent line should not continue through compact drawer ${JSON.stringify(geometry)}`);
    }
    const expectedLeft = geometry.row.left + geometry.rowBox.borderLeft + geometry.rowBox.paddingLeft;
    const expectedWidth = geometry.row.width - geometry.rowBox.borderLeft - geometry.rowBox.borderRight - geometry.rowBox.paddingLeft - geometry.rowBox.paddingRight;
    if (Math.abs(geometry.drawer.left - expectedLeft) > 3) {
      throw new Error(`${scenario.label} source drawer left offset invalid ${JSON.stringify(geometry)}`);
    }
    if (Math.abs(geometry.drawer.width - expectedWidth) > 4) {
      throw new Error(`${scenario.label} source drawer width invalid ${JSON.stringify(geometry)}`);
    }
    if (geometry.content && geometry.drawer.top - geometry.content.bottom > 18) {
      throw new Error(`${scenario.label} source drawer has excessive blank gap ${JSON.stringify(geometry)}`);
    }
    if (geometry.sourceGroups.some((group) => group.width > geometry.drawer.width + 1 || group.left < geometry.drawer.left - 1 || group.right > geometry.drawer.right + 1)) {
      throw new Error(`${scenario.label} source group shifted out of drawer ${JSON.stringify(geometry)}`);
    }

    const sourceSemantics = await row.evaluate((node) => {
      const title = node.querySelector(".source-video-title");
      const timeLinks = Array.from(node.querySelectorAll(".source-time-primary, .source-time-extra"));
      return {
        titleHref: title?.href || "",
        titleText: title?.textContent?.trim() || "",
        titleHeight: title?.getBoundingClientRect().height || 0,
        copiedButtons: node.querySelectorAll(".source-copy").length,
        copySongLinkButtons: node.querySelectorAll("[data-copy-song-links]").length,
        openVideoActions: Array.from(node.querySelectorAll(".source-action")).filter((action) => action.textContent.trim() === "打开视频").length,
        badTimeText: timeLinks.map((link) => link.textContent.trim()).filter((text) => !/^\d{1,2}:\d{2}(?::\d{2})?$/u.test(text)),
        missingTimeAria: timeLinks.filter((link) => !/打开时间戳：.+\d{1,2}:\d{2}/u.test(link.getAttribute("aria-label") || "")).length,
        oldTimestampSpans: node.querySelectorAll(".source-time-link .source-song, .source-time-link .source-artist").length,
      };
    });
    if (!sourceSemantics.titleHref || !/youtube\.com\/watch\?v=.+[?&]t=\d+s/u.test(sourceSemantics.titleHref)) {
      throw new Error(`source video title should link to the selected timestamp ${JSON.stringify(sourceSemantics)}`);
    }
    if (!sourceSemantics.copiedButtons) throw new Error(`source drawer missing compact copy setlist button ${JSON.stringify(sourceSemantics)}`);
    if (sourceSemantics.copySongLinkButtons !== 1) throw new Error(`source drawer should render one same-song source link copy button ${JSON.stringify(sourceSemantics)}`);
    if (sourceSemantics.openVideoActions) throw new Error(`compact source drawer still renders large open video action ${JSON.stringify(sourceSemantics)}`);
    if (sourceSemantics.badTimeText.length || sourceSemantics.missingTimeAria || sourceSemantics.oldTimestampSpans) {
      throw new Error(`source timestamp labels should only show time while aria keeps context ${JSON.stringify(sourceSemantics)}`);
    }
    if (sourceSemantics.titleHeight > 44) throw new Error(`source video title exceeds compact two-line height ${JSON.stringify(sourceSemantics)}`);

    let expectedReopenGroupCount = null;
    let preservedFirstGroupText = "";
    const moreGroups = row.locator("[data-toggle-source-groups]");
    if ((await moreGroups.count()) > 0) {
      const beforeGroupCount = await countVisibleInRow(row, ".source-video-group");
      const moreText = (await moreGroups.first().textContent()) || "";
      if (!/查看更多来源（剩余 \d+）/u.test(moreText)) throw new Error(`source group expander text invalid: ${moreText}`);
      const remainingMatch = moreText.match(/剩余\s*(\d+)/u);
      const expectedTotal = remainingMatch ? beforeGroupCount + Number.parseInt(remainingMatch[1], 10) : sourceCountFromText(moreText);
      let expandedTimestampBeforeMore = false;
      const firstTimestampToggle = row.locator('[data-toggle-source-times][aria-expanded="false"]').first();
      if ((await firstTimestampToggle.count()) > 0) {
        await firstTimestampToggle.click();
        const expandedState = await firstTimestampToggle.getAttribute("aria-expanded");
        if (expandedState !== "true") throw new Error(`source timestamp toggle did not expand before loading all groups: ${expandedState}`);
        await firstTimestampToggle.evaluate((node) => {
          node.dataset.codexPreserveTimeToggle = "1";
        });
        expandedTimestampBeforeMore = true;
      }
      preservedFirstGroupText = await row.locator(".source-video-group").first().evaluate((node) => {
        node.dataset.codexPreserve = "1";
        const image = node.querySelector("img");
        if (image) image.dataset.codexPreserve = "1";
        return node.textContent || "";
      });
      await moreGroups.first().click();
      const afterGroupCount = await waitForVisibleCountAbove(row, ".source-video-group", beforeGroupCount);
      if (afterGroupCount <= beforeGroupCount) throw new Error("source group expander did not add visible groups");
      if (expectedTotal && afterGroupCount !== expectedTotal) {
        throw new Error(`${scenario.label} source group expander should reveal all remaining groups: before=${beforeGroupCount} after=${afterGroupCount} total=${expectedTotal}`);
      }
      if ((await moreGroups.count()) !== 0) throw new Error(`${scenario.label} source group expander should be removed after revealing all sources`);
      const preservedAfter = await row.locator(".source-video-group").first().evaluate((node) => ({
        preserved: node.dataset.codexPreserve === "1",
        imagePreserved: node.querySelector("img")?.dataset.codexPreserve === "1",
        text: node.textContent || "",
        preservedExpandedTimeButtons: Array.from(node.querySelectorAll("[data-toggle-source-times]")).filter(
          (button) => button.dataset.codexPreserveTimeToggle === "1" && button.getAttribute("aria-expanded") === "true",
        ).length,
      }));
      if (!preservedAfter.preserved || !preservedAfter.imagePreserved || preservedAfter.text !== preservedFirstGroupText) {
        throw new Error(`${scenario.label} source group expander rebuilt existing cards ${JSON.stringify(preservedAfter)}`);
      }
      if (expandedTimestampBeforeMore && preservedAfter.preservedExpandedTimeButtons < 1) {
        throw new Error(`${scenario.label} source group expander did not preserve expanded timestamp state ${JSON.stringify(preservedAfter)}`);
      }
      expectedReopenGroupCount = afterGroupCount;
    }

    const moreTimes = row.locator('[data-toggle-source-times][aria-expanded="false"]');
    if ((await moreTimes.count()) > 0) {
      const beforeVisibleTimes = await countVisibleInRow(row, ".source-time-primary, .source-time-extra");
      await moreTimes.first().click();
      const afterVisibleTimes = await waitForVisibleCountAbove(row, ".source-time-primary, .source-time-extra", beforeVisibleTimes);
      if (afterVisibleTimes <= beforeVisibleTimes) throw new Error("source timestamp expander did not add visible timestamps");
    }

    const bottomScreenshotPath = shotPath(`source-drawer-bottom-${viewport.join("x")}.png`);
    const collapseBottom = row.locator("[data-collapse-source]");
    if ((await collapseBottom.count()) !== 1) throw new Error(`${scenario.label} source drawer should have exactly one bottom collapse button`);
    await retryDetachedAction(() => collapseBottom.scrollIntoViewIfNeeded(), "scroll bottom source collapse");
    const bottomCoverage = await page.evaluate(() => {
      const collapse = document.querySelector(".rank-row.is-expanded [data-collapse-source]");
      const nav = document.querySelector("#mobileBottomNav");
      const collapseBox = collapse?.getBoundingClientRect();
      const navBox = nav?.getBoundingClientRect();
      return {
        collapseBottom: collapseBox?.bottom || 0,
        navTop: navBox?.top || window.innerHeight,
        collapseHeight: collapseBox?.height || 0,
      };
    });
    if (bottomCoverage.collapseHeight > 0 && bottomCoverage.collapseBottom > bottomCoverage.navTop - 4) {
      throw new Error(`source bottom collapse is covered by mobile nav ${JSON.stringify(bottomCoverage)}`);
    }
    await page.screenshot({ path: bottomScreenshotPath, fullPage: false });
    await retryDetachedAction(() => collapseBottom.click(), "click bottom source collapse");
    await page.waitForFunction(
      (index) => document.querySelectorAll(".rank-row:not(.skeleton-row):has([data-toggle-source])")[index]?.classList.contains("is-expanded") === false,
      selectedIndex,
    );
    const closedExpanded = await button.getAttribute("aria-expanded");
    if (closedExpanded !== "false") throw new Error(`source bottom collapse aria-expanded expected false, got ${closedExpanded}`);
    if ((await page.locator(".rank-row.is-expanded, .index-row.is-expanded").count()) !== 0) throw new Error("source bottom collapse left an expanded row");

    const screenshotPath = shotPath(`source-drawer-${viewport.join("x")}.png`);
    await button.click();
    await page.waitForSelector(".rank-row.is-expanded .source-drawer:not([hidden])", { timeout: 15000 });
    if (expectedReopenGroupCount) {
      const reopenedGroupCount = await countVisibleInRow(row, ".source-video-group");
      if (reopenedGroupCount !== expectedReopenGroupCount) {
        throw new Error(`${scenario.label} source drawer reopen lost expanded source groups: before=${expectedReopenGroupCount} after=${reopenedGroupCount}`);
      }
      const preservedAfterReopen = await row.locator(".source-video-group").first().evaluate((node) => ({
        preserved: node.dataset.codexPreserve === "1",
        imagePreserved: node.querySelector("img")?.dataset.codexPreserve === "1",
        text: node.textContent || "",
      }));
      if (!preservedAfterReopen.preserved || !preservedAfterReopen.imagePreserved || preservedAfterReopen.text !== preservedFirstGroupText) {
        throw new Error(`${scenario.label} source drawer reopen rebuilt existing source cards ${JSON.stringify(preservedAfterReopen)}`);
      }
    }
    await page.screenshot({ path: screenshotPath, fullPage: false });
    if (count > 1) {
      const otherIndex = selectedIndex === 0 ? 1 : 0;
      const otherRow = sourceRows.nth(otherIndex);
      await otherRow.locator("[data-toggle-source]").first().click();
      await page.waitForSelector(".rank-row.is-expanded .source-drawer:not([hidden])", { timeout: 15000 });
      const expandedCount = await page.locator(".rank-row.is-expanded, .index-row.is-expanded").count();
      if (expandedCount !== 1) throw new Error(`${scenario.label} opening another row should leave one expanded row, got ${expandedCount}`);
      const firstStillExpanded = await row.evaluate((node) => node.classList.contains("is-expanded"));
      if (firstStillExpanded) throw new Error(`${scenario.label} opening another row did not collapse the previous source drawer`);
    }
    const unhandled = await page.evaluate(() => window.__unhandledRejection || "");
    await context.close();
    if (errors.length || unhandled) throw new Error(`${scenario.label} source drawer errors: ${errors.join(" | ")} ${unhandled}`);
    results.push({ scenario: `${scenario.label}-source-drawer-${viewport.join("x")}`, requests: [...new Set(requests)], screenshotPath, bottomScreenshotPath });
  }
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

function sourceCountFromText(text) {
  const value = String(text || "");
  const progress = value.match(/\/(\d+)\s*个来源/u);
  if (progress) return Number.parseInt(progress[1], 10);
  const total = value.match(/(\d+)\s*个来源/u);
  return total ? Number.parseInt(total[1], 10) : 0;
}

async function selectSnapshotDate(page, value) {
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await page.waitForFunction(() => document.querySelector("#snapshotDateSelect")?.disabled === false, null, { timeout: verifyTimeout(30000, 120000) });
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

function mockLegacyMonthlyFallbackGroup() {
  return {
    id: "1m",
    title: "Mock monthly fallback",
    generatedAt: "2026-07-13T15:56:10.026Z",
    updatedAt: "2026-07-13T15:56:10.026Z",
    items: [
      {
        videoId: "codexFall01",
        title: "Fallback source video",
        channelName: "Fallback Channel",
        channelId: "UCfallback",
        publishedTimestamp: Date.parse("2026-07-13T15:00:00.000Z"),
        songs: [
          {
            index: 1,
            time: "0:01:23",
            seconds: 83,
            title: "Fallback Song",
            artist: "Fallback Artist",
            raw: "1:23 Fallback Song / Fallback Artist",
            isNiche: false,
          },
        ],
      },
    ],
  };
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
    const requests = [];
    page.on("request", (request) => requests.push(requestPath(request.url())));
    await page.route("**/*", async (route) => {
      const pathName = requestPath(route.request().url());
      if (runtimePathPattern("1m").test(pathName)) {
        await scenario.handler(route);
        return;
      }
      if (pathName === "data/1m.json") {
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(mockLegacyMonthlyFallbackGroup()),
        });
        return;
      }
      await route.continue();
    });
    await page.goto(`${baseUrl}?shared=1&range=1m&debug=1`, { waitUntil: "domcontentloaded" });
    await waitForRows(page, errors, requests);
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
    results.push({ scenario: `fallback-${scenario.label}`, requests: [...new Set(requests)] });
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
  const screenshotPath = shotPath(`review-404-${viewport.join("x")}.png`);
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
    await desktopRankVisualGeometry(browser);
    await interactionFlow(browser);
    await mobileFilterSheetFlow(browser);
    await mobileRankVisualGeometry(browser);
    await mobileCopyAllLinksFlow(browser);
    await compactSourceDrawerFlow(browser);
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
