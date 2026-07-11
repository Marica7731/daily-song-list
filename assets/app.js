const state = {
  payload: null,
  snapshots: [],
  range: "72h",
  filter: "",
};

const els = {
  status: document.querySelector("#status"),
  summary: document.querySelector("#summary"),
  videoList: document.querySelector("#videoList"),
  snapshotSelect: document.querySelector("#snapshotSelect"),
  filterInput: document.querySelector("#filterInput"),
  tabs: Array.from(document.querySelectorAll(".tab")),
  template: document.querySelector("#videoTemplate"),
};

init().catch((error) => {
  els.status.textContent = "Load failed";
  els.summary.innerHTML = `<span class="empty">Unable to load song-list data: ${escapeHtml(error.message)}</span>`;
});

async function init() {
  const [latest, snapshotIndex, status] = await Promise.all([
    readJson("data/latest.json"),
    readJson("data/snapshots/index.json").catch(() => ({ snapshots: [] })),
    readJson("data/status.json").catch(() => null),
  ]);
  state.payload = latest;
  state.snapshots = Array.isArray(snapshotIndex.snapshots) ? snapshotIndex.snapshots : [];
  renderSnapshotOptions();
  renderStatus(status || latest.status);
  bindEvents();
  render();
}

function bindEvents() {
  for (const tab of els.tabs) {
    tab.addEventListener("click", () => {
      state.range = tab.dataset.range;
      for (const item of els.tabs) {
        item.classList.toggle("active", item === tab);
        item.setAttribute("aria-selected", item === tab ? "true" : "false");
      }
      render();
    });
  }

  els.filterInput.addEventListener("input", () => {
    state.filter = els.filterInput.value.trim().toLowerCase();
    render();
  });

  els.snapshotSelect.addEventListener("change", async () => {
    const path = els.snapshotSelect.value;
    state.payload = await readJson(path);
    renderStatus(state.payload.status);
    render();
  });
}

function renderSnapshotOptions() {
  const latestOption = document.createElement("option");
  latestOption.value = "data/latest.json";
  latestOption.textContent = "Latest";
  els.snapshotSelect.append(latestOption);

  for (const entry of state.snapshots) {
    const option = document.createElement("option");
    option.value = entry.path;
    option.textContent = entry.label || entry.id;
    els.snapshotSelect.append(option);
  }
}

function renderStatus(status) {
  if (!status) {
    els.status.textContent = "Status unavailable";
    return;
  }
  const label = status.status === "success" ? "Last success" : "Using previous data";
  const at = formatDate(status.completedAt || status.generatedAt || status.attemptedAt);
  els.status.textContent = `${label}: ${at}`;
}

function render() {
  const group = state.payload?.groups?.[state.range] || { items: [] };
  const items = filterItems(group.items || []);
  const allSongs = items.reduce((sum, item) => sum + (item.songs?.length || 0), 0);
  els.summary.innerHTML = [
    `<strong>${group.title || state.range}</strong>`,
    `${items.length} videos`,
    `${allSongs} timestamp links`,
    `captured ${formatDate(state.payload?.capturedAt || state.payload?.generatedAt)}`,
  ].join(" · ");

  els.videoList.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = state.filter ? "No matching songs in this snapshot." : "No timestamp song lists in this range.";
    els.videoList.append(empty);
    return;
  }

  for (const item of items) {
    els.videoList.append(renderVideo(item));
  }
}

function filterItems(items) {
  if (!state.filter) return items;
  return items.filter((item) => {
    const haystack = [
      item.title,
      item.channelName,
      item.keyword,
      ...(item.songs || []).flatMap((song) => [song.title, song.artist]),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(state.filter);
  });
}

function renderVideo(item) {
  const node = els.template.content.firstElementChild.cloneNode(true);
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(item.videoId)}`;
  const thumbLink = node.querySelector(".thumb-link");
  const thumb = node.querySelector(".thumb");
  const title = node.querySelector(".video-title");
  const meta = node.querySelector(".video-meta");
  const count = node.querySelector(".song-count");
  const list = node.querySelector(".song-list");

  thumbLink.href = url;
  thumb.src = item.thumbnailUrl || `https://i.ytimg.com/vi/${item.videoId}/hqdefault.jpg`;
  thumb.alt = "";
  title.href = url;
  title.textContent = item.title || item.videoId;
  meta.textContent = [item.channelName, item.publishedText, item.keyword].filter(Boolean).join(" · ");
  count.textContent = `${item.songs?.length || 0} songs`;

  for (const song of item.songs || []) {
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.href = youtubeTimeUrl(item.videoId, song.seconds);
    link.target = "_blank";
    link.rel = "noreferrer";
    link.innerHTML = `<span class="time">${escapeHtml(song.time)}</span> ${escapeHtml(song.title)}${song.artist ? ` / ${escapeHtml(song.artist)}` : ""}`;
    li.append(link);
    list.append(li);
  }

  return node;
}

async function readJson(path) {
  const response = await fetch(path, { cache: "no-store" });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

function youtubeTimeUrl(videoId, seconds) {
  const safeSeconds = Math.max(0, Number(seconds) || 0);
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${safeSeconds}s`;
}

function formatDate(value) {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-Hant", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
