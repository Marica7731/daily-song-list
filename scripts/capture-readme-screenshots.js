const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");
const { expectedScreenshots } = require("./ui-proof-config");
const { pngDimensions, proofInputEntries, proofInputHash, sha256Buffer, validateUiProof } = require("./validate-ui-proof");
const { buildSongRecords } = require("../assets/ranking-utils");
const { trendDisplayModel } = require("../assets/frontend-utils");
const proofFixture = require("../test/fixtures/ui-proof-runtime.json");

const args = process.argv.slice(2);
const baseUrl = args.find((arg) => !arg.startsWith("--")) || "http://127.0.0.1:8080/";
const outputDir = path.join(process.cwd(), "docs", "assets", "screenshots");
const workDir = path.join(outputDir, `.tmp-${process.pid}`);
const recentSearches = ["少女レイ", "HOT LIMIT", "夏祭り"];
const generatedScreenshots = new Set();
const screenshotRecords = new Map();

fs.mkdirSync(outputDir, { recursive: true });
fs.rmSync(workDir, { recursive: true, force: true });
fs.mkdirSync(workDir, { recursive: true });

function screenshotPath(name) {
  return path.join(workDir, name);
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
      return content.classList.contains("empty-state") || Boolean(content.querySelector(".rank-row, .video-card, .index-section, .index-row"));
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

async function assertNoVisibleClipping(page, label) {
  const clipped = await page.evaluate(() => {
    const selectors = [
      ".controls",
      "#summary",
      "#activeQueryStrip:not([hidden])",
      ".pagination-row",
      ".rank-row:not(.skeleton-row)",
      ".index-row",
      ".video-card",
      ".source-inline-item",
      ".source-drawer:not([hidden])",
      ".query-panel",
      ".mobile-bottom-nav",
    ];
    const viewportWidth = document.documentElement.clientWidth;
    const visible = (node) => {
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return !node.hidden && style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    return selectors
      .flatMap((selector) =>
        Array.from(document.querySelectorAll(selector))
          .filter(visible)
          .slice(0, 20)
          .map((node) => {
            const box = node.getBoundingClientRect();
            return {
              selector,
              left: Math.round(box.left * 10) / 10,
              right: Math.round(box.right * 10) / 10,
              width: Math.round(box.width * 10) / 10,
              text: node.textContent.trim().slice(0, 60),
            };
          }),
      )
      .filter((item) => item.left < -1 || item.right > viewportWidth + 1);
  });
  if (clipped.length) throw new Error(`${label} visible clipping: ${JSON.stringify(clipped.slice(0, 8))}`);
}

async function assertQueryHistoryPanelSpacing(page, label) {
  const metrics = await page.evaluate(() => {
    const section = document.querySelector(".query-history-section[open]");
    const footer = document.querySelector(".query-panel-footer");
    if (!section || !footer) return null;
    const sectionBox = section.getBoundingClientRect();
    const footerBox = footer.getBoundingClientRect();
    return {
      gap: Math.round((footerBox.top - sectionBox.bottom) * 10) / 10,
      sectionBottom: Math.round(sectionBox.bottom * 10) / 10,
      footerTop: Math.round(footerBox.top * 10) / 10,
    };
  });
  if (!metrics) throw new Error(`${label} missing open query history section`);
  if (metrics.gap < -1) {
    throw new Error(`${label} query history overlaps footer: ${JSON.stringify(metrics)}`);
  }
}

async function assertExpandedSourceBottomVisible(page, row, label) {
  const metrics = await row.evaluate((node) => {
    const drawer = node.querySelector(".source-drawer:not([hidden])");
    const collapse = drawer?.querySelector(".source-collapse-bottom[data-collapse-source]");
    const bottomNav = document.querySelector("#mobileBottomNav");
    const navBox = bottomNav?.getBoundingClientRect();
    const navTop =
      navBox && getComputedStyle(bottomNav).display !== "none" && getComputedStyle(bottomNav).visibility !== "hidden"
        ? navBox.top
        : window.innerHeight;
    const buttonBox = collapse?.getBoundingClientRect();
    return {
      hasDrawer: Boolean(drawer),
      groupCount: drawer?.querySelectorAll(".source-video-group").length || 0,
      hasCollapse: Boolean(collapse),
      collapseText: collapse?.textContent?.trim() || "",
      buttonTop: Math.round((buttonBox?.top || 0) * 10) / 10,
      buttonBottom: Math.round((buttonBox?.bottom || 0) * 10) / 10,
      navTop: Math.round(navTop * 10) / 10,
      viewportHeight: window.innerHeight,
    };
  });
  if (!metrics.hasDrawer || metrics.groupCount < 8 || !metrics.hasCollapse || metrics.collapseText !== "收起来源") {
    throw new Error(`${label} source drawer bottom controls missing: ${JSON.stringify(metrics)}`);
  }
  if (metrics.buttonTop < 0 || metrics.buttonBottom > metrics.navTop - 6) {
    throw new Error(`${label} source drawer bottom collapse not visible: ${JSON.stringify(metrics)}`);
  }
}

async function assertSongIndexToolbarSpacing(page, label) {
  const shape = await page.evaluate(() => {
    const rectFor = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const box = node.getBoundingClientRect();
      return {
        top: box.top,
        bottom: box.bottom,
        height: box.height,
        text: node.textContent.trim().slice(0, 80),
      };
    };
    return {
      viewportWidth: document.documentElement.clientWidth,
      toolbar: rectFor(".index-toolbar"),
      nextBlock: rectFor(".index-toolbar + .index-section, .index-toolbar + .index-list"),
    };
  });
  if (shape.viewportWidth > 720 || !shape.toolbar || !shape.nextBlock) return;
  if (shape.toolbar.height > 48 || shape.nextBlock.top < shape.toolbar.bottom + 2) {
    throw new Error(`${label} mobile song index toolbar overlaps content: ${JSON.stringify(shape)}`);
  }
}

async function warmVisiblePriorityImages(page) {
  await page
    .waitForFunction(
      () =>
        Array.from(document.querySelectorAll("img[loading='eager']")).every((img) => {
          const box = img.getBoundingClientRect();
          const visible = box.width > 0 && box.height > 0 && box.bottom >= 0 && box.top <= window.innerHeight + 120;
          return !visible || img.complete || img.naturalWidth > 0;
        }),
      null,
      { timeout: 5_000 },
    )
    .catch(() => {});
}

async function warmImagesInElement(page, locator, selector = "img") {
  await locator.locator(selector).evaluateAll((images) => {
    for (const img of images) {
      img.loading = "eager";
      img.fetchPriority = "high";
    }
  });
  const count = await locator.locator(selector).count();
  for (let index = 0; index < count; index += 1) {
    await locator.locator(selector).nth(index).scrollIntoViewIfNeeded().catch(() => {});
    if (index % 8 === 7) await page.waitForTimeout(120);
  }
  await page.waitForTimeout(500);
  await locator.scrollIntoViewIfNeeded().catch(() => {});
}

async function scrollElementNearTop(page, locator) {
  await locator.evaluate((node) => {
    const controls = document.querySelector(".controls");
    const controlsBox = controls?.getBoundingClientRect();
    const controlsStyle = controls ? getComputedStyle(controls) : null;
    const stickyOffset =
      controlsBox && controlsStyle?.display !== "none" && controlsStyle?.visibility !== "hidden"
        ? Math.max(12, controlsBox.bottom + 8)
        : window.matchMedia?.("(max-width: 720px)")?.matches
          ? 52
          : 12;
    const top = window.scrollY + node.getBoundingClientRect().top - stickyOffset;
    window.scrollTo({ top: Math.max(0, top), behavior: "instant" });
  });
  await sleep(150);
}

async function scrollElementBottomIntoView(page, locator) {
  await locator.evaluate((node) => {
    const bottomNav = document.querySelector("#mobileBottomNav");
    const bottomNavBox = bottomNav?.getBoundingClientRect();
    const bottomInset =
      bottomNavBox && getComputedStyle(bottomNav).display !== "none" && getComputedStyle(bottomNav).visibility !== "hidden"
        ? bottomNavBox.height
        : 0;
    const targetBottom = window.scrollY + node.getBoundingClientRect().bottom;
    const nextTop = targetBottom - window.innerHeight + bottomInset + 14;
    window.scrollTo({ top: Math.max(0, nextTop), behavior: "instant" });
  });
  await sleep(150);
}

async function save(page, name, options = {}) {
  await assertNoPageOverflow(page, name);
  await assertNoVisibleClipping(page, name);
  const file = screenshotPath(name);
  await page.screenshot({
    path: file,
    fullPage: Boolean(options.fullPage),
  });
  const stats = fs.statSync(file);
  if (stats.size < 12_000) throw new Error(`${name} screenshot looks empty: ${stats.size} bytes`);
  generatedScreenshots.add(name);
  recordScreenshot(name, file, options);
  console.log(`README_SCREENSHOT ${name}`);
  return file;
}

async function saveElement(page, locator, name, options = {}) {
  await assertNoPageOverflow(page, name);
  await assertNoVisibleClipping(page, name);
  const file = screenshotPath(name);
  await locator.screenshot({ path: file });
  const stats = fs.statSync(file);
  const minBytes = options.minBytes ?? 6_000;
  if (stats.size < minBytes) throw new Error(`${name} element screenshot looks empty: ${stats.size} bytes`);
  generatedScreenshots.add(name);
  recordScreenshot(name, file, options);
  console.log(`README_SCREENSHOT ${name}`);
  return file;
}

function recordScreenshot(name, file, options = {}) {
  const buffer = fs.readFileSync(file);
  const dimensions = pngDimensions(buffer);
  screenshotRecords.set(name, {
    path: `docs/assets/screenshots/${name}`,
    scene: options.scene || name.replace(/\.png$/u, ""),
    viewport: options.viewport || null,
    urlParams: options.params || {},
    selector: options.selector || "page",
    width: dimensions.width,
    height: dimensions.height,
    size: buffer.length,
    sha256: sha256Buffer(buffer),
  });
}

async function openPage(browser, viewport, params, name, options = {}) {
  const page = await newPage(browser, viewport);
  await page.goto(appUrl(params), { waitUntil: "networkidle" });
  await waitForApp(page);
  await warmVisiblePriorityImages(page);
  if (params?.view === "videos") await assertVideoThumbVisible(page, name);
  if (params?.view === "songAz") await assertSongIndexToolbarSpacing(page, name);
  await save(page, name, { ...options, viewport, params });
  await page.close();
}

async function captureQueryPanel(browser, viewport, name, options = {}) {
  const page = await newPage(browser, viewport);
  await page.goto(appUrl(options.params || {}), { waitUntil: "networkidle" });
  await waitForApp(page);
  const openedAt = await page.evaluate(() => performance.now());
  await page.click("#queryTrigger");
  await page.waitForSelector("#queryDialog:not([hidden]) .query-panel", { timeout: 3_000 });
  const visibleMs = await page.evaluate((start) => Math.round((performance.now() - start) * 10) / 10, openedAt);
  console.log(`README_QUERY_OPEN ${name} ${visibleMs}ms`);
  if (options.searchText) {
    await page.fill("#queryInput", options.searchText);
    if (options.expectEmptySuggestions) {
      await page.waitForSelector(".suggestion-empty", { timeout: 15_000 });
    } else {
      await page.waitForSelector(".suggestion-item", { timeout: 15_000 });
    }
    await sleep(250);
  }
  if (options.filterTab || options.openHistory || options.scrollBottom) {
    await assertUnifiedQueryPanel(page, name);
    await sleep(150);
  }
  if (options.openHistory || options.scrollBottom) {
    await page.locator(".query-history-section").evaluate((section) => {
      section.open = true;
    });
    await page.waitForSelector(".query-history-section[open] #querySnapshotDateSelect", { timeout: 15_000 });
  }
  if (options.scrollBottom) {
    await page.locator(".query-panel-body").evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await sleep(250);
  }
  if (options.openHistory) await assertQueryHistoryPanelSpacing(page, name);
  await save(page, name, { viewport, params: options.params || {}, selector: "#queryDialog", scene: options.scene });
  await page.close();
}

async function captureRequestState(browser, viewport, name, options = {}) {
  const page = await newPage(browser, viewport);
  if (options.failStatus) {
    await page.route("**/data/status.json", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "failed",
          attemptedAt: new Date().toISOString(),
          capturedAt: "2026-07-16T00:00:00.000Z",
          dataCapturedAt: "2026-07-16T00:00:00.000Z",
          completedAt: "2026-07-16T00:00:00.000Z",
          failureStage: "publishCheck",
          message: "proof failure status",
        }),
      });
    });
  }
  if (options.delayRequest) {
    await page.route("**/data/ui/ranges/**/views/**/page-*.json", async (route) => {
      await sleep(1200);
      await route.continue();
    });
  }
  if (options.failRequest) {
    await page.route("**/data/ui/ranges/**/views/**/page-*.json", async (route) => {
      await route.fulfill({ status: 503, contentType: "application/json", body: "{\"error\":\"proof\"}" });
    });
  }
  await page.goto(appUrl(options.params || {}), { waitUntil: "domcontentloaded" });
  if (options.delayRequest || options.failRequest) {
    await page.waitForSelector("#videoList[aria-busy='true'], .empty-state, .content-warning", { timeout: 2_000 }).catch(() => {});
    await sleep(250);
  } else {
    await waitForApp(page);
  }
  await save(page, name, { viewport, params: options.params || {}, scene: options.scene });
  await page.close();
}

async function assertUnifiedQueryPanel(page, name) {
  await page.waitForSelector("#queryDialog .query-filter-matrix #hideUnknownToggle", { timeout: 15_000 });
  const result = await page.evaluate(() => ({
    tabCount: document.querySelectorAll(".query-tabs, [data-query-panel-tab]").length,
    searchVisible: Boolean(document.querySelector("#queryInput")?.getBoundingClientRect().height),
    filterVisible: Boolean(document.querySelector(".query-filter-matrix")?.getBoundingClientRect().height),
    hideUnknownChecked: Boolean(document.querySelector("#hideUnknownToggle")?.checked),
  }));
  if (result.tabCount !== 0 || !result.searchVisible || !result.filterVisible) {
    throw new Error(`query panel is not unified for ${name}: ${JSON.stringify(result)}`);
  }
}

async function captureExpandedSource(browser, viewport, params, name) {
  const page = await newPage(browser, viewport);
  await page.goto(appUrl(params), { waitUntil: "networkidle" });
  await waitForApp(page);
  const toggle = page.locator("[data-toggle-source]").first();
  await toggle.click();
  await page.waitForSelector(".source-drawer:not([hidden]) .source-video-group", { timeout: 20_000 });
  await page
    .waitForFunction(() => {
      const img = document.querySelector(".source-drawer:not([hidden]) .source-video-thumb");
      return Boolean(img?.currentSrc || img?.src) && (img?.naturalWidth || 0) > 0;
    }, null, { timeout: 8_000 })
    .catch(() => {});
  const expandedRow = page.locator(".rank-row.is-expanded, .index-row.is-expanded").first();
  await warmImagesInElement(page, expandedRow, ".source-drawer .source-video-thumb");
  await assertExpandedSourceVisible(page, expandedRow, name);
  await scrollElementNearTop(page, expandedRow);
  await sleep(500);
  await save(page, name, { viewport, params, selector: ".rank-row.is-expanded, .index-row.is-expanded" });
  await page.close();
}

async function findSourceCase(browser, viewport, kind) {
  const page = await newPage(browser, viewport);
  try {
    for (let pageNumber = 1; pageNumber <= 25; pageNumber += 1) {
      const params = { page: pageNumber }; // responsive
      await page.goto(appUrl(params), { waitUntil: "networkidle" });
      await waitForApp(page);
      const match = await page.evaluate((targetKind) => {
        const rows = Array.from(document.querySelectorAll(".rank-row:not(.skeleton-row)"));
        const matchesKind = (count) =>
          targetKind === "single" ? count === 1 : targetKind === "triple" ? count === 3 : count > 3;
        for (const [index, row] of rows.entries()) {
          const strip = row.querySelector(".source-inline-strip");
          const count = Number(strip?.dataset.sourceVideoCount || 0);
          if (matchesKind(count)) return { index, count };
        }
        return null;
      }, kind);
      if (match) return { params, rowIndex: match.index, count: match.count };
    }
  } finally {
    await page.close();
  }
  throw new Error(`README source case not found: ${kind}`);
}

async function captureSourceCase(browser, viewport, kind, name, options = {}) {
  const found = await findSourceCase(browser, viewport, kind);
  const page = await newPage(browser, viewport);
  await page.goto(appUrl(found.params), { waitUntil: "networkidle" });
  await waitForApp(page);
  const row = page.locator(".rank-row:not(.skeleton-row)").nth(found.rowIndex);
  await row.evaluate((node) => node.scrollIntoView({ block: "center", inline: "nearest" }));
  if (options.expand) {
    await row.locator("[data-toggle-source]").first().click();
    await row.locator(".source-drawer:not([hidden]) .source-video-group").first().waitFor({ state: "visible", timeout: 20_000 });
    await page
      .waitForFunction(() => {
        const img = document.querySelector(".source-drawer:not([hidden]) .source-video-thumb");
        return Boolean(img?.currentSrc || img?.src) && (img?.naturalWidth || 0) > 0;
      }, null, { timeout: 8_000 })
      .catch(() => {});
    await sleep(350);
  }
  if (options.expand) {
    await warmImagesInElement(page, row, ".source-drawer .source-video-thumb");
    await assertExpandedSourceVisible(page, row, name);
    if (options.scrollBottom) {
      await scrollElementBottomIntoView(page, row.locator(".source-drawer:not([hidden])").first());
      await assertExpandedSourceBottomVisible(page, row, name);
    }
  } else {
    await warmImagesInElement(page, row, ".source-inline-thumb-image");
    await assertInlineSourceCase(page, row, kind, name);
  }
  if (options.viewportOnly) {
    if (!options.scrollBottom) await scrollElementNearTop(page, row);
    await save(page, name, {
      viewport,
      params: found.params,
      selector: `.rank-row source-${kind}${options.scrollBottom ? "-bottom" : ""}`,
      scene: options.scene,
    });
  } else {
    await saveElement(page, row, name, {
      minBytes: kind === "single" ? 4_000 : 6_000,
      viewport,
      params: found.params,
      selector: `.rank-row source-${kind}`,
      scene: options.scene,
    });
  }
  await page.close();
}

async function captureSongIndexPage(browser, viewport, target, name) {
  const page = await newPage(browser, viewport);
  await page.goto(appUrl({ view: "songAz" }), { waitUntil: "networkidle" });
  await waitForApp(page);
  const pageCount = await page.evaluate(() => {
    const input = document.querySelector(".pagination-top [data-page-input], .pagination-bottom [data-page-input]");
    return input ? Number(input.max) || 1 : 1;
  });
  const nextPage = target === "last" ? pageCount : Math.max(1, Math.ceil(pageCount / 2));
  await page.goto(appUrl({ view: "songAz", page: nextPage }), { waitUntil: "networkidle" });
  await waitForApp(page);
  await warmVisiblePriorityImages(page);
  await assertSongIndexToolbarSpacing(page, name);
  await save(page, name, { viewport, params: { view: "songAz", page: nextPage } });
  await page.close();
}

async function captureExpandedVideo(browser, viewport, name, options = {}) {
  const page = await newPage(browser, viewport);
  await page.goto(appUrl({ view: "videos" }), { waitUntil: "networkidle" });
  await waitForApp(page);
  await assertVideoThumbVisible(page, name);
  const more = page.locator(".video-more:not(.video-more-top)").first();
  if ((await more.count()) > 0) {
    await more.click();
    await page.waitForFunction(() => document.querySelector(".video-more:not(.video-more-top)")?.getAttribute("aria-expanded") === "true", null, {
      timeout: 5_000,
    });
    await page.waitForFunction(() => {
      const buttons = Array.from(document.querySelectorAll(".video-card .video-more[aria-expanded='true']"));
      return buttons.length === 2 && buttons.every((button) => button.textContent.trim() === "收起歌曲");
    }, null, { timeout: 5_000 });
    await sleep(350);
  } else {
    throw new Error(`${name} did not find an expandable video card`);
  }
  if (options.scrollBottom) {
    const expandedCard = page.locator(".video-card").filter({ has: page.locator(".video-more[aria-expanded='true']") }).first();
    await scrollElementBottomIntoView(page, expandedCard);
    await assertExpandedVideoBottomVisible(page, name);
  }
  await save(page, name, {
    viewport,
    params: { view: "videos" },
    selector: `.video-card:has(.video-more[aria-expanded='true'])${options.scrollBottom ? " bottom" : ""}`,
    scene: options.scene,
  });
  await page.close();
}

async function assertExpandedVideoBottomVisible(page, label) {
  const metrics = await page.evaluate(() => {
    const expandedButton = document.querySelector(".video-card .video-more[aria-expanded='true']");
    const card = expandedButton?.closest(".video-card");
    const bottomButton = Array.from(card?.querySelectorAll(".video-more[aria-expanded='true']") || []).find(
      (button) => !button.classList.contains("video-more-top"),
    );
    const bottomNav = document.querySelector("#mobileBottomNav");
    const navBox = bottomNav?.getBoundingClientRect();
    const navTop =
      navBox && getComputedStyle(bottomNav).display !== "none" && getComputedStyle(bottomNav).visibility !== "hidden"
        ? navBox.top
        : window.innerHeight;
    const buttonBox = bottomButton?.getBoundingClientRect();
    return {
      hasCard: Boolean(card),
      hasBottomButton: Boolean(bottomButton),
      buttonText: bottomButton?.textContent?.trim() || "",
      buttonTop: Math.round((buttonBox?.top || 0) * 10) / 10,
      buttonBottom: Math.round((buttonBox?.bottom || 0) * 10) / 10,
      navTop: Math.round(navTop * 10) / 10,
    };
  });
  if (!metrics.hasCard || !metrics.hasBottomButton || metrics.buttonText !== "收起歌曲") {
    throw new Error(`${label} expanded video bottom controls missing: ${JSON.stringify(metrics)}`);
  }
  if (metrics.buttonTop < 0 || metrics.buttonBottom > metrics.navTop - 6) {
    throw new Error(`${label} expanded video bottom controls not visible: ${JSON.stringify(metrics)}`);
  }
}

async function captureElementFromPage(browser, viewport, params, selector, name, options = {}) {
  const page = await newPage(browser, viewport);
  await page.goto(appUrl(params), { waitUntil: "networkidle" });
  await waitForApp(page);
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "visible", timeout: 15_000 });
  if (options.assert) await options.assert(page, locator);
  await saveElement(page, locator, name, {
    minBytes: options.minBytes ?? 3_000,
    viewport,
    params,
    selector,
    scene: options.scene,
  });
  await page.close();
}

async function captureToastCase(browser, viewport, name) {
  const page = await newPage(browser, viewport);
  await page.goto(appUrl({}), { waitUntil: "networkidle" });
  await waitForApp(page);
  await page.evaluate(() => {
    const toast = document.querySelector("#toast");
    toast.textContent = "已复制整场歌单 · 18首";
    toast.hidden = false;
  });
  const locator = page.locator("#toast").first();
  await locator.waitFor({ state: "visible", timeout: 3_000 });
  await assertToastGeometry(page, name);
  await saveElement(page, locator, name, {
    minBytes: 800,
    viewport,
    params: {},
    selector: "#toast",
    scene: "mobile-toast-copy-setlist",
  });
  await page.close();
}

async function assertSummaryBaseline(page) {
  const shape = await page.evaluate(() => {
    const main = document.querySelector("#summary .summary-main");
    const title = main?.querySelector(".summary-title");
    const firstMetric = main?.querySelector(".summary-metric");
    const nodes = Array.from(main?.querySelectorAll(".summary-title, .summary-metric, .summary-status") || []);
    const visible = (node) => {
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    const firstTop = Math.min(...nodes.filter(visible).map((node) => node.getBoundingClientRect().top));
    const firstLine = nodes
      .filter((node) => visible(node) && node.getBoundingClientRect().top <= firstTop + 4)
      .map((node) => {
        const box = node.getBoundingClientRect();
        return {
          className: node.className,
          text: node.textContent.trim(),
          top: Math.round(box.top * 10) / 10,
          bottom: Math.round(box.bottom * 10) / 10,
          height: Math.round(box.height * 10) / 10,
          lineHeight: getComputedStyle(node).lineHeight,
        };
      });
    const titleBox = title?.getBoundingClientRect();
    const metricBox = firstMetric?.getBoundingClientRect();
    return {
      alignItems: main ? getComputedStyle(main).alignItems : "",
      titleBottom: Math.round((titleBox?.bottom || 0) * 10) / 10,
      firstMetricBottom: Math.round((metricBox?.bottom || 0) * 10) / 10,
      firstLine,
      text: main?.textContent?.trim() || "",
    };
  });
  if (!/^(?:baseline|first baseline)$/u.test(shape.alignItems)) {
    throw new Error(`summary align-items must be baseline: ${JSON.stringify(shape)}`);
  }
  if (!shape.titleBottom || !shape.firstMetricBottom || Math.abs(shape.titleBottom - shape.firstMetricBottom) > 1.5) {
    throw new Error(`summary title and metric baseline mismatch: ${JSON.stringify(shape)}`);
  }
  const bottoms = shape.firstLine.map((item) => item.bottom);
  if (!bottoms.length || Math.max(...bottoms) - Math.min(...bottoms) > 2) {
    throw new Error(`summary first-line baseline mismatch: ${JSON.stringify(shape)}`);
  }
}

async function assertToastGeometry(page, label) {
  const shape = await page.evaluate(() => {
    const toast = document.querySelector("#toast");
    const nav = document.querySelector("#mobileBottomNav");
    const toastBox = toast?.getBoundingClientRect();
    const navBox = nav?.getBoundingClientRect();
    const navVisible = nav && getComputedStyle(nav).display !== "none" && getComputedStyle(nav).visibility !== "hidden";
    return {
      width: Math.round((toastBox?.width || 0) * 10) / 10,
      height: Math.round((toastBox?.height || 0) * 10) / 10,
      left: Math.round((toastBox?.left || 0) * 10) / 10,
      right: Math.round((toastBox?.right || 0) * 10) / 10,
      centerDelta: Math.round((((toastBox?.left || 0) + (toastBox?.right || 0)) / 2 - window.innerWidth / 2) * 10) / 10,
      bottom: Math.round((toastBox?.bottom || 0) * 10) / 10,
      navTop: navVisible ? Math.round(navBox.top * 10) / 10 : window.innerHeight,
      viewportWidth: window.innerWidth,
      role: toast?.getAttribute("role") || "",
      live: toast?.getAttribute("aria-live") || "",
      text: toast?.textContent?.trim() || "",
    };
  });
  if (
    shape.width <= 0 ||
    shape.width > Math.min(320, shape.viewportWidth - 32) + 1 ||
    shape.height < 36 ||
    shape.height > 44 ||
    Math.abs(shape.centerDelta) > 1.5 ||
    shape.bottom > shape.navTop - 6 ||
    shape.role !== "status" ||
    shape.live !== "polite"
  ) {
    throw new Error(`${label} toast geometry invalid: ${JSON.stringify(shape)}`);
  }
}

async function assertVideoThumbVisible(page, label) {
  const shape = await page.evaluate(() => {
    const thumb = document.querySelector(".video-card .thumb-link");
    const image = thumb?.querySelector("img");
    const box = thumb?.getBoundingClientRect();
    const style = thumb ? getComputedStyle(thumb) : null;
    return {
      width: box?.width || 0,
      height: box?.height || 0,
      display: style?.display || "",
      visibility: style?.visibility || "",
      currentSrc: image?.currentSrc || image?.src || "",
      naturalWidth: image?.naturalWidth || 0,
    };
  });
  if (shape.display === "none" || shape.visibility === "hidden" || shape.width < 100 || shape.height < 50 || !shape.currentSrc || shape.naturalWidth <= 0) {
    throw new Error(`${label} video thumbnail is not visible: ${JSON.stringify(shape)}`);
  }
}

async function assertInlineSourceCase(page, row, kind, label) {
  const shape = await row.evaluate((node) => {
    const visible = (target) => {
      if (!target) return false;
      const box = target.getBoundingClientRect();
      const style = getComputedStyle(target);
      return !target.hidden && style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    const rectFor = (target) => {
      const box = target.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: box.width, height: box.height };
    };
    const strip = node.querySelector(".source-inline-strip");
    const content = node.querySelector(".rank-content, .index-content");
    const side = node.querySelector(".rank-side");
    const more = node.querySelector(".source-inline-more");
    const actions = node.querySelector(".source-inline-actions");
    const items = Array.from(node.querySelectorAll(".source-inline-item")).map((item) => {
      const channel = item.querySelector(".source-inline-channel");
      const thumb = item.querySelector(".source-inline-thumb");
      const image = item.querySelector(".source-inline-thumb-image");
      const time = item.querySelector(".source-inline-time");
      return {
        ...rectFor(item),
        visible: visible(item),
        text: item.textContent.trim(),
        channelText: channel?.textContent?.trim() || "",
        channelVisible: visible(channel),
        channelWidth: channel?.getBoundingClientRect().width || 0,
        thumbVisible: visible(thumb),
        thumbWidth: thumb?.getBoundingClientRect().width || 0,
        thumbHeight: thumb?.getBoundingClientRect().height || 0,
        thumbLoaded: Boolean(image?.currentSrc || image?.src) && (image?.naturalWidth || 0) > 0,
        overlayCount: item.querySelectorAll(".source-inline-time-overlay").length,
        timeText: time?.textContent?.trim() || "",
        timeVisible: visible(time),
        timeScrollWidth: time?.scrollWidth || 0,
        timeClientWidth: time?.clientWidth || 0,
        copyVisible: visible(item.querySelector("[data-copy-setlist]")),
      };
    });
    return {
      viewportWidth: document.documentElement.clientWidth,
      sourceVideoCount: Number(strip?.dataset.sourceVideoCount || 0),
      inlineVisibleCount: Number(strip?.dataset.inlineVisibleCount || 0),
      strip: strip ? rectFor(strip) : null,
      content: content ? rectFor(content) : null,
      side: side ? rectFor(side) : null,
      actions: actions ? { ...rectFor(actions), justifyContent: getComputedStyle(actions).justifyContent } : null,
      toggleCount: node.querySelectorAll("[data-toggle-source]").length,
      drawerCount: node.querySelectorAll(".source-drawer").length,
      copyAllCount: node.querySelectorAll("[data-copy-song-links]").length,
      items,
      more: more
        ? {
            ...rectFor(more),
            visible: visible(more),
            flexGrow: getComputedStyle(more).flexGrow,
            text: more.textContent.trim(),
          }
        : null,
    };
  });

  if (kind === "single") {
    if (
      shape.sourceVideoCount !== 1 ||
      shape.items.length !== 1 ||
      shape.toggleCount !== 0 ||
      shape.drawerCount !== 0 ||
      shape.copyAllCount !== 0 ||
      !shape.items[0]?.visible ||
      !shape.items[0]?.channelVisible ||
      shape.items[0]?.channelWidth < 6 ||
      !shape.items[0]?.channelText ||
      !shape.items[0]?.thumbVisible ||
      !shape.items[0]?.thumbLoaded ||
      shape.items[0]?.overlayCount !== 0 ||
      !shape.items[0]?.timeVisible ||
      !shape.items[0]?.timeText ||
      shape.items[0]?.timeScrollWidth > shape.items[0]?.timeClientWidth + 1 ||
      !shape.items[0]?.copyVisible
    ) {
      throw new Error(`${label} single-source visibility invalid: ${JSON.stringify(shape)}`);
    }
    return;
  }

  if (kind === "triple") {
    if (
      shape.sourceVideoCount !== 3 ||
      shape.items.length !== 3 ||
      shape.toggleCount !== 0 ||
      shape.drawerCount !== 0 ||
      shape.copyAllCount !== 1 ||
      shape.items.some(
        (item) =>
          !item.visible ||
          !item.channelVisible ||
          item.channelWidth < 6 ||
          !item.channelText ||
          !item.thumbVisible ||
          !item.thumbLoaded ||
          item.overlayCount !== 0 ||
          !item.timeVisible ||
          !item.timeText ||
          item.timeScrollWidth > item.timeClientWidth + 1,
      )
    ) {
      throw new Error(`${label} triple-source visibility invalid: ${JSON.stringify(shape)}`);
    }
    if (shape.items[2].width < Math.max(80, (shape.strip?.width || 0) - 44)) {
      throw new Error(`${label} triple-source tail width invalid: ${JSON.stringify(shape)}`);
    }
    return;
  }

  const expectedInlineVisible = shape.viewportWidth <= 720 ? 2 : 3;
  const maxCollapsedCopyAll = shape.viewportWidth <= 720 ? 1 : 0;
  if (
    shape.sourceVideoCount <= 3 ||
    shape.inlineVisibleCount !== expectedInlineVisible ||
    shape.items.length !== expectedInlineVisible ||
    shape.toggleCount !== 1 ||
    shape.copyAllCount > maxCollapsedCopyAll ||
    shape.items.some(
      (item) =>
        !item.visible ||
        !item.channelVisible ||
        item.channelWidth < 6 ||
        !item.channelText ||
        !item.thumbVisible ||
        !item.thumbLoaded ||
        item.overlayCount !== 0 ||
        !item.timeVisible ||
        !item.timeText ||
        item.timeScrollWidth > item.timeClientWidth + 1,
    ) ||
    !shape.more?.visible ||
    shape.more.width > 92 ||
    shape.more.height > 30 ||
    shape.more.flexGrow !== "0" ||
    !shape.strip ||
    !shape.content ||
    !shape.side ||
    Math.abs(shape.strip.left - shape.content.left) > 2 ||
    Math.abs(shape.strip.right - shape.side.right) > 3 ||
    shape.items[0].left < 0 ||
    shape.items[0].right > shape.viewportWidth
  ) {
    throw new Error(`${label} 4+ source visibility invalid: ${JSON.stringify(shape)}`);
  }
  if (shape.viewportWidth <= 720) {
    const lastItemBottom = Math.max(...shape.items.map((item) => item.bottom));
    if (
      !shape.actions ||
      shape.actions.justifyContent !== "flex-start" ||
      shape.actions.left > (shape.content?.left || 0) + 8 ||
      shape.actions.top < lastItemBottom - 1 ||
      shape.actions.top > lastItemBottom + 10
    ) {
      throw new Error(`${label} mobile source actions detached: ${JSON.stringify(shape)}`);
    }
  }
}

async function assertExpandedSourceVisible(page, row, label) {
  const shape = await row.evaluate((node) => {
    const visible = (target) => {
      if (!target) return false;
      const box = target.getBoundingClientRect();
      const style = getComputedStyle(target);
      return !target.hidden && style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    const groups = Array.from(node.querySelectorAll(".source-drawer:not([hidden]) .source-video-group")).map((group) => {
      const thumb = group.querySelector(".source-video-thumb-link");
      const img = group.querySelector(".source-video-thumb");
      const title = group.querySelector(".source-video-title");
      let videoId = "";
      try {
        videoId = new URL(title?.href || "").searchParams.get("v") || "";
      } catch {
        videoId = "";
      }
      return {
        videoId: videoId || group.textContent.trim(),
        channelText: group.querySelector(".source-video-channel")?.textContent?.trim() || "",
        thumbVisible: visible(thumb),
        thumbWidth: thumb?.getBoundingClientRect().width || 0,
        imgLoaded: Boolean(img?.currentSrc || img?.src) && (img?.naturalWidth || 0) > 0,
      };
    });
    const toolbar = node.querySelector(".source-drawer:not([hidden]) .source-drawer-toolbar");
    const inlineVideoIds = Array.from(node.querySelectorAll(".source-inline-item"))
      .filter((item) => {
        const box = item.getBoundingClientRect();
        const style = getComputedStyle(item);
        return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
      })
      .map((item) => item.dataset.videoId)
      .filter(Boolean);
    return {
      viewportWidth: document.documentElement.clientWidth,
      buttonExpanded: node.querySelector("[data-toggle-source]")?.getAttribute("aria-expanded") || "",
      remainingCount: Number(node.querySelector("[data-toggle-source]")?.dataset.remainingCount || 0),
      videoCount: Number(node.querySelector("[data-toggle-source]")?.dataset.videoCount || 0),
      sourceGroupMore: node.querySelectorAll("[data-toggle-source-groups]").length,
      inlineCollapseCount: node.querySelectorAll(".source-inline-more[data-toggle-source][aria-expanded='true']").length,
      toolbarCollapseCount: node.querySelectorAll(".source-collapse-top[data-collapse-source]").length,
      bottomCollapseCount: node.querySelectorAll(".source-collapse-bottom[data-collapse-source]").length,
      copySongLinksCount: node.querySelectorAll("[data-copy-song-links]").length,
      toolbarHeight: toolbar?.getBoundingClientRect().height || 0,
      groups,
      loadedImageCount: groups.filter((group) => group.imgLoaded).length,
      duplicateVideoIds: groups
        .map((group) => group.videoId)
        .filter((id, index, list) => id && list.indexOf(id) !== index),
      repeatedInlineVideoIds: groups.map((group) => group.videoId).filter((id) => inlineVideoIds.includes(id)),
    };
  });
  if (
    shape.buttonExpanded !== "true" ||
    shape.groups.length !== shape.videoCount ||
    shape.sourceGroupMore !== 0 ||
    shape.inlineCollapseCount !== 1 ||
    shape.toolbarCollapseCount !== 1 ||
    shape.bottomCollapseCount > 1 ||
    shape.copySongLinksCount < 1 ||
    shape.copySongLinksCount > 2 ||
    (shape.viewportWidth <= 720 && shape.toolbarHeight > 32) ||
    shape.duplicateVideoIds.length ||
    shape.repeatedInlineVideoIds.length ||
    shape.groups.some((group) => !group.channelText || !group.thumbVisible || group.thumbWidth < 50) ||
    shape.loadedImageCount < Math.min(6, shape.groups.length)
  ) {
    throw new Error(`${label} expanded source visibility invalid: ${JSON.stringify(shape)}`);
  }
}

function proofPlaceholderSvg() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
      <rect width="640" height="360" fill="#E4E7EC"/>
      <rect x="282" y="142" width="76" height="76" rx="38" fill="#98A2B3"/>
      <path d="M310 164v32l28-16z" fill="#fff"/>
    </svg>
  `;
  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fixtureThumbSrc(group) {
  return group.videoId ? `https://i.ytimg.com/vi/${encodeURIComponent(group.videoId)}/mqdefault.jpg` : proofPlaceholderSvg();
}

function sourceTimeLinkHtml(group, time, seconds, className) {
  const videoId = encodeURIComponent(group.videoId || "proof");
  const label = [group.title || "来源视频", group.channelName || "", time].filter(Boolean).join(" · ");
  return `<a class="source-link ${className}" href="https://www.youtube.com/watch?v=${videoId}&t=${Math.max(0, Number(seconds) || 0)}s" target="_blank" rel="noreferrer" title="${escapeHtml(label)}" aria-label="打开时间戳：${escapeHtml(label)}">${escapeHtml(time)}</a>`;
}

function sourceItemHtml(group) {
  const videoId = encodeURIComponent(group.videoId || "proof");
  const seconds = Math.max(0, Number(group.seconds) || 0);
  const extraTimes = Array.isArray(group.extraTimes) ? group.extraTimes : [];
  const extraId = `source-inline-extra-${escapeHtml(group.videoId || "proof")}-${seconds}`;
  const extraLabel = group.extraCountLabel || `+${extraTimes.length}`;
  const extraCount = Number.parseInt(String(extraLabel).replace(/\D+/gu, ""), 10) || extraTimes.length;
  return `
    <span class="source-inline-item" data-video-id="${escapeHtml(group.videoId || "fallback")}" data-published-at="${escapeHtml(group.publishedAt || "")}">
      <a class="source-inline-thumb source-link" href="https://www.youtube.com/watch?v=${videoId}&t=${seconds}s" target="_blank" rel="noreferrer" tabindex="-1" aria-label="打开来源视频时间戳：${escapeHtml(group.title)}">
        <img class="source-inline-thumb-image" alt="" loading="lazy" decoding="async" fetchpriority="low" width="56" height="32" src="${fixtureThumbSrc(group)}" />
      </a>
      <span class="source-inline-main">
        <a class="source-inline-channel" href="https://www.youtube.com/results?search_query=${encodeURIComponent(group.channelName || "")}" target="_blank" rel="noreferrer">${escapeHtml(group.channelName)}</a>
        <span class="source-inline-meta">
          ${sourceTimeLinkHtml(group, group.time, seconds, "source-inline-time")}
          ${
            extraTimes.length
              ? `<button class="source-inline-time-more" type="button" data-toggle-source-times="true" aria-expanded="false" aria-controls="${extraId}" title="另外${extraCount}个时间点" aria-label="显示另外${extraCount}个时间点">${escapeHtml(extraLabel)}<span class="source-inline-time-more-unit">时间点</span></button>`
              : ""
          }
        </span>
      </span>
      <button class="source-inline-copy source-copy-icon ui-chip ui-chip-icon" type="button" data-copy-setlist="true" aria-label="复制该视频歌单">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l10-2v13"/><circle cx="7" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>
      </button>
      ${
        extraTimes.length
          ? `<span class="source-extra-times source-inline-extra-times" id="${extraId}" hidden>${extraTimes
              .map((entry) => sourceTimeLinkHtml(group, entry.time, entry.seconds, "source-inline-extra-time"))
              .join("")}</span>`
          : ""
      }
    </span>
  `;
}

function fixtureSourceStripHtml(caseName, viewport = {}) {
  const fixture = proofFixture.sourceCases[caseName];
  if (!fixture) throw new Error(`unknown proof fixture: ${caseName}`);
  const groups = fixture.groups || [];
  const count = Number(fixture.sourceVideoCount) || groups.length;
  if (!count) {
    return '<div class="source-inline-strip source-inline-none" data-source-video-count="0" data-inline-visible-count="0"><span class="source-inline-empty">无来源</span></div>';
  }
  const inlineLimit = Number(viewport.width) <= 720 ? 2 : 3;
  const head = groups.slice(0, Math.min(inlineLimit, groups.length));
  const remainingCount = Math.max(0, count - head.length);
  const showCopyAll = count > 1 && remainingCount === 0;
  const hasActions = showCopyAll || remainingCount > 0;
  return `
    <div class="source-inline-strip source-inline-${remainingCount ? "collapsed" : "inline"}${hasActions ? " has-tail-action" : ""}" data-source-video-count="${count}" data-inline-visible-count="${head.length}">
      <div class="source-inline-preview-rail" aria-label="来源预览">
        <div class="source-inline-preview-list">${head.map(sourceItemHtml).join("")}</div>
      </div>
      ${
        hasActions
          ? `<div class="source-inline-actions">${remainingCount ? `<button class="source-inline-more ui-chip" type="button" data-toggle-source="true" data-source-summary-toggle="true" aria-expanded="false" data-video-count="${count}" aria-label="查看该歌曲的全部 ${count} 个来源">查看全部来源</button>` : ""}${showCopyAll ? `<button class="source-inline-copy-all source-copy-icon ui-chip ui-chip-icon" type="button" data-copy-song-links="true" title="复制全部链接" aria-label="复制同一首歌全部来源时间点链接"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l2-2a5 5 0 0 0-7.07-7.07l-1.15 1.15"/><path d="M14 11a5 5 0 0 0-7.54-.54l-2 2a5 5 0 0 0 7.07 7.07l1.15-1.15"/></svg></button>` : ""}</div>`
          : ""
      }
    </div>
  `;
}

async function captureFixtureSourceCase(browser, viewport, caseName, name) {
  const page = await newPage(browser, viewport);
  const cssHref = new URL("assets/styles.css", baseUrl).toString();
  await page.setContent(
    `<!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="stylesheet" href="${cssHref}" />
      </head>
      <body>
        <main class="layout">
          <section class="content-shell rank-panel">
            <div class="rank-row proof-row">
              <span class="rank-number">01</span>
              <div class="rank-content">
                <h2 class="rank-title">UI Proof Source Fixture <span class="niche-badge">小众</span></h2>
                <div class="rank-subline"><span class="subline-primary">Proof Artist</span></div>
              </div>
              <div class="rank-side"><span class="rank-count"><span class="rank-count-value">1次</span></span></div>
              ${fixtureSourceStripHtml(caseName, viewport)}
            </div>
          </section>
        </main>
      </body>
    </html>`,
    { waitUntil: "networkidle" },
  );
  if (caseName === "extraTimes" && name.includes("extra")) {
    await page.locator("[data-toggle-source-times]").first().evaluate((button) => {
      const target = document.getElementById(button.getAttribute("aria-controls") || "");
      button.setAttribute("aria-expanded", "true");
      if (target) target.hidden = false;
    });
    await sleep(100);
  }
  await assertFixtureSourceProof(page, caseName, name);
  const row = page.locator(".proof-row").first();
  await saveElement(page, row, name, {
    minBytes: caseName === "none" ? 3_000 : 4_000,
    viewport,
    params: { fixture: caseName },
    selector: ".proof-row",
    scene: `fixture-${caseName}`,
  });
  await page.close();
}

async function assertFixtureSourceProof(page, caseName, label) {
  const shape = await page.locator(".proof-row").first().evaluate((node) => {
    const visible = (target) => {
      if (!target) return false;
      const box = target.getBoundingClientRect();
      const style = getComputedStyle(target);
      return !target.hidden && style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    const items = Array.from(node.querySelectorAll(".source-inline-item")).map((item) => {
      const thumb = item.querySelector(".source-inline-thumb");
      const channel = item.querySelector(".source-inline-channel");
      const time = item.querySelector(".source-inline-time");
      const more = item.querySelector(".source-inline-time-more");
      const extra = item.querySelector(".source-inline-extra-times");
      return {
        width: item.getBoundingClientRect().width,
        thumbWidth: thumb?.getBoundingClientRect().width || 0,
        thumbHeight: thumb?.getBoundingClientRect().height || 0,
        channelWidth: channel?.getBoundingClientRect().width || 0,
        channelText: channel?.textContent || "",
        timeText: time?.textContent || "",
        timeVisible: visible(time),
        timeScrollWidth: time?.scrollWidth || 0,
        timeClientWidth: time?.clientWidth || 0,
        extraButtonText: more?.textContent || "",
        extraButtonExpanded: more?.getAttribute("aria-expanded") || "",
        extraHidden: extra?.hidden ?? null,
        extraTimeTexts: Array.from(extra?.querySelectorAll(".source-inline-extra-time") || []).map((link) => link.textContent || ""),
        publishedAt: item.dataset.publishedAt || "",
      };
    });
    const copyAll = node.querySelector(".source-inline-copy-all");
    const moreButton = node.querySelector(".source-inline-more");
    return {
      sourceVideoCount: Number(node.querySelector(".source-inline-strip")?.dataset.sourceVideoCount || 0),
      inlineVisibleCount: Number(node.querySelector(".source-inline-strip")?.dataset.inlineVisibleCount || 0),
      emptyVisible: visible(node.querySelector(".source-inline-empty")),
      items,
      moreText: moreButton?.textContent || "",
      moreWidth: moreButton?.getBoundingClientRect().width || 0,
      copyAllWidth: copyAll?.getBoundingClientRect().width || 0,
      thumbCount: node.querySelectorAll(".source-inline-thumb-image").length,
      overlayCount: node.querySelectorAll(".source-inline-time-overlay").length,
      overflow: document.body.scrollWidth > document.documentElement.clientWidth,
    };
  });
  if (shape.overflow) throw new Error(`${label} fixture overflow: ${JSON.stringify(shape)}`);
  if (caseName === "none") {
    if (shape.sourceVideoCount !== 0 || !shape.emptyVisible || shape.items.length !== 0) throw new Error(`${label} none fixture invalid: ${JSON.stringify(shape)}`);
    return;
  }
  if (shape.items.length !== shape.inlineVisibleCount || shape.thumbCount !== shape.items.length || shape.overlayCount !== 0) {
    throw new Error(`${label} fixture source count invalid: ${JSON.stringify(shape)}`);
  }
  if (shape.overlayCount !== 0) throw new Error(`${label} overlay should not exist: ${JSON.stringify(shape)}`);
  if (
    shape.items.some(
      (item) =>
        item.thumbWidth < 46 ||
        item.thumbWidth > 56 ||
        item.thumbHeight < 27 ||
        item.thumbHeight > 32 ||
        !item.timeVisible ||
        !item.timeText ||
        item.timeScrollWidth > item.timeClientWidth + 1 ||
        item.channelWidth < 28 ||
        !item.channelText,
    )
  ) {
    throw new Error(`${label} fixture geometry invalid: ${JSON.stringify(shape)}`);
  }
  if (caseName === "longTime" && !shape.items.some((item) => item.timeText === "12:34:56")) {
    throw new Error(`${label} long time missing: ${JSON.stringify(shape)}`);
  }
  if (caseName === "extraTimes") {
    const first = shape.items[0];
    if (!first.extraButtonText.includes("+88")) throw new Error(`${label} extra time button missing: ${JSON.stringify(shape)}`);
    if (label.includes("extra-times") && (first.extraButtonExpanded !== "true" || first.extraHidden !== false || first.extraTimeTexts.length !== 3)) {
      throw new Error(`${label} expanded extra times invalid: ${JSON.stringify(shape)}`);
    }
  }
  if (caseName === "newToOld") {
    const dates = shape.items.map((item) => Date.parse(item.publishedAt));
    if (dates.some((value) => !Number.isFinite(value)) || dates.some((value, index) => index > 0 && value > dates[index - 1])) {
      throw new Error(`${label} source order is not new-to-old: ${JSON.stringify(shape)}`);
    }
  }
  if (shape.sourceVideoCount > shape.inlineVisibleCount) {
    if (shape.moreText !== "查看全部来源" || shape.moreWidth < 68 || shape.copyAllWidth !== 0) {
      throw new Error(`${label} fixture more action invalid: ${JSON.stringify(shape)}`);
    }
    return;
  }
  if (shape.sourceVideoCount > 1 && (shape.copyAllWidth < 26 || shape.copyAllWidth > 32)) {
    throw new Error(`${label} fixture copy action invalid: ${JSON.stringify(shape)}`);
  }
}

function rangeFixtureModels() {
  const future = proofFixture.rangeCases || {};
  return [future["7d"], future.all].filter(Boolean);
}

function rangeFixtureHtml(activeRange) {
  const ranges = rangeFixtureModels();
  const active = ranges.find((range) => range.id === activeRange);
  if (!active) throw new Error(`unknown range fixture: ${activeRange}`);
  return `
    <section class="controls proof-range-fixture" id="controls" aria-label="Range fixture">
      <div class="controls-inner">
        <div class="segmented range-mode" role="group" aria-label="范围">
          ${ranges
            .map(
              (range) =>
                `<button class="tab${range.id === activeRange ? " active" : ""}" type="button" data-range="${escapeHtml(range.id)}" aria-pressed="${range.id === activeRange ? "true" : "false"}">${escapeHtml(range.label)}</button>`,
            )
            .join("")}
        </div>
        <div class="segmented view-mode" role="group" aria-label="视图">
          <button class="tab active" type="button" aria-pressed="true">歌曲</button>
          <button class="tab" type="button" aria-pressed="false">歌手</button>
          <button class="tab" type="button" aria-pressed="false">索引</button>
          <button class="tab" type="button" aria-pressed="false">视频</button>
        </div>
        <button class="query-trigger has-active-query" id="queryTrigger" type="button" aria-label="打开搜索与筛选">
          <svg class="query-trigger-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m21 21-5.2-5.2M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4Z" /></svg>
          <span class="query-trigger-text">${escapeHtml(active.title)} proof</span>
        </button>
      </div>
      <div class="summary" id="summary">
        <div class="summary-main">
          <span class="summary-metrics">
            <span>${escapeHtml(active.label)}</span>
            <span>${escapeHtml(active.itemCount)}个视频</span>
            <span>${escapeHtml(active.runtimePath)}</span>
          </span>
        </div>
      </div>
    </section>
  `;
}

async function captureRangeFixtureCase(browser, viewport, rangeId, name) {
  const page = await newPage(browser, viewport);
  const cssHref = new URL("assets/styles.css", baseUrl).toString();
  await page.setContent(
    `<!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="stylesheet" href="${cssHref}" />
      </head>
      <body>
        <main class="layout">
          ${rangeFixtureHtml(rangeId)}
        </main>
      </body>
    </html>`,
    { waitUntil: "networkidle" },
  );
  await assertRangeFixtureProof(page, rangeId, name);
  await saveElement(page, page.locator(".proof-range-fixture").first(), name, {
    minBytes: 5_000,
    viewport,
    params: { fixture: "range", range: rangeId },
    selector: ".proof-range-fixture",
    scene: `fixture-range-${rangeId}`,
  });
  await page.close();
}

async function assertRangeFixtureProof(page, rangeId, label) {
  const shape = await page.locator(".proof-range-fixture").first().evaluate((node, expectedRange) => {
    const active = node.querySelector(".range-mode .tab[aria-pressed='true']");
    const buttons = Array.from(node.querySelectorAll(".range-mode .tab")).map((button) => ({
      range: button.dataset.range || "",
      text: button.textContent.trim(),
      pressed: button.getAttribute("aria-pressed") || "",
      width: button.getBoundingClientRect().width,
    }));
    return {
      buttons,
      activeRange: active?.dataset.range || "",
      activeText: active?.textContent?.trim() || "",
      summaryText: node.querySelector("#summary")?.textContent || "",
      expectedRange,
      overflow: document.body.scrollWidth > document.documentElement.clientWidth,
    };
  }, rangeId);
  if (shape.overflow) throw new Error(`${label} range fixture overflow: ${JSON.stringify(shape)}`);
  if (shape.activeRange !== rangeId || shape.buttons.length !== 2 || !shape.buttons.some((button) => button.range === "7d") || !shape.buttons.some((button) => button.range === "all")) {
    throw new Error(`${label} range fixture invalid: ${JSON.stringify(shape)}`);
  }
  if (!shape.summaryText.includes(rangeId === "7d" ? "7d" : "all") && !shape.summaryText.includes(shape.activeText)) {
    throw new Error(`${label} range summary invalid: ${JSON.stringify(shape)}`);
  }
}

function dataIndexRowsHtml(kind) {
  const fixture = proofFixture.dataIndexCase || {};
  if (kind === "partition-pagination") {
    return (fixture.partitions || [])
      .map(
        (entry, index) => `
        <div class="rank-row proof-index-row" data-proof-index-kind="partition">
          <span class="rank-number">${String(index + 1).padStart(2, "0")}</span>
          <div class="rank-content">
            <h2 class="rank-title">${escapeHtml(entry.range)} 分片分页</h2>
            <div class="rank-subline"><span class="subline-primary">${escapeHtml(entry.path)}</span></div>
          </div>
          <div class="rank-side"><span class="rank-count"><span class="rank-count-value">${escapeHtml(entry.page)}/${escapeHtml(entry.pageCount)}</span></span></div>
        </div>`,
      )
      .join("");
  }
  const searchRows = (fixture.searchIndexes || [])
    .map(
      (entry, index) => `
      <div class="rank-row proof-index-row" data-proof-index-kind="search">
        <span class="rank-number">S${index + 1}</span>
        <div class="rank-content">
          <h2 class="rank-title">${escapeHtml(entry.scope)} 搜索索引</h2>
          <div class="rank-subline"><span class="subline-primary">${escapeHtml(entry.key)}</span></div>
        </div>
        <div class="rank-side"><span class="rank-count"><span class="rank-count-value">${escapeHtml(entry.terms.length)}词</span></span></div>
      </div>`,
    )
    .join("");
  const snapshotRows = (fixture.snapshotIndex || [])
    .map(
      (entry, index) => `
      <div class="rank-row proof-index-row" data-proof-index-kind="snapshot">
        <span class="rank-number">H${index + 1}</span>
        <div class="rank-content">
          <h2 class="rank-title">${escapeHtml(entry.id)} 快照索引</h2>
          <div class="rank-subline"><span class="subline-primary">${escapeHtml(entry.path)}</span></div>
        </div>
        <div class="rank-side"><span class="rank-count"><span class="rank-count-value">${escapeHtml(entry.generatedAt.slice(11, 16))}</span></span></div>
      </div>`,
    )
    .join("");
  return `${searchRows}${snapshotRows}`;
}

async function captureDataIndexFixtureCase(browser, viewport, kind, name) {
  const page = await newPage(browser, viewport);
  const cssHref = new URL("assets/styles.css", baseUrl).toString();
  await page.setContent(
    `<!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="stylesheet" href="${cssHref}" />
      </head>
      <body>
        <main class="layout">
          <section class="content-shell rank-panel proof-data-index-fixture" data-proof-index-kind="${escapeHtml(kind)}">
            ${dataIndexRowsHtml(kind)}
          </section>
        </main>
      </body>
    </html>`,
    { waitUntil: "networkidle" },
  );
  await assertDataIndexFixtureProof(page, kind, name);
  await saveElement(page, page.locator(".proof-data-index-fixture").first(), name, {
    minBytes: 5_000,
    viewport,
    params: { fixture: kind },
    selector: ".proof-data-index-fixture",
    scene: `fixture-${kind}`,
  });
  await page.close();
}

async function assertDataIndexFixtureProof(page, kind, label) {
  const shape = await page.locator(".proof-data-index-fixture").first().evaluate((node, expectedKind) => {
    const rows = Array.from(node.querySelectorAll(".proof-index-row")).map((row) => ({
      kind: row.dataset.proofIndexKind || "",
      text: row.textContent.trim(),
    }));
    return {
      expectedKind,
      rows,
      overflow: document.body.scrollWidth > document.documentElement.clientWidth,
    };
  }, kind);
  if (shape.overflow) throw new Error(`${label} data index fixture overflow: ${JSON.stringify(shape)}`);
  if (kind === "partition-pagination") {
    if (shape.rows.length !== 2 || shape.rows.some((row) => row.kind !== "partition") || !shape.rows.every((row) => /page-\d{3}/u.test(row.text))) {
      throw new Error(`${label} partition fixture invalid: ${JSON.stringify(shape)}`);
    }
    return;
  }
  if (shape.rows.filter((row) => row.kind === "search").length < 2 || shape.rows.filter((row) => row.kind === "snapshot").length < 3) {
    throw new Error(`${label} search/snapshot fixture invalid: ${JSON.stringify(shape)}`);
  }
}

function trendFixtureCases() {
  return {
    countIncrease: {
      title: "收录增长优先展示",
      artist: "Trend Proof Artist",
      count: "12次",
      trend: { rankDelta: 7, countDelta: 12 },
      expectedText: "收录+12",
      expectedKind: "increase",
    },
    rankOnlyDown: {
      title: "名次相对下滑",
      artist: "Rank Proof Artist",
      count: "4次",
      trend: { rankDelta: -1, countDelta: 0 },
      expectedText: "名次↓1",
      expectedKind: "down",
    },
    correctedDecrease: {
      title: "收录修正减少",
      artist: "Correction Proof Artist",
      count: "3次",
      trend: { rankDelta: 0, countDelta: -2 },
      expectedText: "修正−2",
      expectedKind: "decrease",
    },
  };
}

function rankRowProofHtml({ rank = "01", title, artist, count = "1次", trendModel = null, subline = "" }) {
  return `
    <div class="rank-row proof-row">
      <span class="rank-number">${escapeHtml(rank)}</span>
      <div class="rank-content">
        <h2 class="rank-title">${escapeHtml(title)} <span class="niche-badge">小众</span></h2>
        <div class="rank-subline"><span class="subline-primary">${escapeHtml(artist)}</span>${subline ? `<span>${escapeHtml(subline)}</span>` : ""}</div>
      </div>
      <div class="rank-side">
        <div class="rank-side-top">
          <span class="rank-count"><span class="rank-count-value">${escapeHtml(count)}</span></span>
          ${
            trendModel
              ? `<span class="trend-badge trend-${escapeHtml(trendModel.kind)}" title="${escapeHtml(trendModel.title)}" aria-label="${escapeHtml(trendModel.ariaLabel)}">${escapeHtml(trendModel.text)}</span>`
              : ""
          }
        </div>
      </div>
    </div>
  `;
}

async function captureTrendFixtureCase(browser, viewport, caseName, name) {
  const proof = trendFixtureCases()[caseName];
  if (!proof) throw new Error(`unknown trend proof fixture: ${caseName}`);
  const model = trendDisplayModel(proof.trend);
  if (!model || model.text !== proof.expectedText || model.kind !== proof.expectedKind) {
    throw new Error(`trend proof model mismatch: ${caseName} ${JSON.stringify(model)}`);
  }
  const page = await newPage(browser, viewport);
  const cssHref = new URL("assets/styles.css", baseUrl).toString();
  await page.setContent(
    `<!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="stylesheet" href="${cssHref}" />
      </head>
      <body>
        <main class="layout">
          <section class="content-shell rank-panel proof-trend-fixture" data-proof-trend="${escapeHtml(caseName)}">
            ${rankRowProofHtml({ rank: "07", title: proof.title, artist: proof.artist, count: proof.count, trendModel: model })}
          </section>
        </main>
      </body>
    </html>`,
    { waitUntil: "networkidle" },
  );
  await assertTrendFixtureProof(page, proof, name);
  await saveElement(page, page.locator(".proof-trend-fixture").first(), name, {
    minBytes: 4_000,
    viewport,
    params: { fixture: "trend", case: caseName },
    selector: ".proof-trend-fixture",
    scene: `fixture-trend-${caseName}`,
  });
  await page.close();
}

async function assertTrendFixtureProof(page, proof, label) {
  const shape = await page.locator(".proof-trend-fixture").first().evaluate((node) => {
    const badge = node.querySelector(".trend-badge");
    return {
      text: badge?.textContent?.trim() || "",
      className: badge?.className || "",
      title: badge?.getAttribute("title") || "",
      ariaLabel: badge?.getAttribute("aria-label") || "",
      badgeWidth: badge?.getBoundingClientRect().width || 0,
      badgeScrollWidth: badge?.scrollWidth || 0,
      badgeClientWidth: badge?.clientWidth || 0,
      overflow: document.body.scrollWidth > document.documentElement.clientWidth,
    };
  });
  if (shape.overflow || shape.text !== proof.expectedText || !shape.className.includes(`trend-${proof.expectedKind}`)) {
    throw new Error(`${label} trend fixture invalid: ${JSON.stringify(shape)}`);
  }
  if (shape.badgeScrollWidth > shape.badgeClientWidth + 1 || shape.badgeWidth < 34) {
    throw new Error(`${label} trend badge clips: ${JSON.stringify(shape)}`);
  }
}

function identityMergeRecords() {
  return buildSongRecords([
    identityOccurrence("花に亡霊", "ヨルシカ", "proofA"),
    identityOccurrence("花に亡霊", "Yorushika", "proofB"),
    identityOccurrence("少女レイ", "みきとP", "proofC"),
    identityOccurrence("少女レイ", "MikitoP", "proofD"),
    identityOccurrence("からくりピエロ", "みきとP", "proofE"),
    identityOccurrence("からくりピエロ", "MikitoP feat. 初音ミク", "proofF"),
  ]);
}

function identityOccurrence(title, artist, videoId) {
  return {
    item: {
      videoId,
      title: `Identity proof ${videoId}`,
      channelName: "Identity Proof Channel",
      publishedTimestamp: Date.parse("2026-07-16T12:00:00Z"),
    },
    song: {
      title,
      artist,
      seconds: 60,
      time: "1:00",
    },
  };
}

async function captureIdentityMergeFixtureCase(browser, viewport, name) {
  const records = identityMergeRecords();
  const mergedRecords = records.filter((record) => record.count === 2 && ["花に亡霊", "少女レイ"].includes(record.title));
  const protectedRecords = records.filter((record) => record.title === "からくりピエロ");
  if (mergedRecords.length !== 2 || protectedRecords.length !== 2) {
    throw new Error(`identity merge proof invalid: ${JSON.stringify(records.map((record) => ({ title: record.title, count: record.count })))}`);
  }
  const page = await newPage(browser, viewport);
  const cssHref = new URL("assets/styles.css", baseUrl).toString();
  await page.setContent(
    `<!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="stylesheet" href="${cssHref}" />
      </head>
      <body>
        <main class="layout">
          <section class="content-shell rank-panel proof-identity-fixture">
            ${rankRowProofHtml({ rank: "01", title: "花に亡霊", artist: "ヨルシカ / Yorushika", count: "2次", subline: "同名歌曲合并" })}
            ${rankRowProofHtml({ rank: "02", title: "少女レイ", artist: "みきとP / MikitoP", count: "2次", subline: "假名与罗马音合并" })}
            ${rankRowProofHtml({ rank: "03", title: "からくりピエロ", artist: "feat 身份保持拆分", count: "1次", subline: "不跨身份误合并" })}
          </section>
        </main>
      </body>
    </html>`,
    { waitUntil: "networkidle" },
  );
  await assertIdentityMergeFixtureProof(page, name);
  await saveElement(page, page.locator(".proof-identity-fixture").first(), name, {
    minBytes: 8_000,
    viewport,
    params: { fixture: "identity-merge" },
    selector: ".proof-identity-fixture",
    scene: "fixture-identity-merge",
  });
  await page.close();
}

async function assertIdentityMergeFixtureProof(page, label) {
  const shape = await page.locator(".proof-identity-fixture").first().evaluate((node) => ({
    rows: Array.from(node.querySelectorAll(".rank-row")).map((row) => row.textContent.trim()),
    overflow: document.body.scrollWidth > document.documentElement.clientWidth,
  }));
  if (shape.overflow || shape.rows.length !== 3 || !shape.rows[0].includes("2次") || !shape.rows[2].includes("不跨身份误合并")) {
    throw new Error(`${label} identity merge fixture invalid: ${JSON.stringify(shape)}`);
  }
}

function allSummaryFixtureHtml() {
  const all = proofFixture.rangeCases?.all || {};
  const seven = proofFixture.rangeCases?.["7d"] || {};
  return `
    <section class="controls proof-all-summary-fixture" id="controls" aria-label="All range summary proof">
      <div class="controls-inner">
        <div class="segmented range-mode" role="group" aria-label="范围">
          <button class="tab" type="button" data-range="7d" aria-pressed="false">${escapeHtml(seven.label || "最近7天")}</button>
          <button class="tab active" type="button" data-range="all" aria-pressed="true">${escapeHtml(all.label || "全量累计")}</button>
        </div>
        <button class="query-trigger" id="queryTrigger" type="button" aria-label="打开搜索与筛选">
          <svg class="query-trigger-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m21 21-5.2-5.2M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4Z" /></svg>
        </button>
      </div>
      <div class="summary" id="summary">
        <div class="summary-main">
          <span class="summary-title">歌曲榜</span>
          <span class="summary-metrics">
            <span>全量累计</span>
            <span>${escapeHtml(all.itemCount || "1461")}个视频</span>
            <span>永久快照不清理</span>
          </span>
        </div>
        <p class="summary-note">子集刷新保留旧歌单，原始 occurrence 不回退。</p>
      </div>
    </section>
  `;
}

async function captureAllSummaryFixtureCase(browser, viewport, name) {
  const page = await newPage(browser, viewport);
  const cssHref = new URL("assets/styles.css", baseUrl).toString();
  await page.setContent(
    `<!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="stylesheet" href="${cssHref}" />
      </head>
      <body>
        <main class="layout">${allSummaryFixtureHtml()}</main>
      </body>
    </html>`,
    { waitUntil: "networkidle" },
  );
  await assertAllSummaryFixtureProof(page, name);
  await saveElement(page, page.locator(".proof-all-summary-fixture").first(), name, {
    minBytes: 5_000,
    viewport,
    params: { fixture: "all-summary" },
    selector: ".proof-all-summary-fixture",
    scene: "fixture-all-monotonic-summary",
  });
  await page.close();
}

async function assertAllSummaryFixtureProof(page, label) {
  const shape = await page.locator(".proof-all-summary-fixture").first().evaluate((node) => ({
    text: node.textContent.trim(),
    height: node.getBoundingClientRect().height,
    overflow: document.body.scrollWidth > document.documentElement.clientWidth,
  }));
  if (shape.overflow || !shape.text.includes("全量累计") || !shape.text.includes("子集刷新保留旧歌单") || shape.height > 220) {
    throw new Error(`${label} all summary fixture invalid: ${JSON.stringify(shape)}`);
  }
}

function diagnosticFixtureHtml(kind) {
  if (kind === "video") {
    return `
      <section class="content-shell rank-panel proof-diagnostic-fixture" data-proof-diagnostic="video">
        ${rankRowProofHtml({ rank: "ID", title: "VmLgly38CwY 已进入候选与 catalog", artist: "diagnose:video", count: "OK", subline: "search renderer / comments / runtime shard" })}
        ${rankRowProofHtml({ rank: "ST", title: "firstFailureStage: no_failure_currently_recorded", artist: "诊断输出保留搜索与原始评论证据", count: "1份" })}
      </section>
    `;
  }
  return `
    <section class="content-shell rank-panel proof-diagnostic-fixture" data-proof-diagnostic="diff">
      ${rankRowProofHtml({ rank: "DF", title: "累计差异解释", artist: "explain:diff --range all", count: "all" })}
      ${rankRowProofHtml({ rank: "RG", title: "incoming_strict_song_subset 会保留旧歌单", artist: "catalog regression audit", count: "safe" })}
    </section>
  `;
}

async function captureDiagnosticFixtureCase(browser, viewport, kind, name) {
  const page = await newPage(browser, viewport);
  const cssHref = new URL("assets/styles.css", baseUrl).toString();
  await page.setContent(
    `<!doctype html>
    <html lang="zh-CN">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="stylesheet" href="${cssHref}" />
      </head>
      <body>
        <main class="layout">${diagnosticFixtureHtml(kind)}</main>
      </body>
    </html>`,
    { waitUntil: "networkidle" },
  );
  await assertDiagnosticFixtureProof(page, kind, name);
  await saveElement(page, page.locator(".proof-diagnostic-fixture").first(), name, {
    minBytes: 6_000,
    viewport,
    params: { fixture: kind === "video" ? "video-diagnostic" : "diff-explanation" },
    selector: ".proof-diagnostic-fixture",
    scene: kind === "video" ? "fixture-video-diagnostic" : "fixture-diff-explanation",
  });
  await page.close();
}

async function assertDiagnosticFixtureProof(page, kind, label) {
  const shape = await page.locator(".proof-diagnostic-fixture").first().evaluate((node) => ({
    kind: node.dataset.proofDiagnostic || "",
    text: node.textContent.trim(),
    overflow: document.body.scrollWidth > document.documentElement.clientWidth,
  }));
  const requiredText = kind === "video" ? "VmLgly38CwY" : "incoming_strict_song_subset";
  if (shape.overflow || shape.kind !== kind || !shape.text.includes(requiredText)) {
    throw new Error(`${label} diagnostic fixture invalid: ${JSON.stringify(shape)}`);
  }
}

async function assertFilteredSummaryCopy(page) {
  const shape = await page.evaluate(() => {
    const summary = document.querySelector("#summary");
    return {
      text: summary?.textContent || "",
      lineHeight: Number.parseFloat(getComputedStyle(summary).lineHeight) || 16,
      height: summary?.getBoundingClientRect().height || 0,
    };
  });
  if (/首结果|[0-9,]+视频/u.test(shape.text) || !/[0-9,]+首歌曲/u.test(shape.text) || !/[0-9,]+ 条歌曲收录/u.test(shape.text)) {
    throw new Error(`filtered summary copy invalid: ${JSON.stringify(shape)}`);
  }
  if (shape.height > shape.lineHeight * 2.8) throw new Error(`filtered summary too tall: ${JSON.stringify(shape)}`);
}

async function assertMobileControlsCompact(page) {
  const shape = await page.evaluate(() => {
    const rectFor = (node) => {
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        top: box.top,
        bottom: box.bottom,
        width: box.width,
        height: box.height,
        paddingTop: Number.parseFloat(style.paddingTop) || 0,
        paddingBottom: Number.parseFloat(style.paddingBottom) || 0,
      };
    };
    const controls = document.querySelector(".controls");
    const range = document.querySelector(".range-mode");
    const trigger = document.querySelector("#queryTrigger");
    const next = document.querySelector("#activeQueryStrip:not([hidden]), #summary");
    return {
      controls: controls ? rectFor(controls) : null,
      range: range ? rectFor(range) : null,
      trigger: trigger ? rectFor(trigger) : null,
      next: next ? rectFor(next) : null,
      scrollWidth: document.body.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });
  if (!shape.controls || !shape.range || !shape.trigger) throw new Error(`mobile controls missing: ${JSON.stringify(shape)}`);
  if (shape.controls.height > 48 || shape.controls.paddingTop > 6 || shape.controls.paddingBottom > 6) {
    throw new Error(`mobile controls too large: ${JSON.stringify(shape)}`);
  }
  if (Math.abs(shape.range.height - shape.trigger.height) > 1) throw new Error(`mobile controls height mismatch: ${JSON.stringify(shape)}`);
  if (shape.next && shape.next.top - shape.controls.bottom > 8) throw new Error(`mobile controls gap too large: ${JSON.stringify(shape)}`);
  if (shape.scrollWidth > shape.clientWidth) throw new Error(`mobile controls overflow: ${JSON.stringify(shape)}`);
}

async function assertBottomNavIconSelection(page) {
  const shape = await page.evaluate(() => {
    const active = document.querySelector(".bottom-nav-item[aria-current='page']");
    const wrap = active?.querySelector(".bottom-nav-icon-wrap");
    const itemBox = active?.getBoundingClientRect();
    const wrapBox = wrap?.getBoundingClientRect();
    return {
      itemWidth: itemBox?.width || 0,
      itemHeight: itemBox?.height || 0,
      wrapWidth: wrapBox?.width || 0,
      wrapHeight: wrapBox?.height || 0,
      activeText: active?.textContent?.trim() || "",
    };
  });
  if (shape.itemHeight < 42 || shape.wrapWidth < 28 || shape.wrapWidth > shape.itemWidth * 0.65 || shape.wrapHeight > 28) {
    throw new Error(`bottom nav active geometry invalid: ${JSON.stringify(shape)}`);
  }
}

function publishScreenshots() {
  const generatedAt = new Date().toISOString();
  const proofInputs = proofInputEntries();
  const currentProofInputHash = proofInputHash(proofInputs);
  const screenshots = expectedScreenshots.map((name) => {
    const record = screenshotRecords.get(name);
    if (!record) throw new Error(`missing screenshot record: ${name}`);
    return record;
  });
  const manifest = {
    schemaVersion: 1,
    kind: "daily-song-list-ui-proof",
    generatedAt,
    generatedBy: "scripts/capture-readme-screenshots.js",
    baseUrl,
    proofInputHash: currentProofInputHash,
    uiSourceFingerprint: currentProofInputHash,
    proofInputs,
    screenshots,
  };
  const missingFiles = expectedScreenshots.filter((name) => !fs.existsSync(path.join(workDir, name)));
  if (missingFiles.length) {
    throw new Error(`missing generated screenshot files before publish: ${missingFiles.join(", ")}`);
  }
  for (const name of expectedScreenshots) {
    publishFileWithRetry(path.join(workDir, name), path.join(outputDir, name));
  }
  const tempManifest = path.join(outputDir, `manifest.${process.pid}.tmp`);
  fs.writeFileSync(tempManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(tempManifest, path.join(outputDir, "manifest.json"));
  const validation = validateUiProof({ silent: true });
  if (!validation.ok) throw new Error(`generated UI proof failed validation: ${validation.errors.join("; ")}`);
  fs.rmSync(workDir, { recursive: true, force: true });
  return manifest;
}

function publishFileWithRetry(source, destination) {
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.rmSync(destination, { force: true });
      fs.copyFileSync(source, destination);
      return;
    } catch (error) {
      lastError = error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80 * (attempt + 1));
    }
  }
  throw lastError;
}

async function main() {
  const browser = await chromium.launch();
  const desktop = { width: 1440, height: 900 };
  const desktopWide = { width: 1366, height: 768 };
  const tablet = { width: 820, height: 900 };
  const mobile = { width: 390, height: 844 };

  try {
    await openPage(browser, desktop, {}, "desktop-song-rank.png");
    await captureElementFromPage(browser, desktop, {}, "#summary", "desktop-summary-baseline.png", {
      assert: assertSummaryBaseline,
      minBytes: 1_500,
      scene: "desktop-summary-baseline",
      selector: "#summary",
    });
    await openPage(browser, desktopWide, { range: "1m" }, /* auto */     "desktop-monthly-song-rank.png", {
      scene: "desktop-all-range-song-rank",
    });
    await openPage(browser, desktop, { view: "artistRank" }, "desktop-artist-rank.png");
    await openPage(browser, desktop, { view: "songAz" }, "desktop-song-index.png");
    await captureRangeFixtureCase(browser, desktop, "7d", "desktop-range-7d.png");
    await captureRangeFixtureCase(browser, desktop, "all", "desktop-range-all.png");
    await captureDiagnosticFixtureCase(browser, desktop, "diff", "desktop-all-diff-explanation.png");
    await openPage(browser, desktopWide, { view: "videos" }, "desktop-video-view.png");
    await captureQueryPanel(browser, desktop, "desktop-query-panel.png", { filterTab: true, scene: "desktop-unified-query-panel" });
    await captureExpandedSource(browser, desktop, {}, "desktop-source-expanded.png");
    await captureIdentityMergeFixtureCase(browser, desktop, "desktop-song-kana-romaji-merged.png");
    await captureFixtureSourceCase(browser, desktop, "triple", "desktop-source-inline-3.png");
    await captureDataIndexFixtureCase(browser, desktop, "partition-pagination", "desktop-partition-pagination.png");
    await captureDataIndexFixtureCase(browser, desktop, "search-snapshot-index", "desktop-search-snapshot-index.png");
    await captureFixtureSourceCase(browser, desktop, "longTime", "desktop-source-long-time.png");
    await captureFixtureSourceCase(browser, tablet, "triple", "tablet-source-inline-3.png");

    await openPage(browser, mobile, {}, "mobile-song-rank.png");
    await captureElementFromPage(browser, mobile, {}, "#summary", "mobile-summary-baseline.png", {
      assert: assertSummaryBaseline,
      minBytes: 1_200,
      scene: "mobile-summary-baseline",
      selector: "#summary",
    });
    await captureAllSummaryFixtureCase(browser, mobile, "mobile-all-monotonic-summary.png");
    await captureTrendFixtureCase(browser, mobile, "countIncrease", "mobile-trend-count-increase.png");
    await captureTrendFixtureCase(browser, mobile, "rankOnlyDown", "mobile-trend-rank-only-down.png");
    await captureTrendFixtureCase(browser, mobile, "correctedDecrease", "mobile-trend-corrected-decrease.png");
    await captureIdentityMergeFixtureCase(browser, mobile, "mobile-song-kana-romaji-merged.png");
    await captureDiagnosticFixtureCase(browser, mobile, "video", "mobile-video-diagnostic-result.png");
    await openPage(browser, mobile, { view: "artistRank" }, "mobile-artist-rank.png");
    await openPage(browser, mobile, { view: "songAz" }, "mobile-song-index.png");
    await captureSongIndexPage(browser, mobile, "middle", "mobile-song-index-middle-page.png");
    await captureSongIndexPage(browser, mobile, "last", "mobile-song-index-last-page.png");
    await openPage(browser, mobile, { view: "videos" }, "mobile-video-view.png");
    await captureExpandedVideo(browser, mobile, "mobile-video-expanded.png");
    await captureExpandedVideo(browser, mobile, "mobile-video-expanded-bottom.png", {
      scrollBottom: true,
      scene: "mobile-video-expanded-bottom",
    });
    await openPage(browser, { width: 320, height: 700 }, { page: 7 }, /* auto */     "mobile-pagination-320.png");
    await captureElementFromPage(browser, mobile, { view: "videos" }, "#mobileBottomNav", "mobile-bottom-nav-active.png", {
      assert: assertBottomNavIconSelection,
      scene: "mobile-bottom-nav-active",
      selector: "#mobileBottomNav",
    });
    await openPage(
      browser,
      mobile,
      { q: "少女レイ", hideUnknown: 1, metric: "videos", minCount: 2 },
      "mobile-active-query-strip.png",
      { scene: "mobile-restrictive-filter-chips" },
    );
    await captureToastCase(browser, mobile, "mobile-toast-copy-setlist.png");
    await captureElementFromPage(browser, mobile, { q: "少女レイ" }, "#summary", "mobile-summary-filtered.png", {
      assert: assertFilteredSummaryCopy,
      scene: "mobile-summary-filtered",
      selector: "#summary",
      minBytes: 2_500,
    });
    await captureElementFromPage(browser, mobile, { q: "少女レイ" }, ".controls", "mobile-controls-active.png", {
      assert: assertMobileControlsCompact,
      minBytes: 2_500,
      scene: "mobile-controls-active",
      selector: ".controls",
    });
    await captureQueryPanel(browser, mobile, "mobile-query-recent.png");
    await captureQueryPanel(browser, mobile, "mobile-query-suggestions.png", { searchText: "少女レイ" });
    await captureQueryPanel(browser, mobile, "mobile-query-filter.png", { filterTab: true, scene: "mobile-unified-filter-panel" });
    await captureQueryPanel(browser, mobile, "mobile-query-history.png", { openHistory: true, scrollBottom: true });
    await captureQueryPanel(browser, mobile, "mobile-query-grid-alignment.png", { filterTab: true, scene: "mobile-query-grid-alignment" });
    await captureQueryPanel(browser, mobile, "mobile-query-empty-suggestions-compact.png", {
      searchText: "zzzzzz-not-found-proof",
      expectEmptySuggestions: true,
      scene: "mobile-query-empty-suggestions-compact",
    });
    await captureQueryPanel(browser, mobile, "mobile-query-footer-alignment.png", { filterTab: true, scrollBottom: true, scene: "mobile-query-footer-alignment" });
    await captureQueryPanel(browser, mobile, "mobile-query-history-alignment.png", { openHistory: true, scene: "mobile-query-history-alignment" });
    await captureRequestState(browser, mobile, "mobile-page-request-loading.png", {
      params: { page: 2 },
      delayRequest: true,
      scene: "mobile-page-request-loading",
    });
    await captureRequestState(browser, mobile, "mobile-filter-request-loading.png", {
      params: { q: "少女レイ" },
      delayRequest: true,
      scene: "mobile-filter-request-loading",
    });
    await captureRequestState(browser, mobile, "mobile-page-request-error.png", {
      params: { page: 2 },
      failRequest: true,
      scene: "mobile-page-request-error",
    });
    await openPage(browser, desktop, { range: "all", page: 2 }, /* auto */    "desktop-request-pagination.png", {
      scene: "desktop-request-pagination",
    });
    await captureRequestState(browser, desktop, "desktop-update-failure-status.png", {
      failStatus: true,
      scene: "desktop-update-failure-status",
    });
    await captureRequestState(browser, mobile, "mobile-update-stale-reason.png", {
      failStatus: true,
      scene: "mobile-update-stale-reason",
    });
    await captureExpandedSource(browser, mobile, {}, "mobile-source-expanded.png");
    await captureFixtureSourceCase(browser, mobile, "none", "mobile-source-inline-0.png");
    await captureFixtureSourceCase(browser, mobile, "single", "mobile-source-inline-1.png");
    await captureFixtureSourceCase(browser, mobile, "double", "mobile-source-inline-2.png");
    await captureFixtureSourceCase(browser, mobile, "triple", "mobile-source-inline-3.png");
    await captureFixtureSourceCase(browser, mobile, "newToOld", "mobile-source-new-to-old.png");
    await captureSourceCase(browser, mobile, "more", "mobile-source-more-than-3.png");
    await captureSourceCase(browser, mobile, "more", "mobile-source-more-than-3-expanded.png", { expand: true, viewportOnly: true });
    await captureSourceCase(browser, mobile, "more", "mobile-source-more-than-3-expanded-bottom.png", {
      expand: true,
      viewportOnly: true,
      scrollBottom: true,
      scene: "mobile-source-more-than-3-expanded-bottom",
    });
    await captureFixtureSourceCase(browser, mobile, "fallback", "mobile-source-thumb-fallback.png");
    await captureFixtureSourceCase(browser, mobile, "longChannel", "mobile-source-long-channel.png");
    await captureFixtureSourceCase(browser, mobile, "longTime", "mobile-source-long-time.png");
    await captureFixtureSourceCase(browser, mobile, "extraTimes", "mobile-source-extra-times.png");
    await openPage(browser, desktop, { page: 7 }, /* auto */     "desktop-pagination-middle.png");
  } finally {
    await browser.close();
  }

  const expected = [...expectedScreenshots].sort();
  const generated = [...generatedScreenshots].sort();
  const missing = expected.filter((name) => !generatedScreenshots.has(name));
  const unexpected = generated.filter((name) => !expectedScreenshots.includes(name));
  if (missing.length || unexpected.length) {
    throw new Error(`README screenshot matrix mismatch missing=${missing.join(",")} unexpected=${unexpected.join(",")}`);
  }
  const manifest = publishScreenshots();
  console.log(`README_SCREENSHOTS_OK count=${generated.length} output=${outputDir} proofInputHash=${manifest.proofInputHash}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
