"use strict";

const BASE = "data/static/v1/";
const state = { meta: null, page: 1, pageCount: 1, searchIndex: null };
const el = Object.fromEntries(["status","gap","range","type","keyword","search","summary","ranking","prev","next","page","detail","detail-body"].map((id) => [id, document.getElementById(id)]));

start().catch(showError);

async function start() {
  state.meta = await json("meta.json");
  el.status.textContent = `更新：${dateText(state.meta.generatedAt)} · 数据起点：${dateText(state.meta.continuityStart)} · 已处理 ${state.meta.processedVideoCount} 个视频`;
  if (state.meta.historyGaps?.length) {
    el.gap.hidden = false;
    el.gap.textContent = `历史缺口：${state.meta.historyGaps.map((gap) => `${gap.from}～${gap.through}（${gap.status}）`).join("、")}。页面不会把缺失历史伪装成完整数据。`;
  }
  for (const control of [el.range, el.type]) control.addEventListener("change", () => { state.page = 1; load(); });
  el.keyword.addEventListener("input", renderCurrent);
  el.search.addEventListener("input", debounce(search, 180));
  el.prev.addEventListener("click", () => { if (state.page > 1) { state.page -= 1; load(); } });
  el.next.addEventListener("click", () => { if (state.page < state.pageCount) { state.page += 1; load(); } });
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
  el.page.textContent = `${state.page} / ${state.pageCount}`;
  el.prev.disabled = state.page <= 1;
  el.next.disabled = state.page >= state.pageCount;
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
  el.prev.disabled = true;
  el.next.disabled = true;
}

function render(items) {
  el.ranking.replaceChildren(...items.map((item) => {
    const li = document.createElement("li");
    li.innerHTML = `<span class="rank">#${escapeText(item.rank)}</span><div><div class="name">${escapeText(item.name)}</div><div class="secondary">${escapeText(item.secondary || "")}</div><div class="metrics">${escapeText(item.occurrenceCount)} 次 · ${escapeText(item.videoCount)} 个视频</div></div>`;
    const button = document.createElement("button");
    button.textContent = "详情";
    button.addEventListener("click", () => detail(item));
    li.append(button);
    return li;
  }));
}

async function detail(item) {
  const payload = await json(item.detailPath);
  const occurrences = payload.occurrences.map((entry) => `<article class="occurrence"><img src="${escapeAttr(entry.thumbnailUrl)}" alt=""><strong>${escapeText(entry.videoTitle)}</strong><div>${escapeText(entry.channelName)} · ${escapeText(entry.publishedAt?.slice(0,10) || "")}</div><div>${escapeText(entry.songTitle || payload.name)} ${escapeText(entry.artist || payload.secondary || "")} ${escapeText(entry.time || "")}</div><a href="${escapeAttr(entry.sourcePath)}" data-source="${escapeAttr(entry.sourcePath)}">来源详情</a></article>`).join("");
  el["detail-body"].innerHTML = `<h2>${escapeText(payload.name)}</h2><p>${escapeText(payload.secondary || "")} · ${payload.occurrenceCount} 次 · ${payload.videoCount} 个视频</p>${occurrences || "<p>暂无 occurrence。</p>"}`;
  el["detail-body"].querySelectorAll("[data-source]").forEach((link) => link.addEventListener("click", async (event) => {
    event.preventDefault();
    const source = await json(link.dataset.source);
    el["detail-body"].innerHTML = `<h2>${escapeText(source.title)}</h2><p>${escapeText(source.channelName)} · ${escapeText(source.publishedAt)}</p><p><a href="${escapeAttr(source.watchUrl)}">YouTube</a></p>${source.songs.map((song) => `<div>${escapeText(song.time)} ${escapeText(song.title)} — ${escapeText(song.artist)}</div>`).join("")}`;
  }));
  el.detail.showModal();
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
