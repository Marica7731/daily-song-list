#!/usr/bin/env node
"use strict";

// Shared no-song retry policy for the static pipeline.
//
// A zero-song scrape is never terminal: the streamer may publish the setlist minutes, hours or
// days after the stream, so the video stays in the retry pool forever and only the spacing
// between attempts grows. The ladder starts small so a setlist that lands shortly after the
// stream is picked up on the next pass instead of waiting a whole day, and only reaches the
// day-scale cap once a video has repeatedly come back empty.
//
// Values are minutes and indexed by the attempt count that has already been spent:
// attempts 0 -> due now, 1 -> +15m, 2 -> +45m, 3 -> +2h, 4 -> +5h, 5 -> +12h, 6 -> +24h,
// 7 -> +48h, 8 -> +96h, 9 -> +144h, 10+ -> +168h.
const DEFAULT_RETRY_LADDER_MINUTES = Object.freeze([0, 15, 45, 120, 300, 720, 1440, 2880, 5760, 8640, 10080]);
// Deterministic per-video jitter keeps retries from all becoming due in the same minute, which
// would otherwise turn the pool into a synchronized burst once the cooldown expires.
const RETRY_JITTER_RATIO = 0.2;

function retryLadderMinutes() {
  const raw = String(process.env.STATIC_NO_SONG_RETRY_LADDER_MINUTES || "").trim();
  if (!raw) return [...DEFAULT_RETRY_LADDER_MINUTES];
  const parsed = raw.split(",").map((part) => Number.parseInt(part.trim(), 10));
  if (!parsed.length || parsed.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error(`invalid STATIC_NO_SONG_RETRY_LADDER_MINUTES: ${raw}`);
  }
  return parsed;
}

// FNV-1a: stable across runs and platforms, so a video keeps the same jitter every pass.
function stableHash(value) {
  let hash = 0x811c9dc5;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function retryCooldownMinutes(attempts, videoId, ladder = retryLadderMinutes()) {
  const spent = Number.isFinite(Number(attempts)) ? Math.max(0, Math.trunc(Number(attempts))) : 0;
  const base = ladder[Math.min(spent, ladder.length - 1)] || 0;
  if (base <= 0) return 0;
  const jitter = ((stableHash(videoId) % 2001) / 1000 - 1) * RETRY_JITTER_RATIO;
  return Math.max(1, Math.round(base * (1 + jitter)));
}

// Attempts already spent determine when the next pass may inspect the video again.
function nextEligibleMs(record, videoId, ladder = retryLadderMinutes()) {
  const lastAttempt = Date.parse(record?.lastAttemptAt || "");
  if (!Number.isFinite(lastAttempt)) return 0;
  return lastAttempt + retryCooldownMinutes(record?.attempts || 0, videoId, ladder) * 60000;
}

function isRetryDue(record, videoId, nowMs, ladder = retryLadderMinutes()) {
  return nextEligibleMs(record, videoId, ladder) <= nowMs;
}

module.exports = {
  DEFAULT_RETRY_LADDER_MINUTES,
  RETRY_JITTER_RATIO,
  isRetryDue,
  nextEligibleMs,
  retryCooldownMinutes,
  retryLadderMinutes,
  stableHash,
};
