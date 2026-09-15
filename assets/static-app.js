"use strict";

const BASE = "data/static/v1/";
const state = { meta: null, page: 1, pageCount: 1, searchIndex: null };
const el = Object.fromEntries(["status","gap","range","type","keyword","search","summary","ranking","prev","next","page","page-input","page-go","page-tokens","detail","detail-body"].map((id) => [id, document.getElementById(id)]));

start().catch(showError);

async function start() {
  state.meta = await json("meta.json");
  const sevenDaySongs = Number(state.meta.ranges?.["7d"]?.songs?.totalCount || 0);
  const thirtyDaySongs = Number(state.meta.ranges?.["30d"]?.songs?.totalCount || 0);
  if (sevenDaySongs === 0 && thirtyDaySongs > 0) el.range.value = "30d";
  const pending = Number(state.meta.pendingVideoCount || 0);
  el.status.textContent = `更新：${dateText(state.meta.generatedAt)} · 已处理 ${Number(state.meta.processedVideoCount || 0).toLocaleString()} 个视频${pending ? ` · 待处理 ${pending.toLocaleString()} 个` : ""}${sevenDaySongs === 0 && thirtyDaySongs > 0 ? " · 近 7 天数据正在追赶，已先显示近 30 天" : ""}`;
  if (state.meta.historyGaps?.length) {
    el.gap.hidden = false;
    el.gap.textContent = `历史缺口：${state.meta.historyGaps.map((gap) => `${gap.from}～${gap.through}（${gap.status}）`).join("、")}。页面不会把缺失历史伪装成完整数据。`;
  }
  for (const control of [el.range, el.type]) control.addEventListener("change", () => { state.page = 1; load(); });
  el.keyword.addEventListener("input", renderCurrent);
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
  const manifest = state.meta.ranges[range][type];
  state.pageCount = manifest.pageCount;
  state.page = Math.min(state.page, state.pageCount);
  state.current = await json(`rankings/${range}/${type}/page-${String(state.page).padStart(4,"0")}.json`);
  el.summary.textContent = `${label(type)} · ${label(range)} · ${state.current.totalCount} 项 · 静态分片 ${state.page}/${state.pageCount}`;
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
  const query = normalize(el.search.value);
  if (!query) { state.page = 1; return load(); }
  if (!state.searchIndex) {
    const manifest = await json("search/manifest.json");
    const shards = await Promise.all(manifest.shards.map((shard) => json(shard.path)));
    state.searchIndex = shards.flatMap((shard) => shard.items);
  }
  const type = el.type.value;
  const results = state.searchIndex.filter((item) => item.type === type && item.text.includes(query)).slice(0,100)
    .map((item,index) => ({ rank:index+1,...item,occurrenceCount:"–",videoCount:"–",keywords:[] }));
  el.summary.textContent = `全局搜索：${results.length} 项（最多显示 100）`;
  render(results);
  el.page.textContent = "搜索";
  el["page-tokens"].replaceChildren();
  el["page-input"].value = "1";
  el["page-input"].disabled = true;
  el["page-go"].disabled = true;
  el.prev.disabled = true;
  el.next.disabled = true;
}

function render(items) {
  el.ranking.replaceChildren(...items.map((item) => {
    const li = document.createElement("li");
    li.className = "rank-row";
    li.innerHTML = `<span class="rank">#${escapeText(item.rank)}</span><div class="rank-main"><div class="name">${escapeText(item.name)}</div><div class="secondary">${escapeText(item.secondary || "")}</div><div class="metrics">${escapeText(item.occurrenceCount)} 次 · ${escapeText(item.videoCount)} 个视频</div></div>`;
    const button = document.createElement("button");
    button.textContent = "详情";
    button.addEventListener("click", () => detail(item));
    li.append(button);
    return li;
  }));
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
  el["detail-body"].innerHTML = "<p>正在加载来源…</p>";
  el.detail.showModal();
  const payload = await json(item.detailPath);
  const sorted = [...(payload.occurrences || [])].sort((a, b) => String(b.publishedAt || "").localeCompare(String(a.publishedAt || "")));
  const visible = sorted.slice(0, 20);
  const occurrences = visible.map((entry) => {
    const seconds = Number(entry.seconds || 0);
    const watch = `https://www.youtube.com/watch?v=${encodeURIComponent(entry.videoId || "")}${seconds > 0 ? `&t=${Math.floor(seconds)}s` : ""}`;
    return `<article class="occurrence"><a class="occurrence-thumb" href="${escapeAttr(watch)}" target="_blank" rel="noreferrer"><img src="${escapeAttr(entry.thumbnailUrl)}" alt="" loading="lazy" decoding="async"></a><div class="occurrence-body"><a class="occurrence-title" href="${escapeAttr(watch)}" target="_blank" rel="noreferrer">${escapeText(entry.videoTitle)}</a><div>${escapeText(entry.channelName)} · ${escapeText(entry.publishedAt?.slice(0,10) || "")}</div><div>${escapeText(entry.songTitle || payload.name)} ${escapeText(entry.artist || payload.secondary || "")} ${escapeText(entry.time || "")}</div><div class="occurrence-actions"><a href="${escapeAttr(watch)}" target="_blank" rel="noreferrer">▶ ${escapeText(entry.time || "YouTube")}</a><a href="${escapeAttr(entry.sourcePath)}" data-source="${escapeAttr(entry.sourcePath)}">完整歌单</a></div></div></article>`;
  }).join("");
  const more = sorted.length > visible.length ? `<p class="detail-note">共 ${sorted.length} 条来源，为避免一次加载大量缩略图，这里先显示最新 20 条。</p>` : "";
  el["detail-body"].innerHTML = `<h2>${escapeText(payload.name)}</h2><p>${escapeText(payload.secondary || "")} · ${payload.occurrenceCount} 次 · ${payload.videoCount} 个视频</p>${more}${occurrences || "<p>暂无来源。</p>"}`;
  el["detail-body"].querySelectorAll("[data-source]").forEach((link) => link.addEventListener("click", async (event) => {
    event.preventDefault();
    const source = await json(link.dataset.source);
    el["detail-body"].innerHTML = `<button class="detail-back" type="button">← 返回来源</button><h2>${escapeText(source.title)}</h2><p>${escapeText(source.channelName)} · ${escapeText(source.publishedAt)}</p><p><a href="${escapeAttr(source.watchUrl)}" target="_blank" rel="noreferrer">打开 YouTube</a></p>${source.songs.map((song) => {
      const watch = `${source.watchUrl || `https://www.youtube.com/watch?v=${encodeURIComponent(source.videoId || "")}`}${Number(song.seconds || 0) > 0 ? `&t=${Math.floor(Number(song.seconds))}s` : ""}`;
      return `<div class="source-song"><a href="${escapeAttr(watch)}" target="_blank" rel="noreferrer">${escapeText(song.time)} ${escapeText(song.title)} — ${escapeText(song.artist)}</a></div>`;
    }).join("")}`;
    el["detail-body"].querySelector(".detail-back").addEventListener("click", () => detail(item));
  }));
}

async function json(relative) {
  const response = await fetch(`${BASE}${relative}`, { cache:"no-store" });
  if (!response.ok) throw new Error(`${relative}: HTTP ${response.status}`);
  return response.json();
}
function label(value){return ({songs:"歌曲",artists:"歌手",vtubers:"VTuber","7d":"最近 7 天","30d":"最近 30 天",all:"连续数据全部"})[value]||value}
function dateText(value){return value?new Intl.DateTimeFormat("zh-Hant",{dateStyle:"medium",timeStyle:"short",timeZone:"Asia/Taipei"}).format(new Date(value)):"未知"}
function normalize(value){return String(value||"").normalize("NFKC").toLocaleLowerCase("ja").replace(/[\s\p{P}\p{S}]+/gu,"")}
function escapeText(value){return String(value??"").replace(/[&<>"']/g,(ch)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[ch])}
function escapeAttr(value){return escapeText(value)}
function debounce(fn,ms){let timer;return()=>{clearTimeout(timer);timer=setTimeout(()=>fn().catch(showError),ms)}}
function showError(error){el.status.textContent=`读取失败：${error.message}`;console.error(error)}
