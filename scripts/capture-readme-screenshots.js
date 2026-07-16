const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");
const { expectedScreenshots } = require("./ui-proof-config");
const { pngDimensions, proofInputEntries, proofInputHash, sha256Buffer, validateUiProof } = require("./validate-ui-proof");
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
  const stats = fs.statSync(file);
  if (stats.size < 12_000) throw new Error(`${name} screenshot looks empty: ${stats.size} bytes`);
  generatedScreenshots.add(name);
  recordScreenshot(name, file, options);
  console.log(`README_SCREENSHOT ${name}`);
  return file;
}

async function saveElement(page, locator, name, options = {}) {
  await assertNoPageOverflow(page, name);
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
  if (params?.view === "videos") await assertVideoThumbVisible(page, name);
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
    await page.waitForSelector(".suggestion-item", { timeout: 15_000 });
    await sleep(250);
  }
  if (options.filterTab || options.openHistory || options.scrollBottom) {
    await page.locator('[data-query-panel-tab="filter"]').click({ force: true });
    await page.waitForSelector("#queryFilterPanel:not([hidden])", { timeout: 15_000 });
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
  await save(page, name, { viewport, params: options.params || {}, selector: "#queryDialog" });
  await page.close();
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
  await assertExpandedSourceVisible(page, page.locator(".rank-row.is-expanded, .index-row.is-expanded").first(), name);
  await sleep(500);
  await save(page, name, { viewport, params, selector: ".rank-row.is-expanded, .index-row.is-expanded" });
  await page.close();
}

async function findSourceCase(browser, viewport, kind) {
  const page = await newPage(browser, viewport);
  try {
    for (let pageNumber = 1; pageNumber <= 25; pageNumber += 1) {
      const params = { page: pageNumber, pageSize: 100, showUnknown: 1 };
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
    await assertExpandedSourceVisible(page, row, name);
  } else {
    await assertInlineSourceCase(page, row, kind, name);
  }
  await saveElement(page, row, name, { minBytes: kind === "single" ? 4_000 : 6_000, viewport, params: found.params, selector: `.rank-row source-${kind}` });
  await page.close();
}

async function captureSongIndexPage(browser, viewport, target, name) {
  const page = await newPage(browser, viewport);
  await page.goto(appUrl({ view: "songAz" }), { waitUntil: "networkidle" });
  await waitForApp(page);
  const pageCount = await page.evaluate(() => {
    const select = document.querySelector(".pagination-top [data-page-select], .pagination-bottom [data-page-select]");
    return select ? select.options.length : 1;
  });
  const nextPage = target === "last" ? pageCount : Math.max(1, Math.ceil(pageCount / 2));
  await page.goto(appUrl({ view: "songAz", page: nextPage }), { waitUntil: "networkidle" });
  await waitForApp(page);
  await save(page, name, { viewport, params: { view: "songAz", page: nextPage } });
  await page.close();
}

async function captureExpandedVideo(browser, viewport, name) {
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
    await sleep(350);
  } else {
    throw new Error(`${name} did not find an expandable video card`);
  }
  await save(page, name, { viewport, params: { view: "videos" }, selector: ".video-card.expanded" });
  await page.close();
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
  if (shape.display === "none" || shape.visibility === "hidden" || shape.width < 100 || shape.height < 50 || !shape.currentSrc) {
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
    const items = Array.from(node.querySelectorAll(".source-inline-item")).map((item) => {
      const channel = item.querySelector(".source-inline-channel");
      const thumb = item.querySelector(".source-inline-thumb");
      const image = item.querySelector(".source-inline-thumb-image");
      const overlay = item.querySelector(".source-inline-time-overlay");
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
        thumbLoaded: Boolean(image?.currentSrc || image?.src),
        overlayText: overlay?.textContent?.trim() || "",
        overlayVisible: visible(overlay),
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
      !shape.items[0]?.overlayVisible ||
      !shape.items[0]?.overlayText ||
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
      shape.items.some((item) => !item.visible || !item.channelVisible || item.channelWidth < 6 || !item.channelText || !item.thumbVisible || !item.thumbLoaded || !item.overlayVisible)
    ) {
      throw new Error(`${label} triple-source visibility invalid: ${JSON.stringify(shape)}`);
    }
    if (shape.items[2].width < Math.max(80, (shape.strip?.width || 0) - 44)) {
      throw new Error(`${label} triple-source tail width invalid: ${JSON.stringify(shape)}`);
    }
    return;
  }

  if (
    shape.sourceVideoCount <= 3 ||
    shape.inlineVisibleCount !== 3 ||
    shape.items.length !== 3 ||
    shape.toggleCount !== 1 ||
    shape.copyAllCount !== 0 ||
    shape.items.some((item) => !item.visible || !item.channelVisible || item.channelWidth < 6 || !item.channelText || !item.thumbVisible || !item.thumbLoaded || !item.overlayVisible) ||
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
        imgLoaded: Boolean(img?.currentSrc || img?.src),
      };
    });
    const toolbar = node.querySelector(".source-drawer:not([hidden]) .source-drawer-toolbar");
    const inlineVideoIds = Array.from(node.querySelectorAll(".source-inline-item")).map((item) => item.dataset.videoId).filter(Boolean);
    return {
      viewportWidth: document.documentElement.clientWidth,
      buttonExpanded: node.querySelector("[data-toggle-source]")?.getAttribute("aria-expanded") || "",
      remainingCount: Number(node.querySelector("[data-toggle-source]")?.dataset.remainingCount || 0),
      sourceGroupMore: node.querySelectorAll("[data-toggle-source-groups]").length,
      inlineCollapseCount: node.querySelectorAll(".source-inline-more[data-toggle-source][aria-expanded='true']").length,
      toolbarCollapseCount: node.querySelectorAll(".source-collapse-top[data-collapse-source]").length,
      bottomCollapseCount: node.querySelectorAll(".source-collapse-bottom[data-collapse-source]").length,
      copySongLinksCount: node.querySelectorAll("[data-copy-song-links]").length,
      toolbarHeight: toolbar?.getBoundingClientRect().height || 0,
      groups,
      duplicateVideoIds: groups
        .map((group) => group.videoId)
        .filter((id, index, list) => id && list.indexOf(id) !== index),
      repeatedInlineVideoIds: groups.map((group) => group.videoId).filter((id) => inlineVideoIds.includes(id)),
    };
  });
  if (
    shape.buttonExpanded !== "true" ||
    shape.groups.length !== shape.remainingCount ||
    shape.sourceGroupMore !== 0 ||
    shape.inlineCollapseCount !== 1 ||
    shape.toolbarCollapseCount !== 0 ||
    shape.bottomCollapseCount > 1 ||
    shape.copySongLinksCount !== 1 ||
    (shape.viewportWidth <= 720 && shape.toolbarHeight > 32) ||
    shape.duplicateVideoIds.length ||
    shape.repeatedInlineVideoIds.length ||
    shape.groups.some((group) => !group.channelText || !group.thumbVisible || group.thumbWidth < 50) ||
    !shape.groups[0]?.imgLoaded
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

function sourceItemHtml(group) {
  const videoId = encodeURIComponent(group.videoId || "proof");
  const seconds = Math.max(0, Number(group.seconds) || 0);
  return `
    <span class="source-inline-item" data-video-id="${escapeHtml(group.videoId || "fallback")}">
      <a class="source-inline-thumb source-link" href="https://www.youtube.com/watch?v=${videoId}&t=${seconds}s" target="_blank" rel="noreferrer" aria-label="打开来源视频时间戳：${escapeHtml(group.title)}">
        <img class="source-inline-thumb-image" alt="" loading="lazy" decoding="async" fetchpriority="low" width="56" height="32" src="${fixtureThumbSrc(group)}" />
        <span class="source-inline-time-overlay">${escapeHtml(group.time)}</span>
      </a>
      <span class="source-inline-main">
        <a class="source-inline-channel" href="https://www.youtube.com/results?search_query=${encodeURIComponent(group.channelName || "")}" target="_blank" rel="noreferrer">${escapeHtml(group.channelName)}</a>
      </span>
      <button class="source-inline-copy source-copy-icon ui-chip ui-chip-icon" type="button" data-copy-setlist="true" aria-label="复制该视频歌单">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18V5l10-2v13"/><circle cx="7" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>
      </button>
    </span>
  `;
}

function fixtureSourceStripHtml(caseName) {
  const fixture = proofFixture.sourceCases[caseName];
  if (!fixture) throw new Error(`unknown proof fixture: ${caseName}`);
  const groups = fixture.groups || [];
  const count = Number(fixture.sourceVideoCount) || groups.length;
  if (!count) {
    return '<div class="source-inline-strip source-inline-none" data-source-video-count="0" data-inline-visible-count="0"><span class="source-inline-empty">无来源</span></div>';
  }
  const hasTailAction = caseName === "triple";
  const head = hasTailAction ? groups.slice(0, 2) : groups;
  const tail = hasTailAction ? groups[2] : null;
  return `
    <div class="source-inline-strip source-inline-inline${hasTailAction ? " has-tail-action" : ""}" data-source-video-count="${count}" data-inline-visible-count="${Math.min(count, 3)}">
      <div class="source-inline-preview-rail" aria-label="来源预览">
        <div class="source-inline-preview-list">${head.map(sourceItemHtml).join("")}</div>
      </div>
      ${
        tail
          ? `<div class="source-inline-tail">${sourceItemHtml(tail)}<div class="source-inline-actions"><button class="source-inline-copy-all source-copy-icon ui-chip ui-chip-icon" type="button" data-copy-song-links="true" title="复制全部链接" aria-label="复制同一首歌全部来源时间点链接"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l2-2a5 5 0 0 0-7.07-7.07l-1.15 1.15"/><path d="M14 11a5 5 0 0 0-7.54-.54l-2 2a5 5 0 0 0 7.07 7.07l1.15-1.15"/></svg></button></div></div>`
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
              ${fixtureSourceStripHtml(caseName)}
            </div>
          </section>
        </main>
      </body>
    </html>`,
    { waitUntil: "networkidle" },
  );
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
      const overlay = item.querySelector(".source-inline-time-overlay");
      const channel = item.querySelector(".source-inline-channel");
      return {
        width: item.getBoundingClientRect().width,
        thumbWidth: thumb?.getBoundingClientRect().width || 0,
        thumbHeight: thumb?.getBoundingClientRect().height || 0,
        overlayText: overlay?.textContent || "",
        overlayVisible: visible(overlay),
        channelWidth: channel?.getBoundingClientRect().width || 0,
        channelText: channel?.textContent || "",
      };
    });
    const copyAll = node.querySelector(".source-inline-copy-all");
    return {
      sourceVideoCount: Number(node.querySelector(".source-inline-strip")?.dataset.sourceVideoCount || 0),
      emptyVisible: visible(node.querySelector(".source-inline-empty")),
      items,
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
  if (shape.items.length !== shape.sourceVideoCount || shape.thumbCount !== shape.items.length || shape.overlayCount !== shape.items.length) {
    throw new Error(`${label} fixture source count invalid: ${JSON.stringify(shape)}`);
  }
  if (shape.items.some((item) => item.thumbWidth < 46 || item.thumbWidth > 56 || item.thumbHeight < 27 || item.thumbHeight > 32 || !item.overlayVisible || !item.overlayText || item.channelWidth < 28 || !item.channelText)) {
    throw new Error(`${label} fixture geometry invalid: ${JSON.stringify(shape)}`);
  }
  if (caseName === "triple" && (shape.copyAllWidth < 26 || shape.copyAllWidth > 32 || shape.items[2].width < 180)) {
    throw new Error(`${label} fixture tail invalid: ${JSON.stringify(shape)}`);
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
  for (const name of expectedScreenshots) {
    fs.copyFileSync(path.join(workDir, name), path.join(outputDir, name));
  }
  const tempManifest = path.join(outputDir, `manifest.${process.pid}.tmp`);
  fs.writeFileSync(tempManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.renameSync(tempManifest, path.join(outputDir, "manifest.json"));
  const validation = validateUiProof({ silent: true });
  if (!validation.ok) throw new Error(`generated UI proof failed validation: ${validation.errors.join("; ")}`);
  fs.rmSync(workDir, { recursive: true, force: true });
  return manifest;
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
    await captureQueryPanel(browser, desktop, "desktop-query-panel.png", { filterTab: true });
    await captureExpandedSource(browser, desktop, {}, "desktop-source-expanded.png");
    await captureFixtureSourceCase(browser, desktop, "triple", "desktop-source-inline-3.png");

    await openPage(browser, mobile, {}, "mobile-song-rank.png");
    await openPage(browser, mobile, { view: "artistRank" }, "mobile-artist-rank.png");
    await openPage(browser, mobile, { view: "songAz" }, "mobile-song-index.png");
    await captureSongIndexPage(browser, mobile, "middle", "mobile-song-index-middle-page.png");
    await captureSongIndexPage(browser, mobile, "last", "mobile-song-index-last-page.png");
    await openPage(browser, mobile, { view: "videos" }, "mobile-video-view.png");
    await captureExpandedVideo(browser, mobile, "mobile-video-expanded.png");
    await openPage(browser, { width: 320, height: 700 }, { page: 7, pageSize: 100, showUnknown: 1 }, "mobile-pagination-320.png");
    await openPage(
      browser,
      mobile,
      { q: "少女レイ", metric: "videos", minCount: 2, showUnknown: 1 },
      "mobile-active-query-strip.png",
    );
    await captureQueryPanel(browser, mobile, "mobile-query-recent.png");
    await captureQueryPanel(browser, mobile, "mobile-query-suggestions.png", { searchText: "少女レイ" });
    await captureQueryPanel(browser, mobile, "mobile-query-history.png", { openHistory: true, scrollBottom: true });
    await captureExpandedSource(browser, mobile, {}, "mobile-source-expanded.png");
    await captureFixtureSourceCase(browser, mobile, "none", "mobile-source-inline-0.png");
    await captureSourceCase(browser, mobile, "single", "mobile-source-inline-1.png");
    await captureFixtureSourceCase(browser, mobile, "double", "mobile-source-inline-2.png");
    await captureSourceCase(browser, mobile, "triple", "mobile-source-inline-3.png");
    await captureSourceCase(browser, mobile, "more", "mobile-source-more-than-3.png");
    await captureSourceCase(browser, mobile, "more", "mobile-source-more-than-3-expanded.png", { expand: true });
    await captureFixtureSourceCase(browser, mobile, "fallback", "mobile-source-thumb-fallback.png");
    await captureFixtureSourceCase(browser, mobile, "longChannel", "mobile-source-long-channel.png");
    await openPage(browser, desktop, { page: 7, pageSize: 100, showUnknown: 1 }, "desktop-pagination-middle.png");
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
