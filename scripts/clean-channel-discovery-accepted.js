const fs = require("node:fs");
const path = require("node:path");
const { dropSameSecondTranslatedAliasSongs } = require("../assets/source-filter");
const { auditParsedSongForImport } = require("./song-utils");

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_ACCEPTED_DIR = path.join(ROOT, "data", "external", "youtube-channel-discovery", "accepted");

if (require.main === module) {
  main();
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const acceptedDir = path.resolve(ROOT, String(args.dir || DEFAULT_ACCEPTED_DIR));
  const write = args.write === true;
  const files = listAcceptedFiles(acceptedDir, args.file);
  const summary = {
    files: 0,
    videosBefore: 0,
    videosAfter: 0,
    songsBefore: 0,
    songsAfter: 0,
    droppedVideos: 0,
    droppedSongs: 0,
    changedFiles: 0,
  };

  for (const filePath of files) {
    const result = cleanAcceptedFile(filePath, { write });
    summary.files += 1;
    summary.videosBefore += result.videosBefore;
    summary.videosAfter += result.videosAfter;
    summary.songsBefore += result.songsBefore;
    summary.songsAfter += result.songsAfter;
    summary.droppedVideos += result.droppedVideos;
    summary.droppedSongs += result.droppedSongs;
    if (result.changed) summary.changedFiles += 1;
    console.log(
      [
        "CHANNEL_DISCOVERY_ACCEPTED_FILE",
        `file=${path.relative(ROOT, filePath).replace(/\\/gu, "/")}`,
        `videos=${result.videosBefore}->${result.videosAfter}`,
        `songs=${result.songsBefore}->${result.songsAfter}`,
        `droppedVideos=${result.droppedVideos}`,
        `droppedSongs=${result.droppedSongs}`,
        `changed=${result.changed}`,
      ].join(" "),
    );
  }

  console.log(
    [
      "CODEX_CHANNEL_DISCOVERY_ACCEPTED_CLEAN_OK",
      `mode=${write ? "write" : "dry-run"}`,
      `files=${summary.files}`,
      `changedFiles=${summary.changedFiles}`,
      `videos=${summary.videosBefore}->${summary.videosAfter}`,
      `songs=${summary.songsBefore}->${summary.songsAfter}`,
      `droppedVideos=${summary.droppedVideos}`,
      `droppedSongs=${summary.droppedSongs}`,
    ].join(" "),
  );
}

function cleanAcceptedFile(filePath, options = {}) {
  const originalRaw = fs.readFileSync(filePath, "utf8");
  const payload = JSON.parse(originalRaw);
  const sourceVideos = Array.isArray(payload) ? payload : payload.videos;
  if (!Array.isArray(sourceVideos)) {
    throw new Error(`accepted JSON must be an array or contain videos array: ${filePath}`);
  }

  const cleanedVideos = [];
  let songsBefore = 0;
  let songsAfter = 0;
  for (const video of sourceVideos) {
    const originalSongs = Array.isArray(video?.songs) ? video.songs : [];
    songsBefore += originalSongs.length;
    const sourceContext = acceptedVideoSourceContext(video, payload);
    const filteredSongs = originalSongs
      .map((song) => auditParsedSongForImport(song, sourceContext))
      .filter((audit) => audit.action === "accept" && audit.song?.title)
      .map((audit) => audit.song);
    const cleanedSongs = dropSameSecondTranslatedAliasSongs(filteredSongs)
      .map((song, index) => ({ ...song, index: index + 1 }));
    songsAfter += cleanedSongs.length;
    if (!cleanedSongs.length) continue;
    cleanedVideos.push({ ...video, songs: cleanedSongs });
  }

  const videosChanged = JSON.stringify(cleanedVideos) !== JSON.stringify(sourceVideos);
  const countMismatch =
    !Array.isArray(payload) &&
    (payload.videoCount !== cleanedVideos.length ||
      payload.occurrenceCount !== songsAfter ||
      (payload.readStats && (payload.readStats.usableVideos !== cleanedVideos.length || payload.readStats.songs !== songsAfter)));
  const cleanedPayload = !videosChanged && !countMismatch
    ? payload
    : Array.isArray(payload)
      ? cleanedVideos
      : {
          ...payload,
          videos: cleanedVideos,
          videoCount: cleanedVideos.length,
          occurrenceCount: songsAfter,
          readStats: payload.readStats
            ? {
                ...payload.readStats,
                usableVideos: cleanedVideos.length,
                songs: songsAfter,
              }
            : payload.readStats,
          cleaningSummary: {
            generatedAt: new Date().toISOString(),
            cleaner: "scripts/clean-channel-discovery-accepted.js",
            videosBefore: sourceVideos.length,
            videosAfter: cleanedVideos.length,
            songsBefore,
            songsAfter,
            droppedVideos: sourceVideos.length - cleanedVideos.length,
            droppedSongs: songsBefore - songsAfter,
          },
        };
  const nextRaw = `${JSON.stringify(cleanedPayload, null, 2)}\n`;
  const changed = nextRaw !== originalRaw;
  if (changed && options.write) fs.writeFileSync(filePath, nextRaw);
  return {
    filePath,
    videosBefore: sourceVideos.length,
    videosAfter: cleanedVideos.length,
    songsBefore,
    songsAfter,
    droppedVideos: sourceVideos.length - cleanedVideos.length,
    droppedSongs: songsBefore - songsAfter,
    changed,
  };
}

function acceptedVideoSourceContext(video, payload) {
  return {
    videoId: video?.videoId || "",
    title: video?.title || "",
    videoTitle: video?.title || "",
    channelName: video?.channelName || video?.discoverySingerName || "",
    channelId: video?.channelId || "",
    channelHandle: video?.channelHandle || "",
    channelUrl: video?.channelUrl || video?.discoveryChannelUrl || "",
    sourceUrl: video?.sourceUrl || "",
    candidate: video,
    sourceRecord: video,
    source: payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null,
  };
}

function listAcceptedFiles(acceptedDir, fileArg) {
  if (fileArg) {
    const values = Array.isArray(fileArg) ? fileArg : [fileArg];
    return values.map((value) => path.resolve(ROOT, String(value)));
  }
  return fs.readdirSync(acceptedDir)
    .filter((name) => name.endsWith(".json"))
    .sort((left, right) => left.localeCompare(right))
    .map((name) => path.join(acceptedDir, name));
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[index + 1];
    const value = !next || next.startsWith("--") ? true : next;
    if (value !== true) index += 1;
    if (Object.prototype.hasOwnProperty.call(args, key)) {
      args[key] = Array.isArray(args[key]) ? [...args[key], value] : [args[key], value];
    } else {
      args[key] = value;
    }
  }
  return args;
}

module.exports = {
  acceptedVideoSourceContext,
  cleanAcceptedFile,
};
