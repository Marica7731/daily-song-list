import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXPORTER = path.join(ROOT, "scripts", "migration", "export-sqlite-records.py");

function resolvePython() {
  const candidates = process.env.PYTHON
    ? [process.env.PYTHON]
    : process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true });
    if (!probe.error && probe.status === 0) return candidate;
  }
  throw new Error("Python interpreter not found");
}

test("SQLite exporter streams runtime projection rows without changing occurrence semantics", () => {
  const python = resolvePython();
  const script = String.raw`
import json
import pathlib
import sqlite3
import subprocess
import sys
import tempfile

with tempfile.TemporaryDirectory() as directory:
    db = pathlib.Path(directory) / "fixture.sqlite"
    con = sqlite3.connect(db)
    con.executescript("""
      CREATE TABLE meta (key TEXT, value TEXT);
      CREATE TABLE videos (video_id TEXT, title TEXT, channel_name TEXT, channel_id TEXT, channel_handle TEXT, channel_url TEXT, keyword TEXT, published_timestamp INTEGER, published_text TEXT, duration_text TEXT, thumbnail_url TEXT, payload_json TEXT);
      CREATE TABLE songs (song_key TEXT, title TEXT, artist TEXT, is_niche INTEGER, payload_json TEXT);
      CREATE TABLE occurrences (occurrence_id TEXT, range_id TEXT, video_id TEXT, song_key TEXT, seconds INTEGER, source_system TEXT, source_id TEXT, title TEXT, artist TEXT, is_niche INTEGER, is_unknown_artist INTEGER, payload_json TEXT);
      CREATE TABLE channel_metadata (channel_key TEXT, channel_id TEXT, handle TEXT, display_name TEXT, avatar_url TEXT, thumbnail_url TEXT, source_url TEXT, channel_url TEXT, known_source_type TEXT, is_collected INTEGER, payload_json TEXT);
      CREATE TABLE source_occurrences (source_key TEXT, range_id TEXT, position INTEGER, video_id TEXT, title TEXT, channel_name TEXT, channel_id TEXT, channel_handle TEXT, channel_url TEXT, published_timestamp INTEGER, seconds INTEGER, is_niche INTEGER, is_unknown_artist INTEGER, search_text TEXT, payload_json TEXT);
      CREATE TABLE source_details (source_key TEXT, range_id TEXT, entity_type TEXT, entity_key TEXT, payload_json TEXT);
      CREATE TABLE ranking_rows (row_id TEXT, range_id TEXT, view TEXT, metric TEXT, scope_key TEXT, rank INTEGER, detail_key TEXT, title TEXT, artist TEXT, name TEXT, count INTEGER, song_count INTEGER, video_count INTEGER, timestamp_count INTEGER, payload_json TEXT, search_text TEXT, channel_search_text TEXT);
      CREATE TABLE external_songs (source_system TEXT, external_song_id TEXT, canonical_song_id TEXT, title TEXT, artist TEXT, source_url TEXT, payload_json TEXT);
      CREATE TABLE external_videos (source_system TEXT, external_video_id TEXT, youtube_video_id TEXT, title TEXT, singer_name TEXT, streamed_at TEXT, source_url TEXT, payload_json TEXT);
      CREATE TABLE external_occurrences (source_system TEXT, occurrence_id TEXT, canonical_song_id TEXT, external_song_id TEXT, external_video_id TEXT, youtube_video_id TEXT, seconds INTEGER, payload_json TEXT);
    """)
    con.execute("INSERT INTO meta VALUES (?, ?)", ("latest_videos", "1"))
    con.execute("INSERT INTO videos VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ("AAAAAAAAAAA", "stream", "channel", "UC1", "@channel", "https://example/channel", "", 1, "text", "", "", "{}"))
    con.execute("INSERT INTO songs VALUES (?, ?, ?, ?, ?)", ("song-a", "Song", "", 0, "{}"))
    con.execute("INSERT INTO occurrences VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ("occ-a", "all", "AAAAAAAAAAA", "song-a", None, "", "", "Song", "", 0, 1, "{}"))
    con.execute("INSERT INTO channel_metadata VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ("channel", "UC1", "@channel", "channel", "", "", "", "", "", 0, "{}"))
    con.execute("INSERT INTO source_occurrences VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ("source-a", "all", 0, "AAAAAAAAAAA", "Song", "channel", "UC1", "@channel", "", 1, None, 0, 1, "Song", "{}"))
    con.execute("INSERT INTO source_details VALUES (?, ?, ?, ?, ?)", ("source-a", "all", "song", "song-a", "{}"))
    con.execute("INSERT INTO ranking_rows VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", ("row-a", "all", "songs", "count", "song-a", 1, "detail-a", "Song", "", "", 1, 1, 1, 1, "{}", "Song", "channel"))
    con.execute("INSERT INTO external_songs VALUES (?, ?, ?, ?, ?, ?, ?)", ("ext", "ext-song", "song-a", "Song", "", "", "{}"))
    con.execute("INSERT INTO external_videos VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ("ext", "ext-video", "AAAAAAAAAAA", "stream", "channel", "", "", "{}"))
    con.execute("INSERT INTO external_occurrences VALUES (?, ?, ?, ?, ?, ?, ?, ?)", ("ext", "ext-occ", "song-a", "ext-song", "ext-video", "AAAAAAAAAAA", None, "{}"))
    con.commit()
    con.close()
    result = subprocess.run([sys.executable, ${JSON.stringify(EXPORTER)}, "--db", str(db), "--range", "all"], text=True, capture_output=True, check=True)
    rows = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
    video = next(row for row in rows if row.get("videoId") == "AAAAAAAAAAA")
    assert video["songs"][0]["seconds"] is None
    runtime_types = {row["entityType"] for row in rows if row.get("kind") == "runtime"}
    assert {"meta", "videos", "songs", "occurrences", "channel_metadata", "source_occurrences", "source_details", "ranking_rows", "external_songs", "external_videos", "external_occurrences"} <= runtime_types
    print("OK")
`;
  const result = spawnSync(python, ["-c", script], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 20_000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), "OK");
});