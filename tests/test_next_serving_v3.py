from __future__ import annotations
import importlib.util
import http.client
import json
import threading
from contextlib import closing
import os
import shutil
import sqlite3
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from urllib.parse import parse_qs

ROOT=Path(__file__).resolve().parents[1]
SERVER_PATH=ROOT/"server"/"release_serving_server.py"
SNAPSHOT_PATH=ROOT/"scripts"/"migration"/"snapshot-runtime-db.py"
MATERIALIZER_PATH=ROOT/"scripts"/"migration"/"materialize-ranking-pages.py"
BUILDER_PATH=ROOT/"scripts"/"migration"/"build-serving-store.py"
BUNDLE_PATH=ROOT/"scripts"/"migration"/"build-release-bundle.py"
PATCHER_PATH=ROOT/"scripts"/"migration"/"patch-next-frontend.py"
INSTALLER_PATH=ROOT/"deploy"/"install-wdc-release.sh"


def load(name:str,path:Path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);assert spec and spec.loader;spec.loader.exec_module(module);return module

snapshotter=load("snapshotter",SNAPSHOT_PATH);materializer=load("materializer",MATERIALIZER_PATH);builder=load("builder",BUILDER_PATH);bundle=load("bundle",BUNDLE_PATH);server=load("server",SERVER_PATH);patcher=load("patcher",PATCHER_PATH)
ALL_KEY="01fc9d6830d3c230";SEVEN_KEY="7d0cafe0deadbeef";REV="rev-test-20260810";SERVER_COMMIT="0123456789abcdef0123456789abcdef01234567"


def card(rank:int,range_id:str,key:str="")->dict:
    value={"rank":rank,"key":f"{range_id}-{rank}","title":"ただ君に晴れ" if rank==1 else f"Song {rank:03d}",
           "artist":"ヨルシカ" if rank==1 else "Artist","count":500-rank,"videoCount":max(1,250-rank),
           "occurrences":[{"videoId":f"vid{rank:08d}"[-11:],"seconds":rank}]}
    if key:value["sourceDetailKey"]=key
    return value


def create_source_db(path:Path)->None:
    c=sqlite3.connect(path)
    c.executescript("""
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE source_details(source_key TEXT,range_id TEXT,entity_type TEXT,entity_key TEXT,payload_json TEXT,PRIMARY KEY(source_key,range_id));
    CREATE TABLE source_occurrences(source_key TEXT,range_id TEXT,position INTEGER,video_id TEXT,title TEXT,channel_name TEXT,channel_id TEXT,channel_handle TEXT,channel_url TEXT,published_timestamp INTEGER,seconds INTEGER,is_niche INTEGER,is_unknown_artist INTEGER,search_text TEXT,payload_json TEXT,PRIMARY KEY(source_key,range_id,position));
    CREATE TABLE ranking_rows(row_id TEXT,range_id TEXT,view TEXT,metric TEXT,scope_key TEXT,rank INTEGER,detail_key TEXT,title TEXT,artist TEXT,name TEXT,count INTEGER,song_count INTEGER,video_count INTEGER,timestamp_count INTEGER,payload_json TEXT,search_text TEXT,channel_search_text TEXT,PRIMARY KEY(range_id,view,metric,scope_key,rank));
    """)
    c.execute("INSERT INTO meta VALUES(?,?)",("active_revision_id",REV))
    for range_id,key in (("all",ALL_KEY),("7d",SEVEN_KEY)):
        c.execute("INSERT INTO source_details VALUES(?,?,?,?,?)",(key,range_id,"song","song-hare",json.dumps({"title":"ただ君に晴れ","artist":"ヨルシカ","sourceDetailKey":key},ensure_ascii=False)))
    rows=[(1,"videoAAAAAA",0,0),(2,"videoAAAAAA",1,0),(3,"videoBBBBBB",0,0),(4,"videoCCCCCC",0,0),(5,"videoCCCCCC",0,1)]
    for pos,video,niche,unknown in rows:
        payload={"videoId":video,"title":video,"channelName":"Fixture","channelId":"UCfixture","seconds":100+pos}
        c.execute("INSERT INTO source_occurrences VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  (ALL_KEY,"all",pos,video,video,"Fixture","UCfixture","@fixture","https://youtube.com/@fixture",1700000000+pos,100+pos,niche,unknown,f"ただ君に晴れ ヨルシカ {video}",json.dumps(payload,ensure_ascii=False)))
    payload={"videoId":"video7DDDDD","title":"7d","channelName":"Fixture","channelId":"UCfixture","seconds":1}
    c.execute("INSERT INTO source_occurrences VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              (SEVEN_KEY,"7d",1,"video7DDDDD","7d","Fixture","UCfixture","@fixture","https://youtube.com/@fixture",1700000001,1,0,0,"ただ君に晴れ ヨルシカ",json.dumps(payload,ensure_ascii=False)))
    for range_id,count in (("all",250),("7d",3)):
        for view in ("songs","vtubers","videos"):
            for db_metric in ("count","songs","videos"):
                for rank in range(1,count+1):
                    key=ALL_KEY if range_id=="all" and rank==1 else SEVEN_KEY if range_id=="7d" and rank==1 else ""
                    value=card(rank,range_id,key)
                    search_text=f"{value['title']} {value['artist']}"
                    if rank==1:
                        value["payload"]={"must":"be dropped"}
                        value["searchText"]="must not be served"
                        value["occurrences"]=[
                            {"videoId":"videoAAAAAA","seconds":1,"payload":{"large":True}},
                            {"videoId":"videoAAAAAA","seconds":2},
                            {"videoId":"videoBBBBBB","seconds":3},
                            {"videoId":"videoCCCCCC","seconds":4},
                            {"videoId":"videoDDDDDD","seconds":5},
                        ]
                        search_text += " " + ("x" * 70000)
                    c.execute("INSERT INTO ranking_rows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                              (f"{range_id}-{view}-{db_metric}-{rank}",range_id,view,db_metric,"all",rank,key,value["title"],value["artist"],value["title"],value["count"],1,value["videoCount"],value["count"],json.dumps(value,ensure_ascii=False),search_text,"Fixture @fixture"))
    c.commit();c.close()


def create_pages(root:Path)->None:
    for range_id,count in (("all",250),("7d",3)):
        directory=root/"rankings"/range_id/"songs"/"occurrences";directory.mkdir(parents=True,exist_ok=True)
        values=[]
        for rank in range(1,count+1):
            key=ALL_KEY if range_id=="all" and rank==1 else SEVEN_KEY if range_id=="7d" and rank==1 else ""
            values.append(card(rank,range_id,key))
        for offset in range(0,len(values),200):
            page=offset//200+1
            payload={"schemaVersion":1,"rangeId":range_id,"view":"songs","metric":"occurrences","page":page,"pageSize":200,"totalCount":len(values),"records":values[offset:offset+200]}
            (directory/f"page-{page:04d}.json").write_text(json.dumps(payload,ensure_ascii=False),encoding="utf-8")


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp=Path(tempfile.mkdtemp(prefix="dsl-v3-"));self.source=self.temp/"source.sqlite";self.pages=self.temp/"pages";self.serving=self.temp/"serving.sqlite";self.releases=self.temp/"releases"
        create_source_db(self.source)
        self.snapshot=self.temp/"snapshot.sqlite"
        self.snapshot_result=snapshotter.snapshot(self.source,self.snapshot,expected_revision=REV)
        self.materialized=materializer.materialize(self.snapshot,self.pages,active_revision_id=REV)
        self.build=builder.build_serving_store(self.snapshot,self.pages,self.serving,active_revision_id=REV,built_at="2026-08-10T00:00:00Z")
        meta={"activeRevisionId":REV,"expectedParentRevisionId":"parent","sourceCommitSha":"a"*40,"serverCommitSha":SERVER_COMMIT,"buildLogicSha":"b"*64,"generatedAt":"2026-08-10T00:00:00Z","latestEventTime":"2026-08-09T23:59:59Z"}
        self.sha,self.release=bundle.build_bundle(self.pages,self.releases,serving_sqlite=self.serving,server_artifact=SERVER_PATH,release_meta=meta)
        os.symlink(self.sha,self.releases/"current");self.store=server.ReleaseStore(self.releases)
    def tearDown(self):shutil.rmtree(self.temp,ignore_errors=True)

    def test_canonical_keys_and_coverage(self):
        self.assertEqual(self.snapshot_result["activeRevisionId"],REV)
        self.assertGreater(self.snapshot_result["bytes"],0)
        self.assertEqual(self.materialized["records"],2277)
        self.assertEqual(self.materialized["pages"],27)
        with closing(sqlite3.connect(self.serving)) as c:
            keys=set(c.execute("SELECT range_id,source_key FROM source_details"));meta=dict(c.execute("SELECT key,value FROM serving_meta"))
        self.assertIn(("all",ALL_KEY),keys);self.assertIn(("7d",SEVEN_KEY),keys);self.assertEqual(meta["canonical_source_key"],"copied-from-source_details");self.assertEqual(self.build["validation"]["coverage"]["missing"],0)

    def test_serving_ranking_payload_and_search_text_are_bounded(self):
        with closing(sqlite3.connect(self.serving)) as c:
            payload_text,search_length,fts_count,row_count=c.execute(
                "SELECT payload_json,length(search_text),(SELECT count(*) FROM ranking_search_fts),(SELECT count(*) FROM ranking_rows) FROM ranking_rows WHERE range_id='all' AND rank=1"
            ).fetchone()
        payload=json.loads(payload_text)
        self.assertEqual(len(payload["occurrences"]),3)
        self.assertEqual([item["videoId"] for item in payload["occurrences"]],["videoAAAAAA","videoBBBBBB","videoCCCCCC"])
        self.assertNotIn("payload",payload)
        self.assertNotIn("searchText",payload)
        self.assertLessEqual(search_length,65536)
        self.assertEqual(fts_count,row_count)

    def test_health_and_release_artifacts(self):
        health=self.store.health();self.assertEqual(health["status"],"ok",health);self.assertEqual(health["releaseContentSha"],self.sha);self.assertEqual(health["serverCommit"],SERVER_COMMIT);self.assertEqual(health["buildLogicSha"],"b"*64);self.assertEqual(health["searchTokenizer"],"trigram");self.assertEqual(health["localSourcesRanges"],["7d","all"]);self.assertFalse(health["oldOriginDependency"]);self.assertFalse(health["sourceFallbackEnabled"])
        self.assertEqual(set(health["views"]),{"songs","vtubers","videos"});self.assertEqual(set(health["metrics"]),{"occurrences","songs","videos"})
        manifest=json.loads((self.release/"manifest.json").read_text());artifacts={x["path"] for x in manifest["artifacts"]};self.assertEqual(artifacts,{"serving.sqlite","artifacts/release_serving_server.py"})

    def test_missing_required_series_fails_closed(self):
        sparse=self.temp/"sparse.sqlite";shutil.copyfile(self.snapshot,sparse)
        with closing(sqlite3.connect(sparse)) as connection:
            connection.execute("DELETE FROM ranking_rows WHERE range_id='7d' AND view='videos' AND metric='videos'")
            connection.commit()
        with self.assertRaisesRegex(RuntimeError,"required ranking series missing or empty: 7d/videos/videos"):
            materializer.materialize(sparse,self.temp/"incomplete-pages",active_revision_id=REV)

    def test_release_identity_rejects_tampered_metadata_and_marker(self):
        meta_path=self.release/"meta.json";complete_path=self.release/".complete"
        original_meta=meta_path.read_bytes();meta=json.loads(original_meta)
        meta["generatedAt"]="2099-01-01T00:00:00Z"
        meta_path.write_bytes(bundle.canonical_json(meta))
        with self.assertRaisesRegex(ValueError,"computed hash mismatch"):
            bundle.verify_existing(self.release,self.sha)
        meta_path.write_bytes(original_meta)
        complete_path.write_text("0"*64+"\n",encoding="ascii")
        with self.assertRaisesRegex(ValueError,"completion marker mismatch"):
            bundle.verify_existing(self.release,self.sha)
        degraded=server.ReleaseStore(self.releases).health()
        self.assertEqual(degraded["status"],"degraded",degraded)
        self.assertIn("completion marker mismatch",degraded["errors"])

    def test_server_rejects_computed_release_hash_mismatch(self):
        meta_path=self.release/"meta.json";meta=json.loads(meta_path.read_bytes())
        meta["generatedAt"]="2099-01-01T00:00:00Z";meta_path.write_bytes(bundle.canonical_json(meta))
        degraded=server.ReleaseStore(self.releases).health()
        self.assertEqual(degraded["status"],"degraded",degraded)
        self.assertIn("computed content hash mismatch",degraded["errors"])

    def test_installer_rolls_back_when_first_symlink_switch_fails(self):
        previous="previous-release";(self.releases/previous).mkdir()
        (self.releases/"current").unlink();os.symlink(previous,self.releases/"current")
        server_target=self.temp/"server-target.py";server_target.write_bytes(b"old-server\n")
        fakebin=self.temp/"fakebin";fakebin.mkdir();marker=self.temp/"ln-failed-once"
        (fakebin/"systemctl").write_text(
            '#!/usr/bin/env bash\nif [[ "$1" == "show" ]]; then printf "%s\\n" "/usr/bin/python3 $TEST_SERVER_PATH"; exit 0; fi\n[[ "$1" == "restart" ]]\n',encoding="utf-8")
        (fakebin/"ln").write_text(
            '#!/usr/bin/env bash\ndestination="${@: -1}"\nif [[ ! -e "$FAIL_LN_ONCE_MARKER" && "$destination" == */.current.* ]]; then : > "$FAIL_LN_ONCE_MARKER"; exit 73; fi\nexec /usr/bin/ln "$@"\n',encoding="utf-8")
        os.chmod(fakebin/"systemctl",0o755);os.chmod(fakebin/"ln",0o755)
        env={**os.environ,"PATH":f"{fakebin}:{os.environ.get('PATH','')}","TEST_SERVER_PATH":str(server_target),"FAIL_LN_ONCE_MARKER":str(marker)}
        result=subprocess.run([
            "bash",str(INSTALLER_PATH),"--sha",self.sha,"--releases-root",str(self.releases),
            "--server-path",str(server_target),"--service","fixture.service",
            "--expected-server-commit",SERVER_COMMIT,"--expected-build-logic-sha","b"*64,
        ],env=env,capture_output=True,text=True,timeout=15,check=False)
        self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertEqual(server_target.read_bytes(),b"old-server\n")
        self.assertEqual(os.readlink(self.releases/"current"),previous)
        self.assertIn("DEPLOY_ROLLBACK complete",result.stderr)
        self.assertNotIn("DEPLOY_OK",result.stdout+result.stderr)

    def test_real_page_size_crosses_chunk(self):
        first=self.store.ranking_page(parse_qs("range=all&view=songs&metric=count&page=1&pageSize=30"))[1]
        seventh=self.store.ranking_page(parse_qs("range=all&view=songs&metric=count&page=7&pageSize=30"))[1]
        ninth=self.store.ranking_page(parse_qs("range=all&view=songs&metric=count&page=9&pageSize=30"))[1]
        self.assertEqual([x["rank"] for x in first["records"]],list(range(1,31)));self.assertEqual([x["rank"] for x in seventh["records"]],list(range(181,211)));self.assertEqual([x["rank"] for x in ninth["records"]],list(range(241,251)));self.assertEqual(first["pageCount"],9)

    def test_source_pages_distinct_video(self):
        p1=self.store.source_page(self.sha,ALL_KEY,parse_qs("range=all&page=1&pageSize=2"));p2=self.store.source_page(self.sha,ALL_KEY,parse_qs("range=all&page=2&pageSize=2"))
        self.assertEqual((p1["totalVideoCount"],p1["totalOccurrenceCount"],p1["pageCount"]),(3,5,2));self.assertEqual([x["videoId"] for x in p1["record"]["occurrences"]],["videoAAAAAA","videoAAAAAA","videoBBBBBB"]);self.assertEqual([x["videoId"] for x in p2["record"]["occurrences"]],["videoCCCCCC","videoCCCCCC"])

    def test_search_and_filters_local(self):
        _,payload,source=self.store.ranking_page(parse_qs("range=all&view=songs&metric=count&q=ただ君に晴れ&pageSize=30"));self.assertEqual(source,"local-serving-sqlite");self.assertEqual(payload["totalCount"],1)
        niche=self.store.source_page(self.sha,ALL_KEY,parse_qs("range=all&nicheOnly=1"));visible=self.store.source_page(self.sha,ALL_KEY,parse_qs("range=all&hideUnknownArtist=1"));self.assertEqual((niche["totalOccurrenceCount"],niche["totalVideoCount"]),(1,1));self.assertEqual((visible["totalOccurrenceCount"],visible["totalVideoCount"]),(4,3))

    def test_missing_source_fails_fast_no_proxy(self):
        start=time.monotonic()
        with self.assertRaises(server.ApiError) as raised:self.store.source_page(self.sha,"missing",parse_qs("range=all"))
        self.assertEqual(raised.exception.code,"source_not_found_in_local_release");self.assertLess(time.monotonic()-start,.5)
        text=SERVER_PATH.read_text();self.assertNotIn("ytb-song-rank.culua.com",text);self.assertNotIn("proxy_source",text);self.assertNotIn("SOURCE_PROXY_TIMEOUT",text)

    def test_frontend_patcher(self):
        app=self.temp/"app.js"
        app.write_text('''function shouldUseRuntimeApiForRequest(request) {\n  if (!state.runtimeApi.available) return false;\n  return true;\n}\n  const releaseVersion = state.runtimeApi?.meta?.meta?.content_sha256 || state.runtimeMeta?.dataVersion || "";\nasync function loadRequestSearchRecords(query, signal) {\n  const range = state.range;\n  if (state.runtimeApi.available) {\n    const params = new URLSearchParams({\n      range,\n      view: "songs",\n      metric: "occurrences",\n      page: "1",\n      pageSize: "12",\n      q: cleanText(query),\n    });\n    const payload = await readJson(`${API_RANKINGS_PATH}?${params.toString()}`, {\n      cache: "no-cache",\n      signal,\n    });\nfunction sourceDetailPathForRecord(record, occurrences = []) {\n  const ownerRecord = record?._record || {};\n  const explicitPath = cleanText(record?.sourceDetailPath || ownerRecord?.sourceDetailPath);\n  if (explicitPath) return explicitPath;\n  const detailKey = cleanText(record?.sourceDetailKey || ownerRecord?.sourceDetailKey);\n  const vtuberAlias = cleanText(record?.channelId || ownerRecord?.channelId || (record?.type === "vtuber" ? record?.key : "") || (ownerRecord?.type === "vtuber" ? ownerRecord?.key : ""));\n  if (detailKey || vtuberAlias) {\n    return `/api/sources/${encodeURIComponent(detailKey || vtuberAlias)}`;\n  }\n  const candidates = [\n    record?.sourceDetail?.path,\n    record?.sourceDetails?.path,\n    record?.detailPath,\n    record?.detail?.path,\n    ownerRecord?.sourceDetail?.path,\n    ownerRecord?.sourceDetails?.path,\n    ownerRecord?.detailPath,\n    ownerRecord?.detail?.path,\n    occurrences?.[0]?.sourceDetailPath,\n    occurrences?.[0]?.sourceDetail?.path,\n    occurrences?.[0]?.item?.sourceDetailPath,\n    occurrences?.[0]?.item?.sourceDetail?.path,\n    sourceDetailPathFromShard(record, occurrences),\n  ];\n  return cleanText(candidates.find(Boolean));\n}\nfunction a(path,requestPath,key){\n  const load = readJson(requestPath, { cache: cacheModeForPath(path) })\n    .then((payload) => normalizeSourceDetailOccurrences(payload, key))\n}\nfunction b(path,requestPath){\n  const load = readJson(requestPath, { cache: cacheModeForPath(path) })\n    .then((payload) => {\n}\n  params.set("range", cleanText(state.range) || "all");\n  const suffix = params.toString();\n''',encoding="utf-8")
        self.assertTrue(patcher.patch_app(app));patched=app.read_text();self.assertIn("function runtimeApiCapabilities()",patched);self.assertIn("function runtimeSupportsLocalSources(",patched);self.assertIn('params.set("v", releaseVersion)',patched);self.assertFalse(patcher.patch_app(app))

    def test_http_contract_exposes_version_and_local_data_source(self):
        httpd=server.ThreadingHTTPServer(("127.0.0.1",0),server.make_handler(self.store));httpd.daemon_threads=True
        thread=threading.Thread(target=httpd.serve_forever,kwargs={"poll_interval":0.05},daemon=True);thread.start()
        connection=http.client.HTTPConnection("127.0.0.1",httpd.server_address[1],timeout=5)
        try:
            connection.request("GET",f"/api/rankings?v={self.sha}&range=all&view=songs&metric=occurrences&page=1&pageSize=30")
            response=connection.getresponse();payload=json.loads(response.read())
            self.assertEqual(response.status,200);self.assertEqual(len(payload["records"]),30)
            self.assertEqual(response.getheader("X-Release-Sha"),self.sha)
            self.assertEqual(response.getheader("X-Server-Commit"),SERVER_COMMIT)
            self.assertEqual(response.getheader("X-Data-Source"),"local-release-chunk")
            self.assertEqual(response.getheader("Access-Control-Allow-Origin"),"*")
            connection.request("GET",f"/api/sources/{ALL_KEY}?v={self.sha}&range=all&page=1&pageSize=2")
            response=connection.getresponse();source_payload=json.loads(response.read())
            self.assertEqual(response.status,200);self.assertTrue(source_payload["found"])
            self.assertEqual(response.getheader("X-Data-Source"),"local-serving-sqlite")
        finally:
            connection.close();httpd.shutdown();httpd.server_close();thread.join(timeout=2)

    def test_server_retains_configurable_production_backlog(self):
        httpd=server.make_server("127.0.0.1",0,256,self.store)
        try:self.assertEqual(httpd.request_queue_size,256)
        finally:httpd.server_close()

    def test_workflow_deploys_complete_artifact_and_never_marks_proxy_fallback(self):
        workflow=(ROOT/".github"/"workflows"/"sync-wdc-release.yml").read_text(encoding="utf-8")
        installer=(ROOT/"deploy"/"install-wdc-release.sh").read_text(encoding="utf-8")
        self.assertIn("snapshot-runtime-db.py",workflow)
        self.assertIn("materialize-ranking-pages.py",workflow)
        self.assertIn("build-serving-store.py",workflow)
        self.assertIn("release_serving_server.py",workflow)
        self.assertIn("install-wdc-release.sh",workflow)
        self.assertIn("--build-logic-sha",workflow)
        self.assertNotIn("build-serving-sqlite.py",workflow)
        self.assertNotIn("PUBLIC_BASE",workflow)
        self.assertNotIn("https://ytb-song-rank.culua.com",workflow)
        self.assertNotIn("/api/rankings?range=",workflow)
        self.assertIn('VPS2_RUNTIME_DB: ${{ vars.VPS2_RUNTIME_DB }}',workflow)
        self.assertNotIn("/var/lib/culua/ytb-song-rank/song-rank.sqlite",workflow)
        self.assertIn('test -n "$VPS2_RUNTIME_DB"',workflow)
        self.assertIn("systemd-run --quiet --wait --pipe --collect",workflow)
        self.assertIn('[[ "$DEPLOYED_STATUS" == "ok"',workflow)
        self.assertIn('"$DEPLOYED_RELEASE" =~ ^[0-9a-f]{64}$',workflow)
        self.assertIn('EXPECTED_REMOTE_ROOT="/tmp/dsl-wdc-sync-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',workflow)
        self.assertIn("if: always()",workflow)
        self.assertNotIn("if: always() &&",workflow)
        self.assertIn("DEPLOY_ROLLBACK",installer)
        self.assertIn("sourceFallbackEnabled",installer)
        self.assertIn("computed release content hash mismatch",installer)
        self.assertLess(installer.index("LIVE_MUTATION_STARTED=1"),installer.index('mv -f "$SERVER_TEMP" "$SERVER_PATH"'))
        self.assertNotIn("ytb-song-rank.culua.com",installer)

if __name__=="__main__":unittest.main(verbosity=2)
