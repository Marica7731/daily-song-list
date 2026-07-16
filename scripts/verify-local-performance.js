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

function isIgnorableHttpResponse(response) {
  if (response.status() !== 404) return false;
  try {
    const url = new URL(response.url());
    return url.hostname === "i.ytimg.com";
  } catch {
    return false;
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
    const text = msg.text();
    if (msg.type() === "error" && !text.startsWith("Failed to load resource:")) errors.push(text);
  });
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400 && !isIgnorableHttpResponse(response)) errors.push(`HTTP ${response.status()} ${response.url()}`);
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText || "";
    if (failure === "net::ERR_ABORTED") return;
    errors.push(`request failed ${request.url()} ${failure}`);
  });
  await page.addInitScript(() => {
    window.__longTasks = [];
    window.addEventListener("unhandledrejection", (event) => {
      window.__unhandledRejection = String(event.reason && (event.reason.message || event.reason));
    });
    try {
      new PerformanceObserver((list) => {
        window.__longTasks.push(...list.getEntries().map((entry) => ({ name: entry.name, startTime: entry.startTime, duration: entry.duration })));
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
  await page.locator("#queryTrigger").click();
  await page.waitForSelector("#queryDialog:not([hidden])", { timeout: baseUrl.startsWith("https://") ? 15000 : 5000 });
  await page.locator('[data-query-panel-tab="filter"]').click({ force: true });
  await page.waitForSelector("#queryFilterPanel:not([hidden])", { timeout: baseUrl.startsWith("https://") ? 15000 : 5000 });
  await page.waitForTimeout(baseUrl.startsWith("https://") ? 100 : 50);
}

async function openMobileFilterSheet(page) {
  await page.locator("#queryTrigger").click();
  await page.waitForSelector("#queryDialog:not([hidden])", { timeout: baseUrl.startsWith("https://") ? 15000 : 5000 });
  await page.locator('[data-query-panel-tab="filter"]').click({ force: true });
  await page.waitForSelector("#queryFilterPanel:not([hidden])", { timeout: baseUrl.startsWith("https://") ? 15000 : 5000 });
  await page.waitForTimeout(baseUrl.startsWith("https://") ? 100 : 50);
}

async function openSnapshotFilters(page) {
  if ((await page.locator("#queryDialog:not([hidden])").count()) === 0) {
    await openFilterSheet(page);
  } else if ((await page.locator("#queryFilterPanel:not([hidden])").count()) === 0) {
    await page.locator('[data-query-panel-tab="filter"]').click({ force: true });
    await page.waitForSelector("#queryFilterPanel:not([hidden])", { timeout: baseUrl.startsWith("https://") ? 15000 : 5000 });
  }
  await page.locator(".query-history-section").evaluate((section) => {
    section.open = true;
  });
  await page.waitForSelector(".query-history-section[open] #querySnapshotDateSelect", {
    timeout: baseUrl.startsWith("https://") ? 15000 : 5000,
  });
}

async function setCheckbox(page, selector, checked) {
  const checkbox = page.locator(selector);
  await checkbox.waitFor({ state: "attached", timeout: baseUrl.startsWith("https://") ? 15000 : 5000 });
  if ((await checkbox.isChecked()) === checked) return;
  try {
    if (!(await checkbox.isVisible())) {
      await checkbox.evaluate((input) => input.closest("label")?.click());
    } else if (checked) {
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
    Array.from(document.querySelectorAll("#queryCountBadge")).map((node) => ({
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
    const searchField = rect(".search-field");
    const bottomNav = rect("#mobileBottomNav");
    const summary = rect("#summary");
    const summaryStatus = rect("#summary .summary-status");
    const summaryRange = rect("#summary .summary-range");
    const topPagination = rect(".pagination-top");
    const topSelect = rect(".pagination-top .page-select");
    const topPageSize = rect(".pagination-top .page-size-control");
    const topControls = Array.from(document.querySelectorAll(".pagination-top .pagination-button")).map((node) => ({
      text: node.textContent || "",
      ariaLabel: node.getAttribute("aria-label") || "",
      className: node.className || "",
      width: node.getBoundingClientRect().width,
      height: node.getBoundingClientRect().height,
    }));
    const bottomSelect = rect(".pagination-bottom .page-select");
    const bottomControls = Array.from(document.querySelectorAll(".pagination-bottom .pagination-button")).map((node) => ({
      text: node.textContent || "",
      ariaLabel: node.getAttribute("aria-label") || "",
      svgCount: node.querySelectorAll("svg").length,
      width: node.getBoundingClientRect().width,
      height: node.getBoundingClientRect().height,
    }));
    const filterBadges = Array.from(document.querySelectorAll("#queryCountBadge")).map((node) => ({
      id: node.id,
      hidden: node.hidden,
      display: getComputedStyle(node).display,
      text: node.textContent || "",
    }));
    const queryTrigger = document.querySelector("#queryTrigger");
    const queryTriggerBox = queryTrigger ? queryTrigger.getBoundingClientRect() : null;
    const visibleTriggerChildren = queryTrigger
      ? Array.from(queryTrigger.children)
          .filter((node) => {
            const style = getComputedStyle(node);
            const box = node.getBoundingClientRect();
            return !node.hidden && style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
          })
          .map((node) => {
            const box = node.getBoundingClientRect();
            return {
              tagName: node.tagName,
              className: node.getAttribute("class") || "",
              text: node.textContent || "",
              left: box.left,
              right: box.right,
              top: box.top,
              bottom: box.bottom,
              width: box.width,
              height: box.height,
            };
          })
      : [];
    const queryTriggerShape = queryTrigger
      ? {
          width: queryTriggerBox.width,
          height: queryTriggerBox.height,
          left: queryTriggerBox.left,
          right: queryTriggerBox.right,
          top: queryTriggerBox.top,
          bottom: queryTriggerBox.bottom,
          ariaLabel: queryTrigger.getAttribute("aria-label") || "",
          visibleSvgCount: visibleTriggerChildren.filter((child) => child.tagName.toLowerCase() === "svg").length,
          visibleNumericBadgeCount: visibleTriggerChildren.filter((child) => /^\d+$/u.test(child.text.trim())).length,
          visibleChildren: visibleTriggerChildren,
          hasActiveClass: queryTrigger.classList.contains("has-active-query"),
        }
      : null;
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
      bodyText: document.body.innerText || "",
      topbarExists: Boolean(document.querySelector(".topbar, .topbar-inner, .brand")),
      controls,
      searchField,
      bottomNav,
      bottomItems,
      summary,
      summaryStatus,
      summaryRange,
      topPagination,
      topSelect,
      topPageSize,
      topControls,
      bottomSelect,
      bottomControls,
      filterBadges,
      queryTrigger: queryTriggerShape,
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
  if (result.topbarExists || /\bDaily Song List\b/u.test(result.bodyText)) {
    throw new Error(`legacy title row remains visible ${JSON.stringify({ topbarExists: result.topbarExists, bodyText: result.bodyText.slice(0, 160) })}`);
  }
  if (!result.summaryStatus || result.summaryStatus.display === "none") throw new Error(`summary status missing ${JSON.stringify(result.summary)}`);
  const overflowingSegment = result.segmentedControls.find((control) => control.scrollWidth > control.clientWidth + 1);
  if (overflowingSegment) throw new Error(`segmented control overflowed inside toolbar ${JSON.stringify(overflowingSegment)}`);
  if (result.shareButtonExists || result.copyLinkExists || result.visibleShareLabels.length) {
    throw new Error(`visible share/copy-current-link entry remains ${JSON.stringify(result)}`);
  }
  if (viewport[0] <= 720) {
    if (!result.controls || result.controls.height > 46) throw new Error(`mobile controls not one row ${JSON.stringify(result.controls)}`);
    if (result.summary && result.controls && result.summary.top - result.controls.bottom > 8) {
      throw new Error(`mobile controls left excessive whitespace before summary ${JSON.stringify({ controls: result.controls, summary: result.summary })}`);
    }
    if (!result.queryTrigger) throw new Error("mobile query trigger missing");
    if (result.queryTrigger.width < 34 || result.queryTrigger.width > 36 || result.queryTrigger.height < 34 || result.queryTrigger.height > 36) {
      throw new Error(`mobile query trigger geometry invalid ${JSON.stringify(result.queryTrigger)}`);
    }
    if (Math.abs(result.queryTrigger.width - result.queryTrigger.height) > 1) {
      throw new Error(`mobile query trigger should be square ${JSON.stringify(result.queryTrigger)}`);
    }
    if (result.queryTrigger.visibleSvgCount !== 1 || result.queryTrigger.visibleNumericBadgeCount !== 0) {
      throw new Error(`mobile query trigger should expose one icon and no visible number ${JSON.stringify(result.queryTrigger)}`);
    }
    if (
      result.queryTrigger.visibleChildren.some(
        (child) =>
          child.left < result.queryTrigger.left - 1 ||
          child.right > result.queryTrigger.right + 1 ||
          child.top < result.queryTrigger.top - 1 ||
          child.bottom > result.queryTrigger.bottom + 1,
      )
    ) {
      throw new Error(`mobile query trigger child escaped bounds ${JSON.stringify(result.queryTrigger)}`);
    }
    if (result.searchField && result.searchField.display !== "none") throw new Error("mobile search field is still resident in toolbar");
    if (!result.bottomNav || result.bottomNav.display === "none") throw new Error("mobile bottom nav missing");
    if (result.bottomItems.length !== 4 || result.bottomItems.some((item) => item.width < 60 || item.display === "none")) {
      throw new Error(`mobile bottom nav items invalid ${JSON.stringify(result.bottomItems)}`);
    }
    if (result.summaryRange && result.summaryRange.display !== "none") {
      throw new Error(`mobile summary repeats range: ${result.summary.text}`);
    }
    if (!result.topSelect || result.topPageSize) throw new Error(`mobile top pagination should expose page select without page size ${JSON.stringify(result)}`);
    if (result.topSelect.width > 88) throw new Error(`mobile top page select too wide ${JSON.stringify(result.topSelect)}`);
    if (result.topControls.some((control) => control.width > 30 || control.height > 30)) {
      throw new Error(`mobile top pagination buttons too large ${JSON.stringify(result.topControls)}`);
    }
    if (
      result.topControls.length &&
      (result.topControls[0].ariaLabel !== "上一页" ||
        result.topControls[result.topControls.length - 1].ariaLabel !== "下一页" ||
        result.topControls.some((control) => control.text.trim() === "…" || /向[前后]跳/u.test(control.ariaLabel)))
    ) {
      throw new Error(`mobile top pagination should use stepper controls without clickable ellipsis ${JSON.stringify(result.topControls)}`);
    }
    if (result.filterBadges.some((badge) => !badge.hidden || badge.display !== "none" || badge.text === "0")) {
      throw new Error(`inactive filter badge is visible ${JSON.stringify(result.filterBadges)}`);
    }
    if (result.rankCountStyle && !/rgba\(0,\s*0,\s*0,\s*0\)|transparent/u.test(result.rankCountStyle.backgroundColor)) {
      throw new Error(`mobile rank count should not use a filled pill ${JSON.stringify(result.rankCountStyle)}`);
    }
    if (result.topPagination && result.topPagination.height > 52) throw new Error(`mobile top pagination too tall ${result.topPagination.height}`);
    if (result.bottomControls.length >= 2) {
      const first = result.bottomControls[0];
      const last = result.bottomControls[result.bottomControls.length - 1];
      if (first.ariaLabel !== "首页" || last.ariaLabel !== "末页" || first.text.trim() || last.text.trim() || first.svgCount < 1 || last.svgCount < 1) {
        throw new Error(`mobile bottom pagination first/last should be icon buttons ${JSON.stringify(result.bottomControls)}`);
      }
    }
    if (!result.firstRow || result.firstRow.bottom > viewport[1]) throw new Error(`first mobile row is not visible ${JSON.stringify(result)}`);
    if (!result.firstTitle || result.firstTitle.top < (result.topPagination?.bottom || 0) - 1) {
      throw new Error(`first mobile title is covered ${JSON.stringify(result)}`);
    }
    if (result.firstTitle.fontSize < 14) throw new Error(`first mobile title font too small ${JSON.stringify(result.firstTitle)}`);
    if (result.firstButton && result.firstButton.height < 26) throw new Error(`mobile first action chip too small ${JSON.stringify(result.firstButton)}`);
    if (!result.secondRow || result.secondRow.top >= viewport[1]) throw new Error(`next mobile row entry is not visible ${JSON.stringify(result.secondRow)}`);
  } else if (viewport[0] <= 919) {
    if (result.topSelect || result.topPageSize) throw new Error(`tablet top pagination includes page select/page size ${JSON.stringify(result)}`);
    if (!result.firstRow || result.firstRow.bottom > viewport[1]) throw new Error(`first tablet row is not visible ${JSON.stringify(result)}`);
    if (!result.firstTitle || result.firstTitle.fontSize < 14) throw new Error(`first tablet title invalid ${JSON.stringify(result.firstTitle)}`);
  } else if (viewport[0] >= 1024) {
    if (result.topSelect || !result.bottomSelect) throw new Error(`desktop pagination scope invalid ${JSON.stringify(result)}`);
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
    await page.waitForSelector(".rank-side .trend-badge", { timeout: verifyTimeout(15000, 30000) });

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
        firstRow?.querySelector(".rank-side"),
      ].map((node) => (node ? rectFor(node) : null));
      const title = firstRow?.querySelector(".rank-title");
      const trendCounts = Array.from(document.querySelectorAll(".rank-row:not(.skeleton-row)")).slice(0, 40).map((row) => ({
        visibleBadges: Array.from(row.querySelectorAll(".trend-badge")).filter(visible).length,
        visibleInline: Array.from(row.querySelectorAll(".rank-trend-inline")).filter(visible).length,
        visibleDesktop: Array.from(row.querySelectorAll(".rank-side .trend-badge")).filter(visible).length,
      }));
      const trendTexts = Array.from(document.querySelectorAll(".rank-side .trend-badge"))
        .filter(visible)
        .map((node) => ({
          text: node.textContent.trim(),
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
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
        trendTexts,
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
    if (!geometry.trendCounts.some((row) => row.visibleDesktop > 0)) throw new Error("desktop side area did not render any trend badge");
    if (geometry.trendTexts.some((item) => !/^(新|升\d+|降\d+|增\d+|减\d+)$/u.test(item.text) || item.scrollWidth > item.clientWidth + 1)) {
      throw new Error(`desktop trend label invalid ${JSON.stringify(geometry.trendTexts.slice(0, 10))}`);
    }
    for (let index = 0; index < 3; index += 1) {
      const headerCell = geometry.headerCells[index];
      const rowCell = geometry.rowCells[index];
      if (!headerCell || !rowCell) throw new Error(`desktop rank columns missing ${JSON.stringify(geometry)}`);
      assertClose(headerCell.left, rowCell.left, 4, `desktop column ${index} left`, geometry);
      assertClose(headerCell.right, rowCell.right, 8, `desktop column ${index} right`, geometry);
    }
    if (geometry.controls.some((control) => control.height < 30 || control.height > 40)) {
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
        remainingCount: Number(node.querySelector("[data-toggle-source]")?.dataset.remainingCount || 0),
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
        toolbarCollapseButtons: node.querySelectorAll(".source-drawer-toolbar [data-collapse-source]").length,
        bottomCollapseButtons: node.querySelectorAll(".source-collapse-bottom[data-collapse-source]").length,
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
    if (!sourceGeometry.remainingCount || sourceGeometry.groups.length !== sourceGeometry.remainingCount) {
      throw new Error(`desktop source drawer should render all remaining sources on one click ${JSON.stringify(sourceGeometry)}`);
    }
    if (sourceGeometry.moreButtons) {
      throw new Error(`desktop source drawer should not expose a second source expander ${JSON.stringify(sourceGeometry)}`);
    }
    if (sourceGeometry.toolbarCollapseButtons !== 0) throw new Error(`desktop source drawer should not duplicate the inline collapse action ${JSON.stringify(sourceGeometry)}`);
    if (sourceGeometry.bottomCollapseButtons !== 0) throw new Error(`desktop source drawer should not render a mobile-only bottom collapse action ${JSON.stringify(sourceGeometry)}`);
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
      const footerHandle = await row.locator("[data-toggle-source-groups]").first().elementHandle();
      await row.locator("[data-toggle-source-groups]").first().evaluate((node) => {
        node.dataset.codexFooterPreserve = "1";
      });
      await row.locator("[data-toggle-source-groups]").first().click();
      const afterGroupCount = expectedTotal
        ? await waitForVisibleCountAtLeast(row, ".source-video-group", expectedTotal)
        : await waitForVisibleCountAbove(row, ".source-video-group", beforeGroupCount);
      if (afterGroupCount <= beforeGroupCount) throw new Error("desktop source group expander did not add visible groups");
      if (expectedTotal && afterGroupCount !== expectedTotal) {
        throw new Error(`desktop source group expander should reveal all remaining groups: before=${beforeGroupCount} after=${afterGroupCount} total=${expectedTotal}`);
      }
      if ((await row.locator("[data-toggle-source-groups]").count()) !== 0) throw new Error("desktop source group expander remained after revealing all sources");
      const footerAfter = footerHandle
        ? await footerHandle.evaluate((node) => ({
            preserved: node.dataset.codexFooterPreserve === "1",
            collapse: node.dataset.collapseSource === "true",
            text: node.textContent.trim(),
            connected: node.isConnected,
          }))
        : null;
      if (!footerAfter?.preserved || !footerAfter.collapse || footerAfter.text !== "收起" || !footerAfter.connected) {
        throw new Error(`desktop source group footer did not become collapse in place ${JSON.stringify(footerAfter)}`);
      }
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
  await openFilterSheet(page);
  await page.locator("#queryInput").fill("夜");
  const searchBeforeApply = await page.evaluate(() => window.location.search);
  if (new URLSearchParams(searchBeforeApply).has("q")) throw new Error(`query draft wrote q before apply: ${searchBeforeApply}`);
  await setCheckbox(page, "#nicheOnlyToggle", true);
  await page.locator("#applyQueryButton").click();
  await waitForRows(page, errors, requests);
  assertBadgesVisible(await readFilterBadgeState(page), "filtered");
  const activeConditions = await page.locator("#activeQueryStrip .active-query-chip").evaluateAll((items) => items.map((item) => item.textContent || ""));
  if (!activeConditions.some((text) => text.includes("夜")) || !activeConditions.some((text) => text.includes("只看小众"))) {
    throw new Error(`query strip did not expose search and niche filter: ${JSON.stringify(activeConditions)}`);
  }
  await openFilterSheet(page);
  const draftSearch = await page.locator("#queryInput").inputValue();
  if (draftSearch !== "夜") throw new Error(`query panel forgot applied search: ${draftSearch}`);
  await page.locator("#metricFilterGroup .query-segmented label").filter({ hasText: "按视频" }).click();
  await page.locator("#applyQueryButton").click();
  await waitForRows(page, errors, requests);
  await openFilterSheet(page);
  await page.locator("#queryInput").fill("");
  await setCheckbox(page, "#nicheOnlyToggle", false);
  await page.locator("#metricFilterGroup .query-segmented label").filter({ hasText: "按收录" }).click();
  await page.locator("#applyQueryButton").click();
  await waitForRows(page, errors, requests);
  assertBadgesHidden(await readFilterBadgeState(page), "reset");
  const searchAfterOrdinaryInteractions = await page.evaluate(() => window.location.search);
  const resetParams = new URLSearchParams(searchAfterOrdinaryInteractions);
  if (resetParams.has("q") || resetParams.has("outside") || resetParams.has("rankMetric")) {
    throw new Error(`reset query left active query params: ${searchAfterOrdinaryInteractions}`);
  }
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
    await openFilterSheet(page);
    await openSnapshotFilters(page);
    const dateOptions = await page
      .locator("#querySnapshotDateSelect option")
      .evaluateAll((items) => items.map((item) => item.value).filter((value) => value !== "latest"));
    if (!dateOptions.length) throw new Error("no historical snapshot dates");
    let options = [];
    for (const dateOption of dateOptions) {
      await selectSnapshotDate(page, dateOption);
      options = await page
        .locator("#querySnapshotSelect option")
        .evaluateAll((items) => items.map((item) => item.value).filter((value) => value !== "data/latest.json"));
      if (options.length) break;
    }
    if (!options.length) throw new Error("no historical snapshot options");
    await openSnapshotFilters(page);
    await page.waitForFunction(() => document.querySelector("#querySnapshotSelect")?.disabled === false, null, { timeout: verifyTimeout(30000, 120000) });
    await page.selectOption("#querySnapshotSelect", options[0]);
    await page.locator("#applyQueryButton").click();
    await waitForRows(page, errors, requests);
    const search = await page.evaluate(() => window.location.search);
    if (!new URLSearchParams(search).has("snapshot")) throw new Error(`snapshot apply did not write URL state: ${search}`);
  }
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  const unhandled = await page.evaluate(() => window.__unhandledRejection || "");
  const perf = await page.evaluate(() => window.printSongListPerformance());
  await context.close();
  if (!overflow) throw new Error("interaction viewport overflow");
  if (errors.length || unhandled) throw new Error(`interaction errors: ${errors.join(" | ")} ${unhandled}`);
  results.push({ scenario: latestOnly ? "interaction-flow-latest" : "interaction-flow", requests: [...new Set(requests)], measures: perf.measures });
}

async function measureQueryOpenLatency(browser) {
  const scenarios = [
    { label: "desktop", viewport: [1366, 768], visibleBudget: 100, focusBudget: 300, throttle: 1 },
    { label: "mobile", viewport: [390, 844], visibleBudget: 150, focusBudget: 300, throttle: 1 },
    { label: "mobile-4x", viewport: [390, 844], visibleBudget: 250, focusBudget: 300, throttle: 4 },
  ];
  for (const scenario of scenarios) {
    const { context, page, errors } = await newPage(browser, scenario.viewport);
    const requests = [];
    page.on("request", (request) => requests.push(requestPath(request.url())));
    let cdpSession = null;
    if (scenario.throttle > 1) {
      cdpSession = await context.newCDPSession(page);
      await cdpSession.send("Emulation.setCPUThrottlingRate", { rate: scenario.throttle });
    }
    await page.goto(`${baseUrl}?range=1m&pageSize=100`, { waitUntil: "domcontentloaded" });
    await waitForRows(page, errors, requests);
    await page.evaluate(() => {
      window.__queryPanelVisibleAt = 0;
      window.__queryInputFocusedAt = 0;
      window.__querySuggestionAt = 0;
      document.querySelector("#queryInput")?.addEventListener(
        "focus",
        () => {
          window.__queryInputFocusedAt = performance.now();
        },
        { once: true },
      );
    });
    const startedAt = await page.evaluate(() => performance.now());
    await page.locator("#queryTrigger").click();
    await page.waitForFunction(
      () => {
        const panel = document.querySelector("#queryDialog:not([hidden]) .query-panel");
        if (!panel) return false;
        const rect = panel.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        if (!window.__queryPanelVisibleAt) window.__queryPanelVisibleAt = performance.now();
        return true;
      },
      null,
      { timeout: 5000 },
    );
    await page.waitForFunction(() => document.activeElement?.id === "queryInput", null, { timeout: 5000 });
    await page.locator("#queryInput").fill("夜");
    await page.waitForFunction(
      () => {
        const visible = document.querySelector("#searchSuggestions .suggestion-item");
        if (!visible) return false;
        if (!window.__querySuggestionAt) window.__querySuggestionAt = performance.now();
        return true;
      },
      null,
      { timeout: 5000 },
    );
    const metrics = await page.evaluate((start) => {
      const longTasks = (window.__longTasks || []).filter((entry) => entry.startTime >= start);
      return {
        visibleMs: Math.round((window.__queryPanelVisibleAt - start) * 10) / 10,
        focusMs: Math.round((window.__queryInputFocusedAt - start) * 10) / 10,
        suggestionMs: Math.round((window.__querySuggestionAt - start) * 10) / 10,
        longTasks,
      };
    }, startedAt);
    const screenshotPath = shotPath(`query-open-${scenario.label}-${scenario.viewport.join("x")}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    if (cdpSession) await cdpSession.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
    const unhandled = await page.evaluate(() => window.__unhandledRejection || "");
    await context.close();
    const remoteAllowance = baseUrl.startsWith("https://") ? 150 : 0;
    if (metrics.visibleMs > scenario.visibleBudget + remoteAllowance) {
      throw new Error(`query panel visible latency exceeded ${scenario.label}: ${JSON.stringify(metrics)}`);
    }
    if (metrics.focusMs <= 0 || metrics.focusMs > scenario.focusBudget + remoteAllowance) {
      throw new Error(`query input focus latency exceeded ${scenario.label}: ${JSON.stringify(metrics)}`);
    }
    if (metrics.suggestionMs <= 0 || metrics.suggestionMs > 800 + remoteAllowance) {
      throw new Error(`query suggestion latency exceeded ${scenario.label}: ${JSON.stringify(metrics)}`);
    }
    if (metrics.longTasks.some((entry) => entry.duration > 100)) {
      throw new Error(`query open produced >100ms long task ${scenario.label}: ${JSON.stringify(metrics)}`);
    }
    if (errors.length || unhandled) throw new Error(`query open latency errors ${scenario.label}: ${errors.join(" | ")} ${unhandled}`);
    results.push({ scenario: `query-open-${scenario.label}`, requests: [...new Set(requests)], metrics, screenshotPath });
  }
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

    const topScreenshotPath = shotPath(`query-panel-top-${viewport.join("x")}.png`);
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
      const dialog = document.querySelector("#queryDialog");
      const sheet = document.querySelector("#queryDialog .query-panel");
      const toggles = ["#nicheOnlyToggle", "#hideUnknownToggle"].map((selector) => {
        const input = document.querySelector(selector);
        const label = input?.closest(".query-toggle");
        const text = label?.querySelector("span:not(.sr-only)");
        return {
          label: label ? rectFor(label) : null,
          input: input ? rectFor(input) : null,
          text: text ? rectFor(text) : null,
        };
      });
      const segmented = Array.from(document.querySelectorAll("#metricFilterGroup .query-segmented label")).map(rectFor);
      const selects = Array.from(document.querySelectorAll("#queryDialog select")).map(rectFor);
      const footerButtons = Array.from(document.querySelectorAll("#queryDialog .query-panel-footer button")).map(rectFor);
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
      throw new Error(`mobile query panel overflow ${JSON.stringify(topGeometry)}`);
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
      if (select.height < 36 || select.height > 38) throw new Error(`filter select height invalid ${JSON.stringify(topGeometry)}`);
    }
    const selectHeights = topGeometry.selects.map((item) => item.height);
    if (Math.max(...selectHeights) - Math.min(...selectHeights) > 1) throw new Error(`filter select heights differ ${JSON.stringify(topGeometry)}`);
    if (topGeometry.footerButtons.length !== 2) throw new Error(`filter footer buttons missing ${JSON.stringify(topGeometry)}`);
    const [resetButton, applyButton] = topGeometry.footerButtons;
    assertClose(resetButton.height, applyButton.height, 1, "filter footer button height", topGeometry);
    assertClose(resetButton.top, applyButton.top, 1, "filter footer button top", topGeometry);
    assertClose(resetButton.bottom, applyButton.bottom, 1, "filter footer button bottom", topGeometry);
    if (resetButton.width < 44 || applyButton.width < 44 || resetButton.right > applyButton.left) {
      throw new Error(`filter footer buttons overlap or undersize ${JSON.stringify(topGeometry)}`);
    }

    await page.locator("#queryDialog .query-panel-body").evaluate((body) => {
      body.scrollTop = body.scrollHeight;
    });
    await page.waitForTimeout(50);
    const bottomGeometry = await page.evaluate(() => {
      const rectFor = (node) => {
        const box = node.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, height: box.height };
      };
      const selects = Array.from(document.querySelectorAll("#queryDialog select"));
      const footer = document.querySelector("#queryDialog .query-panel-footer");
      return {
        lastSelect: selects.length ? rectFor(selects[selects.length - 1]) : null,
        footer: footer ? rectFor(footer) : null,
      };
    });
    if (!bottomGeometry.lastSelect || !bottomGeometry.footer) throw new Error(`filter bottom geometry missing ${JSON.stringify(bottomGeometry)}`);
    if (bottomGeometry.lastSelect.bottom > bottomGeometry.footer.top - 12) {
      throw new Error(`filter footer overlaps last select ${JSON.stringify(bottomGeometry)}`);
    }
    const bottomScreenshotPath = shotPath(`query-panel-bottom-${viewport.join("x")}.png`);
    await page.screenshot({ path: bottomScreenshotPath, fullPage: false });

    await page.locator("#cancelQueryButton").click();
    await page.locator("#queryDialog").waitFor({ state: "hidden", timeout: 5000 });
    const unhandled = await page.evaluate(() => window.__unhandledRejection || "");
    await context.close();
    if (errors.length || unhandled) throw new Error(`mobile query panel errors: ${errors.join(" | ")} ${unhandled}`);
    results.push({ scenario: `mobile-query-panel-${viewport.join("x")}`, requests: [...new Set(requests)], topScreenshotPath, bottomScreenshotPath });
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
      () => document.querySelector(".rank-row:not(.skeleton-row)") && document.querySelector(".rank-side"),
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
      const isVisible = (node) => {
        if (!node) return false;
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
      };
      const rows = Array.from(document.querySelectorAll(".rank-row:not(.skeleton-row)"));
      const trendRow =
        rows.find((row) => isVisible(row.querySelector(".rank-side .trend-badge")) && row.querySelector(".source-inline-more")) ||
        rows.find((row) => isVisible(row.querySelector(".rank-side .trend-badge"))) ||
        rows.find((row) => row.querySelector(".source-inline-more")) ||
        rows[0];
      const trend = trendRow?.querySelector(".rank-side .trend-badge");
      const content = trendRow?.querySelector(".rank-content");
      const button = trendRow?.querySelector(".source-inline-more");
      const rank = trendRow?.querySelector(".rank-number");
      const title = trendRow?.querySelector(".rank-title");
      const count = trendRow?.querySelector(".rank-count");
      const side = trendRow?.querySelector(".rank-side");
      const sideTop = trendRow?.querySelector(".rank-side-top");
      const sourceStrip = trendRow?.querySelector(".source-inline-strip");
      const sourceInlineItems = Array.from(trendRow?.querySelectorAll(".source-inline-item") || []).map((node) => {
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const channel = node.querySelector(".source-inline-channel");
        const channelBox = channel?.getBoundingClientRect();
        const channelStyle = channel ? getComputedStyle(channel) : null;
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
          display: style.display,
          visibility: style.visibility,
          text: node.textContent.trim(),
          channelText: channel?.textContent?.trim() || "",
          channelDisplay: channelStyle?.display || "",
          channelVisibility: channelStyle?.visibility || "",
          channelWidth: channelBox?.width || 0,
          channelHeight: channelBox?.height || 0,
        };
      });
      const sourceMoreButton = button
        ? {
            ...rectFor(button),
            flexGrow: getComputedStyle(button).flexGrow,
            maxWidth: getComputedStyle(button).maxWidth,
          }
        : null;
      const rowBox = trendRow ? rectFor(trendRow) : null;
      const subline = trendRow?.querySelector(".rank-subline");
      const metaLine = trendRow?.querySelector(".rank-meta-line");
      const sublineStyle = subline ? getComputedStyle(subline) : null;
      const allTrendTexts = Array.from(document.querySelectorAll(".trend-badge"))
        .filter(isVisible)
        .map((node) => ({ text: node.textContent.trim(), scrollWidth: node.scrollWidth, clientWidth: node.clientWidth }));
      return {
        viewportWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        rowText: trendRow?.textContent?.slice(0, 200) || "",
        row: rowBox,
        subline: subline ? { ...rectFor(subline), display: sublineStyle.display, overflowX: sublineStyle.overflowX } : null,
        metaLine: metaLine ? rectFor(metaLine) : null,
        side: side ? rectFor(side) : null,
        sideTop: sideTop ? rectFor(sideTop) : null,
        allTrendTexts,
        legacyTrendNodes: document.querySelectorAll(".rank-trend, .rank-trend-inline, .rank-actions-line").length,
        trend: isVisible(trend) ? rectFor(trend) : null,
        trendText: isVisible(trend) ? trend.textContent.trim() : "",
        trendScrollWidth: trend?.scrollWidth || 0,
        trendClientWidth: trend?.clientWidth || 0,
        content: content ? rectFor(content) : null,
        sourceStrip: sourceStrip ? rectFor(sourceStrip) : null,
        sourceStripScrollWidth: sourceStrip?.scrollWidth || 0,
        sourceStripClientWidth: sourceStrip?.clientWidth || 0,
        sourceVideoCount: Number(sourceStrip?.dataset.sourceVideoCount || 0),
        sourceInlineItems,
        button: button ? rectFor(button) : null,
        sourceMoreButton,
        buttonText: isVisible(button) ? button.textContent.trim() : "",
        rank: rank ? rectFor(rank) : null,
        title: title ? rectFor(title) : null,
        count: count ? rectFor(count) : null,
        countText: count?.textContent?.trim() || "",
      };
    });
    if (closedGeometry.scrollWidth > closedGeometry.viewportWidth + 1) throw new Error(`mobile rank overflow ${JSON.stringify(closedGeometry)}`);
    if (!closedGeometry.content) throw new Error(`mobile rank content geometry missing ${JSON.stringify(closedGeometry)}`);
    if (!closedGeometry.subline || closedGeometry.subline.display !== "flex") throw new Error(`mobile rank subline should be a single flex line ${JSON.stringify(closedGeometry)}`);
    if (!closedGeometry.metaLine || !closedGeometry.side || !closedGeometry.sideTop) throw new Error(`mobile rank pieces missing ${JSON.stringify(closedGeometry)}`);
    if (
      !closedGeometry.sourceStrip ||
      Math.abs(closedGeometry.sourceStrip.left - closedGeometry.content.left) > 2 ||
      Math.abs(closedGeometry.sourceStrip.right - closedGeometry.side.right) > 3 ||
      closedGeometry.sourceStrip.width < closedGeometry.content.width + closedGeometry.side.width * 0.75 ||
      closedGeometry.sourceStripScrollWidth > closedGeometry.sourceStripClientWidth + 1
    ) {
      throw new Error(`mobile inline source strip should span content and side columns ${JSON.stringify(closedGeometry)}`);
    }
    if (closedGeometry.sourceVideoCount > 3) {
      if (closedGeometry.sourceInlineItems.length !== 3) {
        throw new Error(`4+ source rows should render exactly three inline previews ${JSON.stringify(closedGeometry.sourceInlineItems)}`);
      }
      const invisibleSource = closedGeometry.sourceInlineItems.find(
        (item) =>
          item.display === "none" ||
          item.visibility === "hidden" ||
          item.width <= 0 ||
          item.height <= 0 ||
          !item.channelText ||
          item.channelDisplay === "none" ||
          item.channelVisibility === "hidden" ||
          item.channelWidth < (closedGeometry.viewportWidth <= 340 ? 18 : 28) ||
          item.channelHeight <= 0,
      );
      if (invisibleSource) {
        throw new Error(`inline source preview is visually hidden ${JSON.stringify({ invisibleSource, sourceInlineItems: closedGeometry.sourceInlineItems })}`);
      }
      if (
        !closedGeometry.sourceMoreButton ||
        closedGeometry.sourceMoreButton.width > closedGeometry.sourceStrip.width / 2 + 8 ||
        closedGeometry.sourceMoreButton.height > 30 ||
        closedGeometry.sourceMoreButton.flexGrow !== "0"
      ) {
        throw new Error(`source more button should stay in the fourth grid cell ${JSON.stringify(closedGeometry.sourceMoreButton)}`);
      }
    }
    if (closedGeometry.legacyTrendNodes) throw new Error(`legacy mobile trend nodes remain ${JSON.stringify(closedGeometry)}`);
    const compactRowHeightLimit = closedGeometry.sourceVideoCount > 3 ? 126 : 90;
    if (closedGeometry.row && closedGeometry.title?.height < 25 && closedGeometry.row.height > compactRowHeightLimit) {
      throw new Error(`single-line mobile rank row too tall ${JSON.stringify(closedGeometry)}`);
    }
    if (closedGeometry.allTrendTexts.some((item) => !/^(新|升\d+|降\d+|增\d+|减\d+)$/u.test(item.text) || item.scrollWidth > item.clientWidth + 1)) {
      throw new Error(`mobile trend label invalid ${JSON.stringify(closedGeometry.allTrendTexts.slice(0, 10))}`);
    }
    if (/^[+−+\-↑↓]$/u.test(closedGeometry.trendText) || /收录/u.test(closedGeometry.trendText)) {
      throw new Error(`compact trend should use semantic short labels ${JSON.stringify(closedGeometry)}`);
    }
    if (/^\d+(?:源|点|来源)$/u.test(closedGeometry.buttonText)) throw new Error(`compact source button should use complete Chinese units ${JSON.stringify(closedGeometry)}`);
    if (closedGeometry.trend) {
      if (!/^(新|升\d+|降\d+|增\d+|减\d+)$/u.test(closedGeometry.trendText)) throw new Error(`trend text invalid ${JSON.stringify(closedGeometry)}`);
      if (closedGeometry.trendScrollWidth > closedGeometry.trendClientWidth + 1) throw new Error(`trend badge clipped ${JSON.stringify(closedGeometry)}`);
      if (closedGeometry.trend.height > 22) throw new Error(`trend badge too tall ${JSON.stringify(closedGeometry)}`);
      assertClose(closedGeometry.trend.centerY, closedGeometry.count.centerY, 2, "count and trend center", closedGeometry);
    }
    if (closedGeometry.rank && closedGeometry.title && closedGeometry.rank.top > closedGeometry.title.top + 3) {
      throw new Error(`mobile rank marker should stay near the row top ${JSON.stringify(closedGeometry)}`);
    }
    if (closedGeometry.title && closedGeometry.count && closedGeometry.count.top > closedGeometry.title.top + 8) {
      throw new Error(`mobile count should stay in the right-side upper area ${JSON.stringify(closedGeometry)}`);
    }
    if (closedGeometry.count && closedGeometry.button && (closedGeometry.button.left < closedGeometry.content.left - 1 || closedGeometry.button.right > closedGeometry.side.right + 1)) {
      throw new Error(`mobile source more button should stay inside the source preview span ${JSON.stringify(closedGeometry)}`);
    }

    const expandableRows = page.locator(".rank-row:not(.skeleton-row):has([data-toggle-source])");
    if ((await expandableRows.count()) < 1) throw new Error("no expandable row for mobile rank visual geometry");
    const expandedRow = expandableRows.first();
    await expandedRow.locator("[data-toggle-source]").first().click();
    await page.waitForSelector(".rank-row.is-expanded .source-drawer:not([hidden]) .source-video-group", { timeout: 15000 });
    await page
      .waitForFunction(() => {
        const img = document.querySelector(".rank-row.is-expanded .source-video-thumb");
        return Boolean(img?.currentSrc || img?.src) && (img?.naturalWidth || 0) > 0;
      }, null, { timeout: 8000 })
      .catch(() => {});

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
      const sourceThumb = node.querySelector(".source-video-thumb-link");
      const sourceThumbImage = node.querySelector(".source-video-thumb");
      const sourceMoreTimes = node.querySelector(".source-time-extra-toggle");
      const copyButtons = Array.from(node.querySelectorAll(".source-copy")).map(rectFor);
      const timeLinks = Array.from(node.querySelectorAll(".source-time-primary, .source-time-extra")).map(rectFor);
      return {
        title: title ? rectFor(title) : null,
        sourceTime: sourceTime ? rectFor(sourceTime) : null,
        sourceChannel: sourceChannel ? rectFor(sourceChannel) : null,
        sourceVideoTitle: sourceVideoTitle ? rectFor(sourceVideoTitle) : null,
        sourceThumb: sourceThumb ? rectFor(sourceThumb) : null,
        sourceThumbImage: sourceThumbImage
          ? {
              ...rectFor(sourceThumbImage),
              currentSrc: sourceThumbImage.currentSrc || sourceThumbImage.src || "",
              naturalWidth: sourceThumbImage.naturalWidth || 0,
            }
          : null,
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
    if (!expandedGeometry.sourceThumb || expandedGeometry.sourceThumb.width < 50 || expandedGeometry.sourceThumb.height < 28) {
      throw new Error(`source thumbnail should be visible as a compact cover ${JSON.stringify(expandedGeometry)}`);
    }
    if (!expandedGeometry.sourceThumbImage?.currentSrc) {
      throw new Error(`source thumbnail image did not load ${JSON.stringify(expandedGeometry.sourceThumbImage)}`);
    }
    assertClose(expandedGeometry.sourceVideoTitle.left, expandedGeometry.sourceTime.left, 3, "source time aligns with source title", expandedGeometry);
    if (expandedGeometry.sourceChannel.left <= expandedGeometry.sourceTime.right) {
      throw new Error(`source channel should sit after primary timestamp ${JSON.stringify(expandedGeometry)}`);
    }
    if (expandedGeometry.drawer.rowGap !== "0px") throw new Error(`mobile source drawer should have no grid row gap ${JSON.stringify(expandedGeometry)}`);
    assertClose(expandedGeometry.firstGroup.paddingTop, 6, 1, "source group top padding", expandedGeometry);
    assertClose(expandedGeometry.firstGroup.paddingBottom, 6, 1, "source group bottom padding", expandedGeometry);
    if (!expandedGeometry.copyButtons.length || expandedGeometry.copyButtons.some((button) => button.height < 28 || button.width < 28 || button.width !== button.height)) {
      throw new Error(`source copy button height invalid ${JSON.stringify(expandedGeometry)}`);
    }
    if (expandedGeometry.sourceLinkButtonCount !== 1) throw new Error(`copy same-song links button should render once ${JSON.stringify(expandedGeometry)}`);
    if (!expandedGeometry.timeLinks.length || expandedGeometry.timeLinks.some((link) => link.height < 24 || link.height > 28)) {
      throw new Error(`source timestamp hit area invalid ${JSON.stringify(expandedGeometry)}`);
    }
    if (expandedGeometry.sourceMoreTimes && (expandedGeometry.sourceMoreTimes.height < 24 || expandedGeometry.sourceMoreTimes.height > 28)) {
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

    const expectedCount = Number.parseInt((await row.locator("[data-toggle-source]").first().getAttribute("data-video-count")) || "0", 10);
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

    const setlistButtonsShape = await page.evaluate(() =>
      Array.from(document.querySelectorAll("[data-copy-setlist]")).map((button) => {
        const box = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return {
          text: button.textContent.trim(),
          ariaLabel: button.getAttribute("aria-label") || "",
          title: button.getAttribute("title") || "",
          svgCount: button.querySelectorAll("svg").length,
          visible: !button.hidden && style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0,
          width: box.width,
          height: box.height,
        };
      }),
    );
    const invalidSetlistButton = setlistButtonsShape.find(
      (button) =>
        button.visible &&
        (button.text ||
          button.svgCount !== 1 ||
          !button.ariaLabel.startsWith("复制该视频歌单：") ||
          button.title !== "复制歌单" ||
          Math.abs(button.width - button.height) > 1 ||
          button.width < 26 ||
          button.width > (viewport[0] <= 720 ? 30 : 32)),
    );
    if (invalidSetlistButton) {
      throw new Error(`copy setlist icon button invalid ${JSON.stringify({ invalidSetlistButton, setlistButtonsShape: setlistButtonsShape.slice(0, 12) })}`);
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

    const singleSourcePage = await gotoFirstSingleSourcePage(page, errors, requests);
    const singleSourceRow = page.locator('.rank-row:not(.skeleton-row):has(.source-inline-strip[data-source-video-count="1"])').first();
    if ((await singleSourceRow.count()) !== 1) throw new Error(`single-source inline row not found after paging ${JSON.stringify(singleSourcePage)}`);
    const singleSourceShape = await singleSourceRow.evaluate((node) => ({
      copyButtons: node.querySelectorAll("[data-copy-song-links]").length,
      drawerButtons: node.querySelectorAll("[data-toggle-source]").length,
      drawers: node.querySelectorAll(".source-drawer").length,
      inlineItems: node.querySelectorAll(".source-inline-item").length,
      inlineTimes: node.querySelectorAll(".source-inline-time").length,
      inlineChannels: node.querySelectorAll(".source-inline-channel").length,
      setlistButtons: node.querySelectorAll(".source-inline-item [data-copy-setlist]").length,
      actionHeight: node.querySelector(".source-inline-item [data-copy-setlist]")?.getBoundingClientRect().height || 0,
    }));
    if (
      singleSourceShape.copyButtons !== 0 ||
      singleSourceShape.drawerButtons !== 0 ||
      singleSourceShape.drawers !== 0 ||
      singleSourceShape.inlineItems !== 1 ||
      singleSourceShape.inlineTimes !== 1 ||
      singleSourceShape.inlineChannels !== 1 ||
      singleSourceShape.setlistButtons !== 1
    ) {
      throw new Error(`single-source inline structure invalid ${JSON.stringify(singleSourceShape)}`);
    }
    if (singleSourceShape.actionHeight < 26 || singleSourceShape.actionHeight > 30) {
      throw new Error(`single-source inline copy size invalid ${JSON.stringify(singleSourceShape)}`);
    }
    const singleVisibleShape = await inlineSourceShape(singleSourceRow);
    if (
      singleVisibleShape.items.length !== 1 ||
      !singleVisibleShape.items[0]?.visible ||
      !singleVisibleShape.items[0]?.channel?.visible ||
      !singleVisibleShape.items[0]?.channel?.text ||
      !singleVisibleShape.items[0]?.timeVisible ||
      !singleVisibleShape.items[0]?.copyVisible
    ) {
      throw new Error(`single-source inline visibility invalid ${JSON.stringify(singleVisibleShape)}`);
    }

    let singleSourceScreenshotPath = null;
    if (viewport[0] === 390) {
      singleSourceScreenshotPath = shotPath(`single-source-inline-${viewport.join("x")}.png`);
      await page.screenshot({ path: singleSourceScreenshotPath, fullPage: false });
    }

    if (viewport[0] <= 720) {
      const tripleSourcePage = await gotoFirstSourceCasePage(page, errors, requests, "triple");
      if (!tripleSourcePage.page) throw new Error("triple-source inline row not found");
      const tripleRow = page.locator(".rank-row:not(.skeleton-row)").nth(tripleSourcePage.rowIndex);
      const tripleShape = await inlineSourceShape(tripleRow);
      if (
        tripleShape.sourceVideoCount !== 3 ||
        tripleShape.items.length !== 3 ||
        tripleShape.toggleCount !== 0 ||
        tripleShape.drawerCount !== 0 ||
        tripleShape.copyAllCount !== 1 ||
        tripleShape.items.some((item) => !item.visible || !item.channel?.visible || !item.channel.text)
      ) {
        throw new Error(`triple-source inline shape invalid ${JSON.stringify(tripleShape)}`);
      }

      const moreSourcePage = await gotoFirstSourceCasePage(page, errors, requests, "more");
      if (!moreSourcePage.page) throw new Error("4+ source inline row not found");
      const moreRow = page.locator(".rank-row:not(.skeleton-row)").nth(moreSourcePage.rowIndex);
      const moreShape = await inlineSourceShape(moreRow);
      if (
        moreShape.sourceVideoCount <= 3 ||
        moreShape.inlineVisibleCount !== 3 ||
        moreShape.items.length !== 3 ||
        moreShape.toggleCount !== 1 ||
        moreShape.copyAllCount !== 0 ||
        !moreShape.more?.visible ||
        moreShape.more.width > (moreShape.strip?.width || 0) / 2 + 8 ||
        moreShape.more.height > 30 ||
        moreShape.more.flexGrow !== "0" ||
        !moreShape.strip ||
        !moreShape.content ||
        !moreShape.side ||
        Math.abs(moreShape.strip.left - moreShape.content.left) > 2 ||
        Math.abs(moreShape.strip.right - moreShape.side.right) > 3 ||
        moreShape.items.some((item) => !item.visible || !item.channel?.visible || !item.channel.text)
      ) {
        throw new Error(`4+ source inline shape invalid ${JSON.stringify(moreShape)}`);
      }
    }

    const unhandled = await page.evaluate(() => window.__unhandledRejection || "");
    await context.close();
    if (errors.length || unhandled) throw new Error(`copy all links flow errors: ${errors.join(" | ")} ${unhandled}`);
    results.push({ scenario: `copy-all-links-${viewport.join("x")}`, requests: [...new Set(requests)], screenshotPath, singleSourceScreenshotPath });
  }
}

async function mobileVideoCardGeometry(browser) {
  for (const viewport of [
    [320, 700],
    [390, 844],
    [430, 932],
    [1366, 768],
  ]) {
    const { context, page, errors } = await newPage(browser, viewport);
    const requests = [];
    page.on("request", (request) => requests.push(requestPath(request.url())));
    const url = new URL(baseUrl);
    url.searchParams.set("view", "videos");
    url.searchParams.set("layout", "cards");
    url.searchParams.set("pageSize", "100");
    url.searchParams.set("showUnknown", "1");
    await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
    await waitForRows(page, errors, requests);
    await page.waitForSelector(".video-card .video-title", { timeout: verifyTimeout(15000, 30000) });

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
          display: style.display,
          gridColumn: style.gridColumn,
          fontSize: Number.parseFloat(style.fontSize) || 0,
        };
      };
      const visible = (node) => {
        if (!node) return false;
        const box = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return !node.hidden && style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
      };
      const card = document.querySelector(".video-card");
      const thumb = card?.querySelector(".thumb-link");
      const thumbImage = card?.querySelector(".thumb");
      const heading = card?.querySelector(".video-heading");
      const title = card?.querySelector(".video-title");
      const meta = card?.querySelector(".video-meta");
      const songList = card?.querySelector(".song-list");
      const copy = card?.querySelector("[data-copy-setlist]");
      const more = card?.querySelector(".video-more");
      const visibleCopyButtons = Array.from(document.querySelectorAll("[data-copy-setlist]"))
        .filter(visible)
        .map((button) => ({
          ...rectFor(button),
          text: button.textContent.trim(),
          ariaLabel: button.getAttribute("aria-label") || "",
          title: button.getAttribute("title") || "",
          svgCount: button.querySelectorAll("svg").length,
        }));
      return {
        viewportWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        gridColumns: getComputedStyle(document.querySelector(".video-grid")).gridTemplateColumns,
        card: card ? rectFor(card) : null,
        thumb: thumb ? rectFor(thumb) : null,
        thumbImage: thumbImage
          ? {
              ...rectFor(thumbImage),
              currentSrc: thumbImage.currentSrc || thumbImage.src || "",
              naturalWidth: thumbImage.naturalWidth || 0,
            }
          : null,
        heading: heading ? rectFor(heading) : null,
        title: title ? rectFor(title) : null,
        meta: meta ? rectFor(meta) : null,
        songList: songList ? rectFor(songList) : null,
        copy: copy ? rectFor(copy) : null,
        visibleCopyButtons,
        more: more ? rectFor(more) : null,
      };
    });
    if (geometry.scrollWidth > geometry.viewportWidth + 1) throw new Error(`video view overflow ${JSON.stringify(geometry)}`);
    if (!geometry.card || !geometry.thumb || !geometry.heading || !geometry.title || !geometry.songList || !geometry.copy) {
      throw new Error(`video card geometry missing ${JSON.stringify(geometry)}`);
    }
    if (!geometry.thumbImage?.currentSrc) {
      throw new Error(`video thumbnail image did not load ${JSON.stringify(geometry)}`);
    }
    const badCopy = geometry.visibleCopyButtons.find(
      (button) =>
        button.text ||
        button.svgCount !== 1 ||
        !button.ariaLabel.startsWith("复制该视频歌单：") ||
        button.title !== "复制歌单" ||
        Math.abs(button.width - button.height) > 1,
    );
    if (badCopy) throw new Error(`video copy setlist button invalid ${JSON.stringify({ badCopy, geometry })}`);
    if (viewport[0] <= 720) {
      if (geometry.thumb.width >= geometry.card.width * 0.45) throw new Error(`mobile video thumbnail too wide ${JSON.stringify(geometry)}`);
      if (geometry.thumb.width < 118 || geometry.thumb.width > 146) throw new Error(`mobile video thumbnail size invalid ${JSON.stringify(geometry)}`);
      if (geometry.songList.left > geometry.card.left + 12 || geometry.songList.right < geometry.card.right - 12) {
        throw new Error(`mobile video song list is not full width ${JSON.stringify(geometry)}`);
      }
      if (geometry.copy.width < 28 || geometry.copy.width > 30 || Math.abs(geometry.copy.width - geometry.copy.height) > 1) {
        throw new Error(`mobile video copy button size invalid ${JSON.stringify(geometry)}`);
      }
    } else if (!geometry.gridColumns.includes(" ")) {
      throw new Error(`desktop video grid did not keep multiple columns ${JSON.stringify(geometry)}`);
    }

    let expandedScreenshotPath = null;
    const moreButton = page.locator(".video-card .video-more:not(.video-more-top)").first();
    if ((await moreButton.count()) === 1) {
      await moreButton.click();
      await page.waitForFunction(
        () => document.querySelector(".video-card .video-more:not(.video-more-top)")?.getAttribute("aria-expanded") === "true",
        null,
        { timeout: 5000 },
      );
      if (viewport[0] === 390) {
        expandedScreenshotPath = shotPath(`video-card-expanded-${viewport.join("x")}.png`);
        await page.screenshot({ path: expandedScreenshotPath, fullPage: false });
      }
    }

    let screenshotPath = null;
    if (viewport[0] === 390 || viewport[0] === 1366) {
      screenshotPath = shotPath(`video-card-${viewport.join("x")}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: false });
    }
    const unhandled = await page.evaluate(() => window.__unhandledRejection || "");
    await context.close();
    if (errors.length || unhandled) throw new Error(`video card geometry errors: ${errors.join(" | ")} ${unhandled}`);
    results.push({ scenario: `video-card-geometry-${viewport.join("x")}`, requests: [...new Set(requests)], screenshotPath, expandedScreenshotPath });
  }
}

async function gotoFirstSingleSourcePage(page, errors, requests) {
  return gotoFirstSourceCasePage(page, errors, requests, "single");
}

async function gotoFirstSourceCasePage(page, errors, requests, kind) {
  for (let pageNumber = 1; pageNumber <= 20; pageNumber += 1) {
    const targetUrl = new URL(baseUrl);
    targetUrl.searchParams.set("pageSize", "100");
    targetUrl.searchParams.set("showUnknown", "1");
    targetUrl.searchParams.set("page", String(pageNumber));
    await page.goto(targetUrl.toString(), { waitUntil: "domcontentloaded" });
    await waitForRows(page, errors, requests);
    const match = await page.evaluate((targetKind) => {
      const rows = Array.from(document.querySelectorAll(".rank-row:not(.skeleton-row)"));
      const matches = (count) =>
        targetKind === "single" ? count === 1 : targetKind === "triple" ? count === 3 : targetKind === "more" ? count > 3 : false;
      for (const [index, row] of rows.entries()) {
        const strip = row.querySelector(".source-inline-strip");
        const count = Number(strip?.dataset.sourceVideoCount || 0);
        if (matches(count)) return { rowIndex: index, count };
      }
      return null;
    }, kind);
    if (match) return { page: pageNumber, matchCount: 1, ...match };
  }
  return { page: null, matchCount: 0 };
}

async function inlineSourceShape(row) {
  return row.evaluate((node) => {
    const visible = (target) => {
      if (!target) return false;
      const box = target.getBoundingClientRect();
      const style = getComputedStyle(target);
      return !target.hidden && style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
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
        display: style.display,
        visibility: style.visibility,
        text: target.textContent.trim(),
      };
    };
    const strip = node.querySelector(".source-inline-strip");
    const content = node.querySelector(".rank-content");
    const side = node.querySelector(".rank-side");
    const items = Array.from(node.querySelectorAll(".source-inline-item")).map((item) => {
      const channel = item.querySelector(".source-inline-channel");
      return {
        ...rectFor(item),
        visible: visible(item),
        channel: channel
          ? {
              ...rectFor(channel),
              visible: visible(channel),
              text: channel.textContent.trim(),
            }
          : null,
        copyVisible: visible(item.querySelector("[data-copy-setlist]")),
        timeVisible: visible(item.querySelector(".source-inline-time")),
      };
    });
    const more = node.querySelector(".source-inline-more");
    return {
      sourceVideoCount: Number(strip?.dataset.sourceVideoCount || 0),
      inlineVisibleCount: Number(strip?.dataset.inlineVisibleCount || 0),
      strip: strip ? rectFor(strip) : null,
      content: content ? rectFor(content) : null,
      side: side ? rectFor(side) : null,
      toggleCount: node.querySelectorAll("[data-toggle-source]").length,
      drawerCount: node.querySelectorAll(".source-drawer").length,
      copyAllCount: node.querySelectorAll("[data-copy-song-links]").length,
      items,
      more: more
        ? {
            ...rectFor(more),
            visible: visible(more),
            flexGrow: getComputedStyle(more).flexGrow,
          }
        : null,
    };
  });
}

async function compactSourceDrawerFlow(browser) {
  for (const scenario of [
    { label: "mobile", viewport: [390, 844] },
    { label: "tablet", viewport: [768, 1024] },
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
    const expectedRemaining = Number.parseInt((await button.getAttribute("data-remaining-count")) || "0", 10);
    if (!expectedRemaining) throw new Error(`${scenario.label} source drawer toggle missing remaining count`);
    if ((await row.locator("[data-toggle-source-groups]").count()) !== 0) throw new Error("song source drawer should not expose a second source group expander");
    const visibleGroupsOnOpen = await countVisibleInRow(row, ".source-video-group");
    if (visibleGroupsOnOpen !== expectedRemaining) {
      throw new Error(`${scenario.label} source drawer should reveal all remaining groups on one click: expected=${expectedRemaining} actual=${visibleGroupsOnOpen}`);
    }

    const geometry = await row.evaluate((node) => {
      const rectFor = (target) => {
        const box = target.getBoundingClientRect();
        return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
      };
      const drawer = node.querySelector(".source-drawer");
      const content = node.querySelector(".rank-content");
      const sourceStrip = node.querySelector(".source-inline-strip");
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
        sourceStrip: sourceStrip ? rectFor(sourceStrip) : null,
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
    const expectedLeft =
      viewport[0] <= 720 || !geometry.sourceStrip ? geometry.row.left + geometry.rowBox.borderLeft + geometry.rowBox.paddingLeft : geometry.sourceStrip.left;
    const expectedWidth =
      viewport[0] <= 720 || !geometry.sourceStrip
        ? geometry.row.width - geometry.rowBox.borderLeft - geometry.rowBox.borderRight - geometry.rowBox.paddingLeft - geometry.rowBox.paddingRight
        : geometry.sourceStrip.width;
    if (Math.abs(geometry.drawer.left - expectedLeft) > 3) {
      throw new Error(`${scenario.label} source drawer left offset invalid ${JSON.stringify(geometry)}`);
    }
    if (Math.abs(geometry.drawer.width - expectedWidth) > 4) {
      throw new Error(`${scenario.label} source drawer width invalid ${JSON.stringify(geometry)}`);
    }
    const drawerAnchor = geometry.sourceStrip || geometry.content;
    if (drawerAnchor && geometry.drawer.top - drawerAnchor.bottom > 18) {
      throw new Error(`${scenario.label} source drawer has excessive blank gap ${JSON.stringify(geometry)}`);
    }
    if (geometry.sourceGroups.some((group) => group.width > geometry.drawer.width + 1 || group.left < geometry.drawer.left - 1 || group.right > geometry.drawer.right + 1)) {
      throw new Error(`${scenario.label} source group shifted out of drawer ${JSON.stringify(geometry)}`);
    }

    const sourceSemantics = await row.evaluate((node) => {
      const title = node.querySelector(".source-video-title");
      const timeLinks = Array.from(node.querySelectorAll(".source-time-primary, .source-time-extra"));
      const inlineVideoIds = Array.from(node.querySelectorAll(".source-inline-item")).map((item) => item.dataset.videoId).filter(Boolean);
      const drawerVideoIds = Array.from(node.querySelectorAll(".source-drawer:not([hidden]) .source-video-title"))
        .map((link) => {
          try {
            return new URL(link.href).searchParams.get("v") || "";
          } catch {
            return "";
          }
        })
        .filter(Boolean);
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
        repeatedInlineVideoIds: drawerVideoIds.filter((id) => inlineVideoIds.includes(id)),
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
    if (sourceSemantics.repeatedInlineVideoIds.length) throw new Error(`source drawer duplicated inline preview videos ${JSON.stringify(sourceSemantics)}`);
    if (sourceSemantics.titleHeight > 44) throw new Error(`source video title exceeds compact two-line height ${JSON.stringify(sourceSemantics)}`);

    let expectedReopenGroupCount = null;
    let preservedFirstGroupText = "";
    const moreGroups = row.locator("[data-toggle-source-groups]");
    if ((await moreGroups.count()) > 0) {
      const beforeGroupCount = await countVisibleInRow(row, ".source-video-group");
      const moreText = (await moreGroups.first().textContent()) || "";
      if (!/查看更多 \d+个来源/u.test(moreText)) throw new Error(`source group expander text invalid: ${moreText}`);
      const remainingMatch = moreText.match(/查看更多\s*(\d+)个来源/u);
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
      const footerHandle = await moreGroups.first().elementHandle();
      await moreGroups.first().evaluate((node) => {
        node.dataset.codexFooterPreserve = "1";
      });
      await moreGroups.first().click();
      const afterGroupCount = expectedTotal
        ? await waitForVisibleCountAtLeast(row, ".source-video-group", expectedTotal)
        : await waitForVisibleCountAbove(row, ".source-video-group", beforeGroupCount);
      if (afterGroupCount <= beforeGroupCount) throw new Error("source group expander did not add visible groups");
      if (expectedTotal && afterGroupCount !== expectedTotal) {
        throw new Error(`${scenario.label} source group expander should reveal all remaining groups: before=${beforeGroupCount} after=${afterGroupCount} total=${expectedTotal}`);
      }
      if ((await moreGroups.count()) !== 0) throw new Error(`${scenario.label} source group expander should be removed after revealing all sources`);
      const footerAfter = footerHandle
        ? await footerHandle.evaluate((node) => ({
            preserved: node.dataset.codexFooterPreserve === "1",
            collapse: node.dataset.collapseSource === "true",
            text: node.textContent.trim(),
            connected: node.isConnected,
          }))
        : null;
      if (!footerAfter?.preserved || !footerAfter.collapse || footerAfter.text !== "收起" || !footerAfter.connected) {
        throw new Error(`${scenario.label} source group footer did not become collapse in place ${JSON.stringify(footerAfter)}`);
      }
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
    const collapseTop = row.locator(".source-inline-more[data-toggle-source][aria-expanded='true']");
    const toolbarCollapse = row.locator(".source-collapse-top[data-collapse-source]");
    const collapseBottom = row.locator(".source-collapse-bottom[data-collapse-source]");
    if ((await toolbarCollapse.count()) !== 0) throw new Error(`${scenario.label} source drawer should not duplicate a toolbar collapse button`);
    if ((await collapseTop.count()) !== 1) throw new Error(`${scenario.label} inline source preview should expose exactly one top collapse button`);
    if ((await collapseBottom.count()) > 1) throw new Error(`${scenario.label} source drawer should expose at most one bottom collapse button`);
    if ((await collapseBottom.count()) > 0) {
      await retryDetachedAction(() => collapseBottom.scrollIntoViewIfNeeded(), "scroll bottom source collapse");
      const bottomCoverage = await page.evaluate(() => {
        const collapse = document.querySelector(".rank-row.is-expanded .source-collapse-bottom[data-collapse-source]");
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
    }
    await page.screenshot({ path: bottomScreenshotPath, fullPage: false });
    const closeControl = (await collapseBottom.count()) > 0 ? collapseBottom : collapseTop;
    await retryDetachedAction(() => closeControl.click(), "click source collapse");
    await page.waitForFunction(
      (index) => document.querySelectorAll(".rank-row:not(.skeleton-row):has([data-toggle-source])")[index]?.classList.contains("is-expanded") === false,
      selectedIndex,
    );
    const closedExpanded = await button.getAttribute("aria-expanded");
    if (closedExpanded !== "false") throw new Error(`source collapse aria-expanded expected false, got ${closedExpanded}`);
    if ((await page.locator(".rank-row.is-expanded, .index-row.is-expanded").count()) !== 0) throw new Error("source collapse left an expanded row");

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

async function waitForVisibleCountAtLeast(row, selector, minimum) {
  const deadline = Date.now() + 5000;
  let latest = await countVisibleInRow(row, selector);
  while (latest < minimum && Date.now() < deadline) {
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
    await openSnapshotFilters(page);
    try {
      await page.waitForFunction(() => document.querySelector("#querySnapshotDateSelect")?.disabled === false, null, { timeout: verifyTimeout(30000, 120000) });
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        status: document.querySelector("#status")?.textContent || "",
        busy: document.querySelector("#videoList")?.getAttribute("aria-busy") || "",
        dateDisabled: document.querySelector("#querySnapshotDateSelect")?.disabled ?? null,
        timeDisabled: document.querySelector("#querySnapshotSelect")?.disabled ?? null,
        activeView: document.querySelector("[data-view].is-active")?.textContent || "",
        resources: window.printSongListPerformance?.().resources || [],
      }));
      throw new Error(`${error.message}\nsnapshot diagnostics=${JSON.stringify(diagnostics)}`);
    }
    try {
      await page.selectOption("#querySnapshotDateSelect", value, { timeout: 5000 });
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

async function mobileActiveQueryStripGeometry(browser) {
  for (const viewport of [
    [320, 700],
    [390, 844],
  ]) {
    const { context, page, errors } = await newPage(browser, viewport);
    const requests = [];
    page.on("request", (request) => requests.push(requestPath(request.url())));
    const url = new URL(baseUrl);
    url.searchParams.set("q", "少女レイ");
    url.searchParams.set("outside", "1");
    url.searchParams.set("metric", "videos");
    url.searchParams.set("minCount", "2");
    await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
    await waitForRows(page, errors, requests);
    const geometry = await page.evaluate(() => {
      const rectFor = (node) => {
        const box = node.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          bottom: box.bottom,
          width: box.width,
          height: box.height,
          scrollWidth: node.scrollWidth,
          clientWidth: node.clientWidth,
          text: node.textContent || "",
        };
      };
      const strip = document.querySelector("#activeQueryStrip");
      const clear = document.querySelector("#activeQueryStrip .active-query-clear");
      const chips = Array.from(document.querySelectorAll("#activeQueryStrip .active-query-chip")).map(rectFor);
      const queryTrigger = document.querySelector("#queryTrigger");
      const queryBox = queryTrigger?.getBoundingClientRect();
      const visibleTriggerChildren = queryTrigger
        ? Array.from(queryTrigger.children).filter((node) => {
            const box = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            return !node.hidden && style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
          })
        : [];
      return {
        viewportWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        strip: strip ? rectFor(strip) : null,
        clear: clear ? rectFor(clear) : null,
        chips,
        queryTrigger: queryTrigger
          ? {
              width: queryBox.width,
              height: queryBox.height,
              ariaLabel: queryTrigger.getAttribute("aria-label") || "",
              visibleSvgCount: visibleTriggerChildren.filter((node) => node.tagName.toLowerCase() === "svg").length,
              visibleNumericBadgeCount: visibleTriggerChildren.filter((node) => /^\d+$/u.test((node.textContent || "").trim())).length,
              hasActiveClass: queryTrigger.classList.contains("has-active-query"),
            }
          : null,
      };
    });
    if (geometry.scrollWidth > geometry.viewportWidth + 1) throw new Error(`active query strip page overflow ${JSON.stringify(geometry)}`);
    if (!geometry.strip || !geometry.clear || geometry.chips.length < 3) throw new Error(`active query strip missing pieces ${JSON.stringify(geometry)}`);
    if (!geometry.queryTrigger?.hasActiveClass || geometry.queryTrigger.visibleSvgCount !== 1 || geometry.queryTrigger.visibleNumericBadgeCount !== 0) {
      throw new Error(`active query trigger state invalid ${JSON.stringify(geometry)}`);
    }
    if (!/当前有 4 个条件：少女レイ、只看小众、按视频、2次以上/u.test(geometry.queryTrigger.ariaLabel)) {
      throw new Error(`active query trigger aria label missing condition detail ${JSON.stringify(geometry.queryTrigger)}`);
    }
    if (!/清除全部/u.test(geometry.clear.text) || geometry.clear.width < 58 || geometry.clear.scrollWidth > geometry.clear.clientWidth + 1) {
      throw new Error(`active query clear button clipped ${JSON.stringify(geometry)}`);
    }
    if (geometry.clear.right > geometry.viewportWidth + 1) throw new Error(`active query clear button offscreen ${JSON.stringify(geometry)}`);
    const screenshotPath = shotPath(`active-query-strip-${viewport.join("x")}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });
    const unhandled = await page.evaluate(() => window.__unhandledRejection || "");
    await context.close();
    if (errors.length || unhandled) throw new Error(`active query strip errors: ${errors.join(" | ")} ${unhandled}`);
    results.push({ scenario: `active-query-strip-${viewport.join("x")}`, requests: [...new Set(requests)], screenshotPath });
  }
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
    await measureQueryOpenLatency(browser);
    await mobileFilterSheetFlow(browser);
    await mobileActiveQueryStripGeometry(browser);
    await mobileRankVisualGeometry(browser);
    await mobileCopyAllLinksFlow(browser);
    await mobileVideoCardGeometry(browser);
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
