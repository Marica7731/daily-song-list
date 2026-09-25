"use strict";

const BASE = "data/static/v1/";
const state = { meta: null, page: 1, pageCount: 1, searchIndex: null };
const el = Object.fromEntries(["status","range","type","keyword","search","summary","ranking","prev","next","page","page-input","page-go","page-tokens","detail","detail-body"].map((id) => [id, document.getElementById(id)]));

start().catch(showError);

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
  const pending = Number(state.meta.pendingVideoCount || 0);
  const quarantined = Number(state.meta.quality?.quarantinedOccurrences || 0);
  el.status.textContent = `更新 ${dateText(state.meta.generatedAt)} · ${Number(state.meta.videoCount || 0).toLocaleString("zh-CN")} 个视频 · ${Number(state.meta.songOccurrenceCount || 0).toLocaleString("zh-CN")} 条收录${pending ? ` · ${pending.toLocaleString("zh-CN")} 待处理` : ""}${quarantined ? ` · 隔离 ${quarantined.toLocaleString("zh-CN")} 条异常记录` : ""}`;
  for (const control of [el.range, el.type]) control.addEventListener("change", () => { state.page = 1; load(); });
  el.keyword.addEventListener("input", () => { if (el.search.value.trim()) search(); else renderCurrent(); });
  el.search.addEventListener("input", debounce(search, 180));
  el.prev.addEventListener("click", () => goPage(state.page - 1));
  el.next.addEventListener("click", () => goPage(state.page + 1));
  el["page-go"].addEventListener("click", submitPageJump);
  el["page-input"].addEventListener("keydown", (event) => { if (event.key === "Enter") submitPageJump(); });
  el.detail.querySelector(".close").addEventListener("click", () => el.detail.close());
  await load();
}

async function load() {
  if (el.search.value.trim()) return search();
  const range = el.range.value;
  const type = el.type.value;
  const manifest = state.meta.ranges?.[range]?.[type];
  if (!manifest) throw new Error(`范围 ${range} 尚未生成，请选择其他范围`);
  state.pageCount = manifest.pageCount;
  state.page = Math.min(state.page, state.pageCount);
  state.current = await json(`rankings/${range}/${type}/page-${String(state.page).padStart(4,"0")}.json`);
  el.summary.textContent = `${label(type)} · ${label(range)} · ${Number(state.current.totalCount || 0).toLocaleString("zh-CN")} 项 · 第 ${state.page}/${state.pageCount} 页`;
  renderCurrent();
}

function renderCurrent() {
  if (!state.current) return;
  const keyword = el.keyword.value.trim().toLocaleLowerCase("ja");
  const items = state.current.items.filter((item) => !keyword || (item.keywords || []).some((value) => value.toLocaleLowerCase("ja").includes(keyword)));
  render(items);
  renderPager();
}

async function search() {
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
  let results = state.searchIndex.filter((item) => item.type === type && item.text.includes(query));
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
  results.sort((a,b) => Number(b.occurrenceCount || 0) - Number(a.occurrenceCount || 0) || Number(b.videoCount || 0) - Number(a.videoCount || 0) || String(a.name).localeCompare(String(b.name), "ja"));
  results = results.slice(0, 100).map((item,index) => ({ rank:index+1, ...item, keywords:item.keywords || [] }));
  const keyword = normalize(el.keyword.value);
  if (keyword) results = results.filter((item) => (item.keywords || []).some((value) => normalize(value).includes(keyword)));
  el.summary.textContent = `${hasScopedIndex ? label(range) : "全量"}搜索 · ${label(type)} · “${raw}” · ${results.length} 项${results.length === 100 ? "（最多显示 100）" : ""}`;
  render(results);
  el.page.textContent = "搜索";
  el["page-tokens"].replaceChildren();
  el["page-input"].value = "1";
  el["page-input"].disabled = true;
  el["page-go"].disabled = true;
  el.prev.disabled = true;
  el.next.disabled = true;
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
    main.innerHTML = `<div class="name">${escapeText(item.name)}</div>${item.secondary ? `<div class="secondary">${escapeText(item.secondary)}</div>` : ""}`;

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
    detailButton.addEventListener("click", () => detail(item));
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
  if (el.search.value.trim()) return;
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
  renderDetailList(item, payload, sorted, Math.min(30, sorted.length));
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
  if (loadMore) loadMore.addEventListener("click", () => renderDetailList(item, payload, sorted, sorted.length));
  el["detail-body"].querySelectorAll("[data-source]").forEach((button) => button.addEventListener("click", async () => {
    const source = await json(button.dataset.source);
    el["detail-body"].innerHTML = `<button class="detail-back" type="button">← 返回来源</button><h2>${escapeText(source.title || "完整歌单")}</h2><p>${escapeText(source.channelName || "")} · ${escapeText(source.publishedAt?.slice(0,10) || "")}</p><div class="source-song-list">${(source.songs || []).map((song) => { const url = `${source.watchUrl || `https://www.youtube.com/watch?v=${encodeURIComponent(source.videoId || "")}`}${Number(song.seconds || 0) > 0 ? `&t=${Math.floor(Number(song.seconds))}s` : ""}`; return `<a href="${escapeAttr(url)}" target="_blank" rel="noreferrer">${escapeText([song.time,song.title,song.artist].filter(Boolean).join(" · "))}</a>`; }).join("")}</div>`;
    el["detail-body"].querySelector(".detail-back").addEventListener("click", () => renderDetailList(item, payload, sorted, limit));
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
function label(value){return ({songs:"歌曲榜",artists:"歌手榜",vtubers:"VTuber 频道榜",today:"今日","3d":"近 3 天","7d":"近 7 天","30d":"近 30 天",all:"全部"})[value]||value}
function dateText(value){return value?new Intl.DateTimeFormat("zh-CN",{month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false,timeZone:"Asia/Shanghai"}).format(new Date(value)):"未知"}
function normalize(value){return String(value||"").normalize("NFKC").toLocaleLowerCase("ja").replace(/[\s\p{P}\p{S}]+/gu,"")}
function escapeText(value){return String(value??"").replace(/[&<>"']/g,(ch)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[ch])}
function escapeAttr(value){return escapeText(value)}
function debounce(fn,ms){let timer;return()=>{clearTimeout(timer);timer=setTimeout(()=>fn().catch(showError),ms)}}
function showError(error){el.status.textContent=`读取失败：${error.message}`;console.error(error)}
