const { chromium } = require("playwright");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const rootDir = process.cwd();
const externalBaseUrl = process.argv.slice(2).find((arg) => /^https?:\/\//u.test(arg));
const viewports = [
  { name: "mobile-390", width: 390, height: 844, expectedColumns: 1, expectedPageSize: 20 },
  { name: "mobile-320", width: 320, height: 700, expectedColumns: 1, expectedPageSize: 20 },
  { name: "desktop-1365", width: 1365, height: 768, expectedColumns: 3, expectedPageSize: 30 },
];

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".webp", "image/webp"],
]);

function staticPathFromUrl(requestUrl) {
  const url = new URL(requestUrl, "http://127.0.0.1/");
  const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const normalized = path.normalize(path.join(rootDir, pathname));
  if (!normalized.startsWith(rootDir)) return null;
  return normalized;
}

function serveStatic() {
  const server = http.createServer((request, response) => {
    const filePath = staticPathFromUrl(request.url || "/");
    if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    response.writeHead(200, {
      "content-type": mimeTypes.get(path.extname(filePath)) || "application/octet-stream",
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    fs.createReadStream(filePath).pipe(response);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}/` });
    });
  });
}

function thumbnailSvg(label) {
  const safeLabel = String(label || "video").replace(/[&<>"']/gu, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180"><rect width="320" height="180" fill="#0f766e"/><rect x="112" y="56" width="96" height="68" rx="12" fill="#ffffff" opacity=".9"/><path d="M150 74l38 16-38 16z" fill="#111827"/><text x="16" y="158" font-family="Arial" font-size="18" font-weight="700" fill="#fff">${safeLabel}</text></svg>`;
}

async function installImageFallbacks(page) {
  await page.route("https://i.ytimg.com/**", async (route) => {
    const url = new URL(route.request().url());
    const videoId = url.pathname.split("/").filter(Boolean)[1] || "video";
    await route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: thumbnailSvg(videoId),
    });
  });
}

async function waitForApp(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(
    () => {
      const content = document.querySelector("#videoList");
      if (!content || content.getAttribute("aria-busy") === "true") return false;
      return Boolean(content.querySelector(".rank-row-vtuber .rank-expand"));
    },
    null,
    { timeout: 90_000 },
  );
  await page.waitForTimeout(250);
}

async function expandFirstVtuber(page) {
  await page.locator(".rank-row-vtuber .rank-expand").first().click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        ".rank-row-vtuber.is-expanded .artist-song-drawer:not([hidden]) > .artist-song-group-vtuber",
      ).length > 0,
    null,
    { timeout: 10_000 },
  );
}

async function forceLongLabels(page) {
  await page.evaluate(() => {
    const longTitle =
      "ExtremelyLongSongTitleWithoutSpacesDesignedToStressTheVtuberExpandedCardLayoutAndPreventHorizontalOverflow";
    const longArtist =
      "OfficialArtistNameWithVeryLongAliasAndFeatureCreditThatMustStayInsideOneLineWithoutBreakingTheCard";
    const rowTitle = document.querySelector(".rank-row-vtuber.is-expanded .rank-title");
    if (rowTitle) rowTitle.textContent = `${longTitle} Channel Display Name`;
    const groups = Array.from(document.querySelectorAll(".artist-song-drawer:not([hidden]) > .artist-song-group-vtuber"));
    groups.slice(0, 8).forEach((group, index) => {
      const title = group.querySelector(".artist-song-title");
      const artist = group.querySelector(".artist-song-artist");
      if (title) title.textContent = `${longTitle}${index}`;
      if (artist) artist.textContent = `${longArtist}${index}`;
    });
  });
  await page.waitForTimeout(100);
}

function assertLayoutProof(proof, viewport, expectedVisible) {
  if (proof.pageSize !== viewport.expectedPageSize) {
    throw new Error(`${viewport.name}: expected page size ${viewport.expectedPageSize}, got ${proof.pageSize}: ${JSON.stringify(proof)}`);
  }
  if (proof.visibleGroups !== expectedVisible) {
    throw new Error(`${viewport.name}: expected ${expectedVisible} visible cards, got ${proof.visibleGroups}: ${JSON.stringify(proof)}`);
  }
  if (proof.columnCount !== viewport.expectedColumns) {
    throw new Error(`${viewport.name}: expected ${viewport.expectedColumns} columns, got ${proof.columnCount}: ${JSON.stringify(proof)}`);
  }
  if (proof.documentScrollWidth > viewport.width + 1) {
    throw new Error(`${viewport.name}: horizontal document overflow: ${JSON.stringify(proof)}`);
  }
  if (proof.widthDelta > 1) throw new Error(`${viewport.name}: card widths are not stable: ${JSON.stringify(proof)}`);
  if (proof.heightDelta > 1) throw new Error(`${viewport.name}: card heights are not stable: ${JSON.stringify(proof)}`);
  if (proof.titleWrapJustify === "center") throw new Error(`${viewport.name}: VTuber card title is still centered: ${JSON.stringify(proof)}`);
  if (proof.titleAlign !== "left") throw new Error(`${viewport.name}: VTuber card title is not left aligned: ${JSON.stringify(proof)}`);
  if (proof.hiddenImages > 0 || proof.blankImages > 0) throw new Error(`${viewport.name}: card image disappeared: ${JSON.stringify(proof)}`);
  if (!proof.summaryText.includes(proof.expectedRangeText)) {
    throw new Error(`${viewport.name}: summary range mismatch: ${JSON.stringify(proof)}`);
  }
  if (!proof.hasPageInput || !proof.hasPageSubmit) {
    throw new Error(`${viewport.name}: source drawer page input/submit missing: ${JSON.stringify(proof)}`);
  }
}

async function inspectExpandedLayout(page, viewport, expectedStart, expectedVisible) {
  return page.evaluate(
    ({ expectedStart, expectedVisible }) => {
      const drawer = document.querySelector(".rank-row-vtuber.is-expanded .artist-song-drawer:not([hidden])");
      const pageInfo = drawer?._sourcePageInfo || {};
      const groups = Array.from(drawer?.querySelectorAll(":scope > .artist-song-group-vtuber") || []);
      const rects = groups.map((group) => group.getBoundingClientRect());
      const widths = rects.map((rect) => Math.round(rect.width));
      const heights = rects.map((rect) => Math.round(rect.height));
      const columns = getComputedStyle(drawer)
        .gridTemplateColumns.split(" ")
        .filter((value) => value && value !== "none");
      const firstTitleWrap = groups[0]?.querySelector(".artist-song-title-wrap");
      const firstTitle = groups[0]?.querySelector(".artist-song-title");
      const summaryText = drawer?.querySelector(".source-drawer-count")?.textContent || "";
      const totalFromSummary = Number(summaryText.match(/\d+/u)?.[0] || 0);
      const titleWrapStyle = firstTitleWrap ? getComputedStyle(firstTitleWrap) : null;
      const titleStyle = firstTitle ? getComputedStyle(firstTitle) : null;
      const images = groups.map((group) => {
        const image = group.querySelector(".artist-song-thumb-image");
        const rect = image?.getBoundingClientRect();
        return {
          hidden: !image || image.hidden || image.getAttribute("hidden") !== null,
          blank: !rect || rect.width <= 1 || rect.height <= 1,
        };
      });
      return {
        pageSize: Number(drawer?.dataset.sourcePageSize || 0),
        pageCount: Number(drawer?.querySelector("[data-source-page-form] [data-page-input]")?.getAttribute("max") || 0),
        totalSongs: Number(pageInfo.totalCount || pageInfo.total || 0) || totalFromSummary,
        visibleGroups: groups.length,
        columnCount: columns.length,
        documentScrollWidth: document.documentElement.scrollWidth,
        widthDelta: widths.length ? Math.max(...widths) - Math.min(...widths) : 0,
        heightDelta: heights.length ? Math.max(...heights) - Math.min(...heights) : 0,
        titleWrapJustify: titleWrapStyle?.justifyContent || "",
        titleAlign: titleStyle?.textAlign || "",
        hiddenImages: images.filter((image) => image.hidden).length,
        blankImages: images.filter((image) => image.blank).length,
        summaryText,
        expectedRangeText: `${expectedStart}-${expectedStart + expectedVisible - 1}`,
        hasPageInput: Boolean(drawer?.querySelector("[data-source-page-form] [data-page-input]")),
        hasPageSubmit: Boolean(drawer?.querySelector("[data-source-page-form] .source-page-submit")),
      };
    },
    { expectedStart, expectedVisible },
  );
}

async function runViewport(browser, baseUrl, viewport) {
  const page = await browser.newPage({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    isMobile: viewport.width <= 720,
  });
  await installImageFallbacks(page);
  const url = new URL("index.html", baseUrl);
  url.searchParams.set("view", "vtuberRank");
  await page.goto(url.toString(), { waitUntil: "domcontentloaded" });
  await waitForApp(page);
  await expandFirstVtuber(page);
  await forceLongLabels(page);
  const firstProof = await inspectExpandedLayout(page, viewport, 1, viewport.expectedPageSize);
  assertLayoutProof(firstProof, viewport, viewport.expectedPageSize);
  if (firstProof.pageCount < 2) {
    throw new Error(`${viewport.name}: expected expandable VTuber fixture to have at least 2 pages: ${JSON.stringify(firstProof)}`);
  }

  await page.locator(".artist-song-drawer:not([hidden]) .source-page-button[data-source-page]").filter({ hasText: "下一页" }).click();
  await page.waitForFunction(
    () => document.querySelector(".artist-song-drawer:not([hidden])")?.dataset.sourcePage === "2",
    null,
    { timeout: 10_000 },
  );
  const secondVisible = Math.max(1, Math.min(viewport.expectedPageSize, firstProof.totalSongs - viewport.expectedPageSize));
  assertLayoutProof(await inspectExpandedLayout(page, viewport, viewport.expectedPageSize + 1, secondVisible), viewport, secondVisible);

  const form = page.locator(".artist-song-drawer:not([hidden]) [data-source-page-form]").first();
  const input = form.locator("[data-page-input]");
  await input.scrollIntoViewIfNeeded();
  await input.focus();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("1");
  const typedValue = await input.inputValue();
  if (typedValue !== "1") {
    throw new Error(`${viewport.name}: source page input did not accept typing, value=${typedValue}`);
  }
  await form.locator(".source-page-submit").click();
  await page.waitForTimeout(500);
  const submittedPage = await page.evaluate(() => document.querySelector(".artist-song-drawer:not([hidden])")?.dataset.sourcePage || "");
  if (submittedPage !== "1") {
    const state = await page.evaluate(() => {
      const drawer = document.querySelector(".artist-song-drawer:not([hidden])");
      const form = drawer?.querySelector("[data-source-page-form]");
      const button = form?.querySelector("[data-source-page-submit]");
      const input = form?.querySelector("[data-page-input]");
      return {
        drawerId: drawer?.id || "",
        drawerPage: drawer?.dataset.sourcePage || "",
        formControls: form?.getAttribute("aria-controls") || "",
        inputValue: input?.value || "",
        inputMin: input?.getAttribute("min") || "",
        inputMax: input?.getAttribute("max") || "",
        hasSubmit: Boolean(button),
        toast: document.querySelector("#toast")?.textContent || "",
      };
    });
    throw new Error(`${viewport.name}: source page submit did not navigate to page 1: ${JSON.stringify(state)}`);
  }
  assertLayoutProof(await inspectExpandedLayout(page, viewport, 1, viewport.expectedPageSize), viewport, viewport.expectedPageSize);
  await page.close();
}

async function main() {
  const localServer = externalBaseUrl ? null : await serveStatic();
  const baseUrl = externalBaseUrl || localServer.baseUrl;
  let browser;
  try {
    browser = await chromium.launch(playwrightLaunchOptions());
    for (const viewport of viewports) {
      await runViewport(browser, baseUrl, viewport);
    }
    console.log(`CODEX_VTUBER_EXPAND_LAYOUT_OK viewports=${viewports.length}`);
  } finally {
    if (browser) await browser.close();
    if (localServer?.server) await new Promise((resolve) => localServer.server.close(resolve));
  }
}

function playwrightLaunchOptions() {
  const executablePath = (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROME_EXECUTABLE_PATH || "").trim();
  return executablePath ? { executablePath, headless: true } : { headless: true };
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
