from __future__ import annotations
import importlib.util
import gzip
import http.client
import json
import threading
from contextlib import closing
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from pathlib import Path
from urllib.parse import parse_qs

ROOT=Path(__file__).resolve().parents[1]
SERVER_PATH=ROOT/"server"/"release_serving_server.py"
PG_ADAPTER_PATH=ROOT/"server"/"pg_adapter.py"
PG_MATERIALIZER_PATH=ROOT/"scripts"/"migration"/"materialize-pg-release-snapshot.py"
MATERIALIZER_PATH=ROOT/"scripts"/"migration"/"materialize-ranking-pages.py"
BUILDER_PATH=ROOT/"scripts"/"migration"/"build-serving-store.py"
BUNDLE_PATH=ROOT/"scripts"/"migration"/"build-release-bundle.py"
PATCHER_PATH=ROOT/"scripts"/"migration"/"patch-next-frontend.py"
PREPARE_FRONTEND_PATH=ROOT/"scripts"/"migration"/"prepare-wdc-frontend.py"
INSTALLER_PATH=ROOT/"deploy"/"install-wdc-release.sh"
APP_PATH=ROOT/"assets"/"app.js"
NGINX_PATH=ROOT/"deploy"/"nginx-next-api.conf"
UNIT_PATH=ROOT/"deploy"/"daily-song-list-api.service"


def load(name:str,path:Path):
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);assert spec and spec.loader;sys.modules[name]=module;spec.loader.exec_module(module);return module

sys.path.insert(0,str(ROOT/"server"))
pg_adapter=load("pg_adapter",PG_ADAPTER_PATH);sys.modules["pg_adapter"]=pg_adapter
pg_materializer=load("pg_materializer",PG_MATERIALIZER_PATH);materializer=load("materializer",MATERIALIZER_PATH);builder=load("builder",BUILDER_PATH);bundle=load("bundle",BUNDLE_PATH);server=load("server",SERVER_PATH);patcher=load("patcher",PATCHER_PATH);prepare_frontend=load("prepare_frontend",PREPARE_FRONTEND_PATH)
ALL_KEY="01fc9d6830d3c230";SEVEN_KEY="7d0cafe0deadbeef";MANY_KEY="31video0feedbeef";EMPTY_KEY="empty000feedbeef";REV="rev-test-20260810";SERVER_COMMIT="0123456789abcdef0123456789abcdef01234567"


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
    c.execute("INSERT INTO source_details VALUES(?,?,?,?,?)",(MANY_KEY,"all","song","song-many",json.dumps({"title":"Many videos","artist":"Fixture","sourceDetailKey":MANY_KEY})))
    c.execute("INSERT INTO source_details VALUES(?,?,?,?,?)",(EMPTY_KEY,"all","song","song-empty",json.dumps({"title":"Empty detail","artist":"Fixture","sourceDetailKey":EMPTY_KEY})))
    rows=[(1,"videoAAAAAA",0,0),(2,"videoAAAAAA",1,0),(3,"videoBBBBBB",0,0),(4,"videoCCCCCC",0,0),(5,"videoCCCCCC",0,1)]
    for pos,video,niche,unknown in rows:
        payload={"videoId":video,"title":video,"channelName":"Fixture","channelId":"UCfixture","seconds":100+pos}
        c.execute("INSERT INTO source_occurrences VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  (ALL_KEY,"all",pos,video,video,"Fixture","UCfixture","@fixture","https://youtube.com/@fixture",1700000000+pos,100+pos,niche,unknown,f"ただ君に晴れ ヨルシカ {video}",json.dumps(payload,ensure_ascii=False)))
    payload={"videoId":"video7DDDDD","title":"7d","channelName":"Fixture","channelId":"UCfixture","seconds":1}
    c.execute("INSERT INTO source_occurrences VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              (SEVEN_KEY,"7d",1,"video7DDDDD","7d","Fixture","UCfixture","@fixture","https://youtube.com/@fixture",1700000001,1,0,0,"ただ君に晴れ ヨルシカ",json.dumps(payload,ensure_ascii=False)))
    for pos in range(32):
        video_index=max(0,pos-1);video=f"many{video_index:07d}"
        payload={"videoId":video,"title":f"Many {video_index}","channelName":"Fixture","channelId":"UCfixture","seconds":pos}
        c.execute("INSERT INTO source_occurrences VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  (MANY_KEY,"all",pos,video,payload["title"],"Fixture","UCfixture","@fixture","https://youtube.com/@fixture",1700001000+pos,pos,0,0,f"Many videos Fixture {video}",json.dumps(payload)))
    for range_id,count in (("all",250),("7d",3)):
        for view in ("songs","artists","vtubers","videos"):
            for db_metric in ("count","songs","videos"):
                for rank in range(1,count+1):
                    key=ALL_KEY if range_id=="all" and rank==1 else MANY_KEY if range_id=="all" and view=="songs" and rank==2 else SEVEN_KEY if range_id=="7d" and rank==1 else ""
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
                    if view=="artists":
                        value["name"]=value["artist"]
                        value["songCount"]=5 if rank==1 else 1
                        value["songs"]=[{"name":f"Artist song {index}","count":index} for index in range(1,value["songCount"]+1)]
                    c.execute("INSERT INTO ranking_rows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                              (f"{range_id}-{view}-{db_metric}-{rank}",range_id,view,db_metric,"all",rank,key,value["title"],value["artist"],value.get("name",value["title"]),value["count"],value.get("songCount",1),value["videoCount"],value["count"],json.dumps(value,ensure_ascii=False),search_text,"Fixture @fixture"))
                first=card(1,range_id,ALL_KEY if range_id=="all" else SEVEN_KEY)
                if view=="artists":
                    first.update({"name":first["artist"],"songCount":5,"songs":[{"name":f"Artist song {index}","count":index} for index in range(1,6)]})
                for scope in ("niche","visible","visibleNiche"):
                    c.execute("INSERT INTO ranking_rows VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                              (f"{range_id}-{view}-{db_metric}-{scope}",range_id,view,db_metric,scope,1,first.get("sourceDetailKey",""),first["title"],first["artist"],first.get("name",first["title"]),first["count"],first.get("songCount",1),first["videoCount"],first["count"],json.dumps(first,ensure_ascii=False),f"{first['title']} {first['artist']}","Fixture @fixture"))
    scope_counts={f"{row[0]}/{row[1]}/{row[2]}/{row[3]}":int(row[4]) for row in c.execute(
        "SELECT range_id,view,metric,scope_key,count(*) FROM ranking_rows GROUP BY range_id,view,metric,scope_key"
    )}
    c.execute("INSERT INTO meta VALUES(?,?)",("ranking_scope_counts_json",json.dumps(scope_counts,sort_keys=True,separators=(",",":"))))
    c.execute("INSERT INTO meta VALUES(?,?)",("ranking_scope_series",str(len(scope_counts))))
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


class FakeCursor:
    def __init__(self):self.statements=[]
    def execute(self,statement,*_args):self.statements.append(statement)
    def close(self):pass


class FakePgConnection:
    def __init__(self):self.autocommit=True;self.cursor_value=FakeCursor();self.rollbacks=0;self.closed=False
    def cursor(self):return self.cursor_value
    def rollback(self):self.rollbacks+=1
    def close(self):self.closed=True


class FakeSnapshotPageBuilder:
    def __init__(self,_connection):pass
    def build_combo(self,range_id,view,metric,scope_key="all"):
        def render(page):
            key=f"source-{range_id}-{view}" if view in {"songs","artists","vtubers"} else ""
            record={"rank":1,"type":view[:-1] if view.endswith("s") else view,
                    "key":f"{range_id}-{view}","title":f"{range_id} {view}","displayArtist":"Fixture",
                    "name":f"{range_id} {view}","count":3,"songCount":2,"videoCount":2,
                    "timestampCount":3,"channelName":"Fixture","channelId":"UCfixture",
                    "occurrences":[{"videoId":f"preview-{range_id}-{view}","seconds":1}]}
            if key:record["sourceDetailKey"]=key
            return {"schemaVersion":1,"rangeId":range_id,"view":view,"metric":metric,
                    "page":page,"pageSize":200,"totalCount":1,"filteredBaseCount":1,
                    "totalOccurrenceCount":3,"totalSongCount":2,"totalVideoCount":2,
                    "pageCount":1,"compact":False,"records":[record] if page==1 else []}
        return render


def fake_pg_meta(_connection):
    return {"meta":{"active_revision_id":REV,"content_sha256":"c"*64,
                    "parent_revision_id":"parent-revision","source_commit_sha":"a"*40,
                    "built_at":"2026-08-10T00:00:00Z","latest_generated_at":"2026-08-09T23:59:59Z"}}


def fake_pg_source(_connection,key,query):
    range_id=str(query.get("range") or "all");page=int(query.get("page") or 1)
    start=0 if page==1 else 200;stop=200 if page==1 else 201
    occurrences=[]
    for index in range(start,stop):
        occurrences.append({"videoId":f"video-{range_id}-{index:03d}","title":f"Video {index}",
                            "channelName":"Fixture","channelId":"UCfixture","channelHandle":"@fixture",
                            "channelUrl":"https://youtube.com/@fixture","publishedAt":"2026-08-10T00:00:00Z",
                            "seconds":index,"song":{"songKey":f"song-{index%2}","title":f"Song {index%2}",
                                                        "artist":"Fixture","isNiche":index%2==0}})
    record={"type":"song" if "songs" in key else "artist" if "artists" in key else "vtuber","key":key,
            "sourceDetailKey":key,"rangeId":range_id,"count":201,"videoCount":201,
            "timestampCount":201,"occurrences":occurrences}
    return {"schemaVersion":1,"found":True,"sourceKey":key,"record":record,
            "page":page,"pageSize":200,"pageCount":2,"totalCount":201,
            "totalVideoCount":201,"totalOccurrenceCount":201}


class Tests(unittest.TestCase):
    def setUp(self):
        self.temp=Path(tempfile.mkdtemp(prefix="dsl-v3-"));self.source=self.temp/"source.sqlite";self.pages=self.temp/"pages";self.serving=self.temp/"serving.sqlite";self.releases=self.temp/"releases"
        create_source_db(self.source)
        self.snapshot=self.source
        self.materialized=materializer.materialize(self.snapshot,self.pages,active_revision_id=REV)
        self.build=builder.build_serving_store(self.snapshot,self.pages,self.serving,active_revision_id=REV,built_at="2026-08-10T00:00:00Z")
        self.frontend_index=self.temp/"source-index.html";self.frontend_index.write_text('<link rel="stylesheet" href="assets/styles-h0123456789ab.css"><script src="assets/app-h0123456789ab.js" defer></script>',encoding="utf-8")
        self.frontend_root=self.temp/"prepared-frontend";self.frontend_manifest=prepare_frontend.prepare(APP_PATH,self.frontend_index,self.frontend_root)
        meta={"activeRevisionId":REV,"expectedParentRevisionId":"parent","sourceCommitSha":"a"*40,"serverCommitSha":SERVER_COMMIT,"buildLogicSha":"b"*64,"generatedAt":"2026-08-10T00:00:00Z","latestEventTime":"2026-08-09T23:59:59Z"}
        self.sha,self.release=bundle.build_bundle(self.pages,self.releases,serving_sqlite=self.serving,server_artifact=SERVER_PATH,release_meta=meta,frontend_root=self.frontend_root,nginx_artifact=NGINX_PATH,systemd_artifact=UNIT_PATH)
        os.symlink(self.sha,self.releases/"current");self.store=server.ReleaseStore(self.releases)
    def tearDown(self):shutil.rmtree(self.temp,ignore_errors=True)

    def test_canonical_keys_and_coverage(self):
        self.assertEqual(self.materialized["records"],3036)
        self.assertEqual(self.materialized["pages"],36)
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
        self.assertEqual(set(health["views"]),{"songs","artists","vtubers","videos"});self.assertEqual(set(health["metrics"]),{"occurrences","songs","videos"})
        manifest=json.loads((self.release/"manifest.json").read_text());artifacts={x["path"] for x in manifest["artifacts"]};self.assertEqual(artifacts,{"serving.sqlite","artifacts/release_serving_server.py","artifacts/frontend/index.html","artifacts/frontend/frontend-manifest.json",f"artifacts/frontend/{self.frontend_manifest['appPath']}","artifacts/deploy/next.ytb-song-rank.culua.com.conf","artifacts/deploy/daily-song-list-api.service"})

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
        static_root=self.temp/"static";(static_root/"assets").mkdir(parents=True);(static_root/"index.html").write_bytes(b"old-index\n")
        unit_target=self.temp/"daily-song-list-api.service";unit_target.write_bytes(b"old-unit\n")
        nginx_available=self.temp/"nginx-available.conf";nginx_available.write_bytes(b"old-nginx-available\n")
        nginx_enabled=self.temp/"nginx-enabled.conf";nginx_enabled.write_bytes(b"old-nginx-enabled\n")
        fakebin=self.temp/"fakebin";fakebin.mkdir();marker=self.temp/"ln-failed-once"
        (fakebin/"systemctl").write_text(
            '#!/usr/bin/env bash\nexit 0\n',encoding="utf-8")
        (fakebin/"systemd-analyze").write_text('#!/usr/bin/env bash\nexit 0\n',encoding="utf-8")
        (fakebin/"nginx").write_text('#!/usr/bin/env bash\nexit 0\n',encoding="utf-8")
        (fakebin/"ln").write_text(
            '#!/usr/bin/env bash\ndestination="${@: -1}"\nif [[ ! -e "$FAIL_LN_ONCE_MARKER" && "$destination" == */.current.* ]]; then : > "$FAIL_LN_ONCE_MARKER"; exit 73; fi\nexec /usr/bin/ln "$@"\n',encoding="utf-8")
        for executable in ("systemctl","systemd-analyze","nginx","ln"):os.chmod(fakebin/executable,0o755)
        env={**os.environ,"PATH":f"{fakebin}:{os.environ.get('PATH','')}","TEST_SERVER_PATH":str(server_target),"FAIL_LN_ONCE_MARKER":str(marker)}
        result=subprocess.run([
            "bash",str(INSTALLER_PATH),"--sha",self.sha,"--releases-root",str(self.releases),
            "--server-path",str(server_target),"--static-root",str(static_root),
            "--service-unit-path",str(unit_target),"--nginx-available-path",str(nginx_available),
            "--nginx-enabled-path",str(nginx_enabled),"--service","fixture.service",
            "--expected-server-commit",SERVER_COMMIT,"--expected-build-logic-sha","b"*64,
        ],env=env,capture_output=True,text=True,timeout=15,check=False)
        self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertEqual(server_target.read_bytes(),b"old-server\n")
        self.assertEqual((static_root/"index.html").read_bytes(),b"old-index\n")
        self.assertEqual(unit_target.read_bytes(),b"old-unit\n")
        self.assertEqual(nginx_available.read_bytes(),b"old-nginx-available\n")
        self.assertEqual(nginx_enabled.read_bytes(),b"old-nginx-enabled\n")
        self.assertEqual(os.readlink(self.releases/"current"),previous)
        self.assertFalse((self.releases/f".rollback-{self.sha}").exists())
        self.assertIn("DEPLOY_ROLLBACK complete",result.stdout+result.stderr)
        self.assertNotIn("DEPLOY_ACTIVATED_PENDING_PUBLIC",result.stdout+result.stderr)

    def test_installer_never_publishes_partial_backup_state(self):
        previous="previous-release";(self.releases/previous).mkdir()
        (self.releases/"current").unlink();os.symlink(previous,self.releases/"current")
        server_target=self.temp/"server-target.py";server_target.write_bytes(b"old-server\n")
        static_root=self.temp/"static";(static_root/"assets").mkdir(parents=True);(static_root/"index.html").write_bytes(b"old-index\n")
        unit_target=self.temp/"daily-song-list-api.service";unit_target.write_bytes(b"old-unit\n")
        nginx_available=self.temp/"nginx-available.conf";nginx_available.write_bytes(b"old-nginx-available\n")
        nginx_enabled=self.temp/"nginx-enabled.conf";nginx_enabled.write_bytes(b"old-nginx-enabled\n")
        fakebin=self.temp/"fakebin-partial";fakebin.mkdir()
        for executable in ("systemctl","systemd-analyze","nginx"):
            (fakebin/executable).write_text('#!/usr/bin/env bash\nexit 0\n',encoding="utf-8")
        (fakebin/"cp").write_text(
            '#!/usr/bin/env bash\ndestination="${@: -1}"\nif [[ "$destination" == */index.backup ]]; then exit 74; fi\nexec /usr/bin/cp "$@"\n',encoding="utf-8")
        for executable in ("systemctl","systemd-analyze","nginx","cp"):os.chmod(fakebin/executable,0o755)
        env={**os.environ,"PATH":f"{fakebin}:{os.environ.get('PATH','')}"}
        result=subprocess.run([
            "bash",str(INSTALLER_PATH),"--sha",self.sha,"--releases-root",str(self.releases),
            "--server-path",str(server_target),"--static-root",str(static_root),
            "--service-unit-path",str(unit_target),"--nginx-available-path",str(nginx_available),
            "--nginx-enabled-path",str(nginx_enabled),"--service","fixture.service",
            "--expected-server-commit",SERVER_COMMIT,"--expected-build-logic-sha","b"*64,
        ],env=env,capture_output=True,text=True,timeout=15,check=False)
        self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertEqual(server_target.read_bytes(),b"old-server\n")
        self.assertEqual((static_root/"index.html").read_bytes(),b"old-index\n")
        self.assertEqual(os.readlink(self.releases/"current"),previous)
        self.assertFalse((self.releases/f".rollback-{self.sha}").exists())
        self.assertEqual(list(self.releases.glob(f".rollback-{self.sha}.preparing.*")),[])
        self.assertNotIn("DEPLOY_ROLLBACK complete",result.stdout+result.stderr)

    def test_real_page_size_crosses_chunk(self):
        first=self.store.ranking_page(parse_qs("range=all&view=songs&metric=count&page=1&pageSize=30"))[1]
        seventh=self.store.ranking_page(parse_qs("range=all&view=songs&metric=count&page=7&pageSize=30"))[1]
        ninth=self.store.ranking_page(parse_qs("range=all&view=songs&metric=count&page=9&pageSize=30"))[1]
        self.assertEqual([x["rank"] for x in first["records"]],list(range(1,31)));self.assertEqual([x["rank"] for x in seventh["records"]],list(range(181,211)));self.assertEqual([x["rank"] for x in ninth["records"]],list(range(241,251)));self.assertEqual(first["pageCount"],9);self.assertGreater(first["totalOccurrenceCount"],0)

    def test_source_pages_distinct_video(self):
        p1=self.store.source_page(self.sha,ALL_KEY,parse_qs("range=all&page=1&pageSize=2"));p2=self.store.source_page(self.sha,ALL_KEY,parse_qs("range=all&page=2&pageSize=2"))
        self.assertEqual((p1["totalVideoCount"],p1["totalOccurrenceCount"],p1["pageCount"]),(3,5,2));self.assertEqual([x["videoId"] for x in p1["record"]["occurrences"]],["videoAAAAAA","videoAAAAAA","videoBBBBBB"]);self.assertEqual([x["videoId"] for x in p2["record"]["occurrences"]],["videoCCCCCC","videoCCCCCC"])

    def test_source_31_distinct_videos_cross_pages_without_losing_occurrences(self):
        pages=[self.store.source_page(self.sha,MANY_KEY,parse_qs(f"range=all&page={page}&pageSize=10")) for page in range(1,5)]
        self.assertTrue(all((item["totalVideoCount"],item["totalOccurrenceCount"],item["pageCount"])==(31,32,4) for item in pages))
        self.assertEqual(len(pages[0]["record"]["occurrences"]),11)
        self.assertEqual([item["videoId"] for item in pages[0]["record"]["occurrences"][:2]],["many0000000","many0000000"])
        self.assertEqual(sum(len(item["record"]["occurrences"]) for item in pages),32)

    def test_empty_source_and_invalid_pages_are_explicit(self):
        empty=self.store.source_page(self.sha,EMPTY_KEY,parse_qs("range=all&page=1&pageSize=20"))
        self.assertEqual((empty["totalVideoCount"],empty["totalOccurrenceCount"],empty["pageCount"]),(0,0,1))
        self.assertEqual(empty["record"]["occurrences"],[])
        for query in ("range=all&page=zero","range=all&page=0","range=all&pageSize=201"):
            with self.assertRaises(server.ApiError) as raised:self.store.source_page(self.sha,EMPTY_KEY,parse_qs(query))
            self.assertEqual((raised.exception.status,raised.exception.code),(400,"invalid_pagination"))

    def test_search_and_filters_local(self):
        _,payload,source=self.store.ranking_page(parse_qs("range=all&view=songs&metric=count&q=ただ君に晴れ&pageSize=30"));self.assertEqual(source,"local-serving-sqlite");self.assertEqual(payload["totalCount"],1)
        first_title=payload["records"][0]["title"]
        first_artist=payload["records"][0]["artist"]
        _,title_only,_=self.store.ranking_page(parse_qs(f"range=all&view=songs&metric=count&q={first_title}&searchFields=title"))
        _,wrong_field,_=self.store.ranking_page(parse_qs(f"range=all&view=songs&metric=count&q={first_title}&searchFields=artist"))
        _,artist_only,_=self.store.ranking_page(parse_qs(f"range=all&view=songs&metric=count&q={first_artist}&searchFields=artist"))
        self.assertEqual((title_only["totalCount"],wrong_field["totalCount"],artist_only["totalCount"]),(1,0,1))
        self.assertEqual(len({record["key"] for record in title_only["records"]}),len(title_only["records"]))
        _,scoped,_=self.store.ranking_page(parse_qs("range=all&view=songs&metric=count&nicheOnly=1&hideUnknownArtist=1"))
        self.assertEqual((scoped["scopeKey"],scoped["totalCount"]),("visibleNiche",1))
        self.assertEqual(scoped["filteredBaseCount"],250)
        self.assertNotEqual(scoped["totalCount"],self.store.series_total(self.sha,"all","songs","occurrences"))
        niche=self.store.source_page(self.sha,ALL_KEY,parse_qs("range=all&nicheOnly=1"));visible=self.store.source_page(self.sha,ALL_KEY,parse_qs("range=all&hideUnknownArtist=1"));self.assertEqual((niche["totalOccurrenceCount"],niche["totalVideoCount"]),(1,1));self.assertEqual((visible["totalOccurrenceCount"],visible["totalVideoCount"]),(4,3))

    def test_artist_cards_keep_scalar_count_and_three_previews_for_all_metrics(self):
        for range_id in ("7d","all"):
            for metric in ("occurrences","songs","videos"):
                _,payload,_=self.store.ranking_page(parse_qs(f"range={range_id}&view=artists&metric={metric}&page=1&pageSize=30"))
                self.assertGreater(payload["totalCount"],0)
                record=payload["records"][0]
                self.assertEqual(record["songCount"],5)
                self.assertEqual(len(record["songs"]),3)

    def test_missing_source_fails_fast_no_proxy(self):
        start=time.monotonic()
        with self.assertRaises(server.ApiError) as raised:self.store.source_page(self.sha,"missing",parse_qs("range=all"))
        self.assertEqual(raised.exception.code,"source_not_found_in_local_release");self.assertLess(time.monotonic()-start,.5)
        text=SERVER_PATH.read_text();self.assertNotIn("ytb-song-rank.culua.com",text);self.assertNotIn("proxy_source",text);self.assertNotIn("SOURCE_PROXY_TIMEOUT",text)

    def test_frontend_patcher(self):
        app=self.temp/"app.js"
        app.write_text('''function shouldUseRuntimeApiForRequest(request) {\n  if (!state.runtimeApi.available) return false;\n  return true;\n}\n  const releaseVersion = state.runtimeApi?.meta?.meta?.content_sha256 || state.runtimeMeta?.dataVersion || "";\nasync function loadRequestSearchRecords(query, signal) {\n  const range = state.range;\n  if (state.runtimeApi.available) {\n    const params = new URLSearchParams({\n      range,\n      view: "songs",\n      metric: "occurrences",\n      page: "1",\n      pageSize: "12",\n      q: cleanText(query),\n    });\n    const payload = await readJson(`${API_RANKINGS_PATH}?${params.toString()}`, {\n      cache: "no-cache",\n      signal,\n    });\nfunction sourceDetailPathForRecord(record, occurrences = []) {\n  const ownerRecord = record?._record || {};\n  const explicitPath = cleanText(record?.sourceDetailPath || ownerRecord?.sourceDetailPath);\n  if (explicitPath) return explicitPath;\n  const detailKey = cleanText(record?.sourceDetailKey || ownerRecord?.sourceDetailKey);\n  const vtuberAlias = cleanText(record?.channelId || ownerRecord?.channelId || (record?.type === "vtuber" ? record?.key : "") || (ownerRecord?.type === "vtuber" ? ownerRecord?.key : ""));\n  if (detailKey || vtuberAlias) {\n    return `/api/sources/${encodeURIComponent(detailKey || vtuberAlias)}`;\n  }\n  const candidates = [\n    record?.sourceDetail?.path,\n    record?.sourceDetails?.path,\n    record?.detailPath,\n    record?.detail?.path,\n    ownerRecord?.sourceDetail?.path,\n    ownerRecord?.sourceDetails?.path,\n    ownerRecord?.detailPath,\n    ownerRecord?.detail?.path,\n    occurrences?.[0]?.sourceDetailPath,\n    occurrences?.[0]?.sourceDetail?.path,\n    occurrences?.[0]?.item?.sourceDetailPath,\n    occurrences?.[0]?.item?.sourceDetail?.path,\n    sourceDetailPathFromShard(record, occurrences),\n  ];\n  return cleanText(candidates.find(Boolean));\n}\nfunction a(path,requestPath,key){\n  const load = readJson(requestPath, { cache: cacheModeForPath(path) })\n    .then((payload) => normalizeSourceDetailOccurrences(payload, key))\n}\nfunction b(path,requestPath){\n  const load = readJson(requestPath, { cache: cacheModeForPath(path) })\n    .then((payload) => {\n}\n  params.set("range", cleanText(state.range) || "all");\n  const suffix = params.toString();\n''',encoding="utf-8")
        self.assertTrue(patcher.patch_app(app));patched=app.read_text();self.assertIn("function runtimeApiCapabilities()",patched);self.assertIn("function runtimeSupportsLocalSources(",patched);self.assertIn("capabilities.rankingScopes",patched);self.assertIn('params.set("v", releaseVersion)',patched);self.assertFalse(patcher.patch_app(app))

    def test_snapshot_source_scope_is_disk_backed_and_excludes_7d_boundary(self):
        song_key=pg_adapter._production_source_detail_key_for_group("songs","all","song::artist")
        artist_key=pg_adapter._production_source_detail_key_for_group("artists","all","artist")
        channel_key=pg_adapter._production_source_detail_key_for_group("vtubers","all","UCfixture")
        replacement_key=pg_adapter._production_source_detail_key_for_group("songs","all","replacement::new artist")
        video_key=pg_adapter._stable_key("source-video","all","video-all")
        replacement_video_key=pg_adapter._stable_key("source-video","all","video-new")
        requested={song_key,artist_key,channel_key,replacement_key,video_key,
                   replacement_video_key,"parent-source","alias-song"}

        def fake_stream(_connection,label,_statement,_params):
            if label=="targets":
                yield {"view":"songs","detail_key":"legacy-alias","title":"Song",
                       "artist":"Artist","source_key":"alias-song"}
            elif label=="videos":
                yield {"video_id":"video7d","channel_id":"UC7d","payload_json":{"partialRangeReset":True,"rangeId":"7d"}}
                yield {"video_id":"video-all","channel_id":"UCfixture","payload_json":{}}
            elif label=="occurrences":
                yield {"video_id":"video-all","range_id":"all","title":"Song","artist":"Artist"}
            elif label=="runtime":
                yield {"range_id":"all","payload_json":{"rangeId":"all","videoId":"video-new","title":"Replacement","artist":"New Artist"}}
            elif label.startswith("parents_"):
                yield {"source_key":"parent-source","video_id":"video-all"}

        with closing(sqlite3.connect(":memory:")) as database, \
             patch.object(pg_materializer,"_stream_pg_rows",side_effect=fake_stream):
            scope=pg_materializer.build_snapshot_source_scope(
                object(),database,overlay_revision_ids=("overlay",),
                source_revision_ids=("overlay","parent"),requested_keys=requested,
            )
            self.assertNotIn("video7d",scope.affected_videos())
            self.assertEqual(scope.videos_for_source(song_key),("video-all",))
            self.assertEqual(scope.videos_for_source("alias-song"),("video-all",))
            self.assertEqual(scope.videos_for_source(artist_key),("video-all",))
            self.assertEqual(scope.videos_for_source(channel_key),("video-all",))
            self.assertEqual(scope.videos_for_source(replacement_key),("video-new",))
            self.assertEqual(scope.videos_for_source(video_key),("video-all",))
            self.assertEqual(scope.videos_for_source(replacement_video_key),("video-new",))
            self.assertEqual(scope.videos_for_source("parent-source"),("video-all",))

    def test_snapshot_empty_source_scope_skips_every_overlay_scan(self):
        persisted={"schemaVersion":1,"found":True,"sourceKey":"source",
                   "sourceRevisionId":"parent","record":{"type":"song","sourceDetailKey":"source"}}
        context=SimpleNamespace(runtime=None,generic_runtime=("active",{}),parent=("parent",{}),
                                overlay_ids=("overlay",),authoritative_ids=(),authoritative_records=None)
        with patch.object(pg_adapter,"_runtime_source_payload",return_value=persisted), \
             patch.object(pg_adapter,"_generic_song_source_payload") as rebuild, \
             patch.object(pg_adapter,"_overlay_candidate_rows") as candidates, \
             patch.object(pg_adapter,"_accepted_video_resets") as resets, \
             patch.object(pg_adapter,"_runtime_tombstones") as runtime:
            result=pg_adapter.source_payload(
                object(),"source",{"range":"all","page":"1","pageSize":"200"},
                snapshot_context=context,snapshot_video_scope=(),
            )
        self.assertIs(result,persisted)
        rebuild.assert_not_called();candidates.assert_not_called();resets.assert_not_called();runtime.assert_not_called()

    def test_source_song_identity_accepts_one_complete_200_video_page(self):
        record={"type":"song","occurrences":[
            {"videoId":f"video-{index:03d}","item":{"videoId":f"video-{index:03d}"},
             "song":{"songKey":"song-key","title":"Song","artist":"Artist",
                     "payload":{"title":"Song","artist":"Artist"}}}
            for index in range(200)
        ]}
        pairs,keys=pg_adapter._source_song_identity_evidence(record)
        self.assertIn(("song","artist"),pairs)
        self.assertEqual(keys,{"song-key"})

    def test_snapshot_exact_video_scope_never_reads_unscoped_candidates(self):
        video={"revision_id":"overlay","video_id":"video-one","video_title":"Video",
               "channel_name":"Fixture","channel_id":"UCfixture","channel_handle":"@fixture",
               "channel_url":"","published_at":0,"video_payload_json":{},"video_tombstone":False}
        occurrence={"revision_id":"overlay","video_id":"video-one","occurrence_id":"occ-one",
                    "position":0,"range_id":"all","song_key":"song","seconds":1,"title":"Song",
                    "artist":"Artist","source_id":"source","raw_hash":"raw","source_system":"fixture",
                    "occurrence_payload_json":{}}
        with patch.object(pg_adapter,"_rows",side_effect=[[video],[occurrence]]) as rows:
            selected=pg_adapter._overlay_candidate_rows(
                object(),("overlay",),video_scope=("video-one",),range_id="all",
            )
        self.assertEqual(len(selected),1)
        self.assertEqual(rows.call_count,2)
        self.assertIn("video_id = ANY",rows.call_args_list[0].args[1])
        self.assertEqual(rows.call_args_list[0].args[2][1],["video-one"])
        self.assertIn("coalesce(o.range_id, '')",rows.call_args_list[1].args[1])

    def test_snapshot_channel_source_reuses_prepared_exact_video_changes(self):
        video={"video_id":"video-one","title":"Video","channel_name":"Fixture",
               "channel_id":"UCfixture","channel_handle":"@fixture","channel_url":"",
               "published_timestamp":0,"payload_json":{}}
        occurrence={"video_id":"video-one","occurrence_id":"occ-one","range_id":"all",
                    "song_key":"song","seconds":1,"source_system":"fixture","source_id":"source",
                    "title":"Song","artist":"Artist","payload_json":{}}
        prepared=((),{},())
        with patch.object(pg_adapter,"_rows",side_effect=[[video],[occurrence]]), \
             patch.object(pg_adapter,"_runtime_source_occurrences",return_value=[]), \
             patch.object(pg_adapter,"_snapshot_source_overlay_inputs",return_value=prepared) as prepare, \
             patch.object(pg_adapter,"_runtime_tombstones") as global_changes, \
             patch.object(pg_adapter,"_source_payload_from_channel_records",
                          return_value={"schemaVersion":1,"found":True,"sourceKey":"source","record":{}}):
            result=pg_adapter._runtime_channel_source_payload(
                object(),"parent",{"channelId":"UCfixture"},"source",
                {"range":"all","page":"1","pageSize":"200"},
                overlay_revision_ids=("overlay",),snapshot_video_scope=("video-one",),
            )
        self.assertTrue(result["found"])
        prepare.assert_called_once()
        global_changes.assert_not_called()

    def test_snapshot_overlay_only_video_source_uses_exact_prepared_video(self):
        video_id="video-new"
        source_key=pg_adapter._stable_key("source-video","all",video_id)
        candidate={
            "revision_id":"overlay","video_id":video_id,
            "occurrence_id":"occ-new","position":0,"range_id":"all",
            "song_key":"song-new","seconds":7,"title":"Song",
            "artist":"Artist","source_id":"source","raw_hash":"raw",
            "source_system":"fixture","occurrence_payload_json":{},
            "video_title":"New Video","channel_name":"Fixture",
            "channel_id":"UCfixture","channel_handle":"@fixture",
            "channel_url":"","published_at":0,"video_payload_json":{},
            "video_tombstone":False,
        }
        with patch.object(pg_adapter,"_runtime_source_occurrences",return_value=[]), \
             patch.object(pg_adapter,"_overlay_candidate_rows") as global_candidates, \
             patch.object(pg_adapter,"_accepted_video_resets") as global_resets, \
             patch.object(pg_adapter,"_runtime_tombstones") as global_changes:
            result=pg_adapter._generic_video_source_payload(
                object(),"parent",None,source_key,
                {"range":"all","page":"1","pageSize":"200"},
                ("overlay",),(candidate,),{},(),
            )
        self.assertTrue(result["found"])
        self.assertEqual((result["totalVideoCount"],result["totalOccurrenceCount"]),(1,1))
        self.assertEqual(result["record"]["videoId"],video_id)
        global_candidates.assert_not_called();global_resets.assert_not_called();global_changes.assert_not_called()

    def test_snapshot_overlay_only_artist_source_rebuilds_exact_prepared_video(self):
        artist="\u500d\u8cde\u5343\u6075\u5b50\u3055\u3093"
        source_key=pg_adapter._production_source_detail_key_for_group(
            "artists","all",pg_adapter._overlay_norm(artist),
        )
        self.assertEqual(source_key,"000e41d350a7ef83")
        candidate={
            "revision_id":"accepted_30890421984_1","video_id":"PZPwqBtYM2I",
            "occurrence_id":"occ-artist","position":0,"range_id":"all",
            "song_key":"song-artist","seconds":7,"title":"World Promise",
            "artist":artist,"source_id":"source","raw_hash":"raw",
            "source_system":"fixture","occurrence_payload_json":{},
            "video_title":"Artist Video","channel_name":"Fixture",
            "channel_id":"UCfixture","channel_handle":"@fixture",
            "channel_url":"","published_at":0,"video_payload_json":{},
            "video_tombstone":False,
        }
        summary={"total_occurrence_count":0,"total_video_count":0,"max_position":0}
        page=[{"video_id":"PZPwqBtYM2I","first_position":1}]
        with patch.object(pg_adapter,"_rows",side_effect=[[],[summary],page]), \
             patch.object(pg_adapter,"_overlay_candidate_rows") as global_candidates, \
             patch.object(pg_adapter,"_accepted_video_resets") as global_resets, \
             patch.object(pg_adapter,"_runtime_tombstones") as global_changes:
            result=pg_adapter._generic_overlay_artist_source_for_key(
                object(),"parent",source_key,
                {"range":"all","page":"1","pageSize":"200"},
                ("overlay",),(candidate,),{},(),
            )
        self.assertTrue(result["found"])
        self.assertEqual(
            (result["totalVideoCount"],result["totalOccurrenceCount"],result["totalSongCount"]),
            (1,1,1),
        )
        self.assertEqual(result["record"]["type"],"artist")
        self.assertEqual(result["record"]["name"],artist)
        self.assertEqual(result["record"]["sourceDetailKey"],source_key)
        self.assertEqual(result["record"]["occurrences"][0]["videoId"],"PZPwqBtYM2I")
        global_candidates.assert_not_called();global_resets.assert_not_called();global_changes.assert_not_called()

    def test_snapshot_overlay_artist_route_precedes_video_and_channel_fallbacks(self):
        source_key="000e41d350a7ef83"
        context=SimpleNamespace(
            runtime=None,generic_runtime=("active",{}),parent=("parent",{}),
            overlay_ids=("overlay",),authoritative_ids=(),authoritative_records=None,
        )
        expected={"schemaVersion":1,"found":True,"sourceKey":source_key,
                  "record":{"type":"artist","sourceDetailKey":source_key}}
        prepared=((),{},())
        missing={"schemaVersion":1,"found":False,"sourceKey":source_key}
        with patch.object(pg_adapter,"_runtime_source_payload",return_value=missing), \
             patch.object(pg_adapter,"_runtime_source_key_for_channel_alias",return_value=""), \
             patch.object(pg_adapter,"_snapshot_source_overlay_inputs",return_value=prepared), \
             patch.object(pg_adapter,"_generic_overlay_song_source_for_key",return_value=None), \
             patch.object(pg_adapter,"_generic_overlay_artist_source_for_key",return_value=expected) as artist_detail, \
             patch.object(pg_adapter,"_generic_video_source_payload") as video_detail, \
             patch.object(pg_adapter,"_runtime_channel_source_payload") as channel_detail:
            result=pg_adapter.source_payload(
                object(),source_key,{"range":"all","page":"1","pageSize":"200"},
                snapshot_context=context,snapshot_video_scope=("PZPwqBtYM2I",),
            )
        self.assertIs(result,expected)
        artist_detail.assert_called_once()
        video_detail.assert_not_called();channel_detail.assert_not_called()

    def test_snapshot_persisted_artist_without_delta_is_not_reinterpreted_as_channel(self):
        source_key="artist-source"
        persisted={"schemaVersion":1,"found":True,"sourceKey":source_key,
                   "sourceRevisionId":"parent",
                   "record":{"type":"artist","key":"artist","name":"Artist",
                             "sourceDetailKey":source_key}}
        context=SimpleNamespace(
            runtime=None,generic_runtime=("active",{}),parent=("parent",{}),
            overlay_ids=("overlay",),authoritative_ids=(),authoritative_records=None,
        )
        with patch.object(pg_adapter,"_runtime_source_payload",return_value=persisted), \
             patch.object(pg_adapter,"_snapshot_source_overlay_inputs",return_value=((),{},())), \
             patch.object(pg_adapter,"_generic_song_source_payload",return_value=None), \
             patch.object(pg_adapter,"_generic_artist_source_payload",return_value=None) as artist_detail, \
             patch.object(pg_adapter,"_generic_video_source_payload") as video_detail, \
             patch.object(pg_adapter,"_runtime_channel_source_payload") as channel_detail:
            result=pg_adapter.source_payload(
                object(),source_key,{"range":"all","page":"1","pageSize":"200"},
                snapshot_context=context,snapshot_video_scope=("video-one",),
            )
        self.assertIs(result,persisted)
        artist_detail.assert_called_once()
        video_detail.assert_not_called();channel_detail.assert_not_called()

    def test_snapshot_persisted_video_source_never_rebuilds_whole_channel(self):
        video_id="video-one"
        source_key=pg_adapter._stable_key("source-video","all",video_id)
        persisted={
            "schemaVersion":1,"found":True,"sourceKey":source_key,
            "sourceRevisionId":"parent",
            "record":{"type":"video","key":video_id,"videoId":video_id,
                      "channelId":"UCfixture","sourceDetailKey":source_key},
        }
        context=SimpleNamespace(
            runtime=None,generic_runtime=("active",{}),parent=("parent",{}),
            overlay_ids=("overlay",),authoritative_ids=(),authoritative_records=None,
        )
        expected={"schemaVersion":1,"found":True,"sourceKey":source_key,
                  "record":{"type":"video","videoId":video_id}}
        prepared=((),{},())
        with patch.object(pg_adapter,"_runtime_source_payload",return_value=persisted), \
             patch.object(pg_adapter,"_snapshot_source_overlay_inputs",return_value=prepared), \
             patch.object(pg_adapter,"_generic_video_source_payload",return_value=expected) as video_detail, \
             patch.object(pg_adapter,"_runtime_channel_source_payload") as channel_detail:
            result=pg_adapter.source_payload(
                object(),source_key,{"range":"all","page":"1","pageSize":"200"},
                snapshot_context=context,snapshot_video_scope=(video_id,),
            )
        self.assertIs(result,expected)
        video_detail.assert_called_once()
        channel_detail.assert_not_called()

    def test_authoritative_bulk_source_export_keeps_all_video_occurrences(self):
        records=[]
        for index in range(31):
            songs=[{"occurrenceId":f"occ-{index}-0","position":0,"rangeId":"7d",
                    "songKey":"song","title":"Song","artist":"Artist","seconds":index}]
            if index==0:
                songs.append({"occurrenceId":"occ-0-1","position":1,"rangeId":"7d",
                              "songKey":"song","title":"Song","artist":"Artist","seconds":99})
            records.append({"video":{"videoId":f"video-{index:03d}","title":f"Video {index}",
                                     "channelName":"Fixture","channelId":"UCfixture"},
                            "occurrences":tuple(songs)})
        keys=set()
        for view in pg_materializer.VIEWS:
            payload=pg_adapter.rankings_payload_from_records(
                records,{"range":"7d","view":view,"metric":"occurrences","page":"1","pageSize":"200"},
            )
            keys.update(record["sourceDetailKey"] for record in payload["records"] if record.get("sourceDetailKey"))
        target=self.temp/"bulk-authoritative.sqlite";writer=pg_materializer.CanonicalSnapshotWriter(target)
        exported=pg_materializer.export_sources_from_records(
            writer,records=records,range_id="7d",source_keys=keys,
        )
        writer.finish()
        song_source=pg_adapter._stable_key("source-song","7d","song")
        with closing(sqlite3.connect(target)) as database:
            counts=database.execute(
                "SELECT count(*),count(DISTINCT video_id) FROM source_occurrences WHERE range_id='7d' AND source_key=?",
                (song_source,),
            ).fetchone()
        self.assertEqual(exported,len(keys))
        self.assertEqual(counts,(32,31))

    def test_pg_snapshot_exports_all_scopes_and_complete_source_pages(self):
        pages=self.temp/"pg-pages";meta=self.temp/"pg-meta.json";canonical=self.temp/"pg-canonical.sqlite"
        connection=FakePgConnection()
        with patch.object(pg_materializer.adapter,"connect_from_env",return_value=connection), \
             patch.object(pg_materializer.adapter,"meta_payload",side_effect=fake_pg_meta), \
             patch.object(pg_materializer.adapter,"source_payload",side_effect=fake_pg_source), \
             patch.object(pg_materializer,"SnapshotPageBuilder",FakeSnapshotPageBuilder):
            result=pg_materializer.materialize(pages,meta,canonical,REV)
        self.assertTrue(connection.closed)
        self.assertGreaterEqual(connection.rollbacks,1)
        self.assertEqual(len(list(pages.rglob("page-*.json"))),24)
        self.assertEqual(result["ranking_scope_series"],96)
        self.assertEqual(result["ranking_rows"],96)
        self.assertEqual(result["source_details"],6)
        self.assertEqual(result["source_occurrences"],1206)
        self.assertEqual(result["source_overlay_scope"],
                         {"videos":0,"pairs":0,"sources":0,"targets":0})
        with closing(sqlite3.connect(canonical)) as database:
            scope_marker=json.loads(dict(database.execute("SELECT key,value FROM meta"))["ranking_scope_counts_json"])
            scopes={row[0] for row in database.execute("SELECT DISTINCT scope_key FROM ranking_rows")}
            source_counts=dict(database.execute("SELECT range_id,count(*) FROM source_occurrences GROUP BY range_id"))
        self.assertEqual(len(scope_marker),96)
        self.assertEqual(scopes,{"all","niche","visible","visibleNiche"})
        self.assertEqual(source_counts,{"7d":603,"all":603})
        serving=self.temp/"pg-serving.sqlite"
        built=builder.build_serving_store(canonical,pages,serving,active_revision_id=REV)
        self.assertEqual(len(built["validation"]["rankingScopes"]),96)

    def test_zero_count_filtered_scope_is_declared_and_served(self):
        canonical=self.temp/"zero-scope.sqlite";shutil.copyfile(self.snapshot,canonical)
        expected={}
        with closing(sqlite3.connect(canonical)) as database:
            database.execute("DELETE FROM ranking_rows WHERE scope_key!='all'")
            for range_id,view,metric,count in database.execute(
                "SELECT range_id,view,metric,count(*) FROM ranking_rows "
                "WHERE scope_key='all' GROUP BY range_id,view,metric ORDER BY range_id,view,metric"
            ):
                expected[f"{range_id}/{view}/{metric}/all"]=int(count)
                for scope in ("niche","visible","visibleNiche"):
                    expected[f"{range_id}/{view}/{metric}/{scope}"]=0
            database.execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)",(
                "ranking_scope_counts_json",json.dumps(expected,sort_keys=True,separators=(",",":")),
            ))
            database.execute("INSERT OR REPLACE INTO meta(key,value) VALUES(?,?)",(
                "ranking_scope_series",str(len(expected)),
            ))
            database.commit()
        zero_serving=self.temp/"zero-serving.sqlite"
        built=builder.build_serving_store(canonical,self.pages,zero_serving,active_revision_id=REV)
        marker="all/songs/count/visibleNiche"
        self.assertEqual(len(built["validation"]["rankingScopes"]),96)
        self.assertEqual(built["validation"]["rankingScopes"][marker],0)

        def open_zero(_sha):
            connection=sqlite3.connect(f"file:{zero_serving}?mode=ro",uri=True)
            connection.row_factory=sqlite3.Row
            return connection

        query=parse_qs("nicheOnly=1&hideUnknownArtist=1")
        with patch.object(self.store,"require_ready",return_value={}), \
             patch.object(self.store,"open_db",side_effect=open_zero):
            payload=self.store.dynamic_page(self.sha,query,"all","songs","occurrences",1,30)
        self.assertEqual(payload["totalCount"],0)
        self.assertEqual(payload["filteredBaseCount"],250)
        self.assertEqual(payload["records"],[])

    def test_pg_adapter_selects_one_persisted_scope(self):
        calls=[]
        def fake_rows(_connection,sql,params=()):
            calls.append((sql,list(params)))
            self.assertIn("scope_key",sql)
            self.assertIn("visibleNiche",params)
            if "SELECT count(*) AS total_count" in sql:
                return [{"total_count":1,"total_occurrence_count":3,
                         "total_song_count":2,"total_video_count":1}]
            return [{"rank":1,"detail_key":"video-key","title":"Video","name":"Video",
                     "channel_search_text":"Fixture","payload_json":{"rank":1,"type":"video",
                     "key":"video-key","videoId":"video-key","title":"Video","count":3,
                     "songCount":2,"videoCount":1,"timestampCount":3,"occurrences":[]}}]
        with patch.object(pg_adapter,"_rows",side_effect=fake_rows):
            payload=pg_adapter._runtime_rankings_payload(object(),REV,{"range":"all","view":"videos",
                "metric":"occurrences","page":"1","pageSize":"30","compact":"1",
                "nicheOnly":"1","hideUnknownArtist":"1"})
        self.assertEqual(payload["totalCount"],1)
        self.assertEqual(len(calls),2)
        adapter_text=PG_ADAPTER_PATH.read_text(encoding="utf-8")
        self.assertIn("AND ranking.scope_key = %s",adapter_text)
        self.assertIn("AND parent_row.scope_key = %s",adapter_text)

    def test_large_affected_artist_reconciliation_streams_bounded_pages(self):
        batches=[
            [
                {"video_id":"v1","occurrence_id":"o1","song_key":"s1","title":"One","artist":"Mega Artist"},
                {"video_id":"v1","occurrence_id":"o2","song_key":"s1","title":"One","artist":"Mega Artist"},
            ],
            [
                {"video_id":"v2","occurrence_id":"o1","song_key":"s2","title":"Two","artist":"Mega Artist"},
                {"video_id":"v3","occurrence_id":"o1","song_key":"s3","title":"Three","artist":"Mega Artist"},
            ],
            [
                {"video_id":"v3","occurrence_id":"o2","song_key":"s3","title":"Three","artist":"Mega Artist"},
            ],
        ]
        # Production full-runtime artist rankings carry identity in ``name``
        # and leave the occurrence-shaped ``artist`` scalar empty.
        groups={"mega artist":{"artist":"","name":"Mega Artist","row_count":99,
                               "song_count":99,"video_count":99,"payload_json":{"name":"Mega Artist"}}}
        changes=[{"entityType":"occurrences","videoId":"removed","occurrenceId":"removed",
                  "title":"Old","artist":"Mega Artist"}]
        reconciliation_counts={}
        with patch.object(pg_adapter,"_AFFECTED_RECONCILIATION_BATCH_SIZE",2), \
             patch.object(pg_adapter,"_MAX_AFFECTED_RECONCILIATION_OCCURRENCES",10), \
             patch.object(pg_adapter,"_rows",side_effect=batches) as rows:
            pg_adapter._reconcile_affected_song_counts(
                object(),"parent",[],[],changes,groups,"artists",{"range":"all"},
                reconciliation_counts=reconciliation_counts,
            )
        self.assertEqual(rows.call_count,3)
        self.assertEqual(rows.call_args_list[0].args[2][-3:],["","",2])
        self.assertEqual(rows.call_args_list[1].args[2][-3:],["v1","o2",2])
        self.assertEqual(rows.call_args_list[2].args[2][-3:],["v3","o1",2])
        group=groups["mega artist"]
        self.assertEqual((group["row_count"],group["song_count"],group["video_count"]),(5,3,3))
        self.assertEqual((group["payload_json"]["count"],group["payload_json"]["songCount"],
                          group["payload_json"]["videoCount"]),(5,3,3))
        self.assertEqual(reconciliation_counts,
                         {("parent","all","artists","mega artist"):(5,3,3)})

        cached_groups={"mega artist":{"artist":"","name":"Mega Artist",
                                      "row_count":0,"song_count":0,"video_count":0,
                                      "payload_json":{"name":"Mega Artist"}}}
        with patch.object(pg_adapter,"_rows") as cached_rows:
            pg_adapter._reconcile_affected_song_counts(
                object(),"parent",[],[],changes,cached_groups,"artists",
                {"range":"all","metric":"songs","nicheOnly":True},
                reconciliation_counts=reconciliation_counts,
            )
        cached_rows.assert_not_called()
        cached_group=cached_groups["mega artist"]
        self.assertEqual((cached_group["row_count"],cached_group["song_count"],
                          cached_group["video_count"]),(5,3,3))

        with patch.object(pg_adapter,"_AFFECTED_RECONCILIATION_BATCH_SIZE",2), \
             patch.object(pg_adapter,"_MAX_AFFECTED_RECONCILIATION_OCCURRENCES",4), \
             patch.object(pg_adapter,"_rows",side_effect=batches):
            with self.assertRaisesRegex(pg_adapter.PostgresAdapterError,"streamed occurrence cap"):
                list(pg_adapter._bounded_affected_parent_occurrences(
                    object(),"parent",changes,"artists",{"range":"all"},
                ))

    def test_snapshot_reconciliation_sorts_once_and_fetches_bounded_batches(self):
        columns=("occurrence_id","video_id","song_key","title","artist",
                 "channel_id","channel_handle","channel_name")
        rows=[
            ("o1","v1","s1","One","Mega Artist","c1","h1","Channel"),
            ("o2","v1","s1","One","Mega Artist","c1","h1","Channel"),
            ("o1","v2","s2","Two","Mega Artist","c1","h1","Channel"),
            ("o1","v3","s3","Three","Mega Artist","c1","h1","Channel"),
            ("o2","v3","s3","Three","Mega Artist","c1","h1","Channel"),
        ]

        class StreamingCursor:
            def __init__(self, values):
                self.values=list(values);self.offset=0;self.description=[(name,) for name in columns]
                self.executions=[];self.fetch_sizes=[];self.itersize=None;self.closed=False
            def execute(self, sql, params):self.executions.append((sql,list(params)))
            def fetchmany(self, size):
                self.fetch_sizes.append(size)
                batch=self.values[self.offset:self.offset+size];self.offset+=len(batch)
                return batch
            def close(self):self.closed=True

        class StreamingConnection:
            autocommit=False
            def __init__(self, values):self.cursor_value=StreamingCursor(values);self.names=[]
            def cursor(self, *, name):self.names.append(name);return self.cursor_value

        changes=[{"entityType":"occurrences","videoId":"removed","occurrenceId":"removed",
                  "title":"Old","artist":"Mega Artist"}]
        connection=StreamingConnection(rows)
        with patch.object(pg_adapter,"_AFFECTED_RECONCILIATION_BATCH_SIZE",2), \
             patch.object(pg_adapter,"_MAX_AFFECTED_RECONCILIATION_OCCURRENCES",10):
            streamed=list(pg_adapter._bounded_affected_parent_occurrences(
                connection,"parent",changes,"artists",{"range":"all"},
            ))

        cursor=connection.cursor_value
        self.assertEqual(len(connection.names),1)
        self.assertEqual(len(cursor.executions),1)
        self.assertNotIn("(o.video_id, o.occurrence_id) >",cursor.executions[0][0])
        self.assertIn("ORDER BY o.video_id, o.occurrence_id",cursor.executions[0][0])
        self.assertEqual(cursor.executions[0][1][-1],11)
        self.assertEqual(cursor.itersize,2)
        self.assertEqual(cursor.fetch_sizes,[2,2,2,2])
        self.assertEqual([row["occurrence_id"] for row in streamed],["o1","o2","o1","o1","o2"])
        self.assertTrue(cursor.closed)

        capped=StreamingConnection(rows)
        with patch.object(pg_adapter,"_AFFECTED_RECONCILIATION_BATCH_SIZE",2), \
             patch.object(pg_adapter,"_MAX_AFFECTED_RECONCILIATION_OCCURRENCES",4):
            with self.assertRaisesRegex(pg_adapter.PostgresAdapterError,"streamed occurrence cap"):
                tuple(pg_adapter._bounded_affected_parent_occurrences(
                    capped,"parent",changes,"artists",{"range":"all"},
                ))
        self.assertTrue(capped.cursor_value.closed)

    def test_streamed_reconciliation_uses_database_keyset_for_mixed_case_ids(self):
        changes=[{"entityType":"occurrences","videoId":"removed","occurrenceId":"removed",
                  "title":"Old","artist":"Mega Artist"}]
        # A locale-aware PostgreSQL collation can place lowercase ``a`` before
        # uppercase ``Z`` while Python orders them in the opposite direction.
        # The production failure appeared only after a full page crossed that
        # boundary.  PostgreSQL remains the ordering authority; Python only
        # rejects an exactly repeated cursor.
        batches=[
            [{"video_id":"a-video","occurrence_id":"a-occurrence","song_key":"s1",
              "title":"One","artist":"Mega Artist"}],
            [{"video_id":"Z-video","occurrence_id":"Z-occurrence","song_key":"s2",
              "title":"Two","artist":"Mega Artist"}],
            [],
        ]
        with patch.object(pg_adapter,"_AFFECTED_RECONCILIATION_BATCH_SIZE",1), \
             patch.object(pg_adapter,"_MAX_AFFECTED_RECONCILIATION_OCCURRENCES",4), \
             patch.object(pg_adapter,"_rows",side_effect=batches) as rows:
            streamed=list(pg_adapter._bounded_affected_parent_occurrences(
                object(),"parent",changes,"artists",{"range":"all"},
            ))

        self.assertEqual([row["video_id"] for row in streamed],["a-video","Z-video"])
        self.assertEqual(rows.call_count,3)
        for call in rows.call_args_list:
            sql=call.args[1]
            self.assertIn("(o.video_id, o.occurrence_id) > (%s, %s)",sql)
            self.assertIn("ORDER BY o.video_id, o.occurrence_id",sql)
        self.assertEqual(rows.call_args_list[1].args[2][-3:],
                         ["a-video","a-occurrence",1])
        self.assertEqual(rows.call_args_list[2].args[2][-3:],
                         ["Z-video","Z-occurrence",1])

        with patch.object(pg_adapter,"_AFFECTED_RECONCILIATION_BATCH_SIZE",1), \
             patch.object(pg_adapter,"_MAX_AFFECTED_RECONCILIATION_OCCURRENCES",4), \
             patch.object(pg_adapter,"_rows",side_effect=[batches[0],batches[0]]):
            with self.assertRaisesRegex(pg_adapter.PostgresAdapterError,"did not advance"):
                tuple(pg_adapter._bounded_affected_parent_occurrences(
                    object(),"parent",changes,"artists",{"range":"all"},
                ))

    def test_streamed_reconciliation_preserves_reset_tombstone_replacement_order(self):
        parent_rows=[
            {"video_id":"v1","occurrence_id":"o1","song_key":"old1","title":"Old 1","artist":"Mega Artist"},
            {"video_id":"v1","occurrence_id":"o2","song_key":"old2","title":"Old 2","artist":"Mega Artist"},
            {"video_id":"v2","occurrence_id":"o1","song_key":"old3","title":"Old 3","artist":"Mega Artist"},
        ]
        candidate_rows=[
            {"video_id":"v1","occurrence_id":"n1","song_key":"new1","title":"New 1","artist":"Mega Artist",
             "video_payload_json":{"videoId":"v1"}},
            {"video_id":"v1","occurrence_id":"n2","song_key":"new2","title":"New 2","artist":"Mega Artist",
             "video_payload_json":{"videoId":"v1"}},
        ]
        replacement_rows=[
            {"video_id":"v2","occurrence_id":"o1","song_key":"replacement","title":"Replacement",
             "artist":"Mega Artist"},
        ]
        changes=[
            {"entityType":"occurrences","videoId":"v1","occurrenceId":"o1","title":"Old 1",
             "artist":"Mega Artist","acceptedVideoReset":True},
            {"entityType":"occurrences","videoId":"v2","occurrenceId":"o1","title":"Old 3",
             "artist":"Mega Artist","replacement":True,
             "replacementPayload":{"title":"Replacement","artist":"Mega Artist"}},
        ]
        groups={"mega artist":{"artist":"Mega Artist","name":"Mega Artist","row_count":99,
                               "song_count":99,"video_count":99,"payload_json":{"name":"Mega Artist"}}}
        with patch.object(pg_adapter,"_AFFECTED_RECONCILIATION_BATCH_SIZE",10), \
             patch.object(pg_adapter,"_rows",return_value=parent_rows):
            pg_adapter._reconcile_affected_song_counts(
                object(),"parent",candidate_rows,replacement_rows,changes,groups,"artists",{"range":"all"},
            )
        group=groups["mega artist"]
        self.assertEqual((group["row_count"],group["song_count"],group["video_count"]),(3,3,2))
        self.assertEqual((group["payload_json"]["count"],group["payload_json"]["songCount"],
                          group["payload_json"]["videoCount"]),(3,3,2))

    def test_http_contract_exposes_version_and_local_data_source(self):
        httpd=server.ThreadingHTTPServer(("127.0.0.1",0),server.make_handler(self.store));httpd.daemon_threads=True
        thread=threading.Thread(target=httpd.serve_forever,kwargs={"poll_interval":0.05},daemon=True);thread.start()
        connection=http.client.HTTPConnection("127.0.0.1",httpd.server_address[1],timeout=5)
        try:
            connection.request("GET",f"/api/rankings?v={self.sha}&range=all&view=songs&metric=occurrences&page=1&pageSize=30",headers={"Accept-Encoding":"gzip"})
            response=connection.getresponse();compressed=response.read();payload=json.loads(gzip.decompress(compressed))
            self.assertEqual(response.status,200);self.assertEqual(len(payload["records"]),30)
            self.assertEqual(response.getheader("Content-Encoding"),"gzip");self.assertLess(len(compressed),len(json.dumps(payload).encode()))
            self.assertEqual(response.getheader("X-Release-Sha"),self.sha)
            self.assertEqual(response.getheader("X-Server-Commit"),SERVER_COMMIT)
            self.assertEqual(response.getheader("X-Data-Source"),"local-release-chunk")
            self.assertEqual(response.getheader("Access-Control-Allow-Origin"),"*")
            connection.request("GET",f"/api/sources/{ALL_KEY}?v={self.sha}&range=all&page=1&pageSize=2")
            response=connection.getresponse();source_payload=json.loads(response.read())
            self.assertEqual(response.status,200);self.assertTrue(source_payload["found"])
            self.assertEqual(response.getheader("X-Data-Source"),"local-serving-sqlite")
            with patch.object(self.store,"health",return_value={"status":"degraded","error":"release_not_ready"}):
                connection.request("GET","/healthz")
                response=connection.getresponse();degraded=json.loads(response.read())
                self.assertEqual(response.status,503);self.assertEqual(degraded["status"],"degraded")
                self.assertEqual(response.getheader("Retry-After"),"3")
                self.assertEqual(response.getheader("X-Error-Code"),"release_not_ready")
        finally:
            connection.close();httpd.shutdown();httpd.server_close();thread.join(timeout=2)

    def test_frontend_fail_fast_timeout_and_error_contract(self):
        app=APP_PATH.read_text(encoding="utf-8")
        self.assertIn("const API_META_TIMEOUT_MS = 4_000",app)
        self.assertIn("const API_REQUEST_TIMEOUT_MS = 8_000",app)
        self.assertIn('cache: "default",\n    timeoutMs: API_META_TIMEOUT_MS',app)
        self.assertIn("async function validateStaticRuntimeMeta(meta, rangeId)",app)
        self.assertIn("timeoutMs: 2_000",app)
        self.assertIn("function runtimeApiFallbackMeta()",app)
        self.assertIn("state.runtimeApi.usingFallbackMeta = true",app)
        self.assertIn("if (!state.runtimeApi.staticMeta) throw error",app)
        self.assertIn("requestErrorFriendlyMessage(error)",app)
        self.assertIn("function requestTimeoutMs(path, options = {})",app)
        self.assertIn('error.name = "RequestTimeoutError"',app)
        self.assertIn('error.name = "RequestNetworkError"',app)
        self.assertIn('options.signal?.addEventListener("abort", abortFromCaller, { once: true })',app)
        self.assertIn("window.clearTimeout(timeoutId)",app)
        self.assertIn("客户端截止时间",app)

    def test_frontend_parallelizes_first_ranking_and_binds_release_once(self):
        app=APP_PATH.read_text(encoding="utf-8")
        start=app.index("async function initNextServingV3()")
        end=app.index("function apiMetaReleaseSha",start)
        active_init=app[start:end]
        self.assertLess(active_init.index("const apiMetaPromise"),active_init.index("const firstRankingPromise"))
        self.assertLess(active_init.index("const firstRankingPromise"),active_init.index("await apiMetaPromise"))
        self.assertLess(active_init.index("await firstRankingPromise"),active_init.index("const statusPromise"))
        self.assertNotIn("staticMetaPromise",active_init)
        self.assertIn("fetch-static-meta-after-api-failure",app)
        self.assertIn("state.runtimeApi.versionRetryUsed",app)
        self.assertIn("fetch-versioned-initial-ranking",app)
        self.assertIn("includeResponseMeta: true",app)
        self.assertIn('result.releaseSha = cleanText(response.responseMeta?.releaseSha || "")',app)
        self.assertIn('if (request.rankMetric === "songs") return "songs"',app)
        self.assertIn("record?.displayArtist || record?.artist",app)
        self.assertIn("const workerCount = Math.min(4, pageCount - 1)",app)

    def test_nginx_fails_fast_and_preserves_json_errors(self):
        nginx=NGINX_PATH.read_text(encoding="utf-8")
        self.assertEqual(nginx.count("proxy_read_timeout 10s;"),2)
        self.assertEqual(nginx.count("proxy_next_upstream off;"),2)
        self.assertEqual(nginx.count("proxy_intercept_errors off;"),2)
        self.assertNotIn("proxy_read_timeout 15s;",nginx)
        self.assertIn("server_name next.ytb-song-rank.culua.com;",nginx)
        self.assertIn("gzip on;",nginx)
        self.assertIn("application/javascript",nginx)
        self.assertIn("text/css",nginx)
        self.assertIn("image/svg+xml",nginx)
        self.assertIn('Cache-Control "public, max-age=31536000, immutable"',nginx)
        self.assertIn('Cache-Control "public, max-age=60, must-revalidate"',nginx)

    def test_server_retains_configurable_production_backlog(self):
        httpd=server.make_server("127.0.0.1",0,256,self.store)
        try:self.assertEqual(httpd.request_queue_size,256)
        finally:httpd.server_close()

    def test_workflow_deploys_complete_artifact_and_never_marks_proxy_fallback(self):
        workflow=(ROOT/".github"/"workflows"/"sync-wdc-release.yml").read_text(encoding="utf-8")
        ci=(ROOT/".github"/"workflows"/"test-next-serving-v3.yml").read_text(encoding="utf-8")
        installer=(ROOT/"deploy"/"install-wdc-release.sh").read_text(encoding="utf-8")
        self.assertIn("materialize-pg-release-snapshot.py",workflow)
        self.assertIn("server/pg_adapter.py",workflow)
        self.assertIn("--snapshot-output",workflow)
        self.assertIn("build-serving-store.py",workflow)
        self.assertIn("release_serving_server.py",workflow)
        self.assertIn("install-wdc-release.sh",workflow)
        self.assertIn("--build-logic-sha",workflow)
        self.assertNotIn("build-serving-sqlite.py",workflow)
        self.assertNotIn("PUBLIC_BASE",workflow)
        self.assertNotIn("https://ytb-song-rank.culua.com",workflow)
        self.assertNotIn("/api/rankings?range=",workflow)
        self.assertNotIn("VPS2_RUNTIME_DB",workflow)
        self.assertNotIn("snapshot-runtime-db.py",workflow)
        self.assertNotIn("/var/lib/culua/ytb-song-rank/song-rank.sqlite",workflow)
        self.assertIn("PGHOST=/var/run/postgresql",workflow)
        self.assertIn("--uid=www-data",workflow)
        self.assertIn('chown root:www-data "$remote_root"',workflow)
        self.assertIn("systemd-run --quiet --wait --pipe --collect",workflow)
        self.assertIn("SOURCE_ACTIVE_STABLE",workflow)
        self.assertIn("SOURCE_ACTIVE_DRIFT",workflow)
        self.assertIn("publishing the pinned immutable snapshot",workflow)
        self.assertIn("SOURCE_ACTIVE_INVALID",workflow)
        self.assertNotIn("ACTIVE_MISMATCH after build",workflow)
        self.assertIn('[[ "$DEPLOYED_STATUS" == "ok"',workflow)
        self.assertIn('"$DEPLOYED_RELEASE" =~ ^[0-9a-f]{64}$',workflow)
        self.assertIn('EXPECTED_REMOTE_ROOT="/tmp/dsl-wdc-sync-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',workflow)
        self.assertIn("if: always()",workflow)
        self.assertNotIn("if: always() &&",workflow)
        self.assertIn("VPS2_TRANSIENT_UNITS_CLEANED",workflow)
        self.assertIn("for phase in snapshot serving bundle; do",workflow)
        self.assertIn('unit="dsl-wdc-${phase}-${run_id}-${run_attempt}.service"',workflow)
        self.assertIn('[[ "$remote_root" == "/tmp/dsl-wdc-sync-${run_id}-${run_attempt}" ]]',workflow)
        self.assertIn('exit "$cleanup_status"',workflow)
        self.assertLess(workflow.index('systemctl stop "$unit"'),workflow.index('rm -rf -- "$remote_root"'))
        self.assertIn('WDC_PROJECT_ROOT: "/opt/culua/ytb-song-rank"',workflow)
        self.assertIn('WDC_PROJECT_MAX_BYTES: "40000000000"',workflow)
        self.assertIn('WDC_FILESYSTEM_RESERVE_BYTES: "5000000000"',workflow)
        self.assertIn('projected_bytes=$((current_bytes + incoming_bytes))',workflow)
        self.assertIn('if (( projected_bytes >= max_bytes )); then',workflow)
        self.assertIn("WDC_STORAGE_PREFLIGHT_OK",workflow)
        self.assertIn("WDC_STORAGE_POSTUPLOAD_OK",workflow)
        self.assertIn("WDC_STORAGE_FINAL_OK",workflow)
        self.assertIn('[[ "$project_root" == "/opt/culua/ytb-song-rank" ]]',workflow)
        self.assertIn('[[ "$releases_root" == "$project_root/releases" ]]',workflow)
        self.assertNotIn('du -s /opt/culua',workflow)
        self.assertNotIn('rm -rf /opt/culua',workflow)
        self.assertIn("DEPLOY_ROLLBACK",installer)
        self.assertIn("sourceFallbackEnabled",installer)
        self.assertIn("computed release content hash mismatch",installer)
        self.assertLess(installer.index("LIVE_MUTATION_STARTED=1"),installer.index('atomic_install "$SERVER_ARTIFACT" "$SERVER_PATH"'))
        self.assertIn("DEPLOY_ACTIVATED_PENDING_PUBLIC",installer)
        self.assertIn('ACTION" == "rollback"',installer)
        self.assertIn('ACTION" == "finalize"',installer)
        self.assertIn("--frontend-root",workflow)
        self.assertIn("--nginx-artifact",workflow)
        self.assertIn("--systemd-artifact",workflow)
        self.assertIn("Verify complete public correctness and asset contract",workflow)
        self.assertIn("Roll back WDC release after failed public gate",workflow)
        self.assertIn("Finalize successful WDC release",workflow)
        self.assertIn(".github/workflows/test-next-serving-v3.yml",workflow)
        self.assertIn("page_size=min(200,max(1,total_videos-1))",workflow)
        self.assertIn("backups-complete",installer)
        self.assertIn("PREP_STATE_DIR",installer)
        self.assertIn("state preserved at",installer)
        self.assertIn('git grep -nE -e "$pattern"',ci)
        self.assertIn("sparse-checkout-cone-mode: false",ci)
        self.assertIn("fetch-depth: 2",ci)
        self.assertIn("core.whitespace=blank-at-eol,blank-at-eof,space-before-tab,cr-at-eol",ci)
        self.assertIn('diff --check "$diff_base" HEAD',ci)
        self.assertNotIn('ranking_scope_series\"] == 72',workflow)
        self.assertNotIn("https://ytb-song-rank.culua.com",installer)

if __name__=="__main__":unittest.main(verbosity=2)
