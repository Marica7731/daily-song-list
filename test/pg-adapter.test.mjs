{"message":"No commit found for the ref 972f5e3f42b1d75b8d91b040a48c60a3ebd24b","documentation_url":"https://docs.github.com/v3/repos/contents/","status":"404"}

test("range-specific channel source details use the requested range", () => {
  const output = runPython(`
import importlib.util
spec = importlib.util.spec_from_file_location("pg_adapter", ${JSON.stringify(ADAPTER)})
module = importlib.util.module_from_spec(spec)
import sys
sys.modules[spec.name] = module
spec.loader.exec_module(module)
channel_id = "UCFP9UkgIM_U8NfzRbYEOQdA"
mMetadata = {"channelId": channel_id, "channelName": "なれたん Naraetan Ch.", "channelHandle": "/@naraetanV", "expectedSongCount": 1404, "sourceDetailKey": module._stable_key("source-vtuber", "all", channel_id)}
range_key = module._stable_key("source-vtuber", "7d", channel_id)
assert module._metadata_for_source_key([mMetadata], range_key) is mMetadata
ranking = module._apply_channel_metadata({"key": channel_id, "count": 54, "videoCount": 2, "songCount": 0}, {"detail_key": channel_id, "channel_search_text": "naraetan"}, [mMetadata], "7d")
assert ranking["sourceDetailKey"] == range_key and ranking["songCount"] == 0
class Cursor:
    def execute(self, sql, params):
        if "FROM runtime_videos" in sql:
            self.description = [("video_id",), ("title",), ("channel_name",), ("channel_id",), ("channel_handle",), ("channel_url",), ("published_timestamp",), ("payload_json",)]
            self.rows = [("video-7d", "歌枠", "なれたん Naraetan Ch.", channel_id, "/@naraetanV", "https://www.youtube.com/@naraetanV", "2026-07-27T00:00:00Z", {})]
        elif "FROM runtime_occurrences" in sql:
            assert "COALESCE(range_id, 'all') = %s" in sql and params[-1] == "7d"
            self.description = [("occurrence_id",), ("range_id",), ("video_id",), ("song_key",), ("seconds",), ("source_system",), ("source_id",), ("title",), ("artist",), ("is_niche",), ("is_unknown_artist",), ("payload_json",)]
            self.rows = [("occ-7d", "7d", "video-7d", "song-7d", 12, "youtube", "src-7d", "Song 7D", "Artist", False, False, {})]
        else:
            self.description = []
            self.rows = []
    def fetchall(self): return self.rows
    def close(self): pass
class Connection:
    def cursor(self): return Cursor()
source = module._runtime_channel_source_payload(Connection(), "rev", mMetadata, range_key, {"page": "1", "pageSize": "20"})
assert source["found"] is True and source["sourceKey"] == range_key
assert len(source["record"]["occurrences"]) == 1
assert source["record"]["occurrences"][0]["song"]["rangeId"] == "7d"
print("OK")
`);
  assert.equal(output, "OK");
});
