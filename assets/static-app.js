"use strict";

const BASE = "data/static/v1/";
const state = { meta: null, page: 1, pageCount: 1, searchIndex: null, searchResults: [] };
// Static shards do not carry collection evidence; keep the reviewed channel allowlist explicit.
const COLLECTED_VTUBER_IDS = new Set(["7163e7a35bf251f9"]);
const el = Object.fromEntries(["status","range","type","keyword","search","summary","ranking","prev","next","page","page-input","page-go","page-tokens","detail","detail-body","theme-toggle"].map((id) => [id, document.getElementById(id)]));

initTheme();
start().catch(showError);

function currentTheme() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function setTheme(theme, { persist = true } = {}) {
  const dark = theme === "dark";
  if (dark) document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;

  const button = el["theme-toggle"];
  if (button) {
    const label = dark ? "切换到浅色模式" : "切换到深色模式";
    const icon = button.querySelector(".theme-toggle-icon");
    if (icon) icon.textContent = dark ? "☀" : "☾";
    button.setAttribute("aria-label", label);
    button.title = label;
  }

  const themeColor = document.querySelector('meta[name="theme-color"]');
  if (themeColor) themeColor.content = dark ? "#0d1117" : "#f5f7fa";

  if (persist) {
    try {
      localStorage.setItem("daily-song-list-theme", dark ? "dark" : "light");
    } catch {}
  }
}

function initTheme() {
  const button = el["theme-toggle"];
  if (!button) return;
  setTheme(currentTheme(), { persist: false });
  button.addEventListener("click", () => {
    setTheme(currentTheme() === "dark" ? "light" : "dark");
  });
}

async function start() {
  state.meta = await json("meta.json");
  const available = ["today", "3d", "7d", "30d", "all"].filter((range) => state.meta.ranges?.[range]?.songs);
  if (!available.length) throw new Error("没有可用的排行榜范围");
  el.range.value = available.find((range) => Number(state.meta.ranges[range].songs.totalCount) > 0) || available[0];
  const rangeTabs = [...document.querySelectorAll(".range-tabs [data-range]")];
  function syncRangeTabs() {
    for (const tab of rangeTabs) {
      tab.disabled = !state.meta.ranges?.[tab.dataset.range];
      tab.setAttribute("aria-selected", String(tab.dataset.range === el.range.value));
    }
  }
  for (const tab of rangeTabs) tab.addEventListener("click", () => {
    if (tab.disabled || el.range.value === tab.dataset.range) return;
    el.range.value = tab.dataset.range;
    el.range.dispatchEvent(new Event("change", { bubbles: true }));
  });
  el.range.addEventListener("change", syncRangeTabs);
  syncRangeTabs();
  renderStatus(el.range.value);
  for (const control of [el.range, el.type]) control.addEventListener("change", () => { state.page = 1; load(); });
  el.keyword.addEventListener("input", () => {
    if (el.search.value.trim()) {
      state.page = 1;
      search();
    } else {
      renderCurrent();
    }
  });
  el.search.addEventListener("input", debounce(() => {
    state.page = 1;
    return search();
  }, 180));
  el.prev.addEventListener("click", () => goPage(state.page - 1));
  el.next.addEventListener("click", () => goPage(state.page + 1));
  el["page-go"].addEventListener("click", submitPageJump);
  el["page-input"].addEventListener("keydown", (event) => { if (event.key === "Enter") submitPageJump(); });
  el.detail.querySelector(".close").addEventListener("click", closeDetail);
  el.detail.addEventListener("click", closeDetailOnOutsideClick);
  document.addEventListener("click", closeDetailOnOutsideClick);
  el.detail.addEventListener("close", () => {
    const trigger = state.detailTrigger;
    state.detailTrigger = null;
    if (trigger?.isConnected) trigger.focus();
  });
  await load();
}

async function load() {
  if (el.search.value.trim()) return search();
  const range = el.range.value;
  renderStatus(range);
  const type = el.type.value;
  const manifest = state.meta.ranges?.[range]?.[type];
  if (!manifest) throw new Error(`范围 ${range} 尚未生成，请选择其他范围`);
  state.pageCount = manifest.pageCount;
  state.page = Math.min(state.page, state.pageCount);
  state.current = await json(`rankings/${range}/${type}/page-${String(state.page).padStart(4,"0")}.json`);
  el.summary.textContent = `${label(type)} · ${label(range)} · ${Number(state.current.totalCount || 0).toLocaleString("zh-CN")} 项 · 第 ${state.page}/${state.pageCount} 页`;
  renderCurrent();
}

function renderStatus(range) {
  const scoped = state.meta.ranges?.[range]?.stats;
  const fallback = range === "all" ? {
    videoCount: Number(state.meta.videoCount || 0),
    songOccurrenceCount: Number(state.meta.songOccurrenceCount || 0),
    pendingVideoCount: Number(state.meta.pendingVideoCount || 0),
    quarantinedOccurrences: Number(state.meta.quality?.quarantinedOccurrences || 0),
  } : null;
  const stats = scoped || fallback;
  if (!stats) {
    el.status.textContent = `更新 ${dateText(state.meta.generatedAt)} · ${label(range)}统计正在生成`;
    return;
  }
  const pending = Number(stats.pendingVideoCount || 0);
  const quarantined = Number(stats.quarantinedOccurrences || 0);
  el.status.textContent = `更新 ${dateText(state.meta.generatedAt)} · ${label(range)} · ${Number(stats.videoCount || 0).toLocaleString("zh-CN")} 个视频 · ${Number(stats.songOccurrenceCount || 0).toLocaleString("zh-CN")} 条收录${pending ? ` · ${pending.toLocaleString("zh-CN")} 候选待处理` : ""}${quarantined ? ` · 隔离 ${quarantined.toLocaleString("zh-CN")} 条异常记录` : ""}`;
}

function renderCurrent() {
  if (!state.current) return;
  const keyword = el.keyword.value.trim().toLocaleLowerCase("ja");
  const items = state.current.items.filter((item) => !keyword || (item.keywords || []).some((value) => value.toLocaleLowerCase("ja").includes(keyword)));
  render(items);
  renderPager();
}

async function search() {
  renderStatus(el.range.value);
  const raw = el.search.value.trim();
  const query = normalize(raw);
  if (!query) { state.page = 1; return load(); }
  if (!state.searchIndex) {
    const manifest = await json("search/manifest.json");
    const shards = await Promise.all(manifest.shards.map((shard) => json(shard.path)));
    state.searchIndex = shards.flatMap((shard) => shard.items);
  }
  const type = el.type.value;
  const range = el.range.value;
  const hasScopedIndex = state.searchIndex.some((item) => item.rangeMetrics);
  if (!globalThis.DailySongSearch?.matchSearchItems) throw new Error("搜索匹配模块未加载");
  let results = globalThis.DailySongSearch.matchSearchItems(state.searchIndex, type, raw);
  if (hasScopedIndex && range !== "all") {
    results = results.flatMap((item) => {
      const metrics = item.rangeMetrics?.[range];
      return metrics?.occurrenceCount > 0 ? [{
        ...item,
        occurrenceCount: metrics.occurrenceCount,
        videoCount: metrics.videoCount,
        sourcesPreview: [],
      }] : [];
    });
  } else {
    results = await hydrateSearchMetrics(results);
  }
  const keyword = normalize(el.keyword.value);
  if (keyword) results = results.filter((item) => (item.keywords || []).some((value) => normalize(value).includes(keyword)));
  if (!globalThis.DailySongSearch?.compareSearchResults) throw new Error("搜索排序模块未加载");
  results.sort((left, right) => globalThis.DailySongSearch.compareSearchResults(left, right, raw));
  state.searchResults = results;
  state.pageCount = Math.max(1, Math.ceil(results.length / 50));
  state.page = Math.min(state.page, state.pageCount);
  const start = (state.page - 1) * 50;
  const pageResults = results.slice(start, start + 50).map((item, index) => ({
    rank: start + index + 1,
    ...item,
    keywords: item.keywords || [],
  }));
  el.summary.textContent = `${hasScopedIndex ? label(range) : "全量"}搜索 · ${searchLabel(type)} · “${raw}” · ${results.length} 项`;
  render(pageResults);
  renderPager();
}

async function hydrateSearchMetrics(items) {
  const missing = items.filter((item) => !Number.isFinite(Number(item.occurrenceCount)) || !Number.isFinite(Number(item.videoCount)));
  if (!missing.length) return items;
  const metrics = new Map();
  await Promise.all(missing.map(async (item) => {
    try {
      const detailPayload = await json(item.detailPath);
      metrics.set(item.id, {
        occurrenceCount: Number(detailPayload.occurrenceCount || 0),
        videoCount: Number(detailPayload.videoCount || 0),
        keywords: detailPayload.keywords || item.keywords || [],
        sourcesPreview: detailPayload.sourcesPreview || item.sourcesPreview || [],
      });
    } catch { metrics.set(item.id, {}); }
  }));
  return items.map((item) => metrics.has(item.id) ? { ...item, ...metrics.get(item.id) } : item);
}

function render(items) {
  el.ranking.replaceChildren(...items.map((item) => {
    const li = document.createElement("li");
    li.className = "rank-row";

    const rank = document.createElement("span");
    rank.className = "rank";
    rank.textContent = `#${item.rank ?? ""}`;

    const main = document.createElement("div");
    main.className = "rank-main";
    const collectionBadge = el.type.value === "vtubers" && (item.collected === true || COLLECTED_VTUBER_IDS.has(item.id)) ? '<span class="collection-badge">已收录</span>' : "";
    const streamsUrl = channelStreamsUrl(item);
    const nameMarkup = streamsUrl
      ? `<a class="channel-name-link" href="${escapeAttr(streamsUrl)}" target="_blank" rel="noreferrer">${escapeText(item.name)}</a>`
      : escapeText(item.name);
    main.innerHTML = `<div class="name">${nameMarkup}${collectionBadge}</div>${item.secondary ? `<div class="secondary">${escapeText(item.secondary)}</div>` : ""}`;

    const metrics = document.createElement("div");
    metrics.className = "metrics";
    const occurrenceCount = Number(item.occurrenceCount);
    const videoCount = Number(item.videoCount);
    metrics.innerHTML = Number.isFinite(occurrenceCount)
      ? `<strong>${occurrenceCount.toLocaleString("zh-CN")}</strong><span>${el.type.value === "vtubers" ? "收录" : "次"}</span>${Number.isFinite(videoCount) ? `<small>${videoCount.toLocaleString("zh-CN")} 个视频</small>` : ""}`
      : "<span>统计载入中</span>";

    const sourceCell = document.createElement("div");
    sourceCell.className = "source-preview";
    const previews = uniqueVideoPreviews(item.sourcesPreview || []).slice(0,3);
    for (const source of previews) {
      const link = document.createElement("a");
      link.className = "source-chip";
      link.href = watchUrl(source);
      link.target = "_blank";
      link.rel = "noreferrer";
      const time = source.time || formatSeconds(source.seconds);
      link.innerHTML = `<span>${escapeText(source.channelName || "YouTube")}</span>${time ? `<b>${escapeText(time)}</b>` : ""}`;
      sourceCell.append(link);
    }
    const detailButton = document.createElement("button");
    detailButton.type = "button";
    detailButton.className = "detail-button";
    detailButton.textContent = previews.length && Number.isFinite(videoCount) && videoCount <= previews.length ? "详情" : Number.isFinite(videoCount) ? `查看全部来源（${videoCount.toLocaleString("zh-CN")}）` : "查看来源";
    detailButton.addEventListener("click", () => {
      state.detailTrigger = detailButton;
      detail(item).catch((error) => {
        el["detail-body"].innerHTML = `<p class="detail-loading">读取失败：${escapeText(error.message)}</p>`;
        showError(error);
      });
    });
    sourceCell.append(detailButton);

    li.append(rank, main, metrics, sourceCell);
    return li;
  }));
}

function uniqueVideoPreviews(items) {
  const seen = new Set();
  return items.filter((item) => item?.videoId && !seen.has(item.videoId) && seen.add(item.videoId));
}

function watchUrl(entry) {
  const base = `https://www.youtube.com/watch?v=${encodeURIComponent(entry.videoId || "")}`;
  return Number(entry.seconds || 0) > 0 ? `${base}&t=${Math.floor(Number(entry.seconds))}s` : base;
}

function formatSeconds(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  if (!seconds) return "";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return hours ? `${hours}:${String(minutes).padStart(2,"0")}:${String(rest).padStart(2,"0")}` : `${minutes}:${String(rest).padStart(2,"0")}`;
}

function renderPager() {
  el.page.textContent = `${state.page} / ${state.pageCount}`;
  el.prev.disabled = state.page <= 1;
  el.next.disabled = state.page >= state.pageCount;
  el["page-input"].disabled = false;
  el["page-go"].disabled = false;
  el["page-input"].min = "1";
  el["page-input"].max = String(state.pageCount);
  el["page-input"].value = String(state.page);
  const fragment = document.createDocumentFragment();
  for (const token of visiblePageTokens(state.page, state.pageCount)) {
    if (token === "…") {
      const span = document.createElement("span");
      span.className = "ellipsis";
      span.textContent = token;
      fragment.append(span);
      continue;
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = token === state.page ? "page-token active" : "page-token";
    button.textContent = String(token);
    button.disabled = token === state.page;
    button.addEventListener("click", () => goPage(token));
    fragment.append(button);
  }
  el["page-tokens"].replaceChildren(fragment);
}

function visiblePageTokens(current, total) {
  if (total <= 7) return Array.from({ length: total }, (_, index) => index + 1);
  const pages = [...new Set([1, total, current - 2, current - 1, current, current + 1, current + 2].filter((value) => value >= 1 && value <= total))].sort((a, b) => a - b);
  const output = [];
  for (let index = 0; index < pages.length; index += 1) {
    if (index > 0 && pages[index] - pages[index - 1] > 1) output.push("…");
    output.push(pages[index]);
  }
  return output;
}

function submitPageJump() {
  const target = Number.parseInt(el["page-input"].value, 10);
  if (Number.isFinite(target)) goPage(target);
}

function goPage(target) {
  const next = Math.min(state.pageCount, Math.max(1, Number(target) || 1));
  if (next === state.page) return;
  state.page = next;
  load().catch(showError);
}

async function detail(item) {
  el["detail-body"].innerHTML = "<p class=\"detail-loading\">正在加载来源…</p>";
  el.detail.showModal();
  const payload = await json(item.detailPath);
  const end = new Date(state.meta.generatedAt || Date.now()).getTime();
  const range = el.range.value;
  const start = rangeStartMs(range, new Date(end));
  const maxEnd = end + (range === "today" || range === "3d" ? 300000 : 21600000);
  const sorted = [...(payload.occurrences || [])]
    .filter((entry) => Date.parse(entry.publishedAt || "") >= start && Date.parse(entry.publishedAt || "") <= maxEnd)
    .sort((a,b) => String(b.publishedAt || "").localeCompare(String(a.publishedAt || "")));
  renderGroupedDetailList(item, payload, sorted, Math.min(30, sorted.length));
}

function renderDetailList(item, payload, sorted, limit) {
  const visible = sorted.slice(0, limit);
  const videoCount = new Set(sorted.map((entry) => entry.videoId)).size;
  const occurrences = visible.map((entry) => {
    const watch = watchUrl(entry);
    return `<article class="occurrence"><a class="occurrence-thumb" href="${escapeAttr(watch)}" target="_blank" rel="noreferrer"><img src="${escapeAttr(entry.thumbnailUrl)}" alt="" loading="lazy" decoding="async"></a><div class="occurrence-body"><a class="occurrence-title" href="${escapeAttr(watch)}" target="_blank" rel="noreferrer">${escapeText(entry.videoTitle || "YouTube 视频")}</a><div class="occurrence-meta">${escapeText(entry.channelName || "未知频道")} · ${escapeText(entry.publishedAt?.slice(0,10) || "")}</div><div class="occurrence-song">${escapeText([entry.songTitle || payload.name, entry.artist || payload.secondary, entry.time].filter(Boolean).join(" · "))}</div><div class="occurrence-actions"><a href="${escapeAttr(watch)}" target="_blank" rel="noreferrer">${escapeText(entry.time || "打开 YouTube")}</a>${entry.sourcePath ? `<button type="button" data-source="${escapeAttr(entry.sourcePath)}">完整歌单</button>` : ""}</div></div></article>`;
  }).join("");
  const more = limit < sorted.length ? `<button class="load-more" type="button">显示全部 ${sorted.length.toLocaleString("zh-CN")} 条来源</button>` : "";
  el["detail-body"].innerHTML = `<div class="detail-title-row"><div><h2>${escapeText(payload.name)}</h2>${payload.secondary ? `<p>${escapeText(payload.secondary)}</p>` : ""}</div><strong>${sorted.length.toLocaleString("zh-CN")} 次 · ${videoCount.toLocaleString("zh-CN")} 个视频</strong></div>${occurrences || "<p>当前范围暂无来源。</p>"}${more}`;
  const loadMore = el["detail-body"].querySelector(".load-more");
  if (loadMore) loadMore.addEventListener("click", () => renderGroupedDetailList(item, payload, sorted, sorted.length));
  el["detail-body"].querySelectorAll("[data-source]").forEach((button) => button.addEventListener("click", async () => {
    const source = await json(button.dataset.source);
    el["detail-body"].innerHTML = `<button class="detail-back" type="button">← 返回来源</button><h2>${escapeText(source.title || "完整歌单")}</h2><p>${escapeText(source.channelName || "")} · ${escapeText(source.publishedAt?.slice(0,10) || "")}</p><div class="source-song-list">${(source.songs || []).map((song) => { const url = `${source.watchUrl || `https://www.youtube.com/watch?v=${encodeURIComponent(source.videoId || "")}`}${Number(song.seconds || 0) > 0 ? `&t=${Math.floor(Number(song.seconds))}s` : ""}`; return `<a href="${escapeAttr(url)}" target="_blank" rel="noreferrer">${escapeText([song.time,song.title,song.artist].filter(Boolean).join(" · "))}</a>`; }).join("")}</div>`;
    el["detail-body"].querySelector(".detail-back").addEventListener("click", () => renderGroupedDetailList(item, payload, sorted, limit));
  }));
}

async function json(relative) {
  const response = await fetch(`${BASE}${relative}`, { cache:"no-store" });
  if (!response.ok) throw new Error(`${relative}: HTTP ${response.status}`);
  return response.json();
}
function rangeStartMs(range, now) {
  if (range === "all") return Number.NEGATIVE_INFINITY;
  if (range === "7d" || range === "30d") return now.getTime() - (range === "7d" ? 7 : 30) * 86400000;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const midnight = Date.parse(`${parts.year}-${parts.month}-${parts.day}T00:00:00+08:00`);
  return midnight - (range === "3d" ? 2 : 0) * 86400000;
}
function label(value){return ({songs:"歌曲榜",artists:"歌手榜",vtubers:"收录榜",today:"今日","3d":"近 3 天","7d":"近 7 天","30d":"近 30 天",all:"全部"})[value]||value}
function searchLabel(value){return value === "vtubers" ? "收录" : label(value)}
function dateText(value){return value?new Intl.DateTimeFormat("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false,timeZone:"Asia/Shanghai"}).format(new Date(value)):"未知"}
function normalize(value){return String(value||"").normalize("NFKC").toLocaleLowerCase("ja").replace(/[\s\p{P}\p{S}]+/gu,"")}
function escapeText(value){return String(value??"").replace(/[&<>"']/g,(ch)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[ch])}
function escapeAttr(value){return escapeText(value)}
function debounce(fn,ms){let timer;return()=>{clearTimeout(timer);timer=setTimeout(()=>fn().catch(showError),ms)}}
function showError(error){el.status.textContent=`读取失败：${error.message}`;console.error(error)}
function closeDetail() {
    if (el.detail.open) el.detail.close();
}
function closeDetailOnOutsideClick(event) {
    if (!el.detail.open) return;
    const clickedBackdrop = event.target === el.detail || event.target === document.body || event.target === document.documentElement;
    if (!clickedBackdrop) return;
    const rect = el.detail.getBoundingClientRect();
    const outside = event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom;
    if (outside) closeDetail();
}
const KNOWN_CHANNEL_STREAM_URLS = new Map([["7163e7a35bf251f9", "https://www.youtube.com/@v-rara/streams"]]);

function channelStreamsUrl(item = {}, payload = {}, occurrence = {}) {
  if (el.type.value !== "vtubers") return "";
  const id = item.id || payload.id || "";
  const known = KNOWN_CHANNEL_STREAM_URLS.get(id);
  if (known) return known;
  const candidates = [item.channelUrl, payload.channelUrl, occurrence.channelUrl, item.homepageUrl, payload.homepageUrl];
  for (const candidate of candidates) {
    const normalized = normalizeChannelStreamsUrl(candidate);
    if (normalized) return normalized;
  }
  const channelId = item.channelId || payload.channelId || occurrence.channelId;
  if (/^UC[\w-]{10,}$/u.test(String(channelId || ""))) return `https://www.youtube.com/channel/${encodeURIComponent(channelId)}/streams`;
  const handle = item.channelHandle || payload.channelHandle || occurrence.channelHandle;
  if (handle) return normalizeChannelStreamsUrl(`https://www.youtube.com/${String(handle).startsWith("@") ? "" : "@"}${handle}`);
  return "";
}

function normalizeChannelStreamsUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || "")); } catch { return ""; }
  if (parsed.protocol !== "https:" || !/(^|\.)youtube\.com$/u.test(parsed.hostname)) return "";
  const pathname = parsed.pathname.replace(/\/+$/u, "");
  if (!/^\/(?:channel\/UC[\w-]+|@[\w.-]+|c\/[\w.-]+|user\/[\w.-]+)$/u.test(pathname)) return "";
  return `${parsed.origin}${pathname}/streams`;
}

function groupOccurrencesByVideo(occurrences) {
  const groups = new Map();
  for (const occurrence of occurrences || []) {
    const key = occurrence.videoId || `${occurrence.videoTitle || ""}\u001f${occurrence.publishedAt || ""}\u001f${occurrence.sourcePath || ""}`;
    const group = groups.get(key) || [];
    group.push(occurrence);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function renderGroupedDetailList(item, payload, sorted, limit) {
  const visible = sorted.slice(0, limit);
  const videoCount = new Set(sorted.map((entry) => entry.videoId)).size;
  const groups = groupOccurrencesByVideo(visible);
  const occurrences = groups.map((group) => {
    const first = group[0];
    const videoUrl = first.videoId ? `https://www.youtube.com/watch?v=${encodeURIComponent(first.videoId)}` : watchUrl(first);
    const songs = group.map((entry) => {
      const watch = watchUrl(entry);
      const songTitle = entry.songTitle || payload.name || "未命名歌曲";
      const artist = entry.artist || payload.secondary || "";
      return `<li class="occurrence-song-row"><a href="${escapeAttr(watch)}" target="_blank" rel="noreferrer"><time>${escapeText(entry.time || "--:--")}</time><span class="song-copy"><strong>${escapeText(songTitle)}</strong>${artist ? `<small>${escapeText(artist)}</small>` : ""}</span></a></li>`;
    }).join("");
    const sourceButton = first.sourcePath ? `<button type="button" data-source="${escapeAttr(first.sourcePath)}">完整歌单</button>` : "";
    return `<section class="occurrence-group"><div class="occurrence-video"><a class="occurrence-thumb" href="${escapeAttr(videoUrl)}" target="_blank" rel="noreferrer"><img src="${escapeAttr(first.thumbnailUrl)}" alt="" loading="lazy" decoding="async"></a><div class="occurrence-video-body"><a class="occurrence-title" href="${escapeAttr(videoUrl)}" target="_blank" rel="noreferrer">${escapeText(first.videoTitle || "YouTube 视频")}</a><div class="occurrence-meta">${escapeText(first.channelName || "未知频道")} · ${escapeText(first.publishedAt?.slice(0,10) || "")} · ${group.length.toLocaleString("zh-CN")} 首</div><div class="occurrence-actions"><a href="${escapeAttr(videoUrl)}" target="_blank" rel="noreferrer">打开视频</a>${sourceButton}</div></div></div><ol class="occurrence-songs">${songs}</ol></section>`;
  }).join("");
  const streamsUrl = channelStreamsUrl(item, payload, sorted[0]);
  const detailName = streamsUrl
    ? `<a class="channel-name-link" href="${escapeAttr(streamsUrl)}" target="_blank" rel="noreferrer">${escapeText(payload.name)}</a>`
    : escapeText(payload.name);
  const detailBadge = el.type.value === "vtubers" && (payload.collected === true || item.collected === true || COLLECTED_VTUBER_IDS.has(item.id || payload.id)) ? '<span class="collection-badge">已收录</span>' : "";
  const more = limit < sorted.length ? `<button class="load-more" type="button">显示全部 ${sorted.length.toLocaleString("zh-CN")} 条来源</button>` : "";
  el["detail-body"].innerHTML = `<div class="detail-title-row"><div><h2>${detailName}${detailBadge}</h2>${payload.secondary ? `<p>${escapeText(payload.secondary)}</p>` : ""}</div><strong>${sorted.length.toLocaleString("zh-CN")} 条 · ${videoCount.toLocaleString("zh-CN")} 个视频</strong></div>${occurrences || "<p>当前范围暂无来源。</p>"}${more}`;
  const loadMore = el["detail-body"].querySelector(".load-more");
  if (loadMore) loadMore.addEventListener("click", () => renderGroupedDetailList(item, payload, sorted, sorted.length));
  el["detail-body"].querySelectorAll("[data-source]").forEach((button) => button.addEventListener("click", async () => {
    const source = await json(button.dataset.source);
    el["detail-body"].innerHTML = `<button class="detail-back" type="button">← 返回来源</button><h2>${escapeText(source.title || "完整歌单")}</h2><p>${escapeText(source.channelName || "")} · ${escapeText(source.publishedAt?.slice(0,10) || "")}</p><div class="source-song-list">${(source.songs || []).map((song) => { const url = `${source.watchUrl || `https://www.youtube.com/watch?v=${encodeURIComponent(source.videoId || "")}`}${Number(song.seconds || 0) > 0 ? `&t=${Math.floor(Number(song.seconds))}s` : ""}`; return `<a href="${escapeAttr(url)}" target="_blank" rel="noreferrer">${escapeText([song.time,song.title,song.artist].filter(Boolean).join(" · "))}</a>`; }).join("")}</div>`;
    el["detail-body"].querySelector(".detail-back").addEventListener("click", () => renderGroupedDetailList(item, payload, sorted, limit));
  }));
}
