import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  activateCandidate,
  compareRevisions,
  ensureSchema,
  health,
  prepareCandidate,
  resolveDsnFromEnv,
  resolveRevision,
  rollbackActive,
} from "../scripts/migration/pg-incremental.mjs";

const pgliteModulePath = process.env.PGLITE_MODULE || "";

test("production DSN detection never exposes its value", () => {
  assert.deepEqual(resolveDsnFromEnv({ DAILY_SONG_POSTGRES_DSN: "postgres://secret" }), {
    key: "DAILY_SONG_POSTGRES_DSN",
    present: true,
  });
  assert.deepEqual(resolveDsnFromEnv({}), { key: null, present: false });
});

test("accepted-increment importer keeps 7d range and derives missing song identity", () => {
  const importer = readFileSync(new URL("../scripts/migration/import-pg-incremental.py", import.meta.url), "utf8");
  assert.match(importer, /or record\.get\("rangeId".*or "7d"/);
  assert.match(importer, /def derived_song_key/);
  assert.match(importer, /or record\.get\("sourceSystem".*or "mygit-7d"/);
});

test("ephemeral PostgreSQL candidate supports upsert, compare, activate and rollback", {
  skip: !pgliteModulePath ? "set PGLITE_MODULE to run the real ephemeral PostgreSQL test" : false,
}, async () => {
  const { PGlite } = await import(pgliteModulePath);
  const db = new PGlite(process.env.PGLITE_DATA_DIR || "memory://daily-song-list-pg-test");
  const client = { query: (sql, values) => db.query(sql, values) };
  try {
    await ensureSchema(client);
    const baseRecords = [
      {
        videoId: "AAAAAAAAAAA",
        title: "Base stream",
        channelName: "Channel A",
        channelHandle: "@channel-a",
        songs: [{ seconds: 10, title: "Song A", artist: "Artist A", sourceId: "source-a" }],
        reason: "fixture",
        reviewedAt: "2026-07-27T00:00:00Z",
        reviewedBy: "test",
      },
      {
        videoId: "BBBBBBBBBBB",
      title: "Second stream",
      channelName: "Channel B",
      channelHandle: "@channel-b",
      songs: [{ seconds: 20, title: "Song B", artist: "Artist B", sourceId: "source-b" }],
        reason: "fixture",
        reviewedAt: "2026-07-27T00:00:00Z",
        reviewedBy: "test",
      },
      {
        videoId: "CCCCCCCCCCC",
        title: "Identity stream",
        songs: [
          {
            occurrenceId: "occ-null-1",
            position: 3,
            rangeId: "all",
            songKey: "song-null-1",
            seconds: null,
            title: "Empty artist",
            artist: "",
            sourceId: "",
            sourceSystem: null,
          },
          {
            occurrenceId: "occ-null-2",
            position: 4,
            rangeId: "7d",
            songKey: "song-null-2",
            seconds: null,
            title: "Null artist",
            artist: null,
            sourceId: null,
            sourceSystem: "source-b",
          },
        ],
        reason: "fixture",
        reviewedAt: "2026-07-27T00:00:00Z",
        reviewedBy: "test",
      },
    ];
    const first = await prepareCandidate(client, baseRecords, { fixture: "base" }, { revisionId: "rev-base" });
    assert.equal(first.upsertedRecords, 3);
    assert.equal(first.candidate.videoCount, 3);
    assert.equal(first.candidate.occurrenceCount, 4);
    const identity = (await resolveRevision(client, first.revisionId)).records.find((record) => record.videoId === "CCCCCCCCCCC");
    assert.deepEqual(identity.songs.map(({ occurrenceId, position, rangeId, songKey, seconds, artist, sourceId, sourceSystem }) => ({
      occurrenceId, position, rangeId, songKey, seconds, artist, sourceId, sourceSystem,
    })), [
      {
        occurrenceId: "occ-null-1",
        position: 3,
        rangeId: "all",
        songKey: "song-null-1",
        seconds: null,
        artist: "",
        sourceId: "",
        sourceSystem: null,
      },
      {
        occurrenceId: "occ-null-2",
        position: 4,
        rangeId: "7d",
        songKey: "song-null-2",
        seconds: null,
        artist: null,
        sourceId: null,
        sourceSystem: "source-b",
      },
    ]);
    assert.equal((await health(client)).activeRevisionId, null);
    await activateCandidate(client, first.revisionId, first.candidate.contentSha256);
    assert.equal((await health(client)).activeRevisionId, "rev-base");

    const updated = [{
      ...baseRecords[0],
      title: "Updated stream",
      songs: [{ seconds: 30, title: "Song A2", artist: "Artist A2", sourceId: "source-a2" }],
    }];
    const second = await prepareCandidate(client, updated, { fixture: "updated" }, { revisionId: "rev-updated" });
    assert.deepEqual(second.changedVideoIds, ["AAAAAAAAAAA"]);
    await activateCandidate(client, second.revisionId, second.candidate.contentSha256);
    const updatedHealth = await health(client);
    assert.equal(updatedHealth.activeRevisionId, "rev-updated");
    assert.equal(updatedHealth.videoCount, 3);
    assert.equal(updatedHealth.occurrenceCount, 4);

    const rolledBack = await rollbackActive(client);
    assert.equal(rolledBack.activeRevisionId, "rev-base");
    assert.equal(rolledBack.contentSha256, first.candidate.contentSha256);

    const tombstone = await prepareCandidate(client, [{
      videoId: "BBBBBBBBBBB",
      deleted: true,
      reason: "fixture tombstone",
      reviewedAt: "2026-07-27T00:00:00Z",
      reviewedBy: "test",
    }], { fixture: "tombstone" }, { revisionId: "rev-tombstone" });
    assert.equal(tombstone.candidate.videoCount, 2);
    assert.deepEqual(tombstone.changedVideoIds, ["BBBBBBBBBBB"]);
    await activateCandidate(client, tombstone.revisionId, tombstone.candidate.contentSha256);
    assert.equal((await health(client)).videoCount, 2);
    assert.equal((await rollbackActive(client)).activeRevisionId, "rev-base");

    const concurrentOne = await prepareCandidate(client, updated, { fixture: "concurrent-one" }, { revisionId: "rev-concurrent-one" });
    const concurrentTwo = await prepareCandidate(client, [{
      ...updated[0],
      title: "Concurrent second candidate",
    }], { fixture: "concurrent-two" }, { revisionId: "rev-concurrent-two" });
    await activateCandidate(client, concurrentOne.revisionId, concurrentOne.candidate.contentSha256);
    await assert.rejects(
      () => activateCandidate(client, concurrentTwo.revisionId, concurrentTwo.candidate.contentSha256),
      /candidate parent mismatch/,
    );
    assert.equal((await health(client)).activeRevisionId, "rev-concurrent-one");
    assert.equal((await rollbackActive(client)).activeRevisionId, "rev-base");

    await assert.rejects(
      () => prepareCandidate(client, [{ ...baseRecords[0], videoId: "bad" }], { fixture: "invalid" }, { revisionId: "rev-invalid" }),
      /invalid videoId/,
    );
    assert.equal((await health(client)).activeRevisionId, "rev-base");
  } finally {
    await db.close();
  }
});

test("runtime projection rows preserve source identity and tombstones", {
  skip: !pgliteModulePath ? "set PGLITE_MODULE to run the real ephemeral PostgreSQL test" : false,
}, async () => {
  const { PGlite } = await import(pgliteModulePath);
  const db = new PGlite("memory://daily-song-list-runtime-projection-test");
  const client = { query: (sql, values) => db.query(sql, values) };
  try {
    await ensureSchema(client);
    const base = await prepareCandidate(client, [{
      kind: "runtime",
      entityType: "channel_metadata",
      entityKey: "channel-a",
      sourceSystem: "runtime",
      payload: {
        channel_key: "channel-a",
        channel_id: "UC000000001",
        handle: "@channel-a",
        display_name: "Channel A",
        is_collected: 0,
      },
    }], { fixture: "runtime" }, { revisionId: "rev-runtime" });
    const resolved = await resolveRevision(client, base.revisionId);
    assert.deepEqual(resolved.runtimeRows.map(({ entity_type, entity_key, source_system, payload_json }) => ({
      entity_type, entity_key, source_system, payload_json,
    })), [{
      entity_type: "channel_metadata",
      entity_key: "channel-a",
      source_system: "runtime",
      payload_json: {
        channel_key: "channel-a",
        channel_id: "UC000000001",
        handle: "@channel-a",
        display_name: "Channel A",
        is_collected: 0,
      },
    }]);
    const tombstone = await prepareCandidate(client, [{
      kind: "runtime",
      entityType: "channel_metadata",
      entityKey: "channel-a",
      tombstone: true,
      payload: { channel_key: "channel-a" },
    }], { fixture: "runtime-tombstone" }, { revisionId: "rev-runtime-tombstone" });
    assert.equal((await resolveRevision(client, tombstone.revisionId)).runtimeRows.length, 0);
  } finally {
    await db.close();
  }
});

test("full runtime importer maps SQLite ranking count to PostgreSQL row_count", () => {
  const importer = readFileSync(new URL("../scripts/migration/import-runtime-tables.py", import.meta.url), "utf8");
  assert.match(importer, /TARGET_COLUMNS/);
  assert.match(importer, /"row_count"/);
  assert.match(importer, /"count", "song_count"/);
});
