from __future__ import annotations
import copy
import importlib.util
import gzip
import http.client
import json
import math
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
ALL_KEY="01fc9d6830d3c230";SEVEN_KEY="7d0cafe0deadbeef";MANY_KEY="31video0feedbeef";EMPTY_KEY="empty000feedbeef";VTUBER_KEY="dc6aa541a6dff484";REV="rev-test-20260810";SERVER_COMMIT="0123456789abcdef0123456789abcdef01234567"


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
    CREATE TABLE source_occurrences(source_key TEXT,range_id TEXT,position INTEGER,video_id TEXT,title TEXT,channel_name TEXT,channel_id TEXT,channel_handle TEXT,channel_url TEXT,published_timestamp INTEGER,seconds INTEGER,is_niche INTEGER,is_unknown_artist INTEGER,canonical_song_key TEXT,canonical_song_name TEXT,search_text TEXT,payload_json TEXT,PRIMARY KEY(source_key,range_id,position));
    CREATE TABLE ranking_rows(row_id TEXT,range_id TEXT,view TEXT,metric TEXT,scope_key TEXT,rank INTEGER,detail_key TEXT,title TEXT,artist TEXT,name TEXT,count INTEGER,song_count INTEGER,video_count INTEGER,timestamp_count INTEGER,payload_json TEXT,search_text TEXT,channel_search_text TEXT,PRIMARY KEY(range_id,view,metric,scope_key,rank));
    """)
    def insert_occurrence(values,canonical_key="fixture-song",canonical_name="Fixture Song"):
        c.execute(
            "INSERT INTO source_occurrences VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (*values[:13],canonical_key,canonical_name,*values[13:]),
        )
    c.execute("INSERT INTO meta VALUES(?,?)",("active_revision_id",REV))
    for range_id,key in (("all",ALL_KEY),("7d",SEVEN_KEY)):
        c.execute("INSERT INTO source_details VALUES(?,?,?,?,?)",(key,range_id,"song","song-hare",json.dumps({"title":"ただ君に晴れ","artist":"ヨルシカ","sourceDetailKey":key},ensure_ascii=False)))
    c.execute("INSERT INTO source_details VALUES(?,?,?,?,?)",(MANY_KEY,"all","song","song-many",json.dumps({"title":"Many videos","artist":"Fixture","sourceDetailKey":MANY_KEY})))
    c.execute("INSERT INTO source_details VALUES(?,?,?,?,?)",(EMPTY_KEY,"all","song","song-empty",json.dumps({"title":"Empty detail","artist":"Fixture","sourceDetailKey":EMPTY_KEY})))
    rows=[(1,"videoAAAAAA",0,0),(2,"videoAAAAAA",1,0),(3,"videoBBBBBB",0,0),(4,"videoCCCCCC",0,0),(5,"videoCCCCCC",0,1)]
    for pos,video,niche,unknown in rows:
        payload={"videoId":video,"title":video,"channelName":"Fixture","channelId":"UCfixture","seconds":100+pos}
        insert_occurrence(
                  (ALL_KEY,"all",pos,video,video,"Fixture","UCfixture","@fixture","https://youtube.com/@fixture",1700000000+pos,100+pos,niche,unknown,f"ただ君に晴れ ヨルシカ {video}",json.dumps(payload,ensure_ascii=False)))
    payload={"videoId":"video7DDDDD","title":"7d","channelName":"Fixture","channelId":"UCfixture","seconds":1}
    insert_occurrence(
              (SEVEN_KEY,"7d",1,"video7DDDDD","7d","Fixture","UCfixture","@fixture","https://youtube.com/@fixture",1700000001,1,0,0,"ただ君に晴れ ヨルシカ",json.dumps(payload,ensure_ascii=False)))
    for pos in range(32):
        video_index=max(0,pos-1);video=f"many{video_index:07d}"
        payload={"videoId":video,"title":f"Many {video_index}","channelName":"Fixture","channelId":"UCfixture","seconds":pos}
        insert_occurrence(
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
    build_calls=[]
    def __init__(self,_connection):type(self).build_calls=[]
    def build_combo(self,range_id,view,metric,scope_key="all"):
        type(self).build_calls.append((range_id,view,metric,scope_key))
        def render(page):
            key=f"source-{range_id}-{view}"
            song_count=1 if view=="songs" else 2
            record={"rank":1,"type":view[:-1] if view.endswith("s") else view,
                    "key":f"{range_id}-{view}","title":f"{range_id} {view}","displayArtist":"Fixture",
                    "name":f"{range_id} {view}","count":201,"songCount":song_count,"videoCount":201,
                    "timestampCount":201,"channelName":"Fixture","channelId":"UCfixture",
                    "occurrences":[
                        {"videoId":f"preview-{range_id}-{view}-{index}","seconds":index,
                         "debugSearchEvidence":"deep-only-marker" if index==4 else ""}
                        for index in range(5)
                    ]}
            record["sourceDetailKey"]=key
            return {"schemaVersion":1,"rangeId":range_id,"view":view,"metric":metric,
                    "page":page,"pageSize":200,"totalCount":1,"filteredBaseCount":1,
                    "totalOccurrenceCount":201,"totalSongCount":song_count,"totalVideoCount":201,
                    "pageCount":1,"compact":False,"records":[record] if page==1 else []}
        return render


def fake_pg_meta(_connection):
    return {"meta":{"active_revision_id":REV,"content_sha256":"c"*64,
                    "parent_revision_id":"parent-revision","source_commit_sha":"a"*40,
                    "built_at":"2026-08-10T00:00:00Z","latest_generated_at":"2026-08-09T23:59:59Z"}}


def fake_pg_source(_connection,key,query):
    range_id=str(query.get("range") or "all");page=int(query.get("page") or 1)
    page_size=int(query.get("pageSize") or 30);total=201
    start=(page-1)*page_size;stop=min(start+page_size,total)
    occurrences=[]
    view=next(view for view in pg_materializer.VIEWS if key.endswith(f"-{view}"))
    for index in range(start,stop):
        song_index=0 if view=="songs" else index%2
        occurrences.append({"videoId":f"video-{range_id}-{index:03d}","title":f"Video {index}",
                            "channelName":"Fixture","channelId":"UCfixture","channelHandle":"@fixture",
                            "channelUrl":"https://youtube.com/@fixture","publishedAt":"2026-08-10T00:00:00Z",
                            "seconds":index,"song":{"songKey":f"song-{song_index}","title":f"Song {song_index}",
                                                        "artist":"Fixture","isNiche":index%2==0}})
    record={"type":"song" if view=="songs" else "artist" if view=="artists" else "video" if view=="videos" else "vtuber","key":key,
            "sourceDetailKey":key,"rangeId":range_id,"count":201,"videoCount":201,
            "timestampCount":201,"occurrences":occurrences}
    return {"schemaVersion":1,"found":True,"sourceKey":key,"record":record,
            "page":page,"pageSize":page_size,"pageCount":math.ceil(total/page_size),"totalCount":total,
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

    def test_non_vtuber_snapshot_song_identity_uses_explicit_title_and_artist(self):
        row=pg_materializer._source_occurrence_row(
            "source-fixture","all",1,
            {"videoId":"video-fixture","songTitle":"Fixture Song",
             "songArtist":"Fixture Artist"},
            entity_type="artist",
        )
        self.assertEqual(row[14],"Fixture Song")
        self.assertEqual(
            row[13],
            pg_adapter._song_key(
                {"title":"Fixture Song","artist":"Fixture Artist"},
            ),
        )
        explicit=pg_materializer._source_occurrence_row(
            "source-fixture","all",2,
            {"videoId":"video-explicit","songTitle":"Fixture Song",
             "songArtist":"Fixture Artist","songKey":"canonical-explicit"},
            entity_type="video",
        )
        self.assertEqual(explicit[13],"canonical-explicit")

    def test_serving_build_rejects_ambiguous_vtuber_canonical_identity(self):
        with closing(sqlite3.connect(self.serving)) as connection:
            connection.execute(
                "UPDATE source_details SET entity_type='vtuber' "
                "WHERE range_id='all' AND source_key=?",(MANY_KEY,),
            )
            connection.execute(
                "UPDATE source_occurrences SET canonical_song_name='Conflict' "
                "WHERE range_id='all' AND source_key=? AND position=1",(MANY_KEY,),
            )
            connection.commit()
            with self.assertRaisesRegex(
                RuntimeError,"ambiguous VTuber canonical song identities",
            ):
                builder.validate_database(connection,("7d","all"),self.pages)

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

    def test_serving_store_can_consume_disposable_canonical_snapshot_in_place(self):
        canonical=self.temp/"consume-canonical.sqlite"
        output=self.temp/"consume-serving.sqlite"
        shutil.copyfile(self.snapshot,canonical)
        source_inode=canonical.stat().st_ino
        result=builder.build_serving_store(
            canonical,self.pages,output,active_revision_id=REV,
            built_at="2026-08-10T00:00:00Z",consume_source_db=True,
        )
        self.assertFalse(canonical.exists())
        self.assertTrue(output.is_file())
        self.assertEqual(output.stat().st_ino,source_inode)
        self.assertEqual(result["buildMode"],"consume-canonical-in-place")
        with closing(sqlite3.connect(output)) as connection:
            tables={row[0] for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )}
            quick=connection.execute("PRAGMA quick_check").fetchone()[0]
            meta=dict(connection.execute("SELECT key,value FROM serving_meta"))
            ranking_count=connection.execute("SELECT count(*) FROM ranking_rows").fetchone()[0]
            fts_count=connection.execute("SELECT count(*) FROM ranking_search_fts").fetchone()[0]
        self.assertNotIn("meta",tables)
        self.assertIn("source_videos",tables)
        self.assertEqual(quick,"ok")
        self.assertEqual(meta["active_revision_id"],REV)
        self.assertEqual(ranking_count,fts_count)

    def test_consume_source_mode_refuses_to_overwrite_output(self):
        canonical=self.temp/"consume-refuse.sqlite"
        output=self.temp/"already-present.sqlite"
        shutil.copyfile(self.snapshot,canonical)
        output.write_bytes(b"owned")
        with self.assertRaises(FileExistsError):
            builder.build_serving_store(
                canonical,self.pages,output,active_revision_id=REV,
                consume_source_db=True,
            )
        self.assertTrue(canonical.is_file())
        self.assertEqual(output.read_bytes(),b"owned")

    def test_health_and_release_artifacts(self):
        health=self.store.health();self.assertEqual(health["status"],"ok",health);self.assertEqual(health["releaseContentSha"],self.sha);self.assertEqual(health["serverCommit"],SERVER_COMMIT);self.assertEqual(health["buildLogicSha"],"b"*64);self.assertEqual(health["searchTokenizer"],"trigram");self.assertEqual(health["localSourcesRanges"],["7d","all"]);self.assertFalse(health["oldOriginDependency"]);self.assertFalse(health["sourceFallbackEnabled"])
        self.assertEqual(set(health["views"]),{"songs","artists","vtubers","videos"});self.assertEqual(set(health["metrics"]),{"occurrences","songs","videos"})
        manifest=json.loads((self.release/"manifest.json").read_text());artifacts={x["path"] for x in manifest["artifacts"]};self.assertEqual(artifacts,{"serving.sqlite","artifacts/release_serving_server.py","artifacts/frontend/index.html","artifacts/frontend/frontend-manifest.json",f"artifacts/frontend/{self.frontend_manifest['appPath']}","artifacts/deploy/next.ytb-song-rank.culua.com.conf","artifacts/deploy/daily-song-list-api.service"})

    def test_release_bundle_can_require_same_filesystem_serving_hardlink(self):
        meta={"activeRevisionId":REV,"expectedParentRevisionId":"parent","sourceCommitSha":"a"*40,
              "serverCommitSha":SERVER_COMMIT,"buildLogicSha":"b"*64,
              "generatedAt":"2026-08-10T00:00:00Z","latestEventTime":"2026-08-09T23:59:59Z"}
        sha,release=bundle.build_bundle(
            self.pages,self.temp/"linked-releases",serving_sqlite=self.serving,
            server_artifact=SERVER_PATH,release_meta=meta,frontend_root=self.frontend_root,
            nginx_artifact=NGINX_PATH,systemd_artifact=UNIT_PATH,
            link_serving_sqlite=True,
        )
        source_stat=self.serving.stat();target_stat=(release/"serving.sqlite").stat()
        self.assertEqual(sha,self.sha)
        self.assertEqual((target_stat.st_dev,target_stat.st_ino),(source_stat.st_dev,source_stat.st_ino))
        self.serving.unlink()
        with closing(sqlite3.connect(release/"serving.sqlite")) as connection:
            self.assertEqual(connection.execute("PRAGMA quick_check").fetchone()[0],"ok")

    def test_release_bundle_hardlink_mode_never_falls_back_to_copy(self):
        meta={"activeRevisionId":REV,"expectedParentRevisionId":"parent","sourceCommitSha":"a"*40,
              "serverCommitSha":SERVER_COMMIT,"buildLogicSha":"b"*64,
              "generatedAt":"2026-08-10T00:00:00Z","latestEventTime":"2026-08-09T23:59:59Z"}
        with patch.object(bundle.os,"link",side_effect=OSError("hard links disabled")):
            with self.assertRaisesRegex(OSError,"hard links disabled"):
                bundle.build_bundle(
                    self.pages,self.temp/"failed-linked-releases",serving_sqlite=self.serving,
                    server_artifact=SERVER_PATH,release_meta=meta,frontend_root=self.frontend_root,
                    nginx_artifact=NGINX_PATH,systemd_artifact=UNIT_PATH,
                    link_serving_sqlite=True,
                )

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

    @unittest.skipUnless(
        sys.platform.startswith("linux"),
        "WDC installer runtime requires GNU/Linux",
    )
    def test_installer_rolls_back_when_first_symlink_switch_fails(self):
        previous="1"*64;(self.releases/previous).mkdir()
        for name in ("manifest.json","meta.json","serving.sqlite"):
            (self.releases/previous/name).write_bytes(b"previous\n")
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
            "--previous-release-sha",previous,
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

    @unittest.skipUnless(
        sys.platform.startswith("linux"),
        "WDC installer runtime requires GNU/Linux",
    )
    def test_installer_never_publishes_partial_backup_state(self):
        previous="1"*64;(self.releases/previous).mkdir()
        for name in ("manifest.json","meta.json","serving.sqlite"):
            (self.releases/previous/name).write_bytes(b"previous\n")
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
            "--previous-release-sha",previous,
        ],env=env,capture_output=True,text=True,timeout=15,check=False)
        self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertEqual(server_target.read_bytes(),b"old-server\n")
        self.assertEqual((static_root/"index.html").read_bytes(),b"old-index\n")
        self.assertEqual(os.readlink(self.releases/"current"),previous)
        self.assertFalse((self.releases/f".rollback-{self.sha}").exists())
        self.assertEqual(list(self.releases.glob(f".rollback-{self.sha}.preparing.*")),[])
        self.assertNotIn("DEPLOY_ROLLBACK complete",result.stdout+result.stderr)

    @unittest.skipUnless(
        sys.platform.startswith("linux"),
        "WDC installer runtime requires GNU/Linux",
    )
    def test_installer_legacy_layout_rolls_back_without_creating_current_link(self):
        previous="1"*64;previous_dir=self.releases/previous;previous_dir.mkdir()
        for name in ("manifest.json","meta.json","serving.sqlite"):
            (previous_dir/name).write_bytes(b"previous\n")
        (self.releases/"current").unlink()
        server_target=self.temp/"legacy-server.py";server_target.write_bytes(b"old-server\n")
        static_root=self.temp/"legacy-static";(static_root/"assets").mkdir(parents=True)
        (static_root/"index.html").write_bytes(b"old-index\n")
        unit_target=self.temp/"legacy.service";unit_target.write_bytes(b"old-unit\n")
        nginx_available=self.temp/"legacy-available.conf";nginx_available.write_bytes(b"old-nginx\n")
        nginx_enabled=self.temp/"legacy-enabled.conf";nginx_enabled.write_bytes(b"old-nginx\n")
        fakebin=self.temp/"fakebin-legacy";fakebin.mkdir();marker=self.temp/"legacy-ln-failed"
        for executable in ("systemctl","systemd-analyze","nginx"):
            (fakebin/executable).write_text('#!/usr/bin/env bash\nexit 0\n',encoding="utf-8")
        (fakebin/"curl").write_text(
            '#!/usr/bin/env bash\nprintf \'{"status":"ok","currentRelease":"%s"}\\n\' "$PREVIOUS_RELEASE"\n',
            encoding="utf-8",
        )
        (fakebin/"ln").write_text(
            '#!/usr/bin/env bash\ndestination="${@: -1}"\nif [[ ! -e "$FAIL_LN_ONCE_MARKER" && "$destination" == */.current.* ]]; then : > "$FAIL_LN_ONCE_MARKER"; exit 73; fi\nexec /usr/bin/ln "$@"\n',
            encoding="utf-8",
        )
        for executable in ("systemctl","systemd-analyze","nginx","curl","ln"):
            os.chmod(fakebin/executable,0o755)
        env={**os.environ,"PATH":f"{fakebin}:{os.environ.get('PATH','')}",
             "FAIL_LN_ONCE_MARKER":str(marker),"PREVIOUS_RELEASE":previous}
        result=subprocess.run([
            "bash",str(INSTALLER_PATH),"--sha",self.sha,"--releases-root",str(self.releases),
            "--server-path",str(server_target),"--static-root",str(static_root),
            "--service-unit-path",str(unit_target),"--nginx-available-path",str(nginx_available),
            "--nginx-enabled-path",str(nginx_enabled),"--service","fixture.service",
            "--expected-server-commit",SERVER_COMMIT,"--expected-build-logic-sha","b"*64,
            "--previous-release-sha",previous,
        ],env=env,capture_output=True,text=True,timeout=15,check=False)
        self.assertNotEqual(result.returncode,0,result.stdout+result.stderr)
        self.assertFalse((self.releases/"current").exists())
        self.assertEqual(server_target.read_bytes(),b"old-server\n")
        self.assertEqual((static_root/"index.html").read_bytes(),b"old-index\n")
        self.assertIn("PREVIOUS_RELEASE_HEALTH_OK",result.stdout+result.stderr)
        self.assertIn("DEPLOY_ROLLBACK complete",result.stdout+result.stderr)
        self.assertFalse((self.releases/f".rollback-{self.sha}").exists())

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
        for detail in (niche,visible):
            self.assertEqual(detail["record"]["songCount"],detail["totalSongCount"])
            self.assertEqual(len(detail["record"]["songs"]),detail["totalSongCount"])
            self.assertEqual(
                sum(item["count"] for item in detail["record"]["songs"]),
                detail["totalOccurrenceCount"],
            )

    def test_vtuber_source_four_scopes_match_ranking_card_triples(self):
        with closing(sqlite3.connect(self.serving)) as connection:
            connection.row_factory=sqlite3.Row
            detail={"type":"vtuber","key":"UCfixture","name":"VTuber Fixture",
                    "channelId":"UCfixture","sourceDetailKey":VTUBER_KEY,
                    "count":4,"songCount":3,"videoCount":3,
                    "songs":[{"key":"songa","name":"Song A","count":2},
                             {"key":"songb","name":"Song B","count":1},
                             {"key":"songc","name":"Song C","count":1}]}
            connection.execute(
                "INSERT INTO source_details(range_id,source_key,entity_type,entity_key,payload_json,total_occurrence_count,total_video_count) VALUES(?,?,?,?,?,?,?)",
                ("all",VTUBER_KEY,"vtuber","UCfixture",json.dumps(detail),4,3),
            )
            rows=[
                (1,"vtuberVid01",0,0,"songa","Song A","Song A -Piano Ver"),
                (2,"vtuberVid01",1,0,"songa","Song A","Song A"),
                (3,"vtuberVid02",1,1,"songb","Song B","Song B"),
                (4,"vtuberVid03",0,0,"songc","Song C","Song C"),
            ]
            for pos,video,niche,unknown,song_key,song_name,title in rows:
                payload={"videoId":video,"title":video,"channelName":"VTuber Fixture",
                         "channelId":"UCfixture","seconds":pos,
                         "song":{"songKey":song_key,"title":title,
                                 "artist":"Unknown" if unknown else "Artist",
                                 "isNiche":bool(niche),
                                 "isUnknownArtist":bool(unknown)}}
                connection.execute(
                    "INSERT INTO source_occurrences(range_id,source_key,position,video_id,title,channel_name,channel_id,channel_handle,channel_url,published_timestamp,seconds,is_niche,is_unknown_artist,canonical_song_key,canonical_song_name,search_text,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    ("all",VTUBER_KEY,pos,video,video,"VTuber Fixture","UCfixture",
                     "@fixture","https://youtube.com/@fixture",1700002000+pos,pos,
                     niche,unknown,song_key,song_name,f"{title} {video}",json.dumps(payload)),
                )
            expected={
                "all":(4,3,3,""),
                "niche":(2,2,2,"nicheOnly=1"),
                "visible":(3,2,2,"hideUnknownArtist=1"),
                "visibleNiche":(1,1,1,"nicheOnly=1&hideUnknownArtist=1"),
            }
            for scope,(count,songs,videos,_query) in expected.items():
                card_payload={**detail,"count":count,"songCount":songs,
                              "videoCount":videos,"timestampCount":count}
                for metric in ("count","songs","videos"):
                    connection.execute(
                        "INSERT INTO ranking_rows(row_id,range_id,view,metric,scope_key,rank,detail_key,title,artist,name,row_count,song_count,video_count,timestamp_count,payload_json,search_text,channel_search_text) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (f"fixture-vtuber-{metric}-{scope}","all","vtubers",metric,
                         scope,1,"UCfixture","","","VTuber Fixture",count,songs,
                         videos,count,json.dumps(card_payload),"VTuber Fixture",
                         "VTuber Fixture UCfixture @fixture"),
                    )
            connection.commit()
        def open_fixture(_sha):
            connection=sqlite3.connect(self.serving)
            connection.row_factory=sqlite3.Row
            return connection
        with patch.object(self.store,"require_ready",return_value={}), \
             patch.object(self.store,"open_db",side_effect=open_fixture), \
             patch.object(self.store,"meta",return_value={"activeRevisionId":REV}):
            for scope,(count,songs,videos,query) in expected.items():
                suffix=f"&{query}" if query else ""
                ranking=self.store.dynamic_page(
                    self.sha,
                    parse_qs(
                        f"range=all&view=vtubers&metric=occurrences&page=1&pageSize=200{suffix}"
                    ),
                    "all","vtubers","occurrences",1,200,
                )
                cards=[item for item in ranking["records"] if item.get("channelId")=="UCfixture"]
                self.assertEqual(len(cards),1,scope)
                detail=self.store.source_page(
                    self.sha,VTUBER_KEY,parse_qs(f"range=all&page=1&pageSize=30{suffix}"),
                )
                self.assertEqual(
                    (cards[0]["count"],cards[0]["songCount"],cards[0]["videoCount"]),
                    (count,songs,videos),scope,
                )
                self.assertEqual(
                    (detail["totalOccurrenceCount"],detail["totalSongCount"],
                     detail["totalVideoCount"]),(count,songs,videos),scope,
                )
                self.assertEqual(
                    (detail["record"]["count"],detail["record"]["songCount"],
                     detail["record"]["videoCount"]),(count,songs,videos),scope,
                )
                self.assertEqual(
                    sum(int(item["count"]) for item in detail["record"]["songs"]),
                    count,scope,
                )
                self.assertEqual(len(detail["record"]["songs"]),songs,scope)

    def test_artist_cards_keep_scalar_count_and_three_previews_for_all_metrics(self):
        for range_id in ("7d","all"):
            for metric in ("occurrences","songs","videos"):
                _,payload,_=self.store.ranking_page(parse_qs(f"range={range_id}&view=artists&metric={metric}&page=1&pageSize=30"))
                self.assertGreater(payload["totalCount"],0)
                record=payload["records"][0]
                self.assertEqual(record["songCount"],5)
                self.assertEqual(len(record["songs"]),3)

    def test_compact_artist_card_limits_song_preview_without_changing_count(self):
        record={
            "type":"artist","key":"artist","name":"Artist",
            "count":9,"songCount":5,"videoCount":4,
            "songs":[
                {"key":f"song-{index}","name":f"Song {index}","count":1}
                for index in range(5)
            ],
            "occurrences":[],
        }
        compact=pg_adapter.compact_ranking_card(record,"artists")
        self.assertEqual(compact["songCount"],5)
        self.assertEqual(compact["songPreviewCount"],3)
        self.assertEqual(
            [item["key"] for item in compact["songs"]],
            ["song-0","song-1","song-2"],
        )

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
        reset_song_key=pg_adapter._production_source_detail_key_for_group(
            "songs","all","reset song::reset artist",
        )
        reset_artist_key=pg_adapter._production_source_detail_key_for_group(
            "artists","all","resetartist",
        )
        ordinary_7d_key=pg_adapter._production_source_detail_key_for_group(
            "songs","all","ordinary seven::reset artist",
        )
        punctuated_artist="岡村和義（岡村靖幸,斉藤和義）"
        canonical_artist_key=pg_adapter._production_source_detail_key_for_group(
            "artists","all","岡村和義岡村靖幸斉藤和義",
        )
        video_key=pg_adapter._stable_key("source-video","all","video-all")
        parent_video_key=pg_adapter._stable_key(
            "source-video","all","video-parent",
        )
        replacement_video_key=pg_adapter._stable_key("source-video","all","video-new")
        requested={song_key,artist_key,channel_key,replacement_key,video_key,
                   replacement_video_key,reset_song_key,reset_artist_key,
                   parent_video_key,ordinary_7d_key,canonical_artist_key,
                   "parent-source","alias-song"}

        fetch_sizes={}
        statements={}

        def fake_stream(_connection,label,statement,_params,*,fetch_size=pg_materializer.SOURCE_SCOPE_FETCH_SIZE):
            fetch_sizes[label]=fetch_size
            statements[label]=statement
            if label=="targets":
                yield {"view":"songs","detail_key":"legacy-alias","title":"Song",
                       "artist":"Artist","source_key":"alias-song"}
                yield {"view":"videos","detail_key":"video-parent","title":"Parent",
                       "artist":"","source_key":""}
            elif label=="videos":
                yield {"video_id":"video7d","channel_id":"UC7d",
                       "partial_range_reset":True,"partial_range_id":"7d"}
                yield {"video_id":"video-all","channel_id":"UCfixture",
                       "partial_range_reset":False,"partial_range_id":""}
            elif label=="occurrences":
                yield {"video_id":"video-all","range_id":"all","title":"Song","artist":"Artist"}
                yield {"video_id":"video-punctuated","range_id":"all",
                       "title":"Punctuated","artist":punctuated_artist}
            elif label=="runtime":
                yield {"range_id":"all","payload_json":{"rangeId":"all","videoId":"video-new","title":"Replacement","artist":"New Artist"}}
            elif label.startswith("parents_"):
                yield {"source_key":"parent-source","video_id":"video-all"}

        compatible_reset={
            "video_id":"video-full-7d","occurrence_id":"reset-occ",
            "range_id":"all","title":"Reset Song","artist":"Reset Artist",
            "channel_id":"UCreset",
        }
        with closing(sqlite3.connect(":memory:")) as database, \
             patch.object(pg_materializer,"_stream_pg_rows",side_effect=fake_stream), \
             patch.object(pg_adapter,"_accepted_video_resets",
                          return_value={"video-full-7d":{"video_id":"video-full-7d"}}) as resets, \
             patch.object(pg_adapter,"_selected_full_reset_candidate_rows",
                          return_value=(compatible_reset,)) as compatible:
            scope=pg_materializer.build_snapshot_source_scope(
                object(),database,overlay_revision_ids=("overlay",),
                source_revision_ids=("overlay","parent"),requested_keys=requested,
            )
            self.assertNotIn("video7d",scope.affected_videos())
            self.assertEqual(scope.videos_for_source(song_key),("video-all",))
            self.assertEqual(scope.videos_for_source("alias-song"),("video-all",))
            self.assertEqual(scope.videos_for_source(artist_key),("video-all",))
            self.assertEqual(
                scope.videos_for_source(canonical_artist_key),
                ("video-punctuated",),
            )
            self.assertEqual(scope.videos_for_source(channel_key),("video-all",))
            self.assertEqual(scope.videos_for_source(replacement_key),("video-new",))
            _batch,replacement_scope,_videos=next(scope.source_batches((replacement_key,)))
            self.assertEqual(
                replacement_scope[replacement_key]["targets"],
                (("songs","\x1f".join((
                    pg_adapter._overlay_song_group_norm("Replacement"),
                    pg_adapter._overlay_song_group_norm("New Artist"),
                ))),),
            )
            self.assertEqual(scope.videos_for_source(reset_song_key),("video-full-7d",))
            self.assertEqual(scope.videos_for_source(reset_artist_key),("video-full-7d",))
            self.assertEqual(scope.videos_for_source(ordinary_7d_key),())
            self.assertEqual(scope.videos_for_source(video_key),("video-all",))
            self.assertEqual(scope.videos_for_source(replacement_video_key),("video-new",))
            self.assertEqual(scope.videos_for_source(parent_video_key),("video-parent",))
            self.assertEqual(
                scope.unaffected_parent_video_sources(),
                ((parent_video_key,"video-parent"),),
            )
            self.assertEqual(scope.videos_for_source("parent-source"),("video-all",))
            self.assertNotIn("SELECT video_id,channel_id,channel_handle,channel_name,payload_json",
                             statements["videos"])
            self.assertIn("AS partial_range_reset",statements["videos"])
            self.assertEqual(fetch_sizes["runtime"],
                             pg_materializer.SOURCE_SCOPE_PAYLOAD_FETCH_SIZE)
            self.assertEqual(fetch_sizes["videos"],
                             pg_materializer.SOURCE_SCOPE_FETCH_SIZE)
            self.assertIn("view = ANY",statements["targets"])
            self.assertIn("view = 'videos'",statements["targets"])
            self.assertIn("view = 'artists'",statements["artist_owners"])
            resets.assert_called_once_with(
                unittest.mock.ANY,["overlay"],include_payload=False,
            )
            compatible.assert_called_once_with(
                unittest.mock.ANY,["overlay"],
                {"video-full-7d":{"video_id":"video-full-7d"}},"all",
                include_payload=False,
            )

    def test_snapshot_artist_scope_uses_exact_owner_before_alias_fallback(self):
        with closing(sqlite3.connect(":memory:")) as database:
            scope=pg_materializer.SnapshotSourceScope(database)
            scope.add_artist_identities((
                ("broad",0,"source-broad"),
                ("exactalias",1,"source-broad"),
                ("ownedalias",1,"source-broad"),
                ("exactalias",0,"source-exact"),
            ))
            scope.finalize_artist_targets({"source-broad"})
            self.assertEqual(
                scope.source_keys_for_group("artists","broad"),
                ("source-broad",),
            )
            self.assertEqual(
                scope.source_keys_for_group("artists","ownedalias"),
                ("source-broad",),
            )
            self.assertEqual(
                scope.source_keys_for_group("artists","exactalias"),
                (),
            )

    def test_snapshot_derived_song_source_uses_unknown_artist_owner_identity(self):
        title="From now on(short ver)/Fixture Original Song"
        artist="\u672a\u8a18\u8f09"
        public_group=f"{pg_adapter._overlay_norm(title)}::{pg_adapter._overlay_norm(artist)}"
        source_key=pg_materializer._production_source_key(
            "songs","all",public_group,
        )
        pairs,targets=pg_materializer._derived_source_pairs(
            video_ids=("video-unknown",),
            song_pairs=((title,artist),),
            requested_keys={source_key},
        )
        self.assertEqual(pairs,{(source_key,"video-unknown")})
        self.assertEqual(targets,{(
            "songs",
            "\x1f".join((
                pg_adapter._overlay_song_group_norm(title),"unknown",
            )),
            source_key,
        )})
        candidate={
            "revision_id":"overlay","video_id":"video-unknown",
            "occurrence_id":"occ-unknown","position":1,"range_id":"all",
            "song_key":"song-unknown","seconds":10,
            "title":title,"artist":artist,"is_unknown_artist":True,
            "source_system":"fixture","video_title":"Unknown Artist Video",
            "channel_id":"UCfixture","channel_name":"Fixture",
            "occurrence_payload_json":{},"video_payload_json":{},
            "video_tombstone":False,
        }
        payload=pg_adapter._snapshot_materialized_source_payload(
            source_key,range_id="all",persisted_record=None,
            targets=tuple((view,group) for view,group,key in targets if key==source_key),
            video_scope=("video-unknown",),parent_occurrences=(),
            direct_video_rows=(),direct_occurrence_rows=(),
            candidate_rows=(candidate,),
            accepted_video_resets={"video-unknown":{"video_id":"video-unknown"}},
            runtime_changes=(),
        )
        self.assertTrue(payload["found"])
        self.assertEqual(payload["sourceKey"],source_key)
        self.assertEqual(payload["record"]["count"],1)

    def test_snapshot_symbol_only_song_source_keeps_nonempty_owner_identity(self):
        title="\u301c";artist=""
        public_group=f"{pg_adapter._overlay_norm(title)}::"
        source_key=pg_materializer._production_source_key(
            "songs","all",public_group,
        )
        pairs,targets=pg_materializer._derived_source_pairs(
            video_ids=("video-symbol-song",),
            song_pairs=((title,artist),),
            requested_keys={source_key},
        )
        self.assertEqual(pairs,{(source_key,"video-symbol-song")})
        self.assertEqual(targets,{(
            "songs",f"{pg_adapter._overlay_norm(title)}\x1funknown",source_key,
        )})
        candidate={
            "revision_id":"overlay","video_id":"video-symbol-song",
            "occurrence_id":"occ-symbol-song","position":1,
            "range_id":"all","song_key":"symbol-song","seconds":10,
            "title":title,"artist":artist,"source_system":"fixture",
            "video_title":"Symbol Song Video","channel_id":"UCfixture",
            "channel_name":"Fixture","occurrence_payload_json":{},
            "video_payload_json":{},"video_tombstone":False,
        }
        payload=pg_adapter._snapshot_materialized_source_payload(
            source_key,range_id="all",persisted_record=None,
            targets=tuple((view,group) for view,group,key in targets if key==source_key),
            video_scope=("video-symbol-song",),parent_occurrences=(),
            direct_video_rows=(),direct_occurrence_rows=(),
            candidate_rows=(candidate,),
            accepted_video_resets={
                "video-symbol-song":{"video_id":"video-symbol-song"},
            },
            runtime_changes=(),
        )
        self.assertTrue(payload["found"])
        self.assertEqual(payload["sourceKey"],source_key)
        self.assertEqual(payload["record"]["count"],1)

    def test_snapshot_artist_scope_rejects_ambiguous_alias_only_owner(self):
        with closing(sqlite3.connect(":memory:")) as database:
            scope=pg_materializer.SnapshotSourceScope(database)
            scope.add_artist_identities((
                ("sharedalias",1,"source-one"),
                ("sharedalias",1,"source-two"),
            ))
            with self.assertRaisesRegex(
                RuntimeError,"multiple canonical owners",
            ):
                scope.finalize_artist_targets({"source-one"})

    def test_snapshot_source_scope_marks_only_intersecting_sources_affected(self):
        with closing(sqlite3.connect(":memory:")) as database:
            scope=pg_materializer.SnapshotSourceScope(database)
            scope.add_videos(("video-affected",))
            scope.add_pairs((
                ("source-affected","video-affected"),
                ("source-affected","video-clean"),
                ("source-clean","video-clean"),
            ))
            self.assertEqual(scope.affected_source_keys(),("source-affected",))

    def test_snapshot_stream_cursor_honors_small_payload_batch(self):
        class Cursor:
            def __init__(self):
                self.itersize=None;self.description=[("payload_json",)];self.sizes=[]
                self.rows=[("x"*1024,), ("y"*1024,), ("z"*1024,)];self.closed=False
            def execute(self,_statement,_params):pass
            def fetchmany(self,size):
                self.sizes.append(size);batch=self.rows[:size];self.rows=self.rows[size:];return batch
            def close(self):self.closed=True
        cursor=Cursor()
        connection=SimpleNamespace(autocommit=False,cursor=lambda **_kwargs:cursor)
        rows=list(pg_materializer._stream_pg_rows(
            connection,"payloads","SELECT payload_json",[],fetch_size=2,
        ))
        self.assertEqual([row["payload_json"] for row in rows],["x"*1024,"y"*1024,"z"*1024])
        self.assertEqual(cursor.itersize,2)
        self.assertEqual(cursor.sizes,[2,2,2])
        self.assertTrue(cursor.closed)

    def test_snapshot_runtime_scope_treats_explicit_null_artist_as_empty(self):
        explicit=pg_materializer._runtime_scope_evidence({
            "videoId":"video-explicit","title":"No Artist","artist":None,
        })
        missing=pg_materializer._runtime_scope_evidence({
            "videoId":"video-missing","title":"No Artist",
        })
        self.assertIn(("No Artist",""),explicit[1])
        self.assertEqual(missing[1],set())

    def test_snapshot_render_limits_previews_before_json_hydration(self):
        records=[{"type":"video","key":"video-card","occurrences":[
            {"videoId":f"video-{index}","occurrenceId":f"occ-{index}",
             "position":index,"item":{"videoId":f"video-{index}"}}
            for index in range(20)
        ]}]
        prepared={"filtered":[{"detail_key":"video-card","row_count":20,
                              "song_count":20,"video_count":20,
                              "timestamp_count":20}],
                  "metadata":[],"candidateRows":[],"parentRevisionId":"parent",
                  "overlayRevisionIds":(),"aggregateTotals":{"totalCount":1,
                  "totalOccurrenceCount":20,"totalSongCount":20,"totalVideoCount":20}}
        hydrated=[]
        with patch.object(pg_adapter,"_hydrated_generic_ranking_payload",
                          return_value=records[0]), \
             patch.object(pg_adapter,"_hydrate_overlay_page_previews",
                          side_effect=lambda _connection,_candidates,payloads:
                          hydrated.extend(copy.deepcopy(payloads))), \
             patch.object(pg_adapter,"_hydrate_runtime_ranking_song_previews"):
            response=pg_adapter._render_generic_overlay_rankings(
                object(),"active",prepared,
                {"range":"all","view":"videos","metric":"occurrences",
                 "page":"1","pageSize":"30"},preview_hydration_limit=3,
            )
        self.assertEqual(len(hydrated),1)
        self.assertEqual(
            [item["videoId"] for item in hydrated[0]["occurrences"]],
            ["video-0","video-1","video-2"],
        )
        self.assertEqual(response["totalCount"],1)

    def test_snapshot_render_bulk_hydrates_one_page_in_one_query(self):
        filtered=[
            {"row_id":"row-one","detail_key":"video-one","row_count":2,"song_count":2,
             "video_count":1,"timestamp_count":2,"payload_json":None},
            {"row_id":"row-two","detail_key":"video-two","row_count":1,"song_count":1,
             "video_count":1,"timestamp_count":1,"payload_json":None},
            {"detail_key":"video-overlay","row_count":1,"song_count":1,
             "video_count":1,"timestamp_count":1,"payload_json":None},
            {"detail_key":"video-new","row_count":1,"song_count":1,
             "video_count":1,"timestamp_count":1,"payload_json":None},
        ]
        prepared={
            "filtered":filtered,"metadata":[],"candidateRows":[],
            "parentRevisionId":"parent","overlayRevisionIds":(),
            "snapshotBulkHydrateCards":True,
            "aggregateTotals":{"totalCount":4,"totalOccurrenceCount":5,
                               "totalSongCount":5,"totalVideoCount":4},
        }
        payloads={
            "video-one":{"type":"video","key":"video-one",
                         "videoId":"video-one","title":"One",
                         "occurrences":[]},
            "video-two":{"type":"video","key":"video-two",
                         "videoId":"video-two","title":"Two",
                         "occurrences":[]},
            "video-overlay":{"type":"video","key":"video-overlay",
                             "videoId":"video-overlay","title":"Overlay",
                             "occurrences":[]},
            "video-new":{"type":"video","key":"video-new",
                         "videoId":"video-new","title":"New",
                         "occurrences":[]},
        }

        def fake_rows(_connection,statement,params):
            if "bulk generic ranking page payload hydration" in statement:
                self.assertEqual(
                    params,
                    ["parent",["row-one","row-two"],
                     "all","videos","count","all"],
                )
                return [
                    {"row_id":row_id,"detail_key":detail_key,
                     "payload_json":payloads[detail_key]}
                    for row_id,detail_key in reversed([
                        ("row-one","video-one"),("row-two","video-two")
                    ])
                ]
            self.assertIn(
                "bulk generic ranking page detail payload hydration",statement,
            )
            self.assertEqual(
                params,
                ["parent","all","videos","count","all",
                 ["video-overlay","video-new"]],
            )
            return [{"detail_key":"video-overlay",
                     "payload_json":payloads["video-overlay"]}]

        with patch.object(pg_adapter,"_rows",side_effect=fake_rows) as rows, \
             patch.object(pg_adapter,"_one",return_value={
                 "payload_json":payloads["video-new"]
             }) as exact, \
             patch.object(pg_adapter,"_hydrate_overlay_page_previews"), \
             patch.object(pg_adapter,"_hydrate_runtime_ranking_song_previews"):
            response=pg_adapter._render_generic_overlay_rankings(
                object(),"active",prepared,
                {"range":"all","view":"videos","metric":"occurrences",
                 "page":"1","pageSize":"30"},
                preview_hydration_limit=3,
            )
        self.assertEqual(rows.call_count,2)
        exact.assert_called_once()
        self.assertEqual(
            exact.call_args.args[2][-1],"video-new",
        )
        self.assertEqual(
            [record["videoId"] for record in response["records"]],
            ["video-one","video-two","video-overlay","video-new"],
        )
        self.assertEqual(
            [record["rank"] for record in response["records"]],[1,2,3,4],
        )

    def test_complete_parent_window_recomputes_final_canonical_totals(self):
        filtered=[
            {"detail_key":"artist-one","row_count":3,"song_count":2,
             "video_count":2,"timestamp_count":3,"payload_json":{}},
            {"detail_key":"artist-two","row_count":1,"song_count":1,
             "video_count":1,"timestamp_count":1,"payload_json":{}},
        ]
        self.assertEqual(
            pg_adapter._final_generic_aggregate_totals(filtered),
            {"totalCount":2,"totalOccurrenceCount":4,
             "totalSongCount":3,"totalVideoCount":3},
        )
        prepared={
            "filtered":filtered,"metadata":[],"candidateRows":[],
            "parentRevisionId":"parent","overlayRevisionIds":(),
        }
        hydrated={
            "type":"artist","key":"artist","name":"Artist",
            "sourceDetailKey":"source","occurrences":[],
        }
        prepared["aggregateTotals"]={
            "totalCount":2,"totalOccurrenceCount":4,
            "totalSongCount":3,"totalVideoCount":3,
        }
        with patch.object(
            pg_adapter,"_hydrated_generic_ranking_payload",
            return_value=hydrated,
        ), patch.object(pg_adapter,"_hydrate_overlay_page_previews"), \
             patch.object(pg_adapter,"_hydrate_runtime_ranking_song_previews"):
            response=pg_adapter._render_generic_overlay_rankings(
                object(),"active",prepared,
                {"range":"all","view":"artists","metric":"occurrences",
                 "page":"1","pageSize":"30"},
            )
        self.assertEqual(
            (response["totalCount"],response["totalOccurrenceCount"],
             response["totalSongCount"],response["totalVideoCount"]),
            (2,4,3,3),
        )

    def test_snapshot_rejects_incomplete_ranking_page_series(self):
        pg_materializer.validate_complete_ranking_series(
            "all/artists/count/all",11152,11152,
        )
        with self.assertRaisesRegex(
            RuntimeError,
            "all/artists/count/all expected=11154 actual=11152",
        ):
            pg_materializer.validate_complete_ranking_series(
                "all/artists/count/all",11154,11152,
            )

    def test_snapshot_builder_enables_pre_hydration_preview_limit(self):
        builder=pg_materializer.SnapshotPageBuilder.__new__(
            pg_materializer.SnapshotPageBuilder
        )
        builder.connection=object()
        builder.runtime=None
        builder.generic_runtime=("active",{})
        builder.parent=("parent",{})
        builder.overlay_ids=("overlay",)
        builder.authoritative_ids=()
        builder.authoritative_records=None
        builder.reconciliation_counts={}
        builder.snapshot_reset_changes={}
        builder.snapshot_original_group_counts={}
        builder.snapshot_vtuber_source_totals={}
        rendered={"records":[]}
        with patch.object(pg_adapter,"_prepare_generic_overlay_rankings",
                          return_value={}) as prepare, \
             patch.object(pg_adapter,"_render_generic_overlay_rankings",
                          return_value=rendered) as render, \
             patch.object(pg_adapter,"_project_generic_overlay_video_records",
                          side_effect=lambda _connection,_overlays,response,**_kwargs:
                          response):
            response=builder.build_combo("all","videos","occurrences")(1)
        self.assertIs(response,rendered)
        self.assertEqual(
            render.call_args.kwargs["preview_hydration_limit"],
            pg_adapter.MAX_RANKING_PREVIEW_VIDEOS,
        )
        self.assertIs(
            prepare.call_args.kwargs["snapshot_vtuber_source_totals"],
            builder.snapshot_vtuber_source_totals,
        )

    def test_exact_vtuber_scalar_fallback_uses_production_source_key(self):
        channel_id="UCDqno_7LWobowaVc_vzUuCA"
        legacy=pg_adapter._stable_key("source-vtuber","all",channel_id)
        production=pg_adapter._production_source_detail_key_for_group(
            "vtubers","all",channel_id,
        )
        self.assertEqual(legacy,"00395b9c210d91cd5d6eae1f")
        self.assertEqual(production,"dc6aa541a6dff484")
        self.assertNotEqual(legacy,production)
        self.assertEqual(
            pg_adapter._exact_vtuber_source_detail_key({},"all",channel_id),
            production,
        )

    def test_exact_vtuber_scalar_keeps_explicit_parent_source_key(self):
        self.assertEqual(
            pg_adapter._exact_vtuber_source_detail_key(
                {"sourceDetailKey":"parent-source"},"all","UCfixture",
            ),
            "parent-source",
        )

    def test_scoped_vtuber_parent_sources_resolve_unfiltered_authority(self):
        entering="UCentering";existing="UCexisting"
        rows=[
            {"detail_key":entering,"payload_json":{
                "channelId":entering,"sourceDetailKey":"source-entering",
            }},
            {"detail_key":existing,"payload_json":{
                "channelId":existing,"sourceDetailKey":"source-existing",
            }},
        ]
        with patch.object(pg_adapter,"_rows",return_value=rows) as queried:
            resolved=pg_adapter._resolved_vtuber_parent_sources(
                object(),"parent",{entering,existing},"all",
                {existing:{"detail_key":existing,"payload_json":{
                    "sourceDetailKey":"source-existing",
                }}},
            )
        self.assertEqual(resolved,{
            entering:"source-entering",existing:"source-existing",
        })
        statement=" ".join(queried.call_args.args[1].split())
        params=queried.call_args.args[2]
        self.assertIn("scope_key = 'all'",statement)
        self.assertIn("detail_key = ANY",statement)
        self.assertEqual(params[:2],["parent","all"])
        self.assertEqual(set(params[2]),{entering,existing})

    def test_scoped_vtuber_parent_sources_fail_closed_on_missing_base_authority(self):
        channel="UCfixture"
        with patch.object(pg_adapter,"_rows",return_value=[]), \
             self.assertRaisesRegex(
                 pg_adapter.PostgresAdapterError,
                 "scoped parent source coverage is incomplete",
             ):
            pg_adapter._resolved_vtuber_parent_sources(
                object(),"parent",{channel},"all",
                {channel:{"detail_key":channel,"payload_json":{}}},
            )

    def test_vtuber_canonical_song_identity_matches_runtime_builder_variants(self):
        base=pg_adapter._vtuber_canonical_song_identity("前前前世")
        self.assertEqual(
            pg_adapter._vtuber_canonical_song_identity("前前前世 -Piano Ver"),
            base,
        )
        self.assertEqual(
            pg_adapter._vtuber_canonical_song_identity("33曲目 前前前世"),
            base,
        )
        self.assertNotEqual(
            pg_adapter._vtuber_canonical_song_identity("前前前世 Remix")[1],
            base[1],
        )
        self.assertEqual(
            pg_adapter._vtuber_canonical_song_identity(
                "034,2:44:26 可愛くてごめん"
            ),
            ("可愛くてごめん","可愛くてごめん"),
        )
        self.assertEqual(
            pg_adapter._vtuber_canonical_song_identity(
                "とても素敵な六月でした"
            ),
            ("とても素敵な六月でした","とても素敵な6月でした"),
        )
        self.assertEqual(
            pg_adapter._vtuber_canonical_song_identity("八月、某、月明かり"),
            ("八月、某、月明かり","8月某月明かり"),
        )
        self.assertEqual(
            pg_adapter._vtuber_canonical_song_identity("1,000,000 TIMES"),
            ("TIMES","times"),
        )

    def test_overlay_source_record_drops_titleless_curation_candidate(self):
        row={
            "video_id":"video-empty","occurrence_id":"occ-empty",
            "range_id":"all","song_key":"candidate-key",
            "title":None,"artist":None,"source_system":"youtube_channel_discovery",
            "occurrence_payload_json":{
                "videoId":"video-empty","occurrenceId":"occ-empty",
                "rangeId":"all","songKey":"candidate-key",
                "title":None,"artist":None,
                "curationCandidate":{
                    "flags":["missing_artist_candidate"],"identity":None,
                },
            },
        }
        self.assertIsNone(pg_adapter._overlay_source_record(row))

    def test_overlay_source_record_keeps_title_with_explicit_null_artist(self):
        row={
            "video_id":"video-song","occurrence_id":"occ-song",
            "range_id":"all","song_key":"song-key",
            "title":"Song Title","artist":None,
            "occurrence_payload_json":{
                "videoId":"video-song","occurrenceId":"occ-song",
                "rangeId":"all","songKey":"song-key",
                "title":"Song Title","artist":None,
            },
        }
        record=pg_adapter._overlay_source_record(row)
        self.assertIsNotNone(record)
        self.assertEqual(record["occurrences"][0]["title"],"Song Title")
        self.assertIsNone(record["occurrences"][0]["artist"])

    def test_vtuber_parent_source_keeps_titleless_video_without_song_key(self):
        records=({
            "video":{"videoId":"video-parent"},
            "occurrences":({
                "videoId":"video-parent","occurrenceId":"occ-parent",
                "rangeId":"all","title":"","artist":"",
            },),
        },)
        payload={
            "schemaVersion":1,"found":True,"sourceKey":"source-parent",
            "totalOccurrenceCount":1,"record":{"type":"vtuber"},
        }
        result=pg_adapter._canonicalize_vtuber_source_payload(
            payload,records,{"range":"all"},
        )
        self.assertEqual(result["totalOccurrenceCount"],1)
        self.assertEqual(result["totalSongCount"],0)
        self.assertEqual(result["record"]["songCount"],0)
        self.assertEqual(result["record"]["songs"],[])

    def test_vtuber_parent_source_fails_closed_without_video_identity(self):
        records=({
            "video":{"videoId":""},
            "occurrences":({
                "videoId":"","occurrenceId":"occ-parent",
                "rangeId":"all","title":"","artist":"",
            },),
        },)
        payload={
            "schemaVersion":1,"found":True,"sourceKey":"source-parent",
            "totalOccurrenceCount":1,"record":{"type":"vtuber"},
        }
        with self.assertRaisesRegex(
            pg_adapter.PostgresAdapterError,
            "missing video identity: sourceKey=source-parent videoId=-",
        ):
            pg_adapter._canonicalize_vtuber_source_payload(
                payload,records,{"range":"all"},
            )

    def test_vtuber_parent_source_reads_legacy_nested_song_identity(self):
        records=({
            "video":{"videoId":"video-parent"},
            "occurrences":({
                "videoId":"video-parent","occurrenceId":"occ-parent",
                "rangeId":"all",
                "song":{"title":"Nested Song","artist":"Nested Artist"},
            },),
        },)
        payload={
            "schemaVersion":1,"found":True,"sourceKey":"source-parent",
            "totalOccurrenceCount":1,"record":{"type":"vtuber"},
        }
        result=pg_adapter._canonicalize_vtuber_source_payload(
            payload,records,{"range":"all"},
        )
        self.assertEqual(result["totalSongCount"],1)
        self.assertEqual(result["record"]["songCount"],1)
        self.assertEqual(result["record"]["songs"],[{
            "key":"nestedsong","name":"Nested Song","count":1,
        }])

    def test_vtuber_symbol_only_title_counts_occurrence_without_song_key(self):
        records=({
            "video":{"videoId":"video-symbol"},
            "occurrences":({
                "videoId":"video-symbol","occurrenceId":"occ-symbol",
                "rangeId":"all","title":"\uff0b\u2642",
                "artist":"GigaP feat. Kagamine Len",
            },),
        },)
        payload={
            "schemaVersion":1,"found":True,"sourceKey":"source-symbol",
            "totalOccurrenceCount":1,
            "record":{"type":"vtuber","count":1,"songCount":1},
        }
        result=pg_adapter._canonicalize_vtuber_source_payload(
            payload,records,{"range":"all"},
        )
        self.assertEqual(result["totalSongCount"],0)
        self.assertEqual(result["record"]["songCount"],0)
        self.assertEqual(result["record"]["songs"],[])

    def test_vtuber_emoji_only_title_counts_occurrence_without_song_key(self):
        records=({
            "video":{"videoId":"1IFO9Ol3q04"},
            "occurrences":({
                "videoId":"1IFO9Ol3q04","rangeId":"all",
                "song":{"title":"💙🌷","artist":"未記載"},
            },),
        },)
        payload={
            "schemaVersion":1,"found":True,"sourceKey":"4aeb337b6762836f",
            "totalOccurrenceCount":1,
            "record":{"type":"vtuber","count":1,"songCount":1},
        }
        result=pg_adapter._canonicalize_vtuber_source_payload(
            payload,records,{"range":"all"},
        )
        self.assertEqual(result["totalOccurrenceCount"],1)
        self.assertEqual(result["totalSongCount"],0)
        self.assertEqual(result["record"]["songCount"],0)
        self.assertEqual(result["record"]["songs"],[])

    def test_selected_full_reset_projects_physical_7d_to_all_once(self):
        reset={"video-one":{"video_id":"video-one"}}
        all_row={"video_id":"video-one","occurrence_id":"same","range_id":"all",
                 "song_key":"song","title":"All","occurrence_payload_json":{}}
        seven_row={"video_id":"video-one","occurrence_id":"same","range_id":"7d",
                   "song_key":"song","title":"Seven","occurrence_payload_json":{}}
        seven_new={"video_id":"video-one","occurrence_id":"new","range_id":"7d",
                   "song_key":"new","title":"New","occurrence_payload_json":{}}
        with patch.object(
            pg_adapter,"_overlay_candidate_rows",
            side_effect=[(all_row,),(seven_row,seven_new)],
        ) as candidates:
            rows=pg_adapter._selected_full_reset_candidate_rows(
                object(),("overlay",),reset,"all",
            )
        self.assertEqual(candidates.call_count,2)
        self.assertEqual(
            [(row["occurrence_id"],row["range_id"],row["title"]) for row in rows],
            [("same","all","All"),("new","all","New")],
        )

    def test_selected_full_reset_video_source_projects_nested_range_to_all(self):
        video_id="tZ-UM1BYNas"
        source_key=pg_adapter._stable_key("source-video","all",video_id)
        self.assertEqual(source_key,"003f298aac93675b4654253d")
        physical={
            "revision_id":"overlay","video_id":video_id,
            "occurrence_id":"occ-7d","position":0,"range_id":"7d",
            "song_key":"song-7d","seconds":7,"title":"Song",
            "artist":"Artist","source_id":"source","raw_hash":"raw",
            "source_system":"fixture",
            "occurrence_payload_json":{"payload":{
                "videoId":video_id,"occurrenceId":"occ-7d",
                "position":0,"rangeId":"7d","songKey":"song-7d",
                "seconds":7,"title":"Song","artist":"Artist",
            }},
            "video_title":"Physical 7d Video","channel_name":"Fixture",
            "channel_id":"UCfixture","channel_handle":"@fixture",
            "channel_url":"","published_at":0,
            "video_payload_json":{"payload":{
                "videoId":video_id,"title":"Physical 7d Video",
                "channelId":"UCfixture","channelName":"Fixture",
                "rangeId":"7d",
            }},
            "video_tombstone":False,
        }
        with patch.object(
            pg_adapter,"_overlay_candidate_rows",side_effect=[(),(physical,)],
        ):
            projected=pg_adapter._selected_full_reset_candidate_rows(
                object(),("overlay",),{video_id:{"video_id":video_id}},"all",
            )
        self.assertEqual(len(projected),1)
        self.assertEqual(projected[0]["range_id"],"all")
        self.assertEqual(
            projected[0]["occurrence_payload_json"]["payload"]["rangeId"],
            "all",
        )
        self.assertEqual(
            projected[0]["video_payload_json"]["payload"]["rangeId"],
            "all",
        )
        with patch.object(pg_adapter,"_runtime_source_occurrences",return_value=[]), \
             patch.object(pg_adapter,"_rows",return_value=[]):
            result=pg_adapter._generic_video_source_payload(
                object(),"parent",None,source_key,
                {"range":"all","page":"1","pageSize":"200"},
                ("overlay",),projected,{video_id:{"video_id":video_id}},(),
                snapshot_video_scope=(video_id,),
            )
        self.assertTrue(result["found"])
        self.assertEqual(result["sourceKey"],source_key)
        self.assertEqual(result["record"]["sourceDetailKey"],source_key)
        self.assertEqual(result["record"]["rangeId"],"all")
        self.assertEqual(
            result["record"]["occurrences"][0]["rangeId"],"all",
        )

    def test_selected_full_reset_excludes_empty_runtime_song_without_hydration(self):
        resets={"video-good":{},"video-missing":{}}
        good={"video_id":"video-good","occurrence_id":"good","range_id":"all",
              "song_key":"good","title":"Good","occurrence_payload_json":None}
        missing={"video_id":"video-missing","occurrence_id":"missing","range_id":"all",
                 "song_key":"missing","title":"","occurrence_payload_json":None}
        with patch.object(
            pg_adapter,"_overlay_candidate_rows",
            side_effect=[(good,missing),()],
        ) as candidates:
            rows=pg_adapter._selected_full_reset_candidate_rows(
                object(),("overlay",),resets,"all",include_payload=False,
            )
        self.assertEqual(candidates.call_count,2)
        self.assertEqual([row["occurrence_id"] for row in rows],["good"])

    def test_selected_full_reset_excludes_empty_runtime_song_after_hydration(self):
        empty={"video_id":"video-empty","occurrence_id":"empty","range_id":"all",
               "song_key":"reviewed","title":"","occurrence_payload_json":None}
        with patch.object(
            pg_adapter,"_overlay_candidate_rows",
            side_effect=[(empty,),()],
        ):
            rows=pg_adapter._selected_full_reset_candidate_rows(
                object(),("overlay",),{"video-empty":{}},"all",include_payload=False,
            )
        self.assertEqual(rows,())

    def test_overlay_scope_membership_matches_persisted_four_scope_contract(self):
        known={"artist":"Artist","is_niche_value":"false",
               "is_unknown_artist_value":"false"}
        niche={"artist":"Artist","is_niche_value":"true",
               "is_unknown_artist_value":"false"}
        unknown={"artist":"Unknown","is_niche_value":"false",
                 "is_unknown_artist_value":"true"}
        legacy_unknown={"artist":"\u672a\u8a18\u8f09","is_niche_value":None,
                        "is_unknown_artist_value":None}
        def options(niche_only=False,hide=False):
            return {"nicheOnly":niche_only,"hideUnknownArtist":hide}
        self.assertTrue(pg_adapter._occurrence_matches_ranking_scope(
            known,options(),
        ))
        self.assertFalse(pg_adapter._occurrence_matches_ranking_scope(
            known,options(True),
        ))
        self.assertTrue(pg_adapter._occurrence_matches_ranking_scope(
            niche,options(True),
        ))
        self.assertFalse(pg_adapter._occurrence_matches_ranking_scope(
            unknown,options(False,True),
        ))
        self.assertFalse(pg_adapter._occurrence_matches_ranking_scope(
            legacy_unknown,options(False,True),
        ))
        with self.assertRaisesRegex(
            pg_adapter.PostgresAdapterError,"isNiche flag is invalid",
        ):
            pg_adapter._occurrence_matches_ranking_scope(
                {"artist":"Artist","is_niche_value":"maybe"},options(),
            )

    def test_direct_vtuber_preview_query_binds_scope_filters(self):
        with patch.object(pg_adapter,"_rows",return_value=[]) as rows:
            result=pg_adapter._bounded_direct_overlay_vtuber_previews(
                object(),("overlay",),("UCfixture",),"all",
                niche_only=True,hide_unknown_artist=True,
            )
        self.assertEqual(result,{})
        statement=rows.call_args.args[1]
        params=rows.call_args.args[2]
        self.assertIn("payload_json->>'isNiche'",statement)
        self.assertIn("lower(btrim(coalesce(occurrence.artist, '')))",statement)
        self.assertEqual(params[-4:-1],[True,True,sorted(pg_adapter._UNKNOWN_ARTIST_NAMES)])

    def test_persisted_vtuber_song_delta_preserves_canonical_parent_multiset(self):
        parent={"count":3,"songCount":2,"songs":[
            {"key":"songa","name":"Song A","count":2},
            {"key":"songb","name":"Song B","count":1},
        ]}
        before=[
            {"video":{"videoId":"v1"},"occurrences":({"occurrenceId":"o1","rangeId":"all","title":"Song A"},)},
            {"video":{"videoId":"v2"},"occurrences":({"occurrenceId":"o2","rangeId":"all","title":"Song A"},
                                                        {"occurrenceId":"o3","rangeId":"all","title":"Song B"},)},
        ]
        after=[
            {"video":{"videoId":"v1"},"occurrences":({"occurrenceId":"o1","rangeId":"all","title":"Song A"},)},
            {"video":{"videoId":"v3"},"occurrences":({"occurrenceId":"o4","rangeId":"all","title":"Song C"},
                                                        {"occurrenceId":"o5","rangeId":"all","title":"Song C -Piano Ver"},)},
        ]
        payload={"found":True,"totalOccurrenceCount":3,"record":{}}
        result=pg_adapter._apply_persisted_vtuber_song_delta(
            payload,parent,before,after,{"range":"all","page":"1","pageSize":"30"},
        )
        self.assertEqual(result["record"]["songCount"],2)
        self.assertEqual(
            [(item["key"],item["count"]) for item in result["record"]["songs"]],
            [("songc",2),("songa",1)],
        )
        self.assertEqual(sum(item["count"] for item in result["record"]["songs"]),3)

    def test_persisted_vtuber_song_delta_fails_closed_without_parent_multiset(self):
        records=[{"video":{"videoId":"v1"},"occurrences":({
            "occurrenceId":"o1","rangeId":"all","title":"Song A",
        },)}]
        payload={"found":True,"totalOccurrenceCount":1,"record":{}}
        with self.assertRaisesRegex(
            pg_adapter.PostgresAdapterError,
            "parent song counts do not cover authority",
        ):
            pg_adapter._apply_persisted_vtuber_song_delta(
                payload,{"count":1,"songs":[{"key":"bad","name":"Bad","count":2}]},
                records,records,
                {"range":"all","page":"1","pageSize":"30"},
            )

    def test_persisted_vtuber_song_delta_tracks_unkeyed_occurrences(self):
        parent={"count":2,"songCount":1,"songs":[
            {"key":"songa","name":"Song A","count":1},
        ]}
        before=[{"video":{"videoId":"v1"},"occurrences":(
            {"occurrenceId":"o1","rangeId":"all","title":"Song A"},
            {"occurrenceId":"o2","rangeId":"all","title":"○○○"},
        )}]
        after=[{"video":{"videoId":"v1"},"occurrences":(
            {"occurrenceId":"o1","rangeId":"all","title":"Song A"},
        )}]
        result=pg_adapter._apply_persisted_vtuber_song_delta(
            {"found":True,"totalOccurrenceCount":1,"record":{}},
            parent,before,after,{"range":"all","page":"1","pageSize":"30"},
        )
        self.assertEqual(result["record"]["songCount"],1)
        self.assertEqual(sum(item["count"] for item in result["record"]["songs"]),1)

    def test_persisted_vtuber_song_delta_preserves_duplicate_occurrence_id_counts(self):
        parent={"count":2,"songCount":1,"songs":[
            {"key":"songa","name":"Song A","count":2},
        ]}
        before=[{"video":{"videoId":"v1"},"occurrences":(
            {"occurrenceId":"duplicate","rangeId":"all","title":"Song A"},
            {"occurrenceId":"duplicate","rangeId":"all","title":"Song A"},
        )}]
        after=[{"video":{"videoId":"v1"},"occurrences":(
            {"occurrenceId":"duplicate","rangeId":"all","title":"Song A"},
            {"occurrenceId":"new","rangeId":"all","title":"Song B"},
        )}]
        result=pg_adapter._apply_persisted_vtuber_song_delta(
            {"found":True,"totalOccurrenceCount":2,"record":{}},
            parent,before,after,{"range":"all","page":"1","pageSize":"30"},
        )
        self.assertEqual(
            [(item["key"],item["count"]) for item in result["record"]["songs"]],
            [("songa",1),("songb",1)],
        )
        self.assertEqual(result["totalSongCount"],2)

    def test_authoritative_vtuber_summary_applies_source_delta_once(self):
        channel="UCfixture";source="source-fixture"
        detail={
            "channel_id":channel,"source_key":source,"entity_key":channel,
            "payload_json":{"count":3,"videoCount":3,"songCount":2,"songs":[
                {"key":"songa","name":"Song A","count":2},
                {"key":"songb","name":"Song B","count":1},
            ]},
        }
        totals={"source_key":source,"occurrence_count":3,"video_count":3}
        touched=[
            {"source_key":source,"position":1,"video_id":"v-reset","seconds":1,
             "payload_json":{"title":"Song A","artist":"Artist"}},
            {"source_key":source,"position":2,"video_id":"v-change","seconds":2,
             "payload_json":{"title":"Song B","artist":"Artist"}},
        ]
        preimage={"video_id":"v-change","occurrence_id":"old",
                  "seconds":2,"title":"Song B","artist":"Artist"}
        queries=[]
        def fake_rows(_connection,sql,_params):
            compact=" ".join(sql.split());queries.append(compact)
            if "parent details" in compact:return [detail]
            if "physical totals" in compact:return [totals]
            if "touched source rows" in compact:return touched
            if "occurrence preimages" in compact:return [preimage]
            self.fail(compact[:160])
        additions=[
            {"channel_id":channel,"video_id":"v-reset","title":"Song A",
             "canonical_title":"Song A","canonical_song_key":"songa"},
            {"channel_id":channel,"video_id":"v-new","title":"Song C",
             "canonical_title":"Song C","canonical_song_key":"songc"},
            {"channel_id":channel,"video_id":"v-change","title":"Song B -Piano Ver",
             "canonical_title":"Song B","canonical_song_key":"songb"},
        ]
        source_totals_cache={}
        with patch.object(pg_adapter,"_rows",side_effect=fake_rows):
            rows=pg_adapter._authoritative_vtuber_summary_rows(
                object(),"parent",{channel},{"v-reset"},{("v-change","old")},
                {channel:source},additions,"all",source_totals_cache,
            )
            cached_rows=pg_adapter._authoritative_vtuber_summary_rows(
                object(),"parent",{channel},{"v-reset"},{("v-change","old")},
                {channel:source},additions,"all",source_totals_cache,
            )
        self.assertEqual(len(rows),1)
        self.assertEqual(cached_rows,rows)
        self.assertEqual(
            (rows[0]["row_count"],rows[0]["video_count"],rows[0]["song_count"]),
            (4,4,3),
        )
        self.assertEqual(sum(item["count"] for item in rows[0]["songs"]),4)
        self.assertTrue(any("runtime_source_details" in sql for sql in queries))
        self.assertTrue(any("runtime_source_occurrences" in sql for sql in queries))
        self.assertEqual(
            sum("physical totals" in sql for sql in queries),1,
        )
        self.assertEqual(
            source_totals_cache,{("parent","all",source):(3,3)},
        )

    def test_authoritative_vtuber_summary_rejects_stale_cached_totals(self):
        channel="UCfixture";source="source-fixture"
        detail={
            "channel_id":channel,"source_key":source,"entity_key":channel,
            "payload_json":{"count":1,"videoCount":1,"songCount":1,"songs":[
                {"key":"songa","name":"Song A","count":1},
            ]},
        }
        def fake_rows(_connection,sql,_params):
            compact=" ".join(sql.split())
            if "parent details" in compact:return [detail]
            self.fail(f"cached totals unexpectedly queried SQL: {compact[:120]}")
        with patch.object(pg_adapter,"_rows",side_effect=fake_rows), \
             self.assertRaisesRegex(
                 pg_adapter.PostgresAdapterError,
                 "physical totals disagree with detail",
             ):
            pg_adapter._authoritative_vtuber_summary_rows(
                object(),"parent",{channel},set(),set(),{channel:source},(),"all",
                {("parent","all",source):(2,1)},
            )

    def test_authoritative_vtuber_scoped_summary_uses_physical_flags_and_canonical_titles(self):
        channel="UCfixture";source="source-fixture"
        detail={
            "channel_id":channel,"source_key":source,"entity_key":channel,
            "payload_json":{"count":3,"videoCount":2,"songCount":2,"songs":[
                {"key":"songa","name":"Song A","count":2},
                {"key":"songb","name":"Song B","count":1},
            ]},
        }
        physical={"source_key":source,"occurrence_count":3,"video_count":2}
        scoped_total={"source_key":source,"occurrence_count":1,"video_count":1}
        title={"source_key":source,"song_title":"Song A -Piano Ver",
               "occurrence_count":1}
        touched=[
            {"source_key":source,"position":1,"video_id":"v-change","seconds":1,
             "is_niche":False,"is_unknown_artist":False,
             "payload_json":{"title":"Song B","artist":"Artist"}},
        ]
        preimage={"video_id":"v-change","occurrence_id":"old","seconds":1,
                  "title":"Song B","artist":"Artist"}
        queries=[]
        def fake_rows(_connection,sql,_params):
            compact=" ".join(sql.split());queries.append(compact)
            if "parent details" in compact:return [detail]
            if "scoped authoritative VTuber physical totals" in compact:return [scoped_total]
            if "scoped authoritative VTuber canonical title counts" in compact:return [title]
            if "indexed authoritative VTuber physical totals" in compact:return [physical]
            if "touched source rows" in compact:return touched
            if "occurrence preimages" in compact:return [preimage]
            self.fail(compact[:180])
        addition={"channel_id":channel,"video_id":"v-new","title":"Song C",
                  "canonical_title":"Song C","canonical_song_key":"songc"}
        options=pg_adapter._query_options({
            "range":"all","view":"vtubers","metric":"occurrences",
            "nicheOnly":"1",
        })
        with patch.object(pg_adapter,"_rows",side_effect=fake_rows):
            rows=pg_adapter._authoritative_vtuber_summary_rows(
                object(),"parent",{channel},set(),{("v-change","old")},
                {channel:source},(addition,),"all",options=options,
            )
        self.assertEqual(
            (rows[0]["row_count"],rows[0]["video_count"],rows[0]["song_count"]),
            (2,2,2),
        )
        self.assertEqual(
            {item["key"]:item["count"] for item in rows[0]["songs"]},
            {"songa":1,"songc":1},
        )
        detail_query=next(sql for sql in queries if "parent details" in sql)
        self.assertIn("payload_json::jsonb - 'songs'",detail_query)
        self.assertIn("distinct_song_key_count",detail_query)

    def test_snapshot_vtuber_summary_replaces_song_arrays_with_bounded_search_text(self):
        channel="UCfixture";source="source-fixture"
        detail={
            "channel_id":channel,"source_key":source,"entity_key":channel,
            "payload_json":{"count":2,"videoCount":1,"songCount":2,"songs":[
                {"key":"songa","name":"Song Alpha","count":1},
                {"key":"songb","name":"Song Beta","count":1},
            ]},
        }
        physical={"source_key":source,"occurrence_count":2,"video_count":1}
        def fake_rows(_connection,sql,_params):
            compact=" ".join(sql.split())
            if "parent details" in compact:return [detail]
            if "physical totals" in compact:return [physical]
            if "touched source rows" in compact:return []
            self.fail(compact[:160])
        options=pg_adapter._query_options({
            "range":"all","view":"vtubers","metric":"occurrences",
        })
        options["_snapshotCompactCards"]=True
        options["_snapshotSongSearchMaxChars"]=12
        with patch.object(pg_adapter,"_rows",side_effect=fake_rows):
            rows=pg_adapter._authoritative_vtuber_summary_rows(
                object(),"parent",{channel},set(),set(),{channel:source},(),
                "all",options=options,
            )
        self.assertEqual(rows[0]["song_count"],2)
        self.assertNotIn("songs",rows[0])
        self.assertEqual(rows[0]["_snapshotSongSearchText"],"Song Alpha S")

    def test_snapshot_vtuber_exact_payload_keeps_private_song_search_only(self):
        channel_id="UCsnapshot";source_key="snapshot-source"
        candidate={
            "revision_id":"overlay","video_id":"video-scope",
            "occurrence_id":"occ-scope","position":0,"range_id":"all",
            "song_key":"song","seconds":1,"title":"Scoped Song",
            "artist":"Artist","source_id":"source","raw_hash":"raw",
            "source_system":"fixture","occurrence_payload_json":{},
            "video_title":"Video","channel_name":"Channel",
            "channel_id":channel_id,"channel_handle":"@channel",
            "channel_url":"","published_at":0,"video_payload_json":{},
            "video_tombstone":False,
        }
        options=pg_adapter._query_options({
            "range":"all","view":"vtubers","metric":"occurrences",
            "page":"1","pageSize":"30",
        })
        options["_snapshotCompactCards"]=True
        options["_snapshotSongSearchMaxChars"]=65_536
        summary={
            "channel_id":channel_id,"row_count":1,"song_count":1,
            "video_count":1,"residual_match":True,
            "_snapshotSongSearchText":"Scoped Song",
        }
        pg_adapter._VTUBER_REPLACEMENT_CACHE.clear()
        with patch.object(
            pg_adapter,"_authoritative_vtuber_summary_rows",return_value=[summary],
        ):
            rows=pg_adapter._overlay_vtuber_replacement_rows(
                SimpleNamespace(cursor=lambda:None),"active","parent",
                (candidate,),options,
                {channel_id:{
                    "detail_key":channel_id,"name":"Channel",
                    "payload_json":{
                        "sourceDetailKey":source_key,
                        "songs":[{"key":"old","name":"Old","count":1}],
                    },
                }},
                exact_required=True,
            )
        payload=rows[channel_id]["payload_json"]
        self.assertNotIn("songs",payload)
        self.assertEqual(payload["_snapshotSongSearchText"],"Scoped Song")
        self.assertIn("Scoped Song"," ".join(
            pg_materializer._flatten_scalars(payload)
        ))
        compact=pg_adapter.compact_vtuber_ranking_card(payload)
        self.assertNotIn("_snapshotSongSearchText",compact)

    def test_bounded_query_rows_streams_snapshot_batches_and_closes_cursor(self):
        columns=("source_key","song_title","occurrence_count")
        values=[("source-a","Song A",2),("source-b","Song B",1)]
        class StreamingCursor:
            def __init__(self):
                self.description=[(name,) for name in columns]
                self.offset=0;self.itersize=None;self.closed=False;self.executions=[]
            def execute(self,sql,params):self.executions.append((sql,list(params)))
            def fetchmany(self,size):
                batch=values[self.offset:self.offset+size];self.offset+=len(batch);return batch
            def close(self):self.closed=True
        cursor=StreamingCursor()
        class Connection:
            autocommit=False
            def cursor(self,*,name):
                self.name=name;return cursor
        connection=Connection()
        rows=list(pg_adapter._iter_bounded_query_rows(
            connection,"SELECT fixture",["value"],batch_size=1,
        ))
        self.assertEqual(rows,[
            {"source_key":"source-a","song_title":"Song A","occurrence_count":2},
            {"source_key":"source-b","song_title":"Song B","occurrence_count":1},
        ])
        self.assertEqual(cursor.itersize,1)
        self.assertEqual(cursor.executions,[("SELECT fixture",["value"])])
        self.assertTrue(cursor.closed)

    def test_authoritative_vtuber_summary_rejects_missing_preimage(self):
        channel="UCfixture";source="source-fixture"
        responses=[
            [{"channel_id":channel,"source_key":source,"entity_key":channel,
              "payload_json":{"count":1,"videoCount":1,"songCount":1,
                              "songs":[{"key":"songa","name":"Song A","count":1}]}}],
            [{"source_key":source,"occurrence_count":1,"video_count":1}],
            [{"source_key":source,"position":1,"video_id":"v-change","seconds":1,
              "payload_json":{"title":"Song A","artist":"Artist"}}],
            [],
        ]
        with patch.object(pg_adapter,"_rows",side_effect=responses), \
             self.assertRaisesRegex(pg_adapter.PostgresAdapterError,"preimage coverage is incomplete"):
            pg_adapter._authoritative_vtuber_summary_rows(
                object(),"parent",{channel},set(),{("v-change","missing")},
                {channel:source},(),"all",
            )

    def test_pg_vtuber_source_page_filters_physical_scope_and_canonicalizes_titles(self):
        calls=[]
        summary={"total_occurrence_count":2,"total_video_count":2,
                 "source_occurrence_count":4}
        page_rows=[{"video_id":"v1","first_position":1},
                   {"video_id":"v2","first_position":2}]
        occurrences=[
            {"position":1,"video_id":"v1","title":"Video 1",
             "channel_name":"Fixture","channel_id":"UCfixture",
             "channel_handle":"@fixture","channel_url":"","seconds":1,
             "is_niche":True,"is_unknown_artist":False,
             "payload_json":{"videoId":"v1","song":{"title":"Song A -Piano Ver","artist":"Artist"}}},
            {"position":2,"video_id":"v2","title":"Video 2",
             "channel_name":"Fixture","channel_id":"UCfixture",
             "channel_handle":"@fixture","channel_url":"","seconds":2,
             "is_niche":True,"is_unknown_artist":False,
             "payload_json":{"videoId":"v2","song":{"title":"Song A","artist":"Artist"}}},
        ]
        titles=[{"song_title":"Song A -Piano Ver","occurrence_count":1},
                {"song_title":"Song A","occurrence_count":1}]
        def fake_rows(_connection,sql,params):
            compact=" ".join(sql.split());calls.append((compact,list(params)))
            if "source_occurrence_count" in compact:return [summary]
            if "GROUP BY video_id" in compact:return page_rows
            if "WITH titled AS" in compact:return titles
            if "video_id = ANY" in compact:return occurrences
            self.fail(compact[:180])
        with patch.object(pg_adapter,"_rows",side_effect=fake_rows):
            result=pg_adapter._runtime_source_table_page(
                object(),"parent","source-fixture",
                {"range":"all","page":"1","pageSize":"30",
                 "nicheOnly":"1","hideUnknownArtist":"1"},
                entity_type="vtuber",
            )
        for statement,_params in calls:
            if "runtime_source_occurrences" in statement:
                self.assertIn("is_niche IS TRUE",statement)
                self.assertIn("is_unknown_artist IS NOT TRUE",statement)
        self.assertEqual(
            (result["totalOccurrenceCount"],result["totalSongCount"],
             result["totalVideoCount"]),(2,1,2),
        )
        self.assertEqual(result["record"]["songCount"],1)
        self.assertEqual(result["record"]["songs"],[
            {"key":"songa","name":"Song A","count":2},
        ])
        self.assertTrue(all(
            item.get("isNiche") is True
            and item.get("isUnknownArtist") is False
            for item in result["record"]["occurrences"]
        ))

    def test_vtuber_owned_changes_drop_only_unowned_noop(self):
        owned={
            "entityType":"runtime_occurrences","videoId":"video-owned",
            "occurrenceId":"occ-owned","channel_id":"UCfixture",
        }
        noop={
            "entityType":"runtime_occurrences","videoId":"video-noop",
            "occurrenceId":"occ-noop","rangeId":"all",
        }
        self.assertEqual(
            pg_adapter._vtuber_owned_overlay_changes((owned,noop)),
            (owned,),
        )

    def test_exact_vtuber_does_not_subtract_unowned_occurrence_noop(self):
        channel_id="UCfixture"
        candidate={
            "revision_id":"overlay","video_id":"video-owned",
            "occurrence_id":"occ-owned","position":0,"range_id":"all",
            "song_key":"song","seconds":1,"title":"Song",
            "artist":"Artist","source_id":"source","raw_hash":"raw",
            "source_system":"fixture","occurrence_payload_json":{},
            "video_title":"Video","channel_name":"Channel",
            "channel_id":channel_id,"channel_handle":"@channel",
            "channel_url":"","published_at":0,"video_payload_json":{},
            "video_tombstone":False,
        }
        noop={
            "entityType":"runtime_occurrences","videoId":"video-noop",
            "occurrenceId":"occ-noop","rangeId":"all",
            "title":"Not a VTuber source row","artist":"",
        }
        options=pg_adapter._query_options({
            "range":"all","view":"vtubers","metric":"occurrences",
            "page":"1","pageSize":"30",
        })
        summary={
            "channel_id":channel_id,"row_count":1,
            "song_count":1,"video_count":1,"residual_match":True,
        }
        captured={}
        def authority(
            _connection,_parent,_channels,_videos,occurrences,
            _sources,_candidates,_range_id,*,source_totals_cache=None,
            options=None,
        ):
            captured["occurrences"]=set(occurrences)
            captured["source_totals_cache"]=source_totals_cache
            captured["options"]=options
            return [summary]
        pg_adapter._VTUBER_REPLACEMENT_CACHE.clear()
        with patch.object(
            pg_adapter,"_authoritative_vtuber_summary_rows",
            side_effect=authority,
        ):
            rows=pg_adapter._overlay_vtuber_replacement_rows(
                SimpleNamespace(cursor=lambda:None),"active","parent",
                (candidate,),options,
                {channel_id:{
                    "detail_key":channel_id,"name":"Channel",
                    "payload_json":{"sourceDetailKey":"source-fixture"},
                }},
                runtime_changes=(noop,),exact_required=True,
                direct_overlay_revision_ids=("overlay",),
            )
        self.assertEqual(captured["occurrences"],set())
        self.assertIsNone(captured["source_totals_cache"])
        self.assertIs(captured["options"],options)
        self.assertEqual(rows[channel_id]["row_count"],1)

    def test_exact_vtuber_sql_reconciliation_uses_production_source_key(self):
        channel_id="UCDqno_7LWobowaVc_vzUuCA"
        video_id="IooUAo0J-B0"
        candidate={
            "revision_id":"overlay","video_id":video_id,
            "occurrence_id":"occ-one","position":0,"range_id":"7d",
            "song_key":"song","seconds":1,"title":"Song",
            "artist":"Artist","source_id":"source","raw_hash":"raw",
            "source_system":"fixture","occurrence_payload_json":{},
            "video_title":"Video","channel_name":"Channel",
            "channel_id":channel_id,"channel_handle":"@channel",
            "channel_url":"","published_at":0,"video_payload_json":{},
            "video_tombstone":False,
        }
        options=pg_adapter._query_options({
            "range":"all","view":"vtubers","metric":"occurrences",
            "page":"1","pageSize":"30",
        })
        summary={
            "channel_id":channel_id,"row_count":4238,
            "song_count":999,"video_count":294,"residual_match":True,
        }
        pg_adapter._VTUBER_REPLACEMENT_CACHE.clear()
        with patch.object(
            pg_adapter,"_authoritative_vtuber_summary_rows",return_value=[summary],
        ):
            rows=pg_adapter._overlay_vtuber_replacement_rows(
                SimpleNamespace(cursor=lambda:None),"active","parent",
                (candidate,),options,
                {channel_id:{"detail_key":channel_id,"name":"Channel",
                             "payload_json":None}},
                exact_required=True,
            )
        payload=rows[channel_id]["payload_json"]
        self.assertEqual(payload["sourceDetailKey"],"dc6aa541a6dff484")
        self.assertNotEqual(
            payload["sourceDetailKey"],
            pg_adapter._stable_key("source-vtuber","all",channel_id),
        )

    def test_exact_vtuber_scoped_channel_enters_from_unfiltered_parent_source(self):
        channel_id="UCscope-entering";source_key="source-scope-entering"
        candidate={
            "revision_id":"overlay","video_id":"video-scope",
            "occurrence_id":"occ-scope","position":0,"range_id":"all",
            "song_key":"song","seconds":1,"title":"Scoped Song",
            "artist":"Artist","source_id":"source","raw_hash":"raw",
            "source_system":"fixture","occurrence_payload_json":{},
            "is_niche_value":True,"is_unknown_artist_value":False,
            "video_title":"Video","channel_name":"Channel",
            "channel_id":channel_id,"channel_handle":"@channel",
            "channel_url":"","published_at":0,"video_payload_json":{},
            "video_tombstone":False,
        }
        options=pg_adapter._query_options({
            "range":"all","view":"vtubers","metric":"occurrences",
            "nicheOnly":"1","page":"1","pageSize":"30",
        })
        summary={
            "channel_id":channel_id,"row_count":1,"song_count":1,
            "video_count":1,"residual_match":True,
        }
        captured={}
        def resolve(_connection,_parent,channels,_range_id,base_groups):
            captured["resolved_channels"]=set(channels)
            captured["base_groups"]=dict(base_groups)
            return {channel_id:source_key}
        def authority(
            _connection,_parent,_channels,_videos,_occurrences,
            parent_sources,_candidates,_range_id,**_kwargs,
        ):
            captured["parent_sources"]=dict(parent_sources)
            return [summary]
        pg_adapter._VTUBER_REPLACEMENT_CACHE.clear()
        with patch.object(
            pg_adapter,"_resolved_vtuber_parent_sources",side_effect=resolve,
        ), patch.object(
            pg_adapter,"_authoritative_vtuber_summary_rows",side_effect=authority,
        ):
            rows=pg_adapter._overlay_vtuber_replacement_rows(
                SimpleNamespace(cursor=lambda:None),"active","parent",
                (candidate,),options,{},exact_required=True,
            )
        self.assertEqual(captured["resolved_channels"],{channel_id})
        self.assertEqual(captured["base_groups"],{})
        self.assertEqual(captured["parent_sources"],{channel_id:source_key})
        self.assertEqual(
            (rows[channel_id]["row_count"],rows[channel_id]["song_count"],
             rows[channel_id]["video_count"]),(1,1,1),
        )

    def test_reconciliation_adds_replacement_that_enters_filtered_scope(self):
        replacement={
            "video_id":"video-new","occurrence_id":"occ-new",
            "song_key":"song-new","title":"New Song","artist":"New Artist",
            "is_niche_value":True,
        }
        groups={
            "new artist":{
                "artist":"","name":"New Artist","row_count":0,
                "song_count":0,"video_count":0,
                "payload_json":{"name":"New Artist"},
            },
        }
        # The immutable old tuple was outside niche scope, so the caller
        # intentionally supplies no removal.  The final replacement must
        # still create the exact scoped aggregate.
        with patch.object(pg_adapter,"_rows",return_value=[]) as rows:
            pg_adapter._reconcile_affected_song_counts(
                object(),"parent",[],[replacement],[],groups,"artists",
                {"range":"all","nicheOnly":True},
            )
        self.assertEqual(rows.call_count,1)
        self.assertEqual(
            (groups["new artist"]["row_count"],
             groups["new artist"]["song_count"],
             groups["new artist"]["video_count"]),
            (1,1,1),
        )

    def test_snapshot_writer_periodically_evicts_only_its_temp_file(self):
        target=self.temp/"cache-drop.sqlite"
        writer=pg_materializer.CanonicalSnapshotWriter(target)
        with patch.object(pg_materializer,"SQLITE_CACHE_DROP_ROWS",2), \
             patch.object(pg_materializer,"_drop_clean_file_cache",return_value=True) as drop:
            writer._record_writes(1)
            writer._record_writes(1)
        drop.assert_called_once_with(writer.temp)
        self.assertEqual((writer.cache_drop_attempts,writer.cache_drop_count),(1,1))
        writer.abort()

    def test_snapshot_writer_waits_for_short_read_only_probe_lock(self):
        target=self.temp/"busy-timeout.sqlite"
        writer=pg_materializer.CanonicalSnapshotWriter(target)
        reader=None
        thread=None
        try:
            record={
                "rank":1,"key":"entity","sourceDetailKey":"source",
                "title":"Song","artist":"Artist","name":"Song",
                "count":1,"songCount":1,"videoCount":1,"timestampCount":1,
            }
            writer.add_ranking(pg_materializer._ranking_row(
                record,payload_record=record,range_id="all",view="songs",
                metric="occurrences",scope_key="all",expected_rank=1,
            ))
            self.assertEqual(
                writer.connection.execute("PRAGMA busy_timeout").fetchone()[0],
                pg_materializer.SQLITE_BUSY_TIMEOUT_MS,
            )
            reader=sqlite3.connect(writer.temp,timeout=1,check_same_thread=False)
            reader.execute("BEGIN")
            reader.execute("SELECT count(*) FROM ranking_rows").fetchone()
            def release_reader():
                time.sleep(0.05)
                reader.commit()
                reader.close()
            thread=threading.Thread(target=release_reader)
            thread.start()
            with patch.object(pg_materializer,"SQLITE_CHECKPOINT_ROWS",1):
                writer._record_writes(1)
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
        finally:
            if thread is not None and thread.is_alive():
                thread.join(timeout=2)
            if reader is not None:
                try:
                    reader.close()
                except sqlite3.Error:
                    pass
            writer.abort()

    def test_snapshot_source_search_update_uses_exact_lookup_index(self):
        target=self.temp/"source-lookup.sqlite"
        writer=pg_materializer.CanonicalSnapshotWriter(target)
        plan=writer.connection.execute(
            "EXPLAIN QUERY PLAN UPDATE ranking_rows "
            "INDEXED BY ranking_rows_source_lookup SET search_text=? "
            "WHERE range_id=? AND detail_key=?",
            ("fixture","all","source"),
        ).fetchall()
        detail=" ".join(str(column) for row in plan for column in row)
        self.assertIn("ranking_rows_source_lookup",detail)
        self.assertNotIn("SCAN ranking_rows",detail)
        writer.abort()

    def test_snapshot_writer_derives_metric_orders_from_canonical_rows(self):
        target=self.temp/"derived-rankings.sqlite"
        writer=pg_materializer.CanonicalSnapshotWriter(target)
        records=[
            {"rank":1,"key":"entity-zulu","sourceDetailKey":"source-zulu",
             "title":"Zulu","count":40,"songCount":1,"videoCount":4,
             "timestampCount":40,"deepSearchEvidence":"marker-zulu"},
            {"rank":2,"key":"entity-b","sourceDetailKey":"source-a",
             "title":"同名","count":30,"songCount":3,"videoCount":2,
             "timestampCount":30,"deepSearchEvidence":"marker-b"},
            {"rank":3,"key":"entity-a","sourceDetailKey":"source-z",
             "title":"同名","count":20,"songCount":3,"videoCount":1,
             "timestampCount":20,"deepSearchEvidence":"marker-a"},
            {"rank":4,"key":"entity-hana","sourceDetailKey":"source-hana",
             "title":"花","count":10,"songCount":2,"videoCount":5,
             "timestampCount":10,"deepSearchEvidence":"marker-hana"},
        ]
        try:
            for record in records:
                writer.add_ranking(pg_materializer._ranking_row(
                    record,
                    payload_record={**record,"occurrences":[{
                        "videoId":record["key"],"marker":record["deepSearchEvidence"],
                    }]},
                    range_id="all",view="songs",metric="occurrences",
                    scope_key="all",expected_rank=record["rank"],
                ))
            songs=list(writer.derive_ranking_metric_pages(
                range_id="all",view="songs",scope_key="all",
                source_metric="count",target_metric="songs",page_size=2,
            ))
            videos=list(writer.derive_ranking_metric_pages(
                range_id="all",view="songs",scope_key="all",
                source_metric="count",target_metric="videos",page_size=2,
            ))
            self.assertEqual([page for page,_records in songs],[1,2])
            self.assertEqual([page for page,_records in videos],[1,2])
            self.assertEqual(
                [record["sourceDetailKey"] for _page,page_records in songs
                 for record in page_records],
                ["source-z","source-a","source-hana","source-zulu"],
            )
            self.assertEqual(
                [record["sourceDetailKey"] for _page,page_records in videos
                 for record in page_records],
                ["source-hana","source-zulu","source-a","source-z"],
            )
            rows=writer.connection.execute(
                "SELECT metric,rank,detail_key,row_id,count,song_count,video_count,"
                "timestamp_count,payload_json,search_text,channel_search_text "
                "FROM ranking_rows ORDER BY metric,rank"
            ).fetchall()
            by_metric_detail={(row[0],row[2]):row for row in rows}
            for target_metric in ("songs","videos"):
                for source_record in records:
                    detail_key=source_record["sourceDetailKey"]
                    source=by_metric_detail[("count",detail_key)]
                    derived=by_metric_detail[(target_metric,detail_key)]
                    self.assertEqual(derived[4:8],source[4:8])
                    self.assertEqual(derived[9:11],source[9:11])
                    self.assertIn(source_record["deepSearchEvidence"],derived[9])
                    source_payload=json.loads(source[8])
                    derived_payload=json.loads(derived[8])
                    self.assertEqual(derived_payload["rank"],derived[1])
                    source_payload.pop("rank")
                    derived_payload.pop("rank")
                    self.assertEqual(derived_payload,source_payload)
                    self.assertEqual(
                        derived[3],
                        f"all:songs:{target_metric}:all:{derived[1]}:"
                        f"{source_record['key']}",
                    )
        finally:
            writer.abort()

    def test_snapshot_writer_metric_derivation_fails_closed_on_zero_scalar(self):
        target=self.temp/"derived-zero.sqlite"
        writer=pg_materializer.CanonicalSnapshotWriter(target)
        record={"rank":1,"key":"entity-zero","sourceDetailKey":"source-zero",
                "title":"Zero","count":1,"songCount":0,"videoCount":1,
                "timestampCount":1}
        try:
            writer.add_ranking(pg_materializer._ranking_row(
                record,payload_record=record,range_id="all",view="songs",
                metric="occurrences",scope_key="visible",expected_rank=1,
            ))
            with self.assertRaisesRegex(
                RuntimeError,"membership is not invariant",
            ):
                list(writer.derive_ranking_metric_pages(
                    range_id="all",view="songs",scope_key="visible",
                    source_metric="count",target_metric="songs",page_size=200,
                ))
            self.assertEqual(
                writer.connection.execute(
                    "SELECT count(*) FROM ranking_rows WHERE metric='songs'"
                ).fetchone()[0],0,
            )
            self.assertEqual(
                list(writer.derive_ranking_metric_pages(
                    range_id="7d",view="artists",scope_key="niche",
                    source_metric="count",target_metric="songs",page_size=200,
                )),
                [(1,())],
            )
        finally:
            writer.abort()

    def test_snapshot_writer_derives_filtered_scopes_from_canonical_sources(self):
        target=self.temp/"derived-filtered-scopes.sqlite"
        writer=pg_materializer.CanonicalSnapshotWriter(target)

        def add_fixture(view,source_key,entity_key,name,occurrences):
            canonical=[]
            video_ids=set()
            song_keys=set()
            for position,item in enumerate(occurrences,1):
                row=pg_materializer._source_occurrence_row(
                    source_key,"all",position,item,
                    entity_type="vtuber" if view=="vtubers" else view[:-1],
                )
                canonical.append(row)
                video_ids.add(row[3]);song_keys.add(row[13])
            record={"rank":1,"key":entity_key,"sourceDetailKey":source_key,
                    "title":name if view in {"songs","videos"} else "",
                    "name":name,"displayArtist":"Fixture",
                    "count":len(canonical),"songCount":len(song_keys),
                    "videoCount":len(video_ids),"timestampCount":len(canonical),
                    "occurrences":occurrences}
            existing=writer.connection.execute(
                "SELECT count(*) FROM ranking_rows WHERE range_id='all' "
                "AND view=? AND metric='count' AND scope_key='all'",(view,),
            ).fetchone()[0]
            record["rank"]=int(existing)+1
            compact=pg_adapter.compact_ranking_payloads([record],view)[0]
            writer.add_ranking(pg_materializer._ranking_row(
                record,payload_record=compact,range_id="all",view=view,
                metric="occurrences",scope_key="all",expected_rank=record["rank"],
            ))
            writer.add_source(
                source_key,"all",
                {"type":"vtuber" if view=="vtubers" else view[:-1],
                 "key":entity_key,"sourceDetailKey":source_key},
                occurrences,
            )

        artist_a=[
            {"videoId":"video-a","marker":"visible-niche-marker",
             "song":{"songKey":"song-a","title":"Song A","artist":"Artist A",
                     "isNiche":True,"isUnknownArtist":False}},
            {"videoId":"video-b","marker":"unknown-normal-excluded",
             "song":{"songKey":"song-b","title":"Song B","artist":"unknown",
                     "isNiche":False,"isUnknownArtist":True}},
            {"videoId":"video-c","marker":"unknown-niche-marker",
             "song":{"songKey":"song-c","title":"Song C","artist":"unknown",
                     "isNiche":True,"isUnknownArtist":True}},
        ]
        artist_b=[
            {"videoId":"video-d","marker":"visible-normal-marker",
             "song":{"songKey":"song-d","title":"Song D","artist":"Artist B",
                     "isNiche":False,"isUnknownArtist":False}},
        ]
        add_fixture("artists","source-artist-a","artist-a","Alpha",artist_a)
        add_fixture("artists","source-artist-b","artist-b","Beta",artist_b)
        for view in ("songs","vtubers","videos"):
            add_fixture(
                view,f"source-{view}",f"entity-{view}",view,
                [{"videoId":f"video-{view}","marker":f"visible-{view}",
                  "song":{"songKey":f"song-{view}","title":f"Song {view}",
                          "artist":"Fixture","isNiche":False,
                          "isUnknownArtist":False}}],
            )
        try:
            result=writer.derive_filtered_ranking_scopes(
                range_id="all",page_size=2,
            )
            self.assertEqual(len(result),36)
            self.assertEqual(result["all/artists/count/niche"],1)
            self.assertEqual(result["all/artists/count/visible"],2)
            self.assertEqual(result["all/artists/count/visibleNiche"],1)
            self.assertEqual(result["all/songs/count/niche"],0)
            self.assertEqual(result["all/songs/count/visible"],1)
            for metric in ("count","songs","videos"):
                self.assertEqual(result[f"all/artists/{metric}/niche"],1)
                self.assertEqual(result[f"all/artists/{metric}/visible"],2)
            visible=writer.connection.execute(
                "SELECT rank,detail_key,count,song_count,video_count,payload_json,"
                "search_text FROM ranking_rows WHERE range_id='all' "
                "AND view='artists' AND metric='count' AND scope_key='visible' "
                "ORDER BY rank"
            ).fetchall()
            self.assertEqual(
                [(row[0],row[1],row[2],row[3],row[4]) for row in visible],
                [(1,"source-artist-a",1,1,1),(2,"source-artist-b",1,1,1)],
            )
            payload=json.loads(visible[0][5])
            self.assertEqual(payload["songs"],[
                {"key":"song-a","name":"Song A","count":1},
            ])
            self.assertEqual(len(payload["occurrences"]),1)
            self.assertIn("visible-niche-marker",visible[0][6])
            self.assertNotIn("unknown-normal-excluded",visible[0][6])
            self.assertNotIn("unknown-niche-marker",visible[0][6])
            niche_payload,niche_search=writer.connection.execute(
                "SELECT payload_json,search_text FROM ranking_rows "
                "WHERE range_id='all' AND view='artists' AND metric='count' "
                "AND scope_key='niche' AND rank=1"
            ).fetchone()
            self.assertEqual(
                (json.loads(niche_payload)["count"],
                 json.loads(niche_payload)["songCount"],
                 json.loads(niche_payload)["videoCount"]),
                (2,2,2),
            )
            self.assertIn("unknown-niche-marker",niche_search)
            self.assertNotIn("unknown-normal-excluded",niche_search)
            self.assertEqual(
                writer.connection.execute(
                    "SELECT count(*) FROM temp.sqlite_temp_master "
                    "WHERE name LIKE 'filtered_ranking_%'"
                ).fetchone()[0],0,
            )
        finally:
            writer.abort()

    def test_snapshot_writer_uses_all_scope_song_name_for_filtered_variant(self):
        target = self.temp / "derived-filtered-canonical-song-name.sqlite"
        writer = pg_materializer.CanonicalSnapshotWriter(target)
        occurrences = [
            {
                "videoId": "variant-video-a",
                "song": {
                    "songKey": "shared-song-key",
                    "title": "Canonical Song",
                    "artist": "Fixture Artist",
                    "isNiche": False,
                    "isUnknownArtist": False,
                },
            },
            {
                "videoId": "variant-video-b",
                "song": {
                    "songKey": "shared-song-key",
                    "title": "Canonical Song (Piano Ver.)",
                    "artist": "Fixture Artist",
                    "isNiche": False,
                    "isUnknownArtist": False,
                },
            },
        ]
        source_key = "source-artist-variant"
        record = {
            "rank": 1,
            "key": "artist-variant",
            "sourceDetailKey": source_key,
            "name": "Variant Artist",
            "count": 2,
            "songCount": 1,
            "videoCount": 2,
            "timestampCount": 2,
            "songs": [{"name": "Canonical Song", "count": 2}],
            "occurrences": occurrences,
        }
        compact = pg_adapter.compact_ranking_payloads([record], "artists")[0]
        writer.add_ranking(
            pg_materializer._ranking_row(
                record,
                payload_record=compact,
                range_id="all",
                view="artists",
                metric="occurrences",
                scope_key="all",
                expected_rank=1,
            )
        )
        writer.add_source(
            source_key,
            "all",
            {"type": "artist", "key": "artist-variant", "songs": record["songs"]},
            occurrences,
        )
        for view in ("songs", "videos", "vtubers"):
            other_source = f"source-{view}-variant"
            other_occurrences = [{
                "videoId": f"{view}-variant-video",
                "song": {
                    "songKey": f"{view}-variant-song",
                    "title": f"Other {view} Song",
                    "artist": "Fixture Artist",
                    "isNiche": False,
                    "isUnknownArtist": False,
                },
            }]
            other_record = {
                "rank": 1,
                "key": f"{view}-variant",
                "sourceDetailKey": other_source,
                "title": f"Other {view} Song",
                "name": f"Other {view}",
                "count": 1,
                "songCount": 1,
                "videoCount": 1,
                "timestampCount": 1,
                "songs": [{
                    "key": f"{view}-variant-song",
                    "name": f"Other {view} Song",
                    "count": 1,
                }],
            }
            other_compact = pg_adapter.compact_ranking_payloads(
                [other_record], view,
            )[0]
            writer.add_ranking(
                pg_materializer._ranking_row(
                    other_record,
                    payload_record=other_compact,
                    range_id="all",
                    view=view,
                    metric="occurrences",
                    scope_key="all",
                    expected_rank=1,
                )
            )
            writer.add_source(
                other_source,
                "all",
                {
                    "type": "vtuber" if view == "vtubers" else view[:-1],
                    "key": f"{view}-variant",
                    "songs": other_record["songs"],
                },
                other_occurrences,
            )
        try:
            result = writer.derive_filtered_ranking_scopes(range_id="all", page_size=30)
            self.assertEqual(result["all/artists/count/visible"], 1)
            payload_json = writer.connection.execute(
                "SELECT payload_json FROM ranking_rows "
                "WHERE range_id='all' AND view='artists' AND metric='count' "
                "AND scope_key='visible'"
            ).fetchone()[0]
            payload = json.loads(payload_json)
            self.assertEqual(
                payload["songs"],
                [{"key": "shared-song-key", "name": "Canonical Song", "count": 2}],
            )
        finally:
            writer.abort()

    def test_snapshot_writer_keeps_symbol_only_vtuber_occurrence_without_song_count(self):
        target = self.temp / "derived-vtuber-symbol-only.sqlite"
        writer = pg_materializer.CanonicalSnapshotWriter(target)
        static_root = self.temp / "static-symbol-only-rankings"
        writer.static_ranking_root = static_root

        def add_base(view, source_key, entity_key, name, occurrences, song_count):
            record = {
                "rank": 1,
                "key": entity_key,
                "sourceDetailKey": source_key,
                "title": name if view in {"songs", "videos"} else "",
                "name": name,
                "artist": "Fixture Artist",
                "count": len(occurrences),
                "songCount": song_count,
                "videoCount": len({item["videoId"] for item in occurrences}),
                "timestampCount": len(occurrences),
                "occurrences": occurrences,
            }
            compact = pg_adapter.compact_ranking_payloads([record], view)[0]
            for metric in ("occurrences", "songs", "videos"):
                writer.add_ranking(
                    pg_materializer._ranking_row(
                        record,
                        payload_record=compact,
                        range_id="all",
                        view=view,
                        metric=metric,
                        scope_key="all",
                        expected_rank=1,
                    )
                )
            writer.add_source(
                source_key,
                "all",
                {"type": "vtuber" if view == "vtubers" else view[:-1],
                 "key": entity_key, "name": name},
                occurrences,
            )

        symbol_occurrence = [{
            "videoId": "symbol-only-video",
            "song": {
                "title": "💙🌷",
                "artist": "Fixture Artist",
                "isNiche": False,
                "isUnknownArtist": False,
            },
        }]
        add_base(
            "vtubers", "source-vtuber-symbol", "channel-symbol",
            "Fixture VTuber", symbol_occurrence, 1,
        )
        for view in ("songs", "artists", "videos"):
            occurrence = [{
                "videoId": f"{view}-identity-video",
                "song": {
                    "songKey": f"{view}-identity-song",
                    "title": f"{view} Identity Song",
                    "artist": "Fixture Artist",
                    "isNiche": False,
                    "isUnknownArtist": False,
                },
            }]
            add_base(
                view, f"source-{view}-identity", f"{view}-identity",
                f"{view} Identity", occurrence, 1,
            )
        for metric_name in ("occurrences", "songs", "videos"):
            page = static_root / "all" / "vtubers" / metric_name / "page-0001.json"
            page.parent.mkdir(parents=True, exist_ok=True)
            page.write_text(
                json.dumps({
                    "rangeId": "all", "view": "vtubers", "metric": metric_name,
                    "page": 1, "totalSongCount": 1,
                    "records": [{"rank": 1, "key": "channel-symbol",
                                 "sourceDetailKey": "source-vtuber-symbol",
                                 "songCount": 1}],
                }, ensure_ascii=False),
                encoding="utf-8",
            )
        try:
            result = writer.derive_filtered_ranking_scopes(
                range_id="all", page_size=30,
            )
            self.assertEqual(result["all/vtubers/count/visible"], 1)
            rows = writer.connection.execute(
                "SELECT metric,song_count,payload_json FROM ranking_rows "
                "WHERE range_id='all' AND view='vtubers' AND scope_key='all' "
                "AND detail_key='source-vtuber-symbol' ORDER BY metric"
            ).fetchall()
            self.assertEqual([(row[0], row[1]) for row in rows], [
                ("count", 0), ("songs", 0), ("videos", 0),
            ])
            self.assertTrue(all(json.loads(row[2])["songCount"] == 0 for row in rows))
            occurrence = writer.connection.execute(
                "SELECT canonical_song_key,canonical_song_name,payload_json "
                "FROM source_occurrences WHERE source_key='source-vtuber-symbol'"
            ).fetchone()
            self.assertEqual(occurrence[0:2], ("", ""))
            self.assertEqual(json.loads(occurrence[2])["song"]["title"], "💙🌷")
            for metric_name in ("occurrences", "songs", "videos"):
                page = static_root / "all" / "vtubers" / metric_name / "page-0001.json"
                payload = json.loads(page.read_text(encoding="utf-8"))
                self.assertEqual(payload["totalSongCount"], 0)
                self.assertEqual(payload["records"][0]["songCount"], 0)
        finally:
            writer.abort()

        titleless_target = self.temp / "derived-vtuber-titleless.sqlite"
        writer = pg_materializer.CanonicalSnapshotWriter(titleless_target)
        titleless_occurrence = [{
            "videoId": "titleless-video",
            "song": {
                "title": "",
                "artist": "Fixture Artist",
                "isNiche": False,
                "isUnknownArtist": False,
            },
        }]
        add_base(
            "vtubers", "source-vtuber-titleless", "channel-titleless",
            "Titleless VTuber", titleless_occurrence, 0,
        )
        for view in ("songs", "artists", "videos"):
            occurrence = [{
                "videoId": f"{view}-titleless-identity-video",
                "song": {
                    "songKey": f"{view}-titleless-identity-song",
                    "title": f"{view} Titleless Identity Song",
                    "artist": "Fixture Artist",
                    "isNiche": False,
                    "isUnknownArtist": False,
                },
            }]
            add_base(
                view, f"source-{view}-titleless", f"{view}-titleless",
                f"{view} Titleless Identity", occurrence, 1,
            )
        try:
            result = writer.derive_filtered_ranking_scopes(
                range_id="all", page_size=30,
            )
            self.assertEqual(result["all/vtubers/count/visible"], 1)
            row = writer.connection.execute(
                "SELECT song_count FROM ranking_rows "
                "WHERE range_id='all' AND view='vtubers' "
                "AND metric='count' AND scope_key='all' "
                "AND detail_key='source-vtuber-titleless'"
            ).fetchone()
            self.assertEqual(row[0], 0)
            occurrence = writer.connection.execute(
                "SELECT canonical_song_key,canonical_song_name,payload_json "
                "FROM source_occurrences "
                "WHERE source_key='source-vtuber-titleless'"
            ).fetchone()
            self.assertEqual(occurrence[0:2], ("", ""))
            self.assertEqual(json.loads(occurrence[2])["song"]["title"], "")
        finally:
            writer.abort()

    def test_snapshot_writer_accepts_nfkc_song_name_variants_within_source(self):
        target = self.temp / "derived-filtered-nfkc-song-name.sqlite"
        writer = pg_materializer.CanonicalSnapshotWriter(target)

        def add_base(view, source_key, entity_key, name, occurrences, songs):
            song_keys = {item["song"]["songKey"] for item in occurrences}
            video_ids = {item["videoId"] for item in occurrences}
            record = {
                "rank": 1,
                "key": entity_key,
                "sourceDetailKey": source_key,
                "title": name if view in {"songs", "videos"} else "",
                "name": name,
                "artist": "Fixture Artist",
                "count": len(occurrences),
                "songCount": len(song_keys),
                "videoCount": len(video_ids),
                "timestampCount": len(occurrences),
                "songs": songs,
            }
            compact = pg_adapter.compact_ranking_payloads([record], view)[0]
            writer.add_ranking(
                pg_materializer._ranking_row(
                    record,
                    payload_record=compact,
                    range_id="all",
                    view=view,
                    metric="occurrences",
                    scope_key="all",
                    expected_rank=1,
                )
            )
            writer.add_source(
                source_key,
                "all",
                {
                    "type": "vtuber" if view == "vtubers" else view[:-1],
                    "key": entity_key,
                    "songs": songs,
                },
                occurrences,
            )

        artist_occurrences = [
            {
                "videoId": "grip-video-a",
                "song": {
                    "songKey": "grip-song",
                    "title": "Grip！",
                    "artist": "Fixture Artist",
                    "isNiche": False,
                    "isUnknownArtist": False,
                },
            },
            {
                "videoId": "grip-video-b",
                "song": {
                    "songKey": "grip-song",
                    "title": "Grip!",
                    "artist": "Fixture Artist",
                    "isNiche": False,
                    "isUnknownArtist": False,
                },
            },
        ]
        add_base(
            "artists",
            "source-artist-grip",
            "artist-grip",
            "Grip Artist",
            artist_occurrences,
            [{"name": "Grip!", "count": 2}],
        )
        for view in ("songs", "vtubers", "videos"):
            occurrence = {
                "videoId": f"{view}-grip-video",
                "song": {
                    "songKey": f"{view}-grip-song",
                    "title": f"Other {view} Song",
                    "artist": "Fixture Artist",
                    "isNiche": False,
                    "isUnknownArtist": False,
                },
            }
            add_base(
                view,
                f"source-{view}-grip",
                f"{view}-grip",
                f"Other {view}",
                [occurrence],
                [{"name": f"Other {view} Song", "count": 1}],
            )

        try:
            result = writer.derive_filtered_ranking_scopes(range_id="all", page_size=30)
            self.assertEqual(result["all/artists/count/visible"], 1)
            payload_row = writer.connection.execute(
                "SELECT count,payload_json FROM ranking_rows "
                "WHERE range_id='all' AND view='artists' AND metric='count' "
                "AND scope_key='visible' AND detail_key='source-artist-grip'"
            ).fetchone()
            self.assertEqual(payload_row[0], 2)
            self.assertEqual(
                json.loads(payload_row[1])["songs"],
                [{"key": "grip-song", "name": "Grip！", "count": 2}],
            )
        finally:
            writer.abort()

    def test_snapshot_writer_accepts_case_song_name_variants_within_source(self):
        target = self.temp / "derived-filtered-case-song-name.sqlite"
        writer = pg_materializer.CanonicalSnapshotWriter(target)

        def add_base(view, source_key, entity_key, name, occurrences, songs):
            record = {
                "rank": 1,
                "key": entity_key,
                "sourceDetailKey": source_key,
                "title": name if view in {"songs", "videos"} else "",
                "name": name,
                "artist": "Fixture Artist",
                "count": len(occurrences),
                "songCount": 1,
                "videoCount": len({item["videoId"] for item in occurrences}),
                "timestampCount": len(occurrences),
                "songs": songs,
            }
            compact = pg_adapter.compact_ranking_payloads([record], view)[0]
            writer.add_ranking(
                pg_materializer._ranking_row(
                    record,
                    payload_record=compact,
                    range_id="all",
                    view=view,
                    metric="occurrences",
                    scope_key="all",
                    expected_rank=1,
                )
            )
            writer.add_source(
                source_key,
                "all",
                {
                    "type": "vtuber" if view == "vtubers" else view[:-1],
                    "key": entity_key,
                    "songs": songs,
                },
                occurrences,
            )

        occurrences = [
            {
                "videoId": "case-song-video-a",
                "song": {
                    "songKey": "case-song-key",
                    "title": "ready steady go",
                    "artist": "Fixture Artist",
                    "isNiche": False,
                    "isUnknownArtist": False,
                },
            },
            {
                "videoId": "case-song-video-b",
                "song": {
                    "songKey": "case-song-key",
                    "title": "READY STEADY GO",
                    "artist": "Fixture Artist",
                    "isNiche": False,
                    "isUnknownArtist": False,
                },
            },
        ]
        add_base(
            "artists",
            "source-artist-case",
            "artist-case",
            "Case Artist",
            occurrences,
            [{"name": "ready steady go", "count": 2}],
        )
        for view in ("songs", "vtubers", "videos"):
            occurrence = {
                "videoId": f"{view}-case-video",
                "song": {
                    "songKey": f"{view}-case-key",
                    "title": f"Other {view} Song",
                    "artist": "Fixture Artist",
                    "isNiche": False,
                    "isUnknownArtist": False,
                },
            }
            add_base(
                view,
                f"source-{view}-case",
                f"{view}-case",
                f"Other {view}",
                [occurrence],
                [{"name": f"Other {view} Song", "count": 1}],
            )

        try:
            result = writer.derive_filtered_ranking_scopes(
                range_id="all", page_size=30,
            )
            self.assertEqual(result["all/artists/count/visible"], 1)
            row = writer.connection.execute(
                "SELECT count,payload_json FROM ranking_rows "
                "WHERE range_id='all' AND view='artists' AND metric='count' "
                "AND scope_key='visible' AND detail_key='source-artist-case'"
            ).fetchone()
            self.assertEqual(row[0], 2)
            self.assertEqual(
                json.loads(row[1])["songs"],
                [{"key": "case-song-key", "name": "ready steady go", "count": 2}],
            )
        finally:
            writer.abort()

    def test_snapshot_writer_reconciles_vtuber_song_count_to_source_identity(self):
        target = self.temp / "derived-vtuber-song-count.sqlite"
        writer = pg_materializer.CanonicalSnapshotWriter(target)
        static_root = self.temp / "static-rankings"
        writer.static_ranking_root = static_root

        def add_base(view, source_key, entity_key, name, occurrences, song_count):
            record = {
                "rank": 1,
                "key": entity_key,
                "sourceDetailKey": source_key,
                "title": name if view in {"songs", "videos"} else "",
                "name": name,
                "artist": "Fixture Artist",
                "count": len(occurrences),
                "songCount": song_count,
                "videoCount": len({item["videoId"] for item in occurrences}),
                "timestampCount": len(occurrences),
                "occurrences": occurrences,
            }
            compact = pg_adapter.compact_ranking_payloads([record], view)[0]
            for metric in ("occurrences", "songs", "videos"):
                writer.add_ranking(
                    pg_materializer._ranking_row(
                        record,
                        payload_record=compact,
                        range_id="all",
                        view=view,
                        metric=metric,
                        scope_key="all",
                        expected_rank=1,
                    )
                )
            writer.add_source(
                source_key,
                "all",
                {"type": "vtuber" if view == "vtubers" else view[:-1],
                 "key": entity_key, "name": name},
                occurrences,
            )

        duplicate_occurrences = [
            {
                "videoId": "vtuber-duplicate-video",
                "song": {
                    "title": "Shared Song",
                    "artist": "Fixture Artist",
                    "isNiche": False,
                    "isUnknownArtist": False,
                },
            },
            {
                "videoId": "vtuber-duplicate-video",
                "song": {
                    "title": "Shared Song",
                    "artist": "Fixture Artist",
                    "isNiche": False,
                    "isUnknownArtist": False,
                },
            },
        ]
        add_base(
            "vtubers", "source-vtuber-stale", "channel-stale", "Fixture VTuber",
            duplicate_occurrences, 2,
        )
        for view in ("songs", "artists", "videos"):
            occurrence = [{
                "videoId": f"{view}-identity-video",
                "song": {
                    "songKey": f"{view}-identity-song",
                    "title": f"{view} Identity Song",
                    "artist": "Fixture Artist",
                    "isNiche": False,
                    "isUnknownArtist": False,
                },
            }]
            add_base(
                view,
                f"source-{view}-identity",
                f"{view}-identity",
                f"{view} Identity",
                occurrence,
                1,
            )

        for metric_name in ("occurrences", "songs", "videos"):
            page = static_root / "all" / "vtubers" / metric_name / "page-0001.json"
            page.parent.mkdir(parents=True, exist_ok=True)
            page.write_text(
                json.dumps({
                    "rangeId": "all",
                    "view": "vtubers",
                    "metric": metric_name,
                    "page": 1,
                    "totalSongCount": 2,
                    "records": [{
                        "rank": 1,
                        "key": "channel-stale",
                        "sourceDetailKey": "source-vtuber-stale",
                        "songCount": 2,
                    }],
                }, ensure_ascii=False),
                encoding="utf-8",
            )
        try:
            result = writer.derive_filtered_ranking_scopes(
                range_id="all", page_size=30,
            )
            self.assertEqual(result["all/vtubers/count/visible"], 1)
            rows = writer.connection.execute(
                "SELECT metric,song_count,payload_json FROM ranking_rows "
                "WHERE range_id='all' AND view='vtubers' AND scope_key='all' "
                "AND detail_key='source-vtuber-stale' ORDER BY metric"
            ).fetchall()
            self.assertEqual([(row[0], row[1]) for row in rows], [
                ("count", 1), ("songs", 1), ("videos", 1),
            ])
            self.assertTrue(all(json.loads(row[2])["songCount"] == 1 for row in rows))
            for metric_name in ("occurrences", "songs", "videos"):
                page = static_root / "all" / "vtubers" / metric_name / "page-0001.json"
                payload = json.loads(page.read_text(encoding="utf-8"))
                self.assertEqual(payload["totalSongCount"], 1)
                self.assertEqual(payload["records"][0]["songCount"], 1)
        finally:
            writer.abort()

    def test_legacy_count_cards_recover_canonical_song_counts_once(self):
        song=pg_materializer._complete_ranking_metric_scalars(
            {"key":"song-key","count":5,"songCount":0,"videoCount":4,
             "timestampCount":5},
            "songs",
        )
        artist=pg_materializer._complete_ranking_metric_scalars(
            {"key":"artist-key","count":5,"songCount":0,"videoCount":4,
             "timestampCount":5,"songs":[
                 {"key":"song-a","name":"Song A","count":3},
                 {"key":"song-b","name":"Song B","count":2},
             ]},
            "artists",
        )
        video=pg_materializer._complete_ranking_metric_scalars(
            {"key":"video-key","count":3,"songCount":0,"videoCount":1,
             "timestampCount":3,"songs":[
                 {"title":"Same","artist":"Artist","seconds":1},
                 {"title":"Same","artist":"Artist","seconds":2},
                 {"title":"Other","artist":"Artist","seconds":3},
             ]},
            "videos",
        )
        self.assertEqual(song["songCount"],1)
        self.assertEqual(artist["songCount"],2)
        self.assertEqual(video["songCount"],2)
        with self.assertRaisesRegex(
            RuntimeError,"Artist canonical song identities are invalid",
        ):
            pg_materializer._complete_ranking_metric_scalars(
                {"key":"artist-key","count":2,"songCount":0,
                 "videoCount":1,"timestampCount":2,"songs":[
                     {"key":"duplicate","count":1},
                     {"key":"duplicate","count":1},
                 ]},
                "artists",
            )

    def test_authoritative_record_metrics_share_payloads_and_public_tie_order(self):
        records=[]
        for suffix in ("b","a"):
            records.append({
                "video":{
                    "videoId":f"video-{suffix}","title":"Same Video",
                    "channelId":f"channel-{suffix}","channelName":"Same Channel",
                },
                "occurrences":({
                    "occurrenceId":f"occ-{suffix}","rangeId":"7d",
                    "songKey":f"song-{suffix}","title":"Same Song",
                    "artist":f"Artist {suffix.upper()}","seconds":1,
                },),
            })
        expected_orders={
            "songs":["song-a","song-b"],
            "artists":["Artist A","Artist B"],
            "vtubers":["channel-a","channel-b"],
            "videos":["video-a","video-b"],
        }
        for view,expected_order in expected_orders.items():
            canonical=None
            for metric in pg_materializer.METRICS:
                payload=pg_adapter.rankings_payload_from_records(
                    records,{"range":"7d","view":view,"metric":metric,
                             "page":"1","pageSize":"200"},
                )
                public_records=payload["records"]
                self.assertEqual(
                    [record["key"] for record in public_records],expected_order,
                )
                self.assertTrue(all(
                    int(record.get(name) or 0)>0
                    for record in public_records
                    for name in ("count","songCount","videoCount")
                ))
                normalized={
                    record["key"]:{key:value for key,value in record.items()
                                   if key!="rank"}
                    for record in public_records
                }
                if canonical is None:
                    canonical=normalized
                else:
                    self.assertEqual(normalized,canonical)

    def test_snapshot_file_cache_drop_flushes_before_exact_fadvise(self):
        target=self.temp/"cache-file.bin"
        target.write_bytes(b"fixture")
        advice=4
        with patch.object(pg_materializer.os,"open",return_value=71), \
             patch.object(pg_materializer.os,"fdatasync",create=True) as sync, \
             patch.object(pg_materializer.os,"posix_fadvise",create=True) as fadvise, \
             patch.object(pg_materializer.os,"POSIX_FADV_DONTNEED",advice,create=True), \
             patch.object(pg_materializer.os,"close") as close:
            dropped=pg_materializer._drop_clean_file_cache(target)
        self.assertTrue(dropped)
        sync.assert_called_once_with(71)
        fadvise.assert_called_once_with(
            71,0,0,advice,
        )
        close.assert_called_once_with(71)

    def test_snapshot_json_page_streams_and_evicts_exact_file_cache(self):
        target=self.temp/"page-0001.json"
        payload={"records":[{"title":"Fixture","count":3}],"compact":True}
        advice=4
        with patch.object(pg_materializer.os,"fdatasync",create=True) as sync, \
             patch.object(pg_materializer.os,"posix_fadvise",create=True) as fadvise, \
             patch.object(pg_materializer.os,"POSIX_FADV_DONTNEED",advice,create=True):
            dropped=pg_materializer._write_json_file_and_drop_cache(
                target,payload,
            )
        self.assertTrue(dropped)
        self.assertEqual(json.loads(target.read_text(encoding="utf-8")),payload)
        descriptor=sync.call_args.args[0]
        fadvise.assert_called_once_with(
            descriptor,0,0,advice,
        )

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

    def test_source_song_identity_excludes_incomplete_page_variants(self):
        record={
            "type":"song","title":"Flavor Of Life","artist":"Hikaru Utada",
            "count":88,"occurrenceCount":88,"occurrencePreviewLimited":True,
            "occurrences":[{
                "videoId":"page-one-video",
                "song":{"title":"Flavor Of Life -Ballad Version-",
                        "artist":"Hikaru Utada"},
            }],
        }
        pairs,keys=pg_adapter._source_song_identity_evidence(record)
        self.assertIn(("flavoroflife","hikaruutada"),pairs)
        self.assertNotIn(("flavoroflifeballadversion","hikaruutada"),pairs)
        self.assertEqual(keys,set())

    def test_legacy_unknown_song_group_ignores_unrelated_scoped_change(self):
        persisted={
            "type":"song","key":"責任集合体::unknown","title":"責任集合体",
            "count":39,"occurrenceCount":39,"occurrencePreviewLimited":True,
            "occurrences":[{
                "videoId":"shared-video",
                "song":{"title":"責任集合体","artist":"未記載"},
            }],
        }
        unrelated={
            "entityType":"occurrences","videoId":"shared-video",
            "occurrenceId":"other-occurrence","rangeId":"all",
            "title":"フィナーレ。","artist":"eill",
        }
        with patch.object(pg_adapter,"_rows") as rows:
            rebuilt=pg_adapter._generic_song_source_payload(
                object(),"parent",persisted,"source",
                {"range":"all","page":"1","pageSize":"30"},
                ("overlay",),(),{},(unrelated,),
            )
        self.assertIsNone(rebuilt)
        rows.assert_not_called()

    def test_legacy_unknown_song_group_matches_reviewed_unknown_candidate(self):
        title="責任集合体"
        persisted={
            "type":"song","key":f"{title}::unknown","title":title,
            "count":39,"occurrenceCount":39,"occurrencePreviewLimited":True,
            "occurrences":[{
                "videoId":"parent-page-video",
                "song":{"title":title,"artist":"未記載"},
            }],
        }
        candidate={
            "revision_id":"overlay","video_id":"video-new",
            "occurrence_id":"occ-new","position":0,"range_id":"all",
            "song_key":"song-new","seconds":1,"title":title,
            "artist":"未記載","source_id":"source","raw_hash":"raw",
            "source_system":"fixture","video_tombstone":False,
            "occurrence_payload_json":{
                "videoId":"video-new","occurrenceId":"occ-new",
                "rangeId":"all","title":title,"artist":"未記載",
                "isUnknownArtist":True,
            },
            "video_payload_json":{
                "videoId":"video-new","title":"New Video",
                "channelId":"UCfixture","channelName":"Fixture",
            },
        }
        summary={"total_occurrence_count":39,"total_video_count":39,
                 "max_position":39}
        page=[{"video_id":"video-new","first_position":40}]
        with patch.object(
            pg_adapter,"_rows",side_effect=[[],[summary],page],
        ) as rows:
            rebuilt=pg_adapter._generic_song_source_payload(
                object(),"parent",persisted,"source",
                {"range":"all","page":"1","pageSize":"200"},
                ("overlay",),(candidate,),{},(),
            )
        self.assertTrue(rebuilt["found"])
        self.assertEqual(rebuilt["totalOccurrenceCount"],40)
        self.assertEqual(rebuilt["totalVideoCount"],40)
        self.assertEqual(rebuilt["record"]["count"],40)
        self.assertEqual(
            rebuilt["record"]["occurrences"][0]["song"]["artist"],
            "未記載",
        )
        self.assertEqual(rows.call_count,3)

    def test_snapshot_exports_legacy_unknown_song_after_unrelated_change(self):
        source_key="0dc720fff2e97b01"
        title="責任集合体"
        self.assertEqual(
            pg_adapter._production_source_detail_key_for_group(
                "songs","all",f"{title}::unknown",
            ),
            source_key,
        )
        occurrences=[{
            "videoId":("shared-video" if index==0 else f"video-{index:02d}"),
            "song":{"title":title,"artist":"未記載",
                    "isUnknownArtist":True},
        } for index in range(39)]
        unrelated={
            "entityType":"occurrences","videoId":"shared-video",
            "occurrenceId":"other-occurrence","rangeId":"all",
            "title":"フィナーレ。","artist":"eill",
        }
        context=SimpleNamespace(
            runtime=None,generic_runtime=("active",{}),parent=("parent",{}),
            overlay_ids=("overlay",),authoritative_ids=(),
            authoritative_records=None,snapshot_artist_aliases=None,
        )
        rendered=[]

        def persisted(_connection,_revision,key,query,**_kwargs):
            page=int(query["page"])
            page_values=occurrences[(page-1)*30:page*30]
            return {
                "schemaVersion":1,"found":True,"sourceKey":key,
                "sourceRevisionId":"parent","page":page,"pageSize":30,
                "pageCount":2,"totalCount":39,
                "totalVideoCount":39,"totalOccurrenceCount":39,
                "record":{
                    "type":"song","key":f"{title}::unknown",
                    "title":title,"count":39,"occurrenceCount":39,
                    "videoCount":39,"occurrencePreviewLimited":True,
                    "sourceDetailKey":key,"rangeId":"all",
                    "occurrences":page_values,
                },
            }

        def load(key,query):
            payload=pg_adapter.source_payload(
                object(),key,query,snapshot_context=context,
                snapshot_video_scope=("shared-video",),
            )
            rendered.append(payload)
            return payload

        class Writer:
            def __init__(self):
                self.values=[]
            def begin_source(self,key,range_id,record):
                self.key=key;self.range_id=range_id;self.record=dict(record)
                return {"position":0}
            def add_source_occurrences(self,state,values):
                values=list(values);self.values.extend(values)
                state["position"]+=len(values)
                return len(values)
            def finish_source(self,state):
                return state["position"]

        writer=Writer()
        with patch.object(
            pg_adapter,"_runtime_source_payload",side_effect=persisted,
        ), patch.object(
            pg_adapter,"_snapshot_source_overlay_inputs",
            return_value=((),{},(unrelated,)),
        ), patch.object(pg_adapter,"_rows") as rows:
            pg_materializer.export_source(
                object(),writer,range_id="all",source_key=source_key,
                payload_loader=load,
            )
        rows.assert_not_called()
        self.assertEqual(len(rendered),2)
        self.assertTrue(all(payload["found"] for payload in rendered))
        self.assertTrue(all(
            payload["sourceKey"]==source_key
            and payload["totalOccurrenceCount"]==39
            and payload["totalVideoCount"]==39
            and payload["pageCount"]==2
            and "sourceDetailBlocked" not in payload
            for payload in rendered
        ))
        self.assertEqual(writer.key,source_key)
        self.assertEqual(writer.range_id,"all")
        self.assertEqual(len(writer.values),39)
        self.assertEqual(len({item["videoId"] for item in writer.values}),39)

    def test_incomplete_song_page_cannot_expand_overlay_owner_identity(self):
        persisted={
            "type":"song","key":"flavoroflife::hikaruutada",
            "title":"Flavor Of Life","artist":"Hikaru Utada",
            "count":88,"occurrenceCount":88,"occurrencePreviewLimited":True,
            "occurrences":[{
                "videoId":"page-one-video",
                "song":{"title":"Flavor Of Life -Ballad Version-",
                        "artist":"Hikaru Utada"},
            }],
        }
        candidate={
            "revision_id":"overlay","video_id":"overlay-video",
            "occurrence_id":"overlay-occurrence","position":0,
            "range_id":"all","song_key":"ballad","seconds":1,
            "title":"Flavor Of Life -Ballad Version-",
            "artist":"Hikaru Utada","source_id":"fixture",
            "source_system":"fixture","occurrence_payload_json":{},
            "video_payload_json":{},"video_tombstone":False,
        }
        with patch.object(pg_adapter,"_rows") as rows:
            rebuilt=pg_adapter._generic_song_source_payload(
                object(),"parent",persisted,"source",
                {"range":"all","page":"1","pageSize":"30"},
                ("overlay",),(candidate,),{},(),
            )
        self.assertIsNone(rebuilt)
        rows.assert_not_called()

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

    def test_unscoped_overlay_video_lookup_uses_separate_bounded_cap(self):
        video={"revision_id":"overlay","video_id":"video-one","video_title":"Video",
               "channel_name":"Fixture","channel_id":"UCfixture","channel_handle":"@fixture",
               "channel_url":"","published_at":0,"video_payload_json":{},
               "video_tombstone":False,"partial_range_reset":False,"partial_range_id":""}
        occurrence={"revision_id":"overlay","video_id":"video-one","occurrence_id":"occ-one",
                    "position":0,"range_id":"all","song_key":"song","seconds":1,"title":"Song",
                    "artist":"Artist","source_id":"source","raw_hash":"raw",
                    "source_system":"fixture","occurrence_payload_json":{}}
        with patch.object(pg_adapter,"_rows",side_effect=[[video],[occurrence]]) as rows:
            selected=pg_adapter._overlay_candidate_rows(object(),("overlay",),range_id="all")
        self.assertEqual(len(selected),1)
        self.assertEqual(
            rows.call_args_list[0].args[2][-1],
            pg_adapter._MAX_UNSCOPED_OVERLAY_VIDEOS + 1,
        )
        with patch.object(pg_adapter,"_MAX_UNSCOPED_OVERLAY_VIDEOS",2), \
             patch.object(pg_adapter,"_rows",return_value=[video,dict(video),dict(video)]):
            with self.assertRaisesRegex(
                pg_adapter.PostgresAdapterError,
                "overlay candidate video lookup exceeded bounded cap",
            ):
                pg_adapter._overlay_candidate_rows(object(),("overlay",),range_id="all")

    def test_unscoped_accepted_video_reset_lookup_uses_separate_bounded_cap(self):
        video={"revision_id":"overlay","video_id":"video-one",
               "video_title":"Video","channel_name":"Fixture",
               "channel_id":"UCfixture","channel_handle":"@fixture",
               "channel_url":"","published_at":0,"video_payload_json":{},
               "tombstone":False,"partial_range_reset":False,
               "partial_range_id":""}
        with patch.object(pg_adapter,"_rows",return_value=[video]) as rows:
            selected=pg_adapter._accepted_video_resets(
                object(),("overlay",),include_payload=False,
            )
        self.assertEqual(list(selected),["video-one"])
        self.assertEqual(
            rows.call_args.args[2][-1],
            pg_adapter._MAX_UNSCOPED_OVERLAY_VIDEOS + 1,
        )
        with patch.object(pg_adapter,"_MAX_UNSCOPED_OVERLAY_VIDEOS",2), \
             patch.object(pg_adapter,"_rows",return_value=[video,dict(video),dict(video)]):
            with self.assertRaisesRegex(
                pg_adapter.PostgresAdapterError,
                "accepted-video reset lookup exceeded bounded video cap",
            ):
                pg_adapter._accepted_video_resets(
                    object(),("overlay",),include_payload=False,
                )

    def test_overlay_candidates_exclude_empty_title_for_every_public_view(self):
        video={"revision_id":"overlay","video_id":"video-one",
               "video_title":"Video","channel_name":"Fixture",
               "channel_id":"UCfixture","channel_handle":"@fixture",
               "channel_url":"","published_at":0,
               "video_payload_json":{},"video_tombstone":False}
        valid={"revision_id":"overlay","video_id":"video-one",
               "occurrence_id":"valid","position":0,"range_id":"all",
               "song_key":"song","seconds":1,"title":"Song",
               "artist":"Artist","source_id":"source","raw_hash":"raw",
               "source_system":"fixture","occurrence_payload_json":{}}
        empty={**valid,"occurrence_id":"empty","position":1,
               "song_key":"empty","title":"","artist":""}
        with patch.object(pg_adapter,"_rows",side_effect=[[video],[valid,empty]]):
            selected=pg_adapter._overlay_candidate_rows(
                object(),("overlay",),range_id="all",
            )
        self.assertEqual(
            [row["occurrence_id"] for row in selected],
            ["valid"],
        )

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

    def test_channel_source_does_not_double_load_persisted_same_range_video(self):
        video={"video_id":"video-one","title":"Video","channel_name":"Fixture",
               "channel_id":"UCfixture","channel_handle":"@fixture","channel_url":"",
               "published_timestamp":0,"payload_json":{}}
        occurrence={"video_id":"video-one","occurrence_id":"occ-one","range_id":"all",
                    "song_key":"song","seconds":1,"source_system":"fixture",
                    "source_id":"source","title":"Song","artist":"Artist",
                    "payload_json":{}}
        persisted=[{"videoId":"video-one","rangeId":"all","position":0,
                    "songKey":"song","seconds":1,"title":"Song","artist":"Artist",
                    "channelId":"UCfixture"}]
        metadata={"channelId":"UCfixture","sourceDetailKey":"source",
                  "count":1,"songCount":1,"videoCount":1,
                  "songs":[{"key":"song","name":"Song","count":1}]}
        with patch.object(pg_adapter,"_rows",side_effect=[[video],[occurrence]]), \
             patch.object(pg_adapter,"_runtime_source_occurrences",return_value=persisted), \
             patch.object(pg_adapter,"_snapshot_source_overlay_inputs",return_value=((),{},())), \
             patch.object(pg_adapter,"_runtime_tombstones",return_value=()):
            result=pg_adapter._runtime_channel_source_payload(
                object(),"parent",metadata,"source",
                {"range":"all","page":"1","pageSize":"30"},
                overlay_revision_ids=("overlay",),snapshot_video_scope=("video-one",),
            )
        self.assertEqual((result["totalOccurrenceCount"],result["totalVideoCount"]),(1,1))

    def test_channel_source_prefers_complete_persisted_same_video_authority(self):
        video={"video_id":"video-one","title":"Video","channel_name":"Fixture",
               "channel_id":"UCfixture","channel_handle":"@fixture","channel_url":"",
               "published_timestamp":0,"payload_json":{}}
        occurrence={"video_id":"video-one","occurrence_id":"occ-one","range_id":"all",
                    "song_key":"song-one","seconds":1,"source_system":"fixture",
                    "source_id":"source","title":"Song one","artist":"Artist",
                    "payload_json":{}}
        persisted=[
            {"videoId":"video-one","rangeId":"all","position":0,
             "songKey":"song-one","seconds":1,"title":"Song one",
             "artist":"Artist","channelId":"UCfixture"},
            {"videoId":"video-one","rangeId":"all","position":1,
             "songKey":"song-two","seconds":2,"title":"Song two",
             "artist":"Artist","channelId":"UCfixture"},
        ]
        metadata={"channelId":"UCfixture","sourceDetailKey":"source",
                  "count":2,"songCount":2,"videoCount":1,
                  "songs":[
                      {"key":"songone","name":"Song one","count":1},
                      {"key":"songtwo","name":"Song two","count":1},
                  ]}
        with patch.object(pg_adapter,"_rows",side_effect=[[video],[occurrence]]), \
             patch.object(pg_adapter,"_runtime_source_occurrences",return_value=persisted), \
             patch.object(pg_adapter,"_snapshot_source_overlay_inputs",return_value=((),{},())), \
             patch.object(pg_adapter,"_runtime_tombstones",return_value=()):
            result=pg_adapter._runtime_channel_source_payload(
                object(),"parent",metadata,"source",
                {"range":"all","page":"1","pageSize":"30"},
                overlay_revision_ids=("overlay",),snapshot_video_scope=("video-one",),
            )
        self.assertEqual(
            (result["totalOccurrenceCount"],result["totalSongCount"],
             result["totalVideoCount"]),(2,2,1),
        )
        self.assertEqual(len(result["record"]["occurrences"]),2)

    def test_name_only_vtuber_source_keeps_underlying_channel_ids_together(self):
        videos=[
            {"video_id":"video-one","title":"One","channel_name":"Fixture",
             "channel_id":"UCone","channel_handle":"","channel_url":"",
             "published_timestamp":0,"payload_json":{}},
            {"video_id":"video-two","title":"Two","channel_name":"Fixture",
             "channel_id":"UCtwo","channel_handle":"","channel_url":"",
             "published_timestamp":0,"payload_json":{}},
        ]
        persisted=[
            {"videoId":"video-one","rangeId":"all","position":0,
             "songKey":"song-one","seconds":1,"title":"Song one",
             "artist":"Artist","channelId":"UCone"},
            {"videoId":"video-two","rangeId":"all","position":1,
             "songKey":"song-two","seconds":2,"title":"Song two",
             "artist":"Artist","channelId":"UCtwo"},
        ]
        metadata={"channelName":"Fixture","sourceDetailKey":"source",
                  "count":2,"songCount":2,"videoCount":2,
                  "songs":[
                      {"key":"songone","name":"Song one","count":1},
                      {"key":"songtwo","name":"Song two","count":1},
                  ]}
        with patch.object(pg_adapter,"_rows",side_effect=[videos,[]]), \
             patch.object(pg_adapter,"_runtime_source_occurrences",return_value=persisted), \
             patch.object(pg_adapter,"_snapshot_source_overlay_inputs",return_value=((),{},())), \
             patch.object(pg_adapter,"_runtime_tombstones",return_value=()):
            result=pg_adapter._runtime_channel_source_payload(
                object(),"parent",metadata,"source",
                {"range":"all","page":"1","pageSize":"30"},
                overlay_revision_ids=("overlay",),
                snapshot_video_scope=("video-one","video-two"),
            )
        self.assertEqual(
            (result["totalOccurrenceCount"],result["totalSongCount"],
             result["totalVideoCount"]),(2,2,2),
        )
        self.assertEqual(
            {item["videoId"] for item in result["record"]["occurrences"]},
            {"video-one","video-two"},
        )

    def test_channel_source_keeps_persisted_only_video_complement(self):
        video={"video_id":"video-one","title":"Video","channel_name":"Fixture",
               "channel_id":"UCfixture","channel_handle":"@fixture","channel_url":"",
               "published_timestamp":0,"payload_json":{}}
        occurrence={"video_id":"video-one","occurrence_id":"occ-one","range_id":"all",
                    "song_key":"song-one","seconds":1,"source_system":"fixture",
                    "source_id":"source","title":"Song one","artist":"Artist",
                    "payload_json":{}}
        persisted=[
            {"videoId":"video-one","rangeId":"all","position":0,
             "songKey":"song-one","seconds":1,"title":"Song one",
             "artist":"Artist","channelId":"UCfixture"},
            {"videoId":"video-two","rangeId":"all","position":1,
             "songKey":"song-two","seconds":2,"title":"Song two",
             "artist":"Artist","channelId":"UCfixture"},
        ]
        metadata={"channelId":"UCfixture","sourceDetailKey":"source",
                  "count":2,"songCount":2,"videoCount":2,
                  "songs":[
                      {"key":"songone","name":"Song one","count":1},
                      {"key":"songtwo","name":"Song two","count":1},
                  ]}
        with patch.object(pg_adapter,"_rows",side_effect=[[video],[occurrence]]), \
             patch.object(pg_adapter,"_runtime_source_occurrences",return_value=persisted), \
             patch.object(pg_adapter,"_snapshot_source_overlay_inputs",return_value=((),{},())), \
             patch.object(pg_adapter,"_runtime_tombstones",return_value=()):
            result=pg_adapter._runtime_channel_source_payload(
                object(),"parent",metadata,"source",
                {"range":"all","page":"1","pageSize":"30"},
                overlay_revision_ids=("overlay",),snapshot_video_scope=("video-one",),
            )
        self.assertEqual((result["totalOccurrenceCount"],result["totalVideoCount"]),(2,2))

    def test_source_merge_identity_keeps_same_occurrence_id_across_ranges(self):
        records=[{"video":{"videoId":"video-one"},"occurrences":({
            "occurrenceId":"occ-one","rangeId":"all","title":"All",
        },)}]
        additions=[{"video":{"videoId":"video-one"},"occurrences":({
            "occurrenceId":"occ-one","rangeId":"7d","title":"Seven",
        },)}]
        merged=pg_adapter._merge_source_records(records,additions)
        self.assertEqual(
            [(value["rangeId"],value["title"]) for value in merged[0]["occurrences"]],
            [("all","All"),("7d","Seven")],
        )

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
             patch.object(pg_adapter,"_rows",return_value=[]), \
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

    def test_snapshot_parent_video_source_uses_exact_scope_and_parent_rows(self):
        video_id="parent-old"
        source_key=pg_adapter._stable_key("source-video","all",video_id)
        video_row={
            "video_id":video_id,"title":"Parent Video","channel_name":"Fixture",
            "channel_id":"UCfixture","channel_handle":"@fixture",
            "channel_url":"https://youtube.com/@fixture",
            "published_timestamp":1700000000,"payload_json":{},
        }
        occurrence_row={
            "video_id":video_id,"occurrence_id":"occ-parent","range_id":"all",
            "song_key":"song-parent","seconds":12,"source_system":"fixture",
            "source_id":"source-parent","title":"Parent Song","artist":"Artist",
            "payload_json":{},
        }
        def rows(_connection,statement,params):
            if "FROM runtime_videos" in statement:return [video_row]
            if "FROM runtime_occurrences" in statement:
                self.assertIn("range_id = ANY",statement)
                self.assertNotIn("coalesce(range_id",statement)
                self.assertEqual(params[2],["all",""])
                return [occurrence_row]
            self.fail(statement)
        with patch.object(pg_adapter,"_rows",side_effect=rows), \
             patch.object(pg_adapter,"_runtime_source_occurrences",return_value=[]), \
             patch.object(pg_adapter,"_overlay_candidate_rows") as global_candidates, \
             patch.object(pg_adapter,"_accepted_video_resets") as global_resets, \
             patch.object(pg_adapter,"_runtime_tombstones") as global_changes:
            result=pg_adapter._generic_video_source_payload(
                object(),"parent",None,source_key,
                {"range":"all","page":"1","pageSize":"200"},
                ("overlay",),(),{},(),snapshot_video_scope=(video_id,),
            )
        self.assertTrue(result["found"])
        self.assertEqual((result["totalVideoCount"],result["totalOccurrenceCount"]),(1,1))
        self.assertEqual(result["record"]["videoId"],video_id)
        self.assertEqual(
            result["record"]["occurrences"][0]["song"]["title"],
            "Parent Song",
        )
        global_candidates.assert_not_called();global_resets.assert_not_called();global_changes.assert_not_called()

    def test_snapshot_bulk_exports_unaffected_parent_video_sources(self):
        video_id="parent-bulk"
        source_key=pg_adapter._stable_key("source-video","all",video_id)
        video_row={
            "video_id":video_id,"title":"Bulk Video","channel_name":"Fixture",
            "channel_id":"UCfixture","channel_handle":"@fixture",
            "channel_url":"https://youtube.com/@fixture",
            "published_timestamp":1700000000,"payload_json":{},
        }
        occurrence_row={
            "video_id":video_id,"occurrence_id":"occ-bulk","range_id":"all",
            "song_key":"song-bulk","seconds":9,"source_system":"fixture",
            "source_id":"source-bulk","title":"Bulk Song","artist":"Artist",
            "payload_json":{},
        }
        class Writer:
            def __init__(self):self.values=[]
            def add_source(self,key,range_id,record,occurrences):
                self.values.append((key,range_id,dict(record),list(occurrences)))
        writer=Writer()
        def stream(_connection,label,statement,params,**_kwargs):
            self.assertTrue(label.startswith("parent_video_occurrences_"))
            self.assertIn("runtime_occurrences",statement)
            self.assertIn("range_id = ANY",statement)
            self.assertNotIn("coalesce(range_id",statement)
            self.assertEqual(params[2],["all",""])
            yield occurrence_row
        def rows(_connection,statement,_params):
            if "FROM runtime_videos" in statement:return [video_row]
            if "SELECT DISTINCT video_id" in statement:
                return [{"video_id":video_id}]
            self.fail(statement)
        with patch.object(pg_adapter,"_rows",side_effect=rows) as lookup_rows, \
             patch.object(pg_materializer,"_stream_pg_rows",side_effect=stream):
            completed=pg_materializer.export_unaffected_parent_video_sources(
                object(),writer,parent_revision_id="parent",
                sources=((source_key,video_id),),
            )
        self.assertEqual(completed,{source_key})
        self.assertEqual(len(writer.values),1)
        key,range_id,record,occurrences=writer.values[0]
        self.assertEqual((key,range_id,record["videoId"]),(source_key,"all",video_id))
        self.assertEqual(record["sourceDetailKey"],source_key)
        self.assertEqual(occurrences[0]["song"]["title"],"Bulk Song")
        self.assertEqual(lookup_rows.call_count,2)

    def test_snapshot_bulk_exports_ranking_only_parent_video_sources(self):
        video_id="parent-ranking-only"
        source_key=pg_adapter._stable_key("source-video","all",video_id)
        ranking_payload={
            "type":"video","key":video_id,"detailKey":f"all:{video_id}",
            "videoId":video_id,"title":"Ranking-only Video",
            "channelName":"Fixture","channelId":"UCfixture",
            "channelHandle":"/@fixture",
            "channelUrl":"https://youtube.com/@fixture",
            "publishedTimestamp":1700000000,
            "count":2,"timestampCount":2,"videoCount":1,
            "songs":[
                {"title":"Song A","artist":"Artist","seconds":11},
                {"title":"Song B","artist":"Artist","seconds":22},
            ],
        }
        ranking_row={
            "detail_key":video_id,"title":"Ranking-only Video",
            "row_count":2,"video_count":1,"timestamp_count":2,
            "payload_json":ranking_payload,
        }
        class Writer:
            def __init__(self):self.values=[]
            def add_source(self,key,range_id,record,occurrences):
                self.values.append((key,range_id,dict(record),list(occurrences)))
        writer=Writer()
        def rows(_connection,statement,params):
            if "FROM runtime_source_details AS detail" in statement:
                return []
            if "FROM runtime_videos" in statement:
                return []
            if "SELECT DISTINCT video_id" in statement:
                return []
            if "FROM runtime_ranking_rows" in statement:
                self.assertEqual(params[1],[video_id])
                self.assertIn("metric = 'count'",statement)
                self.assertIn("scope_key = 'all'",statement)
                return [ranking_row]
            self.fail(statement)
        with patch.object(pg_adapter,"_rows",side_effect=rows), \
             patch.object(pg_materializer,"_stream_pg_rows",return_value=iter(())):
            preflight=pg_materializer.preflight_unaffected_parent_video_sources(
                object(),parent_revision_id="parent",
                sources=((source_key,video_id),),
            )
            completed=pg_materializer.export_unaffected_parent_video_sources(
                object(),writer,parent_revision_id="parent",
                sources=((source_key,video_id),),
            )
        self.assertEqual(preflight,{source_key})
        self.assertEqual(completed,{source_key})
        self.assertEqual(len(writer.values),1)
        key,range_id,record,occurrences=writer.values[0]
        self.assertEqual((key,range_id,record["videoId"]),(source_key,"all",video_id))
        self.assertEqual(record["sourceDetailKey"],source_key)
        self.assertEqual(
            [
                (item["song"]["title"],item["song"]["seconds"])
                for item in occurrences
            ],
            [("Song A",11),("Song B",22)],
        )

    def test_snapshot_ranking_only_parent_video_rejects_wrong_range_identity(self):
        video_id="parent-ranking-wrong-range"
        ranking_row={
            "detail_key":video_id,"title":"Wrong Range",
            "row_count":1,"video_count":1,"timestamp_count":1,
            "payload_json":{
                "type":"video","key":video_id,
                "detailKey":f"7d:{video_id}","videoId":video_id,
                "title":"Wrong Range","count":1,
                "timestampCount":1,"videoCount":1,
                "songs":[{"title":"Song","artist":"Artist"}],
            },
        }
        with self.assertRaisesRegex(
            RuntimeError,"parent video ranking fallback changed identity",
        ):
            pg_materializer._parent_video_ranking_fallback(
                ranking_row,expected_video_id=video_id,
            )

    def test_snapshot_affected_ranking_only_video_applies_drop_to_parent_card(self):
        video_id="LLe0YJODmFM"
        source_key=pg_adapter._stable_key("source-video","all",video_id)
        ranking_row={
            "detail_key":video_id,"title":"Ranking-only affected video",
            "row_count":2,"video_count":1,"timestamp_count":2,
            "payload_json":{
                "type":"video","key":video_id,
                "detailKey":f"all:{video_id}","videoId":video_id,
                "title":"Ranking-only affected video",
                "channelName":"Fixture","channelId":"UCfixture",
                "count":2,"timestampCount":2,"videoCount":1,
                "songs":[
                    {"title":"Keep Song","artist":"Artist","seconds":11},
                    {"title":"Drop Song","artist":"Artist","seconds":22},
                ],
            },
        }
        runtime_drop={
            "entityType":"runtime_occurrences","videoId":video_id,
            "occurrenceId":"legacy-drop-id","rangeId":"all",
            "title":"Drop Song","artist":"Artist","seconds":22,
        }
        with closing(sqlite3.connect(":memory:")) as database:
            scope=pg_materializer.SnapshotSourceScope(database)
            scope.add_videos((video_id,))
            scope.add_pairs(((source_key,video_id),))
            scope.add_targets((("videos",video_id,source_key),))

            def rows(_connection,statement,params):
                if "runtime_source_details" in statement:return []
                if "count(*) AS occurrence_count" in statement:return []
                if "FROM runtime_videos" in statement:
                    self.assertEqual(params[1],[video_id]);return []
                if "SELECT DISTINCT video_id" in statement:
                    self.assertEqual(params[1],[video_id]);return []
                if "FROM runtime_ranking_rows" in statement:
                    self.assertEqual(params[1],[video_id]);return [ranking_row]
                self.fail(statement)

            def stream(_connection,label,_statement,_params,**_kwargs):
                self.assertTrue(label.startswith("affected_direct_sources_"))
                return iter(())

            class Writer:
                def __init__(self):self.values=[]
                def add_source(self,key,range_id,record,occurrences):
                    self.values.append(
                        (key,range_id,dict(record),list(occurrences))
                    )

            writer=Writer()
            with patch.object(pg_adapter,"_rows",side_effect=rows), \
                 patch.object(pg_materializer,"_stream_pg_rows",
                              side_effect=stream), \
                 patch.object(pg_adapter,"_snapshot_source_overlay_inputs",
                              return_value=((),{},(runtime_drop,))):
                preflight=pg_materializer.preflight_affected_parent_sources(
                    object(),parent_revision_id="parent",
                    overlay_revision_ids=("overlay",),source_scope=scope,
                    source_keys=(source_key,),
                )
                completed=pg_materializer.export_affected_parent_sources(
                    object(),writer,parent_revision_id="parent",
                    overlay_revision_ids=("overlay",),source_scope=scope,
                    source_keys=(source_key,),
                )

        self.assertEqual(preflight,{source_key})
        self.assertEqual(completed,{source_key})
        self.assertEqual(len(writer.values),1)
        key,range_id,record,occurrences=writer.values[0]
        self.assertEqual((key,range_id),(source_key,"all"))
        self.assertEqual(
            (record["count"],record["occurrenceCount"],record["videoCount"]),
            (1,1,1),
        )
        self.assertEqual(
            [item["song"]["title"] for item in occurrences],["Keep Song"],
        )

    def test_snapshot_ranking_only_parent_video_count_mismatch_fails_closed(self):
        video_id="parent-ranking-mismatch"
        source_key=pg_adapter._stable_key("source-video","all",video_id)
        ranking_row={
            "detail_key":video_id,"title":"Mismatch",
            "row_count":3,"video_count":1,"timestamp_count":2,
            "payload_json":{
                "type":"video","key":video_id,"detailKey":video_id,
                "videoId":video_id,"title":"Mismatch",
                "count":2,"timestampCount":2,"videoCount":1,
                "songs":[
                    {"title":"Song A","artist":"Artist","seconds":11},
                    {"title":"Song B","artist":"Artist","seconds":22},
                ],
            },
        }
        def rows(_connection,statement,_params):
            if "FROM runtime_videos" in statement:return []
            if "SELECT DISTINCT video_id" in statement:return []
            if "FROM runtime_ranking_rows" in statement:return [ranking_row]
            self.fail(statement)
        with patch.object(pg_adapter,"_rows",side_effect=rows):
            with self.assertRaisesRegex(
                RuntimeError,"parent video ranking fallback count changed",
            ):
                pg_materializer.export_unaffected_parent_video_sources(
                    object(),object(),parent_revision_id="parent",
                    sources=((source_key,video_id),),
                )

    def test_snapshot_parent_video_preflight_skips_persisted_and_checks_direct(self):
        persisted_video="parent-persisted"
        direct_video="parent-direct"
        persisted_key=pg_adapter._stable_key("source-video","all",persisted_video)
        direct_key=pg_adapter._stable_key("source-video","all",direct_video)
        direct_row={
            "video_id":direct_video,"title":"Direct Video",
            "channel_name":"Fixture","channel_id":"UCfixture",
            "channel_handle":"@fixture","channel_url":"https://youtube.com/@fixture",
            "published_timestamp":1700000000,"payload_json":{},
        }
        statements=[]
        def rows(_connection,statement,params):
            statements.append(" ".join(statement.split()))
            if "FROM runtime_source_details AS detail" in statement:
                self.assertEqual(set(params[1]),{persisted_key,direct_key})
                return [{"source_key":persisted_key}]
            if "FROM runtime_videos" in statement:
                self.assertEqual(params[1],[direct_video])
                return [direct_row]
            if "SELECT DISTINCT video_id" in statement:
                self.assertEqual(params[1],[direct_video])
                return [{"video_id":direct_video}]
            self.fail(statement)
        with patch.object(pg_adapter,"_rows",side_effect=rows):
            actual=pg_materializer.preflight_unaffected_parent_video_sources(
                object(),parent_revision_id="parent",
                sources=(
                    (persisted_key,persisted_video),
                    (direct_key,direct_video),
                ),
            )
        self.assertEqual(actual,{direct_key})
        self.assertEqual(len(statements),3)
        self.assertIn("runtime_source_details",statements[0])
        self.assertIn("runtime_videos",statements[1])
        self.assertIn("runtime_occurrences",statements[2])

    def test_snapshot_parent_video_preflight_rejects_missing_occurrences(self):
        video_id="parent-no-occurrences"
        source_key=pg_adapter._stable_key("source-video","all",video_id)
        video_row={
            "video_id":video_id,"title":"No Occurrences",
            "channel_name":"Fixture","channel_id":"UCfixture",
            "channel_handle":"@fixture","channel_url":"https://youtube.com/@fixture",
            "published_timestamp":1700000000,"payload_json":{},
        }
        def rows(_connection,statement,_params):
            if "FROM runtime_source_details AS detail" in statement:return []
            if "FROM runtime_videos" in statement:return [video_row]
            if "SELECT DISTINCT video_id" in statement:return []
            if "FROM runtime_ranking_rows" in statement:return []
            self.fail(statement)
        with patch.object(pg_adapter,"_rows",side_effect=rows):
            with self.assertRaisesRegex(
                RuntimeError,"parent video occurrence preflight changed",
            ):
                pg_materializer.preflight_unaffected_parent_video_sources(
                    object(),parent_revision_id="parent",
                    sources=((source_key,video_id),),
                )

    def test_snapshot_parent_video_without_runtime_occurrence_uses_ranking_fallback(self):
        video_id="parent-runtime-video-ranking-occurrence"
        video_row={
            "video_id":video_id,"title":"Stale Runtime Video",
            "channel_name":"Fixture","channel_id":"UCfixture",
            "channel_handle":"@fixture","channel_url":"https://youtube.com/@fixture",
            "published_timestamp":1700000000,"payload_json":{},
        }
        ranking_row={
            "detail_key":video_id,"title":"Authoritative Ranking Video",
            "row_count":1,"video_count":1,"timestamp_count":1,
            "payload_json":{
                "type":"video","key":video_id,"detailKey":f"all:{video_id}",
                "videoId":video_id,"title":"Authoritative Ranking Video",
                "count":1,"timestampCount":1,"videoCount":1,
                "songs":[{"title":"Song A","artist":"Artist","seconds":11}],
            },
        }
        def rows(_connection,statement,params):
            if "FROM runtime_videos" in statement:
                self.assertEqual(params[1],[video_id])
                return [video_row]
            if "SELECT DISTINCT video_id" in statement:
                self.assertEqual(params[1],[video_id])
                return []
            if "FROM runtime_ranking_rows" in statement:
                self.assertEqual(params[1],[video_id])
                return [ranking_row]
            self.fail(statement)
        with patch.object(pg_adapter,"_rows",side_effect=rows):
            videos,fallback=pg_materializer._load_parent_video_source_batch(
                object(),parent_revision_id="parent",video_ids=[video_id],
            )
        self.assertEqual(videos[video_id]["title"],"Authoritative Ranking Video")
        self.assertEqual(len(fallback[video_id]),1)
        self.assertEqual(fallback[video_id][0]["videoId"],video_id)
        self.assertEqual(fallback[video_id][0]["song"]["title"],"Song A")

    def test_snapshot_bulk_streams_unaffected_persisted_parent_sources(self):
        keep_key="source-keep"
        affected_key="source-affected"
        overlay_key="source-overlay"
        detail={
            "source_key":keep_key,"entity_type":"song","entity_key":"song-a",
            "payload_json":{
                "type":"song","key":"song-a","name":"Song A",
                "sourceDetailKey":keep_key,"rangeId":"all",
                "count":2,"occurrenceCount":2,"videoCount":2,
            },
        }
        occurrences=[
            {
                "source_key":keep_key,"position":1,"video_id":"video-a",
                "title":"Video A","channel_name":"Fixture","channel_id":"UCfixture",
                "channel_handle":"@fixture","channel_url":"","published_timestamp":1,
                "seconds":10,"is_niche":False,"is_unknown_artist":False,
                "payload_json":{"videoId":"video-a","song":{"title":"Song A"}},
            },
            {
                "source_key":keep_key,"position":2,"video_id":"video-b",
                "title":"Video B","channel_name":"Fixture","channel_id":"UCfixture",
                "channel_handle":"@fixture","channel_url":"","published_timestamp":2,
                "seconds":20,"is_niche":False,"is_unknown_artist":False,
                "payload_json":{"videoId":"video-b","song":{"title":"Song A"}},
            },
        ]

        class Writer:
            def __init__(self):self.values={}
            def begin_source(self,key,range_id,record):
                self.values[key]={"range":range_id,"record":dict(record),"occurrences":[]}
                return {"source_key":key,"range_id":range_id,"position":0}
            def add_source_occurrences(self,state,values):
                values=list(values);state["position"]+=len(values)
                self.values[state["source_key"]]["occurrences"].extend(values)
                return len(values)
            def finish_source(self,state):return state["position"]

        writer=Writer()
        def rows(_connection,statement,params):
            self.assertIn("runtime_source_details",statement)
            self.assertEqual(params[0],"parent")
            self.assertEqual(set(params[1]),{keep_key,overlay_key})
            self.assertNotIn(affected_key,params[1])
            return [detail]
        def stream(_connection,label,statement,params,**kwargs):
            self.assertTrue(label.startswith("parent_sources_"))
            self.assertIn("runtime_source_occurrences",statement)
            self.assertEqual(params[0],"parent")
            self.assertEqual(params[1],[keep_key])
            self.assertEqual(
                kwargs.get("fetch_size"),
                pg_materializer.SOURCE_SCOPE_PAYLOAD_FETCH_SIZE,
            )
            yield from occurrences

        with patch.object(pg_adapter,"_rows",side_effect=rows), \
             patch.object(pg_materializer,"_stream_pg_rows",side_effect=stream):
            completed=pg_materializer.export_unaffected_parent_sources(
                object(),writer,parent_revision_id="parent",
                source_keys={keep_key,affected_key,overlay_key},
                affected_source_keys={affected_key},
            )
        self.assertEqual(completed,{keep_key})
        self.assertEqual(set(writer.values),{keep_key})
        self.assertEqual(writer.values[keep_key]["range"],"all")
        self.assertEqual(writer.values[keep_key]["record"]["sourceDetailKey"],keep_key)
        self.assertEqual(
            [item["videoId"] for item in writer.values[keep_key]["occurrences"]],
            ["video-a","video-b"],
        )

    def test_snapshot_affected_source_sql_scales_with_key_batches_without_fallback(self):
        keys=[f"source-{index:04d}" for index in range(501)]
        with closing(sqlite3.connect(":memory:")) as database:
            scope=pg_materializer.SnapshotSourceScope(database)
            scope.add_pairs((key,f"video-{index:04d}") for index,key in enumerate(keys))
            scope.add_targets((
                "songs",f"song-{index:04d}::artist",key
            ) for index,key in enumerate(keys))

            detail_calls=[];stream_calls=[];overlay_calls=[]
            def rows(_connection,statement,params):
                if "runtime_source_details" not in statement:self.fail(statement)
                self.assertEqual(params[0],["overlay","parent"])
                self.assertEqual(params[2],["overlay","parent"])
                detail_calls.append(tuple(params[1]))
                return [{
                    "revision_id":"parent","source_key":key,"entity_type":"song",
                    "entity_key":f"song-{key[-4:]}::artist",
                    "payload_json":{
                        "type":"song","key":f"song-{key[-4:]}::artist",
                        "sourceDetailKey":key,"rangeId":"all",
                        "count":1,"occurrenceCount":1,"timestampCount":1,
                        "videoCount":1,
                    },
                } for key in params[1]]
            def stream(_connection,label,statement,params,**_kwargs):
                stream_calls.append((label,tuple(params[0]),tuple(params[1])))
                self.assertIn(
                    "ORDER BY occurrence.source_key,occurrence.position",statement,
                )
                for key,revision_id in zip(params[0],params[1]):
                    yield {
                        "revision_id":revision_id,"source_key":key,"position":1,
                        "video_id":f"video-{key[-4:]}",
                        "payload_json":{"videoId":f"video-{key[-4:]}",
                                        "occurrenceId":f"occ-{key[-4:]}",
                                        "rangeId":"all","title":f"Song {key[-4:]}",
                                        "artist":"Artist"},
                    }
            def overlay(_connection,_parent,_ids,_range,videos,**_kwargs):
                overlay_calls.append(tuple(videos));return (),{},()
            def materialized(key,**_kwargs):
                suffix=key[-4:]
                return {"schemaVersion":1,"found":True,"sourceKey":key,
                        "record":{"type":"song","key":f"song-{suffix}::artist",
                                  "sourceDetailKey":key,"rangeId":"all",
                                  "count":1,"occurrenceCount":1,
                                  "timestampCount":1,"videoCount":1,
                                  "occurrences":[{"videoId":f"video-{suffix}",
                                                  "occurrenceId":f"occ-{suffix}",
                                                  "title":f"Song {suffix}",
                                                  "artist":"Artist"}]}}
            class Writer:
                def __init__(self):self.keys=[]
                def add_source(self,key,_range,_record,occurrences):
                    self.keys.append(key);self.assertions=list(occurrences)
            writer=Writer()
            with patch.object(pg_adapter,"_rows",side_effect=rows), \
                 patch.object(pg_materializer,"_stream_pg_rows",side_effect=stream), \
                 patch.object(pg_adapter,"_snapshot_source_overlay_inputs",
                              side_effect=overlay), \
                 patch.object(pg_adapter,"_snapshot_materialized_source_payload",
                              side_effect=materialized), \
                 patch.object(pg_materializer,"export_source",
                              side_effect=AssertionError("paged exporter forbidden")), \
                 patch.object(pg_adapter,"source_payload",
                              side_effect=AssertionError("paged fallback forbidden")):
                completed=pg_materializer.export_affected_parent_sources(
                    object(),writer,parent_revision_id="parent",
                    overlay_revision_ids=("overlay",),source_scope=scope,
                    source_keys=keys,
                )
        self.assertEqual(completed,set(keys));self.assertEqual(set(writer.keys),set(keys))
        self.assertEqual([len(batch) for batch in detail_calls],[500,1])
        self.assertEqual([len(batch) for _label,batch,_revisions in stream_calls],[500,1])
        self.assertTrue(all(
            set(revisions)=={"parent"}
            for _label,_batch,revisions in stream_calls
        ))
        self.assertEqual(len(overlay_calls),2)

    def test_snapshot_affected_source_adapts_batches_and_releases_each_preimage(self):
        counts={"source-large":4,"source-small-a":1,"source-small-b":2}
        keys=tuple(counts)
        with closing(sqlite3.connect(":memory:")) as database:
            scope=pg_materializer.SnapshotSourceScope(database)
            scope.add_pairs((key,f"video-{key}") for key in keys)
            scope.add_targets(("songs",f"song-{key}::artist",key) for key in keys)
            stream_calls=[];captured_buffers=[];overlay_calls=[]
            class Writer:
                def __init__(self):self.keys=[]
                def add_source(self,key,_range,_record,_occurrences):
                    self.keys.append(key)
            writer=Writer()
            def rows(_connection,statement,params):
                self.assertIn("runtime_source_details",statement)
                return [{
                    "revision_id":"parent","source_key":key,
                    "entity_type":"song","entity_key":f"song-{key}::artist",
                    "payload_json":{
                        "type":"song","key":f"song-{key}::artist",
                        "sourceDetailKey":key,"rangeId":"all",
                        "count":counts[key],"occurrenceCount":counts[key],
                        "timestampCount":counts[key],"videoCount":1,
                    },
                } for key in params[1]]
            def stream(_connection,_label,_statement,params,**_kwargs):
                batch=tuple(params[0]);stream_calls.append((batch,params[2]))
                for key,revision_id in zip(params[0],params[1]):
                    for position in range(1,counts[key]+1):
                        yield {
                            "revision_id":revision_id,"source_key":key,
                            "position":position,"video_id":f"video-{key}",
                            "payload_json":{
                                "videoId":f"video-{key}",
                                "occurrenceId":f"{key}-{position}",
                                "title":f"Song {key}","artist":"Artist",
                            },
                        }
                        if key=="source-small-a" and position==1:
                            self.assertEqual(writer.keys,["source-large"])
            def overlay(_connection,_base,_ids,_range,videos,**_kwargs):
                overlay_calls.append(tuple(videos));return (),{},()
            def materialized(key,**kwargs):
                parent_rows=kwargs["parent_occurrences"]
                captured_buffers.append(parent_rows)
                self.assertEqual(len(parent_rows),counts[key])
                return {
                    "schemaVersion":1,"found":True,"sourceKey":key,
                    "record":{
                        "type":"song","key":f"song-{key}::artist",
                        "sourceDetailKey":key,"rangeId":"all",
                        "count":1,"occurrenceCount":1,"timestampCount":1,
                        "videoCount":1,
                        "occurrences":[{
                            "videoId":f"video-{key}",
                            "occurrenceId":f"output-{key}",
                            "title":f"Song {key}","artist":"Artist",
                        }],
                    },
                }
            with patch.object(pg_materializer,"PARENT_SOURCE_OCCURRENCE_BATCH_ROWS",5), \
                 patch.object(pg_adapter,"_rows",side_effect=rows), \
                 patch.object(pg_materializer,"_stream_pg_rows",side_effect=stream), \
                 patch.object(pg_adapter,"_snapshot_source_overlay_inputs",
                              side_effect=overlay), \
                 patch.object(pg_adapter,"_snapshot_materialized_source_payload",
                              side_effect=materialized):
                completed=pg_materializer.export_affected_parent_sources(
                    object(),writer,parent_revision_id="parent",
                    overlay_revision_ids=("overlay",),source_scope=scope,
                    source_keys=keys,
                )
        self.assertEqual(completed,set(keys))
        self.assertEqual(stream_calls,[
            (("source-large","source-small-a"),6),
            (("source-small-b",),3),
        ])
        self.assertEqual(len(overlay_calls),2)
        self.assertTrue(captured_buffers)
        self.assertTrue(all(buffer==[] for buffer in captured_buffers))

    def test_snapshot_affected_source_rejects_single_source_over_batch_cap(self):
        source_key="source-too-large"
        with closing(sqlite3.connect(":memory:")) as database:
            scope=pg_materializer.SnapshotSourceScope(database)
            scope.add_pairs(((source_key,"video-too-large"),))
            scope.add_targets((("songs","too large::artist",source_key),))
            def rows(_connection,statement,_params):
                self.assertIn("runtime_source_details",statement)
                count=pg_materializer.PARENT_SOURCE_OCCURRENCE_BATCH_ROWS+1
                return [{
                    "revision_id":"parent","source_key":source_key,
                    "entity_type":"song","entity_key":"too large::artist",
                    "payload_json":{
                        "type":"song","key":"too large::artist",
                        "sourceDetailKey":source_key,"rangeId":"all",
                        "count":count,"occurrenceCount":count,
                        "timestampCount":count,"videoCount":1,
                    },
                }]
            with patch.object(pg_adapter,"_rows",side_effect=rows), \
                 patch.object(pg_materializer,"_stream_pg_rows") as stream, \
                 patch.object(pg_adapter,"_snapshot_source_overlay_inputs") as overlay, \
                 self.assertRaisesRegex(RuntimeError,"single-source batch cap"):
                pg_materializer.export_affected_parent_sources(
                    object(),object(),parent_revision_id="parent",
                    overlay_revision_ids=("overlay",),source_scope=scope,
                    source_keys=(source_key,),
                )
            stream.assert_not_called();overlay.assert_not_called()

    def test_snapshot_affected_direct_source_rejects_parent_count_over_batch_cap(self):
        source_key="source-direct-too-large";video_id="video-too-large"
        with closing(sqlite3.connect(":memory:")) as database:
            scope=pg_materializer.SnapshotSourceScope(database)
            scope.add_pairs(((source_key,video_id),))
            scope.add_targets((("videos",video_id,source_key),))
            def rows(_connection,statement,_params):
                if "runtime_source_details" in statement:return []
                self.assertIn("count(*) AS occurrence_count",statement)
                return [{
                    "video_id":video_id,
                    "occurrence_count":
                        pg_materializer.PARENT_SOURCE_OCCURRENCE_BATCH_ROWS+1,
                }]
            with patch.object(pg_adapter,"_rows",side_effect=rows), \
                 patch.object(pg_materializer,"_stream_pg_rows") as stream, \
                 patch.object(pg_adapter,"_snapshot_source_overlay_inputs") as overlay, \
                 self.assertRaisesRegex(RuntimeError,"single-source batch cap"):
                pg_materializer.export_affected_parent_sources(
                    object(),object(),parent_revision_id="parent",
                    overlay_revision_ids=("overlay",),source_scope=scope,
                    source_keys=(source_key,),
                )
            stream.assert_not_called();overlay.assert_not_called()

    def test_snapshot_affected_source_uses_overlay_detail_base_and_newer_suffix(self):
        persisted_key="source-persisted";overlay_only_key="source-overlay-only"
        keys=(persisted_key,overlay_only_key)
        with closing(sqlite3.connect(":memory:")) as database:
            scope=pg_materializer.SnapshotSourceScope(database)
            scope.add_pairs((
                (persisted_key,"video-base"),
                (persisted_key,"video-middle"),
                (persisted_key,"video-new"),
                (overlay_only_key,"video-overlay-middle"),
                (overlay_only_key,"video-overlay-new"),
            ))
            scope.add_targets((
                ("songs","persisted::artist",persisted_key),
                ("songs","overlay only::artist",overlay_only_key),
            ))
            overlay_calls=[]
            def rows(_connection,statement,params):
                self.assertIn("runtime_source_details",statement)
                self.assertEqual(params[0],["overlay-new","overlay-middle","parent"])
                return [{
                    "revision_id":"overlay-middle","source_key":persisted_key,
                    "entity_type":"song","entity_key":"persisted::artist",
                    "payload_json":{
                        "type":"song","key":"persisted::artist",
                        "sourceDetailKey":persisted_key,"rangeId":"all",
                        "count":2,"occurrenceCount":2,"timestampCount":2,
                        "videoCount":2,
                    },
                }]
            def stream(_connection,_label,statement,params,**_kwargs):
                self.assertIn("unnest(%s::text[],%s::text[])",statement)
                self.assertEqual(params[0],[persisted_key])
                self.assertEqual(params[1],["overlay-middle"])
                for position,occurrence_id in enumerate(("base-a","middle-b"),1):
                    yield {
                        "revision_id":"overlay-middle","source_key":persisted_key,
                        "position":position,"video_id":f"video-{occurrence_id}",
                        "payload_json":{
                            "videoId":f"video-{occurrence_id}",
                            "occurrenceId":occurrence_id,"title":"Persisted",
                            "artist":"Artist",
                        },
                    }
            def candidate(occurrence_id,video_id):
                return {"occurrence_id":occurrence_id,"video_id":video_id}
            def overlay(_connection,base,ids,_range,videos,**_kwargs):
                call=(base,tuple(ids),tuple(videos));overlay_calls.append(call)
                if base=="overlay-middle":
                    self.assertEqual(tuple(ids),("overlay-new",))
                    return (candidate("new-c","video-new"),),{},()
                self.assertEqual(base,"parent")
                self.assertEqual(tuple(ids),("overlay-new","overlay-middle"))
                return (
                    candidate("overlay-middle-a","video-overlay-middle"),
                    candidate("overlay-new-b","video-overlay-new"),
                ),{},()
            rebuilt={}
            def materialized(key,**kwargs):
                occurrence_ids=[
                    item["occurrenceId"]
                    for item in kwargs["parent_occurrences"]
                ]+[
                    item["occurrence_id"] for item in kwargs["candidate_rows"]
                ]
                rebuilt[key]=tuple(occurrence_ids)
                return {
                    "schemaVersion":1,"found":True,"sourceKey":key,
                    "record":{
                        "type":"song","sourceDetailKey":key,"rangeId":"all",
                        "count":len(occurrence_ids),
                        "occurrenceCount":len(occurrence_ids),
                        "timestampCount":len(occurrence_ids),"videoCount":len(occurrence_ids),
                        "occurrences":[{
                            "videoId":f"video-{value}","occurrenceId":value,
                            "title":"Fixture","artist":"Artist",
                        } for value in occurrence_ids],
                    },
                }
            class Writer:
                def __init__(self):self.values={}
                def add_source(self,key,_range,_record,occurrences):
                    self.values[key]=tuple(item["occurrenceId"] for item in occurrences)
            writer=Writer()
            with patch.object(pg_adapter,"_rows",side_effect=rows), \
                 patch.object(pg_materializer,"_stream_pg_rows",side_effect=stream), \
                 patch.object(pg_adapter,"_snapshot_source_overlay_inputs",
                              side_effect=overlay), \
                 patch.object(pg_adapter,"_snapshot_materialized_source_payload",
                              side_effect=materialized), \
                 patch.object(pg_materializer,"export_source",
                              side_effect=AssertionError("generic-all export fallback")), \
                 patch.object(pg_adapter,"source_payload",
                              side_effect=AssertionError("generic-all payload fallback")):
                completed=pg_materializer.export_affected_parent_sources(
                    object(),writer,parent_revision_id="parent",
                    overlay_revision_ids=("overlay-new","overlay-middle"),
                    source_scope=scope,source_keys=keys,
                )
        self.assertEqual(completed,set(keys))
        self.assertEqual(rebuilt[persisted_key],("base-a","middle-b","new-c"))
        self.assertEqual(
            rebuilt[overlay_only_key],
            ("overlay-middle-a","overlay-new-b"),
        )
        self.assertEqual(writer.values,rebuilt)
        self.assertEqual({(base,ids) for base,ids,_videos in overlay_calls},{
            ("overlay-middle",("overlay-new",)),
            ("parent",("overlay-new","overlay-middle")),
        })

    def test_snapshot_materialized_source_matches_disk_scope_and_keeps_triples(self):
        title="Disk Scope Song";artist="Fixture Artist"
        group_key="\x1f".join((
            pg_adapter._overlay_song_group_norm(title),
            pg_adapter._overlay_song_group_norm(artist),
        ))
        source_key=pg_adapter._production_source_detail_key_for_group(
            "songs","all",f"{pg_adapter._overlay_norm(title)}::"
            f"{pg_adapter._overlay_norm(artist)}",
        )
        parent={
            "videoId":"video-parent","occurrenceId":"occ-parent",
            "rangeId":"all","position":1,"seconds":10,
            "title":title,"artist":artist,
        }
        candidate={
            "revision_id":"overlay","video_id":"video-new",
            "occurrence_id":"occ-new","position":2,"range_id":"all",
            "song_key":"song-new","seconds":20,"title":title,
            "artist":artist,"source_id":"source","source_system":"fixture",
            "occurrence_payload_json":{
                "videoId":"video-new","occurrenceId":"occ-new",
                "position":2,"rangeId":"all","songKey":"song-new",
                "seconds":20,"title":title,"artist":artist,
            },
            "video_title":"New Video","channel_name":"Fixture",
            "channel_id":"UCfixture","channel_handle":"@fixture",
        }
        payload=pg_adapter._snapshot_materialized_source_payload(
            source_key,range_id="all",
            persisted_record={
                "type":"song","key":f"{pg_adapter._overlay_norm(title)}::"
                f"{pg_adapter._overlay_norm(artist)}",
                "sourceDetailKey":source_key,"rangeId":"all",
            },
            targets=(("songs",group_key),),
            video_scope=("video-parent","video-new"),
            parent_occurrences=(parent,),direct_video_rows=(),
            direct_occurrence_rows=(),candidate_rows=(candidate,),
            accepted_video_resets={},runtime_changes=(),
        )
        self.assertTrue(payload["found"])
        record=payload["record"]
        self.assertEqual(
            (record["count"],record["occurrenceCount"],
             record["timestampCount"],record["videoCount"]),
            (2,2,2,2),
        )

    def test_snapshot_materialized_source_rejects_ambiguous_preimage_delete(self):
        source_key="source-ambiguous";title="Same Song";artist="Same Artist"
        parent=tuple({
            "videoId":"video-one","occurrenceId":f"occ-{index}",
            "rangeId":"all","position":index,"seconds":30,
            "title":title,"artist":artist,
        } for index in (1,2))
        with self.assertRaisesRegex(
            pg_adapter.PostgresAdapterError,"does not uniquely match",
        ):
            pg_adapter._snapshot_materialized_source_payload(
                source_key,range_id="all",
                persisted_record={
                    "type":"song","key":"same song::same artist",
                    "sourceDetailKey":source_key,"rangeId":"all",
                },
                targets=(("songs","same song::same artist"),),
                video_scope=("video-one",),parent_occurrences=parent,
                direct_video_rows=(),direct_occurrence_rows=(),candidate_rows=(),
                accepted_video_resets={},runtime_changes=({
                    "entityType":"occurrences","videoId":"video-one",
                    "rangeId":"all","seconds":30,"title":title,"artist":artist,
                },),
            )

    def test_snapshot_materialized_source_deletes_by_id_without_title_fallback(self):
        source_key="source-exact-delete";title="Exact Song";artist="Artist"
        parent=tuple({
            "videoId":"video-one","occurrenceId":f"occ-{index}",
            "rangeId":"all","position":index,"seconds":index,
            "title":title,"artist":artist,
        } for index in (1,2))
        payload=pg_adapter._snapshot_materialized_source_payload(
            source_key,range_id="all",
            persisted_record={
                "type":"song","key":"exact song::artist",
                "sourceDetailKey":source_key,"rangeId":"all",
            },
            targets=(("songs","exact song::artist"),),
            video_scope=("video-one",),parent_occurrences=parent,
            direct_video_rows=(),direct_occurrence_rows=(),candidate_rows=(),
            accepted_video_resets={},runtime_changes=({
                "entityType":"occurrences","videoId":"video-one",
                "occurrenceId":"occ-1","rangeId":"all",
            },),
        )
        self.assertTrue(payload["found"])
        self.assertEqual(
            [item["song"]["occurrenceId"]
             for item in payload["record"]["occurrences"]],
            ["occ-2"],
        )

    def test_snapshot_affected_source_batch_rejects_empty_scope_before_sql(self):
        with closing(sqlite3.connect(":memory:")) as database:
            scope=pg_materializer.SnapshotSourceScope(database)
            scope.add_targets((("songs","song::artist","source-empty"),))
            with patch.object(pg_adapter,"_rows") as rows, \
                 patch.object(pg_adapter,"_snapshot_source_overlay_inputs") as overlay, \
                 self.assertRaisesRegex(RuntimeError,"empty exact video scope"):
                pg_materializer.export_affected_parent_sources(
                    object(),object(),parent_revision_id="parent",
                    overlay_revision_ids=("overlay",),source_scope=scope,
                    source_keys=("source-empty",),
                )
            rows.assert_not_called();overlay.assert_not_called()

    def test_song_identity_treats_explicit_null_artist_as_exact_empty_artist(self):
        title="Video is completed ten minutes before publication"
        expected=(pg_adapter._overlay_song_group_norm(title),"")
        explicit_pairs,_=pg_adapter._source_song_identity_evidence(
            {"title":title,"artist":None},
        )
        missing_pairs,_=pg_adapter._source_song_identity_evidence(
            {"title":title},
        )
        self.assertIn(expected,explicit_pairs)
        self.assertEqual(missing_pairs,{})

    def test_snapshot_overlay_only_song_source_rebuilds_explicit_null_artist(self):
        title="Video is completed ten minutes before publication"
        group_key=f"{pg_adapter._overlay_norm(title)}::"
        source_key=pg_adapter._production_source_detail_key_for_group(
            "songs","all",group_key,
        )
        candidates=tuple({
            "revision_id":"overlay","video_id":"video-new",
            "occurrence_id":f"occ-{index}","position":index,
            "range_id":"all","song_key":"song-new","seconds":index,
            "title":title,"artist":None,"source_id":"source",
            "raw_hash":"raw","source_system":"fixture",
            "occurrence_payload_json":{
                "videoId":"video-new","occurrenceId":f"occ-{index}",
                "position":index,"rangeId":"all","songKey":"song-new",
                "seconds":index,"title":title,"artist":None,
            },
            "video_title":"New Video","channel_name":"Fixture",
            "channel_id":"UCfixture","channel_handle":"@fixture",
            "channel_url":"","published_at":0,"video_payload_json":{},
            "video_tombstone":False,
        } for index in range(2))
        summary={"total_occurrence_count":0,"total_video_count":0,
                 "max_position":0}
        page=[{"video_id":"video-new","first_position":1}]
        with patch.object(pg_adapter,"_rows",side_effect=[[],[summary],page]), \
             patch.object(pg_adapter,"_overlay_candidate_rows") as global_candidates, \
             patch.object(pg_adapter,"_accepted_video_resets") as global_resets, \
             patch.object(pg_adapter,"_runtime_tombstones") as global_changes:
            result=pg_adapter._generic_overlay_song_source_for_key(
                object(),"parent",source_key,
                {"range":"all","page":"1","pageSize":"200"},
                ("overlay",),candidates,{"video-new":{"video_id":"video-new"}},(),
            )
        self.assertTrue(result["found"])
        self.assertEqual(result["sourceKey"],source_key)
        self.assertEqual(
            (result["totalVideoCount"],result["totalOccurrenceCount"],
             result["totalSongCount"]),(1,2,1),
        )
        self.assertEqual(result["record"]["type"],"song")
        self.assertEqual(result["record"]["artist"],"")
        self.assertEqual(len(result["record"]["occurrences"]),2)
        global_candidates.assert_not_called();global_resets.assert_not_called();global_changes.assert_not_called()

    def test_snapshot_overlay_only_artist_source_rebuilds_exact_prepared_video(self):
        artist="\u500d\u8cde\u5343\u6075\u5b50\u3055\u3093"
        source_key=pg_adapter._production_source_detail_key_for_group(
            "artists","all",pg_adapter._overlay_artist_group_norm(artist),
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

    def test_snapshot_parent_artist_source_matches_canonical_punctuation_free_key(self):
        display_artist="岡村和義（岡村靖幸,斉藤和義）"
        canonical_artist="岡村和義岡村靖幸斉藤和義"
        video_id="jsQX01izzbY"
        source_key=pg_adapter._production_source_detail_key_for_group(
            "artists","all",canonical_artist,
        )
        self.assertEqual(source_key,"0126c6ea5a6f30f6")
        candidate={
            "revision_id":"accepted_30347149376_1","video_id":video_id,
            "occurrence_id":"position:14","position":14,"range_id":"all",
            "song_key":"song-artist","seconds":4500,"title":"カモンベイビー",
            "artist":display_artist,"source_id":"source","raw_hash":"raw",
            "source_system":"fixture",
            "occurrence_payload_json":{
                "videoId":video_id,"occurrenceId":"position:14",
                "position":14,"rangeId":"all","songKey":"song-artist",
                "seconds":4500,"title":"カモンベイビー",
                "artist":display_artist,
            },
            "video_title":"Artist Video","channel_name":"Fixture",
            "channel_id":"UCfixture","channel_handle":"@fixture",
            "channel_url":"","published_at":0,"video_payload_json":{},
            "video_tombstone":False,
        }
        parent_occurrence={
            "position":14,"video_id":video_id,"title":"Artist Video",
            "channel_name":"Fixture","channel_id":"UCfixture",
            "channel_handle":"@fixture","channel_url":"",
            "published_timestamp":0,"seconds":4500,"search_text":"",
            "payload_json":{
                "videoId":video_id,"occurrenceId":"position:14",
                "position":14,"rangeId":"all","songKey":"song-artist",
                "seconds":4500,"title":"カモンベイビー",
                "artist":display_artist,
            },
        }
        persisted={
            "type":"artist","key":canonical_artist,"name":display_artist,
            "artist":display_artist,"count":1,"occurrenceCount":1,
            "timestampCount":1,"videoCount":1,"songCount":1,
            "songs":[{"name":"カモンベイビー","count":1}],
            "channels":[{"name":"Fixture","count":1}],
            "rangeId":"all","sourceDetailKey":source_key,
        }
        summary={"total_occurrence_count":1,"total_video_count":1,
                 "max_position":14}
        page=[{"video_id":video_id,"first_position":14}]
        rows=[ [parent_occurrence], [summary], page, [parent_occurrence] ]
        with patch.object(pg_adapter,"_rows",side_effect=rows), \
             patch.object(pg_adapter,"_overlay_candidate_rows") as global_candidates, \
             patch.object(pg_adapter,"_accepted_video_resets") as global_resets, \
             patch.object(pg_adapter,"_runtime_tombstones") as global_changes:
            result=pg_adapter._generic_artist_source_payload(
                object(),"parent",persisted,source_key,
                {"range":"all","page":"1","pageSize":"200"},
                ("overlay",),(candidate,),{video_id:{"video_id":video_id}},(),
            )
        self.assertTrue(result["found"])
        self.assertEqual(result["sourceKey"],source_key)
        self.assertEqual(
            (result["totalVideoCount"],result["totalOccurrenceCount"],
             result["totalSongCount"]),(1,1,1),
        )
        self.assertEqual(result["record"]["key"],canonical_artist)
        self.assertEqual(result["record"]["name"],display_artist)
        self.assertEqual(result["record"]["occurrences"][0]["videoId"],video_id)
        self.assertEqual(
            result["record"]["occurrences"][0]["song"]["artist"],
            display_artist,
        )
        self.assertEqual(len(result["record"]["occurrences"]),1)
        global_candidates.assert_not_called();global_resets.assert_not_called();global_changes.assert_not_called()

    def test_artist_group_identity_matches_runtime_normalize_artist_key(self):
        display_artist="岡村和義（岡村靖幸,斉藤和義）"
        canonical_artist="岡村和義岡村靖幸斉藤和義"
        candidate={
            "video_id":"jsQX01izzbY","occurrence_id":"position:14",
            "position":14,"range_id":"all","song_key":"song-artist",
            "seconds":4500,"title":"カモンベイビー",
            "artist":display_artist,"occurrence_payload_json":{},
            "video_payload_json":{},"video_tombstone":False,
        }
        self.assertEqual(
            pg_adapter._overlay_artist_group_norm(display_artist),
            canonical_artist,
        )
        self.assertEqual(
            pg_adapter._runtime_view_group_key(candidate,"artists"),
            canonical_artist,
        )
        self.assertEqual(
            set(pg_adapter._overlay_candidate_groups((candidate,),"artists")),
            {canonical_artist},
        )
        source_key=pg_adapter._production_source_detail_key_for_group(
            "artists","all",canonical_artist,
        )
        with patch.object(
            pg_adapter,"_generic_artist_source_payload",return_value={"found":True},
        ) as detail:
            result=pg_adapter._generic_overlay_artist_source_for_key(
                object(),"parent",source_key,{"range":"all"},("overlay",),
                (candidate,),{},(),
            )
        self.assertTrue(result["found"])
        self.assertEqual(detail.call_args.args[2]["key"],canonical_artist)
        self.assertEqual(detail.call_args.args[2]["name"],display_artist)

    def test_artist_source_song_counts_use_runtime_entity_key_identity(self):
        current=[{"key":"planetes","name":"Planetes","count":2}]
        before=[{"song":{"title":"PLANETES"}}]
        after=[{"song":{"title":"\uff30\uff4c\uff41\uff4e\uff45\uff54\uff45\uff53"}}]
        actual=pg_adapter._adjust_source_count_list(
            current,before,after,"title",
        )
        self.assertEqual(
            actual,
            [{"key":"planetes","name":"Planetes","count":2}],
        )

    def test_artist_source_song_counts_never_use_video_title(self):
        current=[{"key":"song","name":"Song","count":2}]
        before=[{
            "title":"Old video title",
            "item":{"title":"Old video title"},
            "song":{"title":"Song","artist":"Artist"},
        }]
        after=[{
            "title":"New video title",
            "video":{"title":"New video title"},
            "song":{"title":"Song","artist":"Artist"},
        }]
        actual=pg_adapter._adjust_source_count_list(
            current,before,after,"title",
        )
        self.assertEqual(
            actual,
            [{"key":"song","name":"Song","count":2}],
        )

    def test_artist_source_alias_keys_match_reviewed_parent_owner(self):
        record={
            "type":"artist","key":"artist","name":"Artist (2023)",
            "aliases":[
                {"key":"artist2023","name":"Artist (2023)","count":{}},
            ],
        }
        self.assertEqual(
            pg_adapter._artist_source_alias_keys(record),
            {"artist","artist2023"},
        )
        with self.assertRaisesRegex(
            pg_adapter.PostgresAdapterError,
            "Artist source alias payload is invalid",
        ):
            pg_adapter._artist_source_alias_keys({
                **record,"aliases":[{"key":"","name":"Artist","count":{}}],
            })

    def test_artist_source_uses_current_global_owner_not_stale_alias(self):
        persisted={
            "type":"artist","key":"current","name":"Current",
            "aliases":[
                {"key":"alias","name":"Alias","count":{}},
            ],
            "songs":[],"channels":[],"sourceDetailKey":"source-current",
        }
        candidate={
            "video_id":"video-alias","occurrence_id":"occ-alias",
            "range_id":"all","title":"Song","artist":"Alias",
            "video_tombstone":False,
        }
        resolved=(
            {"current":"source-current","alias":"source-alias"},
            {"current":"current","alias":"alias"},
            {"current":"Current","alias":"Alias"},
        )
        with patch.object(
            pg_adapter,"_resolved_artist_parent_sources",return_value=resolved,
        ) as owners, patch.object(pg_adapter,"_rows") as rows:
            actual=pg_adapter._generic_artist_source_payload(
                object(),"parent",persisted,"source-current",
                {"range":"all"},("overlay",),(candidate,),{},(),
                artist_owner_revision_id="parent",
                artist_alias_cache={},
            )
        self.assertIsNone(actual)
        owners.assert_called_once()
        rows.assert_not_called()

    def test_artist_parent_source_resolution_uses_explicit_alias_owner(self):
        cache={}
        rows=[{
            "detail_key":"artist","name":"Artist (2023)",
            "source_key":"source-artist",
            "aliases":[{"key":"artist2023","name":"Artist (2023)","count":{}}],
        }]
        with patch.object(pg_adapter,"_rows",return_value=rows) as query:
            sources,aliases,names=pg_adapter._resolved_artist_parent_sources(
                object(),"parent",{"artist2023","overlayonly"},"all",
                alias_cache=cache,
            )
        self.assertEqual(sources,{"artist":"source-artist"})
        self.assertEqual(aliases,{"artist2023":"artist"})
        self.assertEqual(names,{"artist":"Artist (2023)"})
        self.assertIn("runtime_ranking_rows",query.call_args.args[1])
        self.assertEqual(cache[("parent","all","overlayonly")],("","",""))
        with patch.object(pg_adapter,"_rows") as cached_query:
            cached=pg_adapter._resolved_artist_parent_sources(
                object(),"parent",{"artist2023","overlayonly"},"all",
                alias_cache=cache,
            )
        self.assertEqual(cached,(sources,aliases,names))
        cached_query.assert_not_called()

    def test_artist_parent_canonical_key_wins_over_broader_alias(self):
        rows=[
            {
                "detail_key":"artist","name":"Artist",
                "source_key":"source-broad",
                "aliases":[
                    {"key":"artistspecific","name":"Artist Specific",
                     "count":1},
                ],
            },
            {
                "detail_key":"artistspecific","name":"Artist Specific",
                "source_key":"source-specific","aliases":[],
            },
        ]
        with patch.object(pg_adapter,"_rows",return_value=rows):
            sources,aliases,names=pg_adapter._resolved_artist_parent_sources(
                object(),"parent",{"artistspecific"},"all",
            )
        self.assertEqual(
            (sources,aliases,names),
            ({"artistspecific":"source-specific"},
             {"artistspecific":"artistspecific"},
             {"artistspecific":"Artist Specific"}),
        )

    def test_authoritative_artist_summary_applies_reset_and_replacement_once(self):
        artist_key="artist";source_key="source-artist"
        detail={
            "type":"artist","key":artist_key,"name":"Artist",
            "count":3,"occurrenceCount":3,"timestampCount":3,
            "songCount":3,"videoCount":2,
            "songs":[
                {"key":"a","name":"A","count":1},
                {"key":"b","name":"B","count":1},
                {"key":"c","name":"C","count":1},
            ],
            "sourceDetailKey":source_key,
        }
        touched=[]
        for position,(title,seconds) in enumerate((("B",20),("C",30)),1):
            touched.append({
                "source_key":source_key,"position":position,
                "video_id":"video-two","seconds":seconds,
                "is_niche":False,"is_unknown_artist":False,
                "payload_json":{
                    "videoId":"video-two","seconds":seconds,
                    "song":{"title":title,"artist":"Artist"},
                },
            })
        candidate=[]
        for occurrence_id,title,seconds in (("occ-b","B",20),("occ-c","C",30)):
            candidate.append({
                "video_id":"video-two","occurrence_id":occurrence_id,
                "position":seconds,"range_id":"all","song_key":title.lower(),
                "seconds":seconds,"title":title,"artist":"Artist",
                "is_niche_value":False,"is_unknown_artist_value":False,
                "occurrence_payload_json":{
                    "occurrenceId":occurrence_id,"rangeId":"all",
                    "seconds":seconds,"title":title,"artist":"Artist",
                },
                "video_payload_json":{"videoId":"video-two"},
                "video_tombstone":False,
            })
        replacement={**candidate[0],"title":"D","song_key":"d",
                     "occurrence_payload_json":{
                         "occurrenceId":"occ-b","rangeId":"all",
                         "seconds":20,"title":"D","artist":"Artist",
                     }}
        reset_changes=[
            {"entityType":"occurrences","videoId":"video-two",
             "acceptedVideoReset":True,"parentArtistGroupKey":artist_key,
             "title":title,"artist":"Artist"}
            for title in ("B","C")
        ]
        runtime_changes=[{
            "entityType":"runtime_occurrences","videoId":"video-two",
            "occurrenceId":"occ-b","title":"B","artist":"Artist",
            "seconds":20,"replacement":True,
        }]
        rows=[
            [{"artist_key":artist_key,"source_key":source_key,
              "entity_key":artist_key,"payload_json":detail,
              "songs_is_array":True,"song_array_count":3,
              "distinct_song_key_count":3,"song_occurrence_count":3,
              "invalid_song_count":0}],
            [{"source_key":source_key,"occurrence_count":3,"video_count":2}],
            touched,
        ]
        with patch.object(pg_adapter,"_rows",side_effect=rows):
            actual=pg_adapter._authoritative_artist_summary_rows(
                object(),"parent",{artist_key},{artist_key:source_key},
                {artist_key:"Artist"},{"artist":artist_key},candidate,
                reset_changes,runtime_changes,(replacement,),
                pg_adapter._query_options({
                    "range":"all","view":"artists","metric":"count",
                    "page":"1","pageSize":"30",
                }),
            )
        row=actual[artist_key];payload=row["payload_json"]
        self.assertEqual(
            (row["row_count"],row["song_count"],row["video_count"]),
            (3,3,2),
        )
        self.assertEqual(
            {item["key"]:item["count"] for item in payload["songs"]},
            {"a":1,"c":1,"d":1},
        )
        self.assertEqual(payload["sourceDetailKey"],source_key)

    def test_snapshot_authoritative_artist_keeps_three_song_preview_and_search(self):
        artist_key="artist";source_key="source-artist"
        detail={
            "type":"artist","key":artist_key,"name":"Artist",
            "count":4,"occurrenceCount":4,"timestampCount":4,
            "songCount":4,"videoCount":1,
            "songs":[
                {"key":key.lower(),"name":key,"count":1}
                for key in ("Alpha","Beta","Gamma","Delta")
            ],
            "sourceDetailKey":source_key,
        }
        rows=[
            [{"artist_key":artist_key,"source_key":source_key,
              "entity_key":artist_key,"payload_json":detail,
              "songs_is_array":True,"song_array_count":4,
              "distinct_song_key_count":4,"song_occurrence_count":4,
              "invalid_song_count":0}],
            [{"source_key":source_key,"occurrence_count":4,"video_count":1}],
        ]
        options=pg_adapter._query_options({
            "range":"all","view":"artists","metric":"count",
            "page":"1","pageSize":"30",
        })
        options["_snapshotCompactCards"]=True
        options["_snapshotSongSearchMaxChars"]=64
        with patch.object(pg_adapter,"_rows",side_effect=rows):
            actual=pg_adapter._authoritative_artist_summary_rows(
                object(),"parent",{artist_key},{artist_key:source_key},
                {artist_key:"Artist"},{"artist":artist_key},(),(),(),(),
                options,
            )
        row=actual[artist_key];payload=row["payload_json"]
        self.assertEqual((row["row_count"],row["song_count"]),(4,4))
        self.assertEqual(len(payload["songs"]),3)
        self.assertEqual(
            payload["_snapshotSongSearchText"],
            "Alpha Beta Delta Gamma",
        )
        compact=pg_adapter.compact_ranking_card(payload,"artists")
        self.assertNotIn("_snapshotSongSearchText",compact)

    def test_authoritative_artist_summary_uses_unique_source_only_preimage(self):
        artist_key="artist";source_key="source-artist"
        detail={
            "type":"artist","key":artist_key,"name":"Artist",
            "count":2,"occurrenceCount":2,"timestampCount":2,
            "songCount":2,"videoCount":1,
            "songs":[
                {"key":"a","name":"A","count":1},
                {"key":"b","name":"B","count":1},
            ],
            "sourceDetailKey":source_key,
        }
        touched=[
            {
                "source_key":source_key,"position":position,
                "video_id":"video-one","seconds":seconds,
                "is_niche":False,"is_unknown_artist":False,
                "payload_json":{
                    "videoId":"video-one","seconds":seconds,
                    "song":{"title":title,"artist":"Artist"},
                },
            }
            for position,(title,seconds) in enumerate((("A",10),("B",20)),1)
        ]
        change={
            "entityType":"runtime_occurrences","videoId":"video-one",
            "occurrenceId":"source-only-id","title":"A",
            "artist":"Artist","seconds":10,
        }
        rows=[
            [{"artist_key":artist_key,"source_key":source_key,
              "entity_key":artist_key,"payload_json":detail,
              "songs_is_array":True,"song_array_count":2,
              "distinct_song_key_count":2,"song_occurrence_count":2,
              "invalid_song_count":0}],
            [{"source_key":source_key,"occurrence_count":2,"video_count":1}],
            touched,
            [],
        ]
        with patch.object(pg_adapter,"_rows",side_effect=rows):
            actual=pg_adapter._authoritative_artist_summary_rows(
                object(),"parent",{artist_key},{artist_key:source_key},
                {artist_key:"Artist"},{"artist":artist_key},(),(),
                (change,),(),
                pg_adapter._query_options({
                    "range":"all","view":"artists","metric":"count",
                    "page":"1","pageSize":"30",
                }),
            )
        row=actual[artist_key]
        self.assertEqual(
            (row["row_count"],row["song_count"],row["video_count"]),
            (1,1,1),
        )
        self.assertEqual(row["payload_json"]["songs"],[
            {"key":"b","name":"B","count":1},
        ])

    def test_authoritative_artist_summary_rejects_ambiguous_source_only_preimage(self):
        artist_key="artist";source_key="source-artist"
        detail={
            "type":"artist","key":artist_key,"name":"Artist",
            "count":2,"occurrenceCount":2,"timestampCount":2,
            "songCount":1,"videoCount":1,
            "songs":[{"key":"a","name":"A","count":2}],
            "sourceDetailKey":source_key,
        }
        touched=[
            {
                "source_key":source_key,"position":position,
                "video_id":"video-one","seconds":10,
                "is_niche":False,"is_unknown_artist":False,
                "payload_json":{
                    "videoId":"video-one","seconds":10,
                    "song":{"title":"A","artist":"Artist"},
                },
            }
            for position in (1,2)
        ]
        change={
            "entityType":"runtime_occurrences","videoId":"video-one",
            "occurrenceId":"ambiguous-id","title":"A",
            "artist":"Artist","seconds":10,
        }
        rows=[
            [{"artist_key":artist_key,"source_key":source_key,
              "entity_key":artist_key,"payload_json":detail,
              "songs_is_array":True,"song_array_count":1,
              "distinct_song_key_count":1,"song_occurrence_count":2,
              "invalid_song_count":0}],
            [{"source_key":source_key,"occurrence_count":2,"video_count":1}],
            touched,
            [],
        ]
        with patch.object(pg_adapter,"_rows",side_effect=rows), \
             self.assertRaisesRegex(
                 pg_adapter.PostgresAdapterError,
                 "does not uniquely match source authority",
             ):
            pg_adapter._authoritative_artist_summary_rows(
                object(),"parent",{artist_key},{artist_key:source_key},
                {artist_key:"Artist"},{"artist":artist_key},(),(),
                (change,),(),
                pg_adapter._query_options({
                    "range":"all","view":"artists","metric":"count",
                    "page":"1","pageSize":"30",
                }),
            )

    def test_authoritative_artist_summary_routes_empty_artist_to_unknown(self):
        candidate={
            "video_id":"video-unknown","occurrence_id":"occ-unknown",
            "position":1,"range_id":"all","song_key":"song",
            "seconds":10,"title":"Song","artist":"",
            "is_niche_value":False,"is_unknown_artist_value":True,
            "occurrence_payload_json":{
                "occurrenceId":"occ-unknown","rangeId":"all",
                "seconds":10,"title":"Song","artist":"",
                "isUnknownArtist":True,
            },
            "video_payload_json":{"videoId":"video-unknown"},
            "video_tombstone":False,
        }
        with patch.object(pg_adapter,"_rows",side_effect=[]):
            actual=pg_adapter._authoritative_artist_summary_rows(
                object(),"parent",{"unknown"},{},{},
                {},(candidate,),(),(),(),
                pg_adapter._query_options({
                    "range":"all","view":"artists","metric":"count",
                    "page":"1","pageSize":"30",
                }),
            )
        row=actual["unknown"]
        self.assertEqual(
            (row["row_count"],row["song_count"],row["video_count"]),
            (1,1,1),
        )
        self.assertEqual(row["payload_json"]["name"],"unknown")

    def test_prepare_artist_installs_exact_authority_without_generic_replay(self):
        options=pg_adapter._query_options({
            "range":"all","view":"artists","metric":"count",
            "page":"1","pageSize":"30",
        })
        candidate={
            "video_id":"video-one","occurrence_id":"occ-one",
            "range_id":"all","title":"Song","artist":"Artist",
            "video_tombstone":False,
        }
        change={
            "entityType":"runtime_occurrences","videoId":"video-one",
            "occurrenceId":"occ-one","rangeId":"all",
            "title":"Song","artist":"Artist",
        }
        exact={
            "artist":{
                "detail_key":"artist","title":"","artist":"Artist",
                "name":"Artist","row_count":3,"song_count":2,
                "video_count":2,"timestamp_count":3,
                "payload_json":{
                    "type":"artist","key":"artist","name":"Artist",
                    "count":3,"songCount":2,"videoCount":2,
                    "timestampCount":3,"occurrences":[],
                    "sourceDetailKey":"source-artist",
                },
                "search_text":"artist","channel_search_text":"",
            },
        }
        aggregate={
            "total_count":1,"total_occurrence_count":3,
            "total_song_count":0,"total_video_count":2,
        }
        parent_row={
            "rank":1,"detail_key":"artist","title":"",
            "artist":"Artist","name":"Artist","row_count":3,
            "song_count":0,"video_count":2,"timestamp_count":3,
            "payload_json":None,"search_text":"artist",
            "channel_search_text":"",
        }
        with patch.object(pg_adapter,"_overlay_revision_ids",return_value=("overlay",)), \
             patch.object(pg_adapter,"_resolve_exact_vtuber_channel_scope",return_value=None), \
             patch.object(pg_adapter,"_one",return_value=aggregate), \
             patch.object(pg_adapter,"_rows",side_effect=[
                 [parent_row],[parent_row],[parent_row],[],
             ]), \
             patch.object(pg_adapter,"_overlay_candidate_rows",return_value=[candidate]), \
             patch.object(pg_adapter,"_accepted_video_resets",return_value={}), \
             patch.object(pg_adapter,"_snapshot_accepted_video_reset_changes",return_value=[]), \
             patch.object(pg_adapter,"_runtime_tombstones",return_value=[change]), \
             patch.object(pg_adapter,"_runtime_replacement_candidate_rows",return_value=[]), \
             patch.object(pg_adapter,"_resolved_artist_parent_sources",
                          return_value=({"artist":"source-artist"},
                                        {"artist":"artist"},
                                        {"artist":"Artist"})), \
             patch.object(pg_adapter,"_authoritative_artist_summary_rows",
                          return_value=exact) as authority, \
             patch.object(pg_adapter,"_enrich_runtime_parent_group_keys") as parent_groups, \
             patch.object(pg_adapter,"_enrich_runtime_original_group_counts") as enrich, \
             patch.object(pg_adapter,"_apply_runtime_tombstone_groups") as tombstones, \
             patch.object(pg_adapter,"_reconcile_affected_song_counts") as reconcile:
            prepared=pg_adapter._prepare_generic_overlay_rankings(
                object(),"active",("parent",{}),options,
            )
        self.assertEqual(
            (prepared["filtered"][0]["row_count"],
             prepared["filtered"][0]["song_count"],
             prepared["filtered"][0]["video_count"]),
            (3,2,2),
        )
        self.assertEqual(prepared["exactAffectedArtistKeys"],("artist",))
        authority.assert_called_once()
        parent_groups.assert_called_once()
        enrich.assert_not_called();tombstones.assert_not_called()
        reconcile.assert_not_called()

    def test_snapshot_overlay_only_vtuber_source_rebuilds_compatible_full_reset(self):
        video_id="pIaojB8RGwE";channel_id="UCDV5jA1Cgg53EdmsB8zYQpA"
        source_key=pg_adapter._production_source_detail_key_for_group(
            "vtubers","all",channel_id,
        )
        self.assertEqual(source_key,"00485aba2b39b893")
        candidate={
            "revision_id":"accepted_30347149376_1","video_id":video_id,
            "occurrence_id":"position:0","position":1,"range_id":"all",
            "song_key":"song-new","seconds":938,"title":"Nyan",
            "artist":"Unknown","source_id":"source","raw_hash":"raw",
            "source_system":"fixture",
            "occurrence_payload_json":{
                "videoId":video_id,"occurrenceId":"position:0",
                "position":1,"rangeId":"all","songKey":"song-new",
                "seconds":938,"title":"Nyan","artist":"Unknown",
            },
            "video_title":"Relay","channel_name":"Fixture VTuber",
            "channel_id":channel_id,"channel_handle":"/@fixture",
            "channel_url":f"https://www.youtube.com/channel/{channel_id}",
            "published_at":0,
            "video_payload_json":{
                "videoId":video_id,"title":"Relay","channelId":channel_id,
                "channelName":"Fixture VTuber","channelHandle":"/@fixture",
                "channelUrl":f"https://www.youtube.com/channel/{channel_id}",
            },
            "video_tombstone":False,
        }
        titleless={
            **candidate,
            "occurrence_id":"position:1","position":2,
            "song_key":"candidate-null","seconds":999,
            "title":None,"artist":None,
            "source_system":"youtube_channel_discovery",
            "occurrence_payload_json":{
                "videoId":video_id,"occurrenceId":"position:1",
                "position":2,"rangeId":"all","songKey":"candidate-null",
                "seconds":999,"title":None,"artist":None,
                "curationCandidate":{
                    "flags":["missing_artist_candidate"],"identity":None,
                },
            },
        }
        symbol_only={
            **candidate,
            "occurrence_id":"position:2","position":3,
            "song_key":"symbol-song","seconds":1060,
            "title":"\uff0b\u2642","artist":"GigaP feat. Kagamine Len",
            "occurrence_payload_json":{
                "videoId":video_id,"occurrenceId":"position:2",
                "position":3,"rangeId":"all","songKey":"symbol-song",
                "seconds":1060,"title":"\uff0b\u2642",
                "artist":"GigaP feat. Kagamine Len",
            },
        }
        resets={video_id:{"video_id":video_id}}
        with patch.object(pg_adapter,"_rows",side_effect=[[],[],[],[]]), \
             patch.object(pg_adapter,"_runtime_source_occurrences",return_value=[]), \
             patch.object(pg_adapter,"_snapshot_source_overlay_inputs") as global_prepare, \
             patch.object(pg_adapter,"_runtime_tombstones") as global_changes:
            result=pg_adapter._generic_overlay_vtuber_source_for_key(
                object(),"parent",source_key,
                {"range":"all","page":"1","pageSize":"200"},
                ("overlay",),(candidate,titleless,symbol_only),resets,(),(video_id,),
            )
        self.assertTrue(result["found"])
        self.assertEqual(result["sourceKey"],source_key)
        self.assertEqual(
            (result["totalOccurrenceCount"],result["totalSongCount"],result["totalVideoCount"]),
            (2,1,1),
        )
        self.assertEqual(result["record"]["type"],"vtuber")
        self.assertEqual(result["record"]["channelId"],channel_id)
        self.assertEqual(
            result["record"]["channelUrl"],
            "https://www.youtube.com/@fixture",
        )
        self.assertEqual(result["record"]["sourceDetailKey"],source_key)
        self.assertEqual(result["record"]["occurrences"][0]["videoId"],video_id)
        self.assertEqual(len(result["record"]["occurrences"]),2)
        global_prepare.assert_not_called();global_changes.assert_not_called()

    def test_snapshot_overlay_vtuber_route_precedes_video_and_channel_fallbacks(self):
        source_key="00485aba2b39b893"
        context=SimpleNamespace(
            runtime=None,generic_runtime=("active",{}),parent=("parent",{}),
            overlay_ids=("overlay",),authoritative_ids=(),authoritative_records=None,
        )
        prepared=(({"video_id":"pIaojB8RGwE"},),{},())
        expected={"schemaVersion":1,"found":True,"sourceKey":source_key,
                  "record":{"type":"vtuber","sourceDetailKey":source_key}}
        missing={"schemaVersion":1,"found":False,"sourceKey":source_key}
        with patch.object(pg_adapter,"_runtime_source_payload",return_value=missing), \
             patch.object(pg_adapter,"_runtime_source_key_for_channel_alias",return_value=""), \
             patch.object(pg_adapter,"_snapshot_source_overlay_inputs",return_value=prepared) as prepare, \
             patch.object(pg_adapter,"_generic_overlay_song_source_for_key",return_value=None), \
             patch.object(pg_adapter,"_generic_overlay_artist_source_for_key",return_value=None), \
             patch.object(pg_adapter,"_generic_overlay_vtuber_source_for_key",return_value=expected) as vtuber_detail, \
             patch.object(pg_adapter,"_generic_video_source_payload") as video_detail, \
             patch.object(pg_adapter,"_runtime_channel_source_payload") as channel_detail:
            result=pg_adapter.source_payload(
                object(),source_key,{"range":"all","page":"1","pageSize":"200"},
                snapshot_context=context,snapshot_video_scope=("pIaojB8RGwE",),
            )
        self.assertIs(result,expected)
        prepare.assert_called_once()
        vtuber_detail.assert_called_once_with(
            unittest.mock.ANY,"parent",source_key,
            {"range":"all","page":"1","pageSize":"200"},
            ("overlay",),*prepared,("pIaojB8RGwE",),
        )
        video_detail.assert_not_called();channel_detail.assert_not_called()

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
             patch.object(pg_adapter,"_snapshot_source_overlay_inputs",return_value=prepared) as prepare, \
             patch.object(pg_adapter,"_generic_overlay_song_source_for_key",return_value=None), \
             patch.object(pg_adapter,"_generic_overlay_artist_source_for_key",return_value=expected) as artist_detail, \
             patch.object(pg_adapter,"_generic_video_source_payload") as video_detail, \
             patch.object(pg_adapter,"_runtime_channel_source_payload") as channel_detail:
            result=pg_adapter.source_payload(
                object(),source_key,{"range":"all","page":"1","pageSize":"200"},
                snapshot_context=context,snapshot_video_scope=("PZPwqBtYM2I",),
            )
        self.assertIs(result,expected)
        prepare.assert_called_once_with(
            unittest.mock.ANY,"parent",("overlay",),"all",
            ("PZPwqBtYM2I",),include_compatible_full_reset_7d=True,
        )
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
        prepared=(({"video_id":"video-one"},),{"video-one":{"video_id":"video-one"}},())
        with patch.object(pg_adapter,"_runtime_source_payload",return_value=persisted), \
             patch.object(pg_adapter,"_snapshot_source_overlay_inputs",return_value=prepared) as prepare, \
             patch.object(pg_adapter,"_generic_song_source_payload",return_value=None), \
             patch.object(pg_adapter,"_generic_artist_source_payload",return_value=None) as artist_detail, \
             patch.object(pg_adapter,"_generic_video_source_payload") as video_detail, \
             patch.object(pg_adapter,"_runtime_channel_source_payload") as channel_detail:
            result=pg_adapter.source_payload(
                object(),source_key,{"range":"all","page":"1","pageSize":"200"},
                snapshot_context=context,snapshot_video_scope=("video-one",),
            )
        self.assertIs(result,persisted)
        prepare.assert_called_once_with(
            unittest.mock.ANY,"parent",["overlay"],"all",("video-one",),
            include_compatible_full_reset_7d=True,
        )
        artist_detail.assert_called_once_with(
            unittest.mock.ANY,"parent",persisted["record"],source_key,
            {"range":"all","page":"1","pageSize":"200"},["overlay"],*prepared,
            artist_owner_revision_id="parent",artist_alias_cache=None,
        )
        video_detail.assert_not_called();channel_detail.assert_not_called()

    def test_snapshot_resolved_artist_alias_reuses_exact_prepared_video(self):
        requested_key="artist-alias"
        resolved_key="artist-source"
        missing={"schemaVersion":1,"found":False,"sourceKey":requested_key}
        persisted={"schemaVersion":1,"found":True,"sourceKey":resolved_key,
                   "sourceRevisionId":"parent",
                   "record":{"type":"artist","key":"artist","name":"Artist",
                             "sourceDetailKey":resolved_key}}
        context=SimpleNamespace(
            runtime=None,generic_runtime=("active",{}),parent=("parent",{}),
            overlay_ids=("overlay",),authoritative_ids=(),authoritative_records=None,
        )
        prepared=(({"video_id":"video-one"},),{},())
        with patch.object(
                pg_adapter,"_runtime_source_payload",side_effect=[missing,persisted]), \
             patch.object(
                pg_adapter,"_runtime_source_key_for_channel_alias",return_value=resolved_key), \
             patch.object(
                pg_adapter,"_snapshot_source_overlay_inputs",return_value=prepared) as prepare, \
             patch.object(pg_adapter,"_generic_song_source_payload",return_value=None), \
             patch.object(
                pg_adapter,"_generic_artist_source_payload",return_value=None) as artist_detail, \
             patch.object(pg_adapter,"_generic_video_source_payload") as video_detail, \
             patch.object(pg_adapter,"_runtime_channel_source_payload") as channel_detail:
            result=pg_adapter.source_payload(
                object(),requested_key,{"range":"all","page":"1","pageSize":"200"},
                snapshot_context=context,snapshot_video_scope=("video-one",),
            )
        self.assertIs(result,persisted)
        prepare.assert_called_once_with(
            unittest.mock.ANY,"parent",["overlay"],"all",("video-one",),
            include_compatible_full_reset_7d=True,
        )
        artist_detail.assert_called_once_with(
            unittest.mock.ANY,"parent",persisted["record"],resolved_key,
            {"range":"all","page":"1","pageSize":"200"},["overlay"],*prepared,
            artist_owner_revision_id="parent",artist_alias_cache=None,
        )
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
        vtuber_source=pg_adapter._stable_key("source-vtuber","7d","UCfixture")
        self.assertIn(vtuber_source,keys)
        with closing(sqlite3.connect(target)) as database:
            counts=database.execute(
                "SELECT count(*),count(DISTINCT video_id) FROM source_occurrences WHERE range_id='7d' AND source_key=?",
                (song_source,),
            ).fetchone()
            vtuber_counts=database.execute(
                "SELECT count(*),count(DISTINCT video_id) FROM source_occurrences WHERE range_id='7d' AND source_key=?",
                (vtuber_source,),
            ).fetchone()
        self.assertEqual(exported,len(keys))
        self.assertEqual(counts,(32,31))
        self.assertEqual(vtuber_counts,(32,31))

    def test_source_export_streams_validated_pages_without_whole_source_list(self):
        source_key="streaming-source"
        pages={
            1:[
                {"videoId":"video-one","occurrenceId":"one-a","title":"One"},
                {"videoId":"video-one","occurrenceId":"one-b","title":"One"},
                {"videoId":"video-two","occurrenceId":"two-a","title":"Two"},
            ],
            2:[{"videoId":"video-three","occurrenceId":"three-a","title":"Three"}],
        }
        class ProbeWriter:
            def __init__(self):self.page_sizes=[];self.started=0;self.position=0
            def begin_source(self,key,range_id,record):
                self.started+=1;return {"source_key":key,"range_id":range_id,"position":0}
            def add_source_occurrences(self,state,values):
                rows=list(values);self.page_sizes.append(len(rows));state["position"]+=len(rows);return len(rows)
            def finish_source(self,state):self.position=state["position"];return self.position
        requested_page_sizes=[]
        def load(key,query):
            requested_page_sizes.append(int(query["pageSize"]))
            page=int(query["page"]);occurrences=pages[page]
            return {"found":True,"sourceKey":key,"page":page,
                    "pageSize":pg_materializer.SOURCE_EXPORT_VIDEO_PAGE_SIZE,
                    "pageCount":2,"totalVideoCount":3,"totalOccurrenceCount":4,
                    "record":{"type":"song","sourceDetailKey":key,"rangeId":"all",
                              "occurrences":occurrences}}
        writer=ProbeWriter()
        pg_materializer.export_source(
            object(),writer,range_id="all",source_key=source_key,payload_loader=load,
        )
        self.assertEqual(writer.started,1)
        self.assertEqual(writer.page_sizes,[3,1])
        self.assertEqual(writer.position,4)
        self.assertEqual(requested_page_sizes,[30,30])

    def test_snapshot_writer_bounds_large_source_write_batches(self):
        target=self.temp/"streaming-source.sqlite"
        writer=pg_materializer.CanonicalSnapshotWriter(target)
        source_key="large-streaming-source"
        def occurrences():
            for index in range(5000):
                yield {"videoId":f"video-{index:06d}","occurrenceId":f"occ-{index:06d}",
                       "title":f"Title {index}","channelName":"Fixture",
                       "channelId":"UCfixture","seconds":index}
        writer.add_source(
            source_key,"all",{"type":"vtuber","sourceDetailKey":source_key},occurrences(),
        )
        self.assertLessEqual(
            writer.max_source_write_batch,pg_materializer.SOURCE_WRITE_BATCH_SIZE,
        )
        writer.finish()
        with closing(sqlite3.connect(target)) as database:
            count,minimum,maximum=database.execute(
                "SELECT count(*),min(position),max(position) FROM source_occurrences "
                "WHERE source_key=? AND range_id='all'",(source_key,),
            ).fetchone()
        self.assertEqual((count,minimum,maximum),(5000,1,5000))

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
        self.assertEqual(len(FakeSnapshotPageBuilder.build_calls),8)
        self.assertEqual(
            {metric for _range_id,_view,metric,_scope
             in FakeSnapshotPageBuilder.build_calls},
            {"occurrences"},
        )
        self.assertEqual(
            {scope for _range_id,_view,_metric,scope
             in FakeSnapshotPageBuilder.build_calls},
            {"all"},
        )
        self.assertEqual(result["source_details"],8)
        self.assertEqual(result["source_occurrences"],1608)
        self.assertEqual(result["source_overlay_scope"],
                         {"videos":0,"pairs":0,"sources":0,"targets":0})
        with closing(sqlite3.connect(canonical)) as database:
            scope_marker=json.loads(dict(database.execute("SELECT key,value FROM meta"))["ranking_scope_counts_json"])
            scopes={row[0] for row in database.execute("SELECT DISTINCT scope_key FROM ranking_rows")}
            source_counts=dict(database.execute("SELECT range_id,count(*) FROM source_occurrences GROUP BY range_id"))
            ranking_payload,ranking_search=database.execute(
                "SELECT payload_json,search_text FROM ranking_rows "
                "WHERE range_id='all' AND view='songs' AND metric='count' "
                "AND scope_key='all' AND rank=1"
            ).fetchone()
        self.assertEqual(len(scope_marker),96)
        self.assertEqual(scopes,{"all","niche","visible","visibleNiche"})
        self.assertEqual(source_counts,{"7d":804,"all":804})
        self.assertEqual(len(json.loads(ranking_payload)["occurrences"]),3)
        self.assertIn("deep-only-marker",ranking_search)
        for metric in pg_materializer.METRICS:
            static_payload=json.loads((
                pages/"rankings"/"all"/"songs"/metric/"page-0001.json"
            ).read_text(encoding="utf-8"))
            self.assertEqual(static_payload["totalSongCount"],1)
            self.assertEqual(static_payload["records"][0]["songCount"],1)
        serving=self.temp/"pg-serving.sqlite"
        built=builder.build_serving_store(canonical,pages,serving,active_revision_id=REV)
        self.assertEqual(len(built["validation"]["rankingScopes"]),96)

    def test_pg_snapshot_generic_all_never_uses_per_source_fallback(self):
        pages=self.temp/"pg-generic-pages";meta=self.temp/"pg-generic-meta.json"
        canonical=self.temp/"pg-generic-canonical.sqlite"
        connection=FakePgConnection();payload_ranges=[];export_ranges=[];bulk_calls=[]
        phase_order=[]
        class GenericBuilder(FakeSnapshotPageBuilder):
            def __init__(self,connection):
                super().__init__(connection)
                self.generic_runtime=("active",{})
                self.parent=("parent",{})
                self.overlay_ids=("overlay",)
                self.authoritative_ids=()
                self.authoritative_records=None
            def prepare_source_scope(self,sqlite_connection,source_keys):
                scope=pg_materializer.SnapshotSourceScope(sqlite_connection)
                scoped=[];targets=[]
                for key in sorted(source_keys):
                    view=next(view for view in pg_materializer.VIEWS
                              if key.endswith(f"-{view}"))
                    video_id=f"scope-{key}"
                    scoped.append((key,video_id));targets.append((view,key,key))
                scope.add_videos(video_id for _key,video_id in scoped)
                scope.add_pairs(scoped);scope.add_targets(targets)
                return scope
        original_export_source=pg_materializer.export_source
        def source_payload_spy(connection,key,query):
            payload_ranges.append(str(query.get("range") or "all"))
            return fake_pg_source(connection,key,query)
        def export_source_spy(*args,**kwargs):
            range_id=str(kwargs.get("range_id") or "")
            export_ranges.append(range_id)
            if range_id=="all":
                raise AssertionError("generic-all reached per-source export_source")
            return original_export_source(*args,**kwargs)
        def bulk_export(_connection,writer,**kwargs):
            phase_order.append("affected")
            keys=tuple(sorted(kwargs["source_keys"]));bulk_calls.append(keys)
            for key in keys:
                first=fake_pg_source(
                    None,key,{"range":"all","page":1,"pageSize":30},
                )
                detail=dict(first["record"]);occurrences=[]
                for page in range(1,int(first["pageCount"])+1):
                    payload=(first if page==1 else fake_pg_source(
                        None,key,{"range":"all","page":page,"pageSize":30},
                    ))
                    occurrences.extend(payload["record"]["occurrences"])
                detail.pop("occurrences",None)
                writer.add_source(key,"all",detail,occurrences)
            return set(keys)
        def affected_preflight(*_args,**kwargs):
            phase_order.append("preflight")
            return set(kwargs["source_keys"])
        def unaffected_export(*_args,**_kwargs):
            phase_order.append("unaffected")
            return set()
        with patch.object(pg_materializer.adapter,"connect_from_env",return_value=connection), \
             patch.object(pg_materializer.adapter,"meta_payload",side_effect=fake_pg_meta), \
             patch.object(pg_materializer.adapter,"source_payload",
                          side_effect=source_payload_spy), \
             patch.object(pg_materializer,"export_source",side_effect=export_source_spy), \
             patch.object(pg_materializer,"export_affected_parent_sources",
                          side_effect=bulk_export), \
             patch.object(pg_materializer,"preflight_affected_parent_sources",
                          side_effect=affected_preflight), \
             patch.object(pg_materializer,"export_unaffected_parent_sources",
                          side_effect=unaffected_export), \
             patch.object(pg_materializer,"SnapshotPageBuilder",GenericBuilder):
            result=pg_materializer.materialize(pages,meta,canonical,REV)
        self.assertEqual(export_ranges,["7d"]*4)
        self.assertTrue(payload_ranges)
        self.assertEqual(set(payload_ranges),{"7d"})
        self.assertEqual(len(bulk_calls),1)
        self.assertEqual(len(bulk_calls[0]),4)
        self.assertEqual(phase_order,["preflight","affected","unaffected"])
        self.assertEqual(result["source_details"],8)
        self.assertEqual(result["source_occurrences"],1608)

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
        groups={"megaartist":{"artist":"","name":"Mega Artist","row_count":99,
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
        group=groups["megaartist"]
        self.assertEqual((group["row_count"],group["song_count"],group["video_count"]),(5,3,3))
        self.assertEqual((group["payload_json"]["count"],group["payload_json"]["songCount"],
                          group["payload_json"]["videoCount"]),(5,3,3))
        self.assertEqual(reconciliation_counts,
                         {("parent","all","artists","all","megaartist"):(5,3,3)})

        cached_groups={"megaartist":{"artist":"","name":"Mega Artist",
                                      "row_count":0,"song_count":0,"video_count":0,
                                      "payload_json":{"name":"Mega Artist"}}}
        niche_batches=[[{**batches[0][0],"is_niche":True}]]
        with patch.object(pg_adapter,"_rows",side_effect=niche_batches) as cached_rows:
            pg_adapter._reconcile_affected_song_counts(
                object(),"parent",[],[],changes,cached_groups,"artists",
                {"range":"all","metric":"songs","nicheOnly":True},
                reconciliation_counts=reconciliation_counts,
            )
        self.assertEqual(cached_rows.call_count,1)
        cached_group=cached_groups["megaartist"]
        self.assertEqual((cached_group["row_count"],cached_group["song_count"],
                          cached_group["video_count"]),(1,1,1))
        self.assertEqual(
            reconciliation_counts[
                ("parent","all","artists","niche","megaartist")
            ],
            (1,1,1),
        )

        with patch.object(pg_adapter,"_AFFECTED_RECONCILIATION_BATCH_SIZE",2), \
             patch.object(pg_adapter,"_MAX_AFFECTED_RECONCILIATION_OCCURRENCES",4), \
             patch.object(pg_adapter,"_rows",side_effect=batches):
            with self.assertRaisesRegex(pg_adapter.PostgresAdapterError,"streamed occurrence cap"):
                list(pg_adapter._bounded_affected_parent_occurrences(
                    object(),"parent",changes,"artists",{"range":"all"},
                ))

    def test_snapshot_accepted_reset_parent_projection_is_reused_by_range_and_mode(self):
        cache={}
        resets={"video-one":{"video_id":"video-one"}}
        occurrence_changes=[{"videoId":"video-one","occurrenceId":"occ-one"}]
        identity_changes=[{"videoId":"video-one","acceptedVideoReset":True}]
        with patch.object(pg_adapter,"_accepted_video_reset_changes",
                          return_value=occurrence_changes) as occurrences, \
             patch.object(pg_adapter,"_accepted_video_reset_identity_changes",
                          return_value=identity_changes) as identities:
            first=pg_adapter._snapshot_accepted_video_reset_changes(
                object(),"parent",resets,{"range":"all","metric":"occurrences"},
                cache=cache,
            )
            second=pg_adapter._snapshot_accepted_video_reset_changes(
                object(),"parent",resets,{"range":"all","metric":"videos",
                                          "nicheOnly":True},cache=cache,
            )
            seven=pg_adapter._snapshot_accepted_video_reset_changes(
                object(),"parent",resets,{"range":"7d","metric":"occurrences"},
                cache=cache,
            )
            identity=pg_adapter._snapshot_accepted_video_reset_changes(
                object(),"parent",resets,{"range":"all"},identity_only=True,
                cache=cache,
            )
        self.assertIs(first,second)
        self.assertIs(first,occurrence_changes)
        self.assertIs(seven,occurrence_changes)
        self.assertIs(identity,identity_changes)
        self.assertEqual(occurrences.call_count,2)
        identities.assert_called_once()
        self.assertEqual(len(cache),3)

    def test_overlay_video_projection_keeps_only_public_identity_fields(self):
        projected=pg_adapter._overlay_video_projection({
            "videoId":"video-fixture",
            "item":{
                "title":"Fixture video",
                "channelId":"UCfixture","channelName":"Fixture",
                "channelHandle":"@fixture",
                "channelUrl":"https://www.youtube.com/@fixture",
                "thumbnailUrl":"https://i.ytimg.com/vi/video-fixture/default.jpg",
                "publishedAt":"2026-08-13T00:00:00Z",
                "songs":[{"title":"large nested value"} for _ in range(100)],
                "description":"large private value",
                "curationEvidence":{"secret":"must not be retained"},
            },
            "song":{"title":"Song"},
        })
        self.assertEqual(projected,{
            "videoId":"video-fixture","title":"Fixture video",
            "channelId":"UCfixture","channelName":"Fixture",
            "channelHandle":"@fixture",
            "channelUrl":"https://www.youtube.com/@fixture",
            "thumbnailUrl":"https://i.ytimg.com/vi/video-fixture/default.jpg",
            "publishedAt":"2026-08-13T00:00:00Z",
        })

    def test_generic_video_projection_assigns_source_key_without_overlay_metadata(self):
        video_id="parent00001"
        expected=pg_adapter._stable_key("source-video","all",video_id)
        response={
            "rangeId":"all","view":"videos","records":[{
                "type":"video","key":video_id,"videoId":video_id,
                "title":"Persisted parent video","count":3,
                "songCount":2,"videoCount":1,"timestampCount":3,
            }],
        }
        with patch.object(pg_adapter,"_rows",return_value=[]):
            projected=pg_adapter._project_generic_overlay_video_records(
                object(),("overlay",),response,view="videos",
            )
        record=projected["records"][0]
        self.assertEqual(record["sourceDetailKey"],expected)
        self.assertEqual(record["sourceDetailPath"],f"/api/sources/{expected}")
        row=pg_materializer._ranking_row(
            {**record,"rank":1},payload_record={**record,"rank":1},
            range_id="all",view="videos",metric="occurrences",
            scope_key="all",expected_rank=1,
        )
        self.assertEqual(row[6],expected)

    def test_generic_video_projection_rejects_conflicting_source_key(self):
        video_id="parent00001"
        response={
            "rangeId":"all","view":"videos","records":[{
                "key":video_id,"videoId":video_id,
                "sourceDetailKey":"wrong-source-key",
            }],
        }
        with patch.object(pg_adapter,"_rows",return_value=[]), \
             self.assertRaisesRegex(
                 pg_adapter.PostgresAdapterError,
                 "sourceDetailKey conflicts",
             ):
            pg_adapter._project_generic_overlay_video_records(
                object(),("overlay",),response,view="videos",
            )

    def test_accepted_reset_preserves_raw_artist_and_public_unknown_flag(self):
        parent_row={
            "occurrence_id":"occ-old","video_id":"video-reset",
            "song_key":"song-old","title":"Torinoko City (Live)",
            "artist":"Unknown placeholder","is_unknown_artist":True,
            "range_id":"all","channel_id":"UCfixture",
            "channel_handle":"@fixture","channel_name":"Fixture",
            "channel_url":"https://www.youtube.com/channel/UCfixture",
        }
        with patch.object(pg_adapter,"_rows",return_value=[parent_row]) as rows:
            changes=pg_adapter._accepted_video_reset_changes(
                object(),"parent",{"video-reset":{"video_id":"video-reset"}},
                {"range":"all"},
            )
        self.assertEqual(len(changes),1)
        self.assertEqual(changes[0]["artist"],"Unknown placeholder")
        self.assertTrue(changes[0]["isUnknownArtist"])
        self.assertTrue(changes[0]["acceptedVideoReset"])
        self.assertIn("o.is_unknown_artist",rows.call_args.args[1])

    def test_snapshot_reset_prefers_persisted_source_only_parent_authority(self):
        video_id="video-source-only"
        channel_id="UCsourceonly"
        scalar={
            "occurrence_id":"scalar-a","video_id":video_id,
            "song_key":"scalar-song-a","seconds":10,"title":"Song A",
            "artist":"Unknown display","is_unknown_artist":True,
            "range_id":"all","channel_id":channel_id,
            "channel_handle":"@fixture","channel_name":"Fixture",
            "channel_url":"https://www.youtube.com/channel/UCsourceonly",
        }
        def payload(title,artist,seconds):
            return {
                "item":{
                    "videoId":video_id,"title":"Source-only video",
                    "channelId":channel_id,"channelHandle":"@fixture",
                    "channelName":"Fixture",
                    "channelUrl":"https://www.youtube.com/@fixture",
                },
                "song":{"title":title,"artist":artist,"seconds":seconds},
            }
        vtuber_rows=[
            {"video_id":video_id,"source_key":"vtuber-source",
             "entity_type":"vtuber","entity_key":channel_id,
             "position":100,"seconds":10,"is_unknown_artist":True,
             "payload_json":payload("Song A","Unknown display",10)},
            {"video_id":video_id,"source_key":"vtuber-source",
             "entity_type":"vtuber","entity_key":channel_id,
             "position":101,"seconds":20,"is_unknown_artist":False,
             "payload_json":payload("Song B","Artist B",20)},
        ]
        song_rows=[
            {**vtuber_rows[0],"source_key":"song-source-a",
             "entity_type":"song","entity_key":"songa::unknown",
             "position":0},
            {**vtuber_rows[1],"source_key":"song-source-b",
             "entity_type":"song","entity_key":"songb::artistb",
             "position":0},
        ]
        queries=[]
        def fake_rows(_connection,sql,params):
            compact=" ".join(sql.split());queries.append((compact,params))
            if "FROM runtime_occurrences AS o" in compact:return [scalar]
            if "persisted source authority" in compact:
                self.assertEqual(params[0],["song"])
                return song_rows
            self.fail(compact[:160])
        with patch.object(pg_adapter,"_rows",side_effect=fake_rows):
            changes=pg_adapter._accepted_video_reset_changes(
                object(),"parent",{video_id:{"video_id":video_id}},
                {"range":"all"},include_persisted_source_authority=True,
            )
        self.assertEqual(len(changes),2)
        self.assertEqual(
            [(row["title"],row["parentSongGroupKey"],row["parentArtistGroupKey"])
             for row in changes],
            [("Song A","songa::unknown","unknown"),
             ("Song B","songb::artistb","artistb")],
        )
        self.assertTrue(changes[0]["isUnknownArtist"])
        self.assertFalse(changes[1]["isUnknownArtist"])
        self.assertTrue(all(row["persistedSourceAuthority"] for row in changes))
        authority_sql,authority_params=queries[1]
        self.assertIn("runtime_source_occurrences_video_search_trgm", (
            "runtime_source_occurrences_video_search_trgm"
            if "daily_song_source_video_search_text" in authority_sql else ""
        ))
        self.assertEqual(authority_params[:3],[["song"],"parent","all"])
        self.assertEqual(authority_params[4],video_id)

    def test_snapshot_reset_source_authority_is_selected_by_view(self):
        video_id="video-by-view"
        common={
            "video_id":video_id,"position":0,"seconds":10,
            "is_unknown_artist":False,
            "payload_json":{
                "item":{"videoId":video_id,"channelId":"UCfixture"},
                "song":{"title":"Song A","artist":"Artist","seconds":10},
            },
        }
        song_row={**common,"source_key":"song","entity_type":"song",
                  "entity_key":"songa::artist"}
        artist_row={**common,"source_key":"artist","entity_type":"artist",
                    "entity_key":"artist"}
        requested=[]
        def fake_rows(_connection,sql,params):
            compact=" ".join(sql.split())
            if "FROM runtime_occurrences AS o" in compact:return []
            if "persisted source authority" in compact:
                requested.append(tuple(params[0]))
                return [song_row] if params[0]==["song"] else [artist_row]
            self.fail(compact[:160])
        with patch.object(pg_adapter,"_rows",side_effect=fake_rows):
            song_changes=pg_adapter._accepted_video_reset_changes(
                object(),"parent",{video_id:{}},{"range":"all","view":"songs"},
                include_persisted_source_authority=True,
            )
            artist_changes=pg_adapter._accepted_video_reset_changes(
                object(),"parent",{video_id:{}},{"range":"all","view":"artists"},
                include_persisted_source_authority=True,
            )
            video_changes=pg_adapter._accepted_video_reset_changes(
                object(),"parent",{video_id:{}},{"range":"all","view":"videos"},
                include_persisted_source_authority=True,
            )
        self.assertEqual(requested,[("song",),("artist",)])
        self.assertEqual(song_changes[0]["parentSongGroupKey"],"songa::artist")
        self.assertEqual(song_changes[0]["parentArtistGroupKey"],"artist")
        self.assertEqual(artist_changes[0]["parentArtistGroupKey"],"artist")
        self.assertEqual(video_changes,[])

    def test_snapshot_reset_source_authority_uses_canonical_title_only_as_fallback(self):
        video_id="video-title-rewrite"
        scalar={
            "occurrence_id":"scalar","video_id":video_id,
            "song_key":"runtime-song","seconds":15860,
            "title":"TIMES feat. chelly (EGOIST)",
            "artist":"MY FIRST STORY","is_unknown_artist":False,
            "range_id":"all","channel_id":"UCfixture",
        }
        source={
            "video_id":video_id,"source_key":"song-source",
            "entity_type":"song",
            "entity_key":"timesfeatchellyegoist::myfirststory",
            "position":9,"seconds":15860,"is_unknown_artist":False,
            "payload_json":{
                "item":{"videoId":video_id,"channelId":"UCfixture"},
                "song":{
                    "title":"1,000,000 TIMES feat. chelly (EGOIST)",
                    "artist":"MY FIRST STORY","seconds":15860,
                },
            },
        }
        with patch.object(pg_adapter,"_rows",side_effect=[[scalar],[source]]):
            changes=pg_adapter._accepted_video_reset_changes(
                object(),"parent",{video_id:{}},
                {"range":"all","view":"songs"},
                include_persisted_source_authority=True,
            )
        self.assertEqual(len(changes),1)
        self.assertEqual(
            (changes[0]["title"],changes[0]["parentSongGroupKey"]),
            ("1,000,000 TIMES feat. chelly (EGOIST)",
             "timesfeatchellyegoist::myfirststory"),
        )
        self.assertTrue(changes[0]["persistedSourceAuthority"])

    def test_snapshot_reset_source_authority_matches_raw_before_canonical_collision(self):
        video_id="video-raw-collision"
        def scalar(title,occurrence_id):
            return {
                "occurrence_id":occurrence_id,"video_id":video_id,
                "song_key":occurrence_id,"seconds":7159,"title":title,
                "artist":"*Luna","is_unknown_artist":False,
                "range_id":"all","channel_id":"UCfixture",
            }
        def source(title,key,position):
            return {
                "video_id":video_id,"source_key":f"source-{position}",
                "entity_type":"song","entity_key":key,
                "position":position,"seconds":7159,
                "is_unknown_artist":False,
                "payload_json":{
                    "item":{"videoId":video_id,"channelId":"UCfixture"},
                    "song":{"title":title,"artist":"*Luna","seconds":7159},
                },
            }
        scalar_rows=[scalar("32","occ-32"),scalar("8.32","occ-832")]
        # Reverse the source order so a canonical-first matcher would bind
        # ``32`` to the wrong persisted identity when both canonicalize alike.
        source_rows=[source("8.32","832::luna",2),source("32","32::luna",0)]
        with patch.object(pg_adapter,"_rows",side_effect=[scalar_rows,source_rows]), \
             patch.object(
                 pg_adapter,"_vtuber_canonical_song_identity",
                 side_effect=AssertionError("raw matches must precede canonical fallback"),
             ):
            changes=pg_adapter._accepted_video_reset_changes(
                object(),"parent",{video_id:{}},
                {"range":"all","view":"songs"},
                include_persisted_source_authority=True,
            )
        self.assertEqual(
            {(row["title"],row["parentSongGroupKey"]) for row in changes},
            {("32","32::luna"),("8.32","832::luna")},
        )
        self.assertEqual(len(changes),2)

    def test_snapshot_reset_source_authority_cache_is_isolated_by_view(self):
        cache={}
        resets={"video-one":{"video_id":"video-one"}}
        def fake_changes(_connection,_parent,_resets,options,**_kwargs):
            return [{"view":options["view"]}]
        with patch.object(pg_adapter,"_accepted_video_reset_changes",
                          side_effect=fake_changes) as changes:
            songs=pg_adapter._snapshot_accepted_video_reset_changes(
                object(),"parent",resets,{"range":"all","view":"songs"},
                include_persisted_source_authority=True,cache=cache,
            )
            artists=pg_adapter._snapshot_accepted_video_reset_changes(
                object(),"parent",resets,{"range":"all","view":"artists"},
                include_persisted_source_authority=True,cache=cache,
            )
            songs_again=pg_adapter._snapshot_accepted_video_reset_changes(
                object(),"parent",resets,{"range":"all","view":"songs"},
                include_persisted_source_authority=True,cache=cache,
            )
        self.assertEqual(songs,[{"view":"songs"}])
        self.assertEqual(artists,[{"view":"artists"}])
        self.assertIs(songs_again,songs)
        self.assertEqual(changes.call_count,2)
        self.assertEqual(len(cache),2)

    def test_all_song_view_includes_selected_physical_7d_reset_once(self):
        options=pg_adapter._query_options({
            "range":"all","view":"songs","metric":"occurrences",
            "page":"1","pageSize":"30",
        })
        reset={"video-reset":{"video_id":"video-reset"}}
        compatible={
            "video_id":"video-reset","occurrence_id":"accepted-7d",
            "range_id":"all","title":"Replacement","artist":"Artist",
        }
        calls={}
        def stop_after_resets(*_args,**_kwargs):
            raise RuntimeError("stop-after-resets")
        with patch.object(pg_adapter,"_overlay_revision_ids",return_value=("overlay",)), \
             patch.object(pg_adapter,"_resolve_exact_vtuber_channel_scope",return_value=None), \
             patch.object(pg_adapter,"_rows",return_value=[]), \
             patch.object(pg_adapter,"_one",return_value={
                 "total_count":0,"total_occurrence_count":0,
                 "total_song_count":0,"total_video_count":0,
             }), \
             patch.object(pg_adapter,"_overlay_candidate_rows",return_value=[]), \
             patch.object(pg_adapter,"_accepted_video_resets",return_value=reset), \
             patch.object(pg_adapter,"_selected_full_reset_candidate_rows",
                          return_value=(compatible,)) as selected, \
             patch.object(pg_adapter,"_snapshot_accepted_video_reset_changes",
                          side_effect=lambda _c,_p,resets,_o,**kwargs:
                          calls.update({"resets":resets,"kwargs":kwargs}) or []), \
             patch.object(pg_adapter,"_runtime_tombstones",side_effect=stop_after_resets), \
             self.assertRaisesRegex(RuntimeError,"stop-after-resets"):
            pg_adapter._prepare_generic_overlay_rankings(
                object(),"active",("parent",{}),options,
                snapshot_reset_changes={},
            )
        selected.assert_called_once()
        self.assertEqual(selected.call_args.args[3],"all")
        self.assertTrue(calls["kwargs"]["include_persisted_source_authority"])
        self.assertEqual(set(calls["resets"]),{"video-reset"})

    def test_accepted_reset_moves_unknown_song_into_existing_canonical_artist(self):
        title="Torinoko City (Live)"
        title_key=pg_adapter._overlay_song_group_norm(title)
        old_key=f"{title_key}::unknown"
        new_key=f"{title_key}::40mp"
        raw_new_key=(
            f"{pg_adapter._overlay_norm(title)}::"
            f"{pg_adapter._overlay_norm('40mP')}"
        )
        change={
            "entityType":"occurrences","videoId":"video-reset",
            "occurrenceId":"occ-old","title":title,
            "artist":"Unknown placeholder","isUnknownArtist":True,
            "acceptedVideoReset":True,
            "originalGroupVideoOccurrenceCount":1,
        }
        groups={
            old_key:{
                "detail_key":old_key,"title":title,"artist":"",
                "row_count":1,"song_count":1,"video_count":1,
                "timestamp_count":1,"payload_json":None,
            },
            new_key:{
                "detail_key":new_key,"title":title,"artist":"40mP",
                "row_count":4,"song_count":1,"video_count":4,
                "timestamp_count":4,"payload_json":None,
            },
        }
        self.assertEqual(
            pg_adapter._runtime_change_group_key(change,"songs"),old_key,
        )
        self.assertEqual(
            pg_adapter._runtime_change_group_key(change,"artists"),"unknown",
        )
        pg_adapter._apply_runtime_tombstone_groups(
            groups,[change],"songs",allow_accepted_reset_detail_fallback=True,
        )
        self.assertNotIn(old_key,groups)

        delta={raw_new_key:{
            "title":title,"artist":"40mP","name":title,
            "occurrenceCount":1,"occurrences":[{
                "videoId":"video-reset","occurrenceId":"occ-new",
            }],"videoIds":{"video-reset"},"songKeys":{"song-new"},
            "search":"torinoko city 40mp",
        }}
        persisted={new_key:dict(groups[new_key])}
        pg_adapter._apply_overlay_delta_groups(
            groups,persisted,delta,"songs","all",
        )
        self.assertEqual(set(groups),{new_key})
        self.assertEqual(groups[new_key]["row_count"],5)
        self.assertEqual(groups[new_key]["video_count"],5)
        self.assertNotIn(raw_new_key,groups)

    def test_unknown_artist_reconciliation_uses_physical_runtime_flag(self):
        change={
            "entityType":"occurrences","videoId":"video-reset",
            "occurrenceId":"occ-old","title":"Old Song",
            "artist":"Unknown placeholder","isUnknownArtist":True,
            "acceptedVideoReset":True,
        }
        parent_row={
            "occurrence_id":"occ-keep","video_id":"video-keep",
            "song_key":"song-keep","title":"Kept Song",
            "artist":"Different placeholder","is_unknown_artist":True,
            "channel_id":"UCfixture","channel_handle":"@fixture",
            "channel_name":"Fixture",
        }
        connection=SimpleNamespace(autocommit=True)
        with patch.object(pg_adapter,"_rows",return_value=[parent_row]) as rows:
            selected=list(pg_adapter._bounded_affected_parent_occurrences(
                connection,"parent",[change],"artists",{"range":"all"},
            ))
        self.assertEqual(selected,[parent_row])
        statement=rows.call_args.args[1]
        params=rows.call_args.args[2]
        self.assertIn("o.is_unknown_artist IS TRUE",statement)
        self.assertIn("o.is_unknown_artist",statement)
        self.assertIn(True,params)
        self.assertEqual(
            pg_adapter._runtime_view_group_key(parent_row,"artists"),
            "unknown",
        )

    def test_runtime_parent_group_keys_use_exact_physical_unknown_flag(self):
        cache={}
        original_artist="\u672a\u8a18\u8f09"
        first={
            "entityType":"occurrences","videoId":"ZQtuEfpiawc",
            "occurrenceId":"a858aab31ec7cd9ffb7d30e7",
            "title":"Snow halation \u5408\u5531","artist":original_artist,
            "replacement":True,
        }
        second=dict(first)
        parent_row={
            "video_id":"ZQtuEfpiawc",
            "occurrence_id":"a858aab31ec7cd9ffb7d30e7",
            "title":"Snow halation \u5408\u5531","artist":original_artist,
            "is_unknown_artist":True,
        }
        with patch.object(pg_adapter,"_rows",return_value=[parent_row]) as rows:
            pg_adapter._enrich_runtime_parent_group_keys(
                object(),"parent",[first],range_id="all",
                parent_group_cache=cache,
            )
            pg_adapter._enrich_runtime_parent_group_keys(
                object(),"parent",[second],range_id="all",
                parent_group_cache=cache,
            )
        self.assertEqual(rows.call_count,1)
        statement=rows.call_args.args[1]
        params=rows.call_args.args[2]
        self.assertIn("jsonb_to_recordset",statement)
        self.assertIn("o.is_unknown_artist",statement)
        self.assertEqual(params[1:3],["parent",["all",""]])
        requested=json.loads(params[0])
        self.assertEqual(requested,[{
            "video_id":"ZQtuEfpiawc",
            "occurrence_id":"a858aab31ec7cd9ffb7d30e7",
        }])
        for change in (first,second):
            self.assertIs(change["isUnknownArtist"],True)
            self.assertEqual(change["parentArtistGroupKey"],"unknown")
            self.assertEqual(
                change["parentSongGroupKey"],
                "snowhalation\u5408\u5531::unknown",
            )

    def test_runtime_replacement_removes_explicit_parent_song_group(self):
        old_key="snowhalation\u5408\u5531::unknown"
        groups={old_key:{
            "detail_key":old_key,"title":"Snow halation \u5408\u5531",
            "artist":"","row_count":1,"timestamp_count":1,
            "song_count":1,"video_count":1,"payload_json":None,
        }}
        change={
            "entityType":"occurrences","videoId":"ZQtuEfpiawc",
            "occurrenceId":"a858aab31ec7cd9ffb7d30e7",
            "title":"Snow halation \u5408\u5531","artist":"\u672a\u8a18\u8f09",
            "isUnknownArtist":True,"parentSongGroupKey":old_key,
            "parentArtistGroupKey":"unknown",
            "originalGroupVideoOccurrenceCount":1,"replacement":True,
            "replacementPayload":{
                "videoId":"ZQtuEfpiawc",
                "occurrenceId":"a858aab31ec7cd9ffb7d30e7",
                "title":"Snow halation \u5408\u5531",
                "artist":"\u03bc's (Love Live!)",
            },
        }
        pg_adapter._apply_runtime_tombstone_groups(
            groups,[change],"songs",
        )
        self.assertEqual(groups,{})

    def test_snapshot_parent_group_counts_reuse_exact_video_set(self):
        cache={}
        first_change={"videoId":"video-one","title":"Old Song","artist":"Artist"}
        second_change={"videoId":"video-one","title":"Old Song","artist":"Artist"}
        seven_day_change={"videoId":"video-one","title":"Old Song","artist":"Artist"}
        niche_change={"videoId":"video-one","title":"Old Song","artist":"Artist"}
        other_change={"videoId":"video-two","title":"Other Song","artist":"Artist"}
        def parent_rows(_connection,_sql,params):
            count=1 if params[1][0]=="7d" else 2 if params[3] else 3
            return [{"video_id":params[2][0],"title":"Old Song","artist":"Artist",
                     "occurrence_count":count}]
        with patch.object(pg_adapter,"_rows",side_effect=parent_rows) as rows:
            pg_adapter._enrich_runtime_original_group_counts(
                object(),"parent",[],[first_change],range_id="all",
                parent_count_cache=cache,
            )
            pg_adapter._enrich_runtime_original_group_counts(
                object(),"parent",[],[second_change],range_id="all",
                parent_count_cache=cache,
            )
            pg_adapter._enrich_runtime_original_group_counts(
                object(),"parent",[],[seven_day_change],range_id="7d",
                parent_count_cache=cache,
            )
            pg_adapter._enrich_runtime_original_group_counts(
                object(),"parent",[],[niche_change],range_id="all",
                options={"nicheOnly":True},parent_count_cache=cache,
            )
            pg_adapter._enrich_runtime_original_group_counts(
                object(),"parent",[],[other_change],range_id="all",
                parent_count_cache=cache,
            )
        self.assertEqual(rows.call_count,4)
        self.assertEqual(
            rows.call_args_list[0].args[2],
            ["parent",["all",""],["video-one"],False,False],
        )
        self.assertEqual(
            rows.call_args_list[1].args[2],
            ["parent",["7d",""],["video-one"],False,False],
        )
        self.assertEqual(
            rows.call_args_list[2].args[2],
            ["parent",["all",""],["video-one"],True,False],
        )
        self.assertEqual(
            rows.call_args_list[3].args[2],
            ["parent",["all",""],["video-two"],False,False],
        )
        self.assertEqual(first_change["originalGroupVideoOccurrenceCount"],3)
        self.assertEqual(second_change["originalGroupVideoOccurrenceCount"],3)
        self.assertEqual(seven_day_change["originalGroupVideoOccurrenceCount"],1)
        self.assertEqual(niche_change["originalGroupVideoOccurrenceCount"],2)
        self.assertEqual(other_change["originalGroupVideoOccurrenceCount"],0)
        self.assertEqual(len(cache),4)

    def test_snapshot_phase_release_clears_reset_and_scalar_caches(self):
        key=("parent","all","occurrences",("video-one",))
        fake_builder=SimpleNamespace(
            authoritative_records=(1,),
            reconciliation_counts={("parent","all","artists","all","artist"):(1,1,1)},
            snapshot_reset_changes={key:[{"videoId":"video-one"}]},
            snapshot_original_group_counts={
                ("parent","all","all",("video-one",)):{
                    ("video-one","song","artist"):1,
                },
            },
            snapshot_vtuber_source_totals={
                ("parent","all","source-one"):(1,1),
            },
        )
        checkpoints=[]
        fake_writer=SimpleNamespace(
            checkpoint=lambda *,shrink:checkpoints.append(shrink),
        )
        pg_materializer._release_materializer_memory(
            fake_writer,fake_builder,phase="rankings",drop_authoritative=True,
        )
        self.assertIsNone(fake_builder.authoritative_records)
        self.assertEqual(fake_builder.reconciliation_counts,{})
        self.assertEqual(fake_builder.snapshot_reset_changes,{})
        self.assertEqual(fake_builder.snapshot_original_group_counts,{})
        self.assertEqual(fake_builder.snapshot_vtuber_source_totals,{})
        self.assertEqual(checkpoints,[True])

    def test_ranking_combo_release_trims_heap_and_reports_rss_and_swap(self):
        with (
            patch.object(pg_materializer,"_trim_process_heap",return_value=True) as trim,
            patch.object(pg_materializer,"_current_rss_kib",return_value=123456),
            patch.object(pg_materializer,"_current_swap_kib",return_value=789),
            patch("builtins.print") as printer,
        ):
            pg_materializer._release_ranking_combo_memory(
                range_id="all",view="videos",metric="songs",scope_key="visible",
            )
        trim.assert_called_once_with()
        printer.assert_called_once_with(
            "PG_SNAPSHOT_COMBO_RELEASE all/videos/songs/visible "
            "rss_kib=123456 swap_kib=789 trimmed=1",
            flush=True,
        )

    def test_vtuber_combo_release_clears_recomputable_payload_caches(self):
        fake_builder=SimpleNamespace(
            snapshot_reset_changes={("parent","all","source-authority:vtubers",()):[{}]},
            reconciliation_counts={("parent","all","vtubers","niche","key"):(1,1,1)},
            snapshot_vtuber_source_totals={("parent","all","source"):(1,1)},
        )
        pg_adapter._VTUBER_REPLACEMENT_CACHE[("old",)]={"payload":"large"}
        pg_adapter._GENERIC_RANKING_PREPARATION_CACHE[("old",)]={"payload":"large"}
        with (
            patch.object(pg_materializer,"_trim_process_heap",return_value=True),
            patch.object(pg_materializer,"_current_rss_kib",return_value=1),
            patch.object(pg_materializer,"_current_swap_kib",return_value=0),
            patch("builtins.print"),
        ):
            pg_materializer._release_ranking_combo_memory(
                range_id="all",view="vtubers",metric="occurrences",scope_key="niche",
                builder=fake_builder,
            )
        self.assertEqual(pg_adapter._VTUBER_REPLACEMENT_CACHE,{})
        self.assertEqual(pg_adapter._GENERIC_RANKING_PREPARATION_CACHE,{})
        self.assertEqual(fake_builder.snapshot_reset_changes,{})
        self.assertEqual(fake_builder.reconciliation_counts,{})
        self.assertEqual(
            fake_builder.snapshot_vtuber_source_totals,
            {("parent","all","source"):(1,1)},
        )

    def test_completed_view_release_drops_only_expired_snapshot_caches(self):
        fake_builder=SimpleNamespace(
            reconciliation_counts={("parent","all","songs","all","key"):(1,1,1)},
            snapshot_reset_changes={("parent","all","source-authority:songs",()):[{}]},
            snapshot_original_group_counts={("parent","all","all",()):{}},
            snapshot_vtuber_source_totals={("parent","all","source"):(1,1)},
        )
        with (
            patch.object(pg_materializer,"_trim_process_heap",return_value=True),
            patch.object(pg_materializer,"_current_rss_kib",return_value=2),
            patch.object(pg_materializer,"_current_swap_kib",return_value=0),
            patch("builtins.print"),
        ):
            pg_materializer._release_completed_ranking_view_memory(
                fake_builder,range_id="all",view="songs",
            )
        self.assertEqual(fake_builder.reconciliation_counts,{})
        self.assertEqual(fake_builder.snapshot_reset_changes,{})
        self.assertEqual(fake_builder.snapshot_original_group_counts,{})
        self.assertEqual(
            fake_builder.snapshot_vtuber_source_totals,
            {("parent","all","source"):(1,1)},
        )
        with (
            patch.object(pg_materializer,"_trim_process_heap",return_value=True),
            patch.object(pg_materializer,"_current_rss_kib",return_value=2),
            patch.object(pg_materializer,"_current_swap_kib",return_value=0),
            patch("builtins.print"),
        ):
            pg_materializer._release_completed_ranking_view_memory(
                fake_builder,range_id="all",view="vtubers",
            )
        self.assertEqual(fake_builder.snapshot_vtuber_source_totals,{})

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
        for required in (
            "ubuntu_gate:",
            "runs-on: ubuntu-latest",
            "runs-on: [self-hosted, macOS, ARM64, daily-song-list-mac]",
            "materialize-pg-release-snapshot.py",
            "scripts/migration/pg-peer-relay.py",
            "server/pg_adapter.py",
            "--snapshot-output",
            "build-serving-store.py",
            "release_serving_server.py",
            "install-wdc-release.sh",
            "--build-logic-sha",
            "/Users/be/codex-temp/dsl-wdc-sync-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}",
            ".codex-owned-run",
            "--socket /var/run/postgresql/.s.PGSQL.5432",
            "--require-user www-data",
            '-L "127.0.0.1:${LOCAL_PORT}:127.0.0.1:${RELAY_PORT}"',
            "PGHOST=127.0.0.1",
            'PGPORT="$LOCAL_PORT"',
            'PGAPPNAME="dsl-wdc-snapshot-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
            'PYTHONPATH="$PYTHON_DEPS_ROOT:$GITHUB_WORKSPACE/server:$GITHUB_WORKSPACE"',
            '"$MAC_PYTHON" scripts/migration/materialize-pg-release-snapshot.py --help >/dev/null',
            'MATERIALIZE_LOG="$MAC_RUN_ROOT/materialize.log"',
            "PYTHONUNBUFFERED=1",
            '2>&1 | tee "$MATERIALIZE_LOG"',
            "SOURCE_TRIPLET_STABLE_AFTER_BUILD",
            "SOURCE_TRIPLET_STABLE_BEFORE_WDC_WRITE",
            "SOURCE_TRIPLET_STABLE_BEFORE_ACTIVATE",
            "SOURCE_TRIPLET_STABLE_AFTER_ACTIVATE",
            "release.tar.gz.part",
            'tar -C "$BUNDLE_ROOT" -czf - "$BUNDLE_SHA"',
            'WDC_PROJECT_ROOT: "/opt/culua/ytb-song-rank"',
            'WDC_PROJECT_MAX_BYTES: "40000000000"',
            'WDC_FILESYSTEM_RESERVE_BYTES: "5000000000"',
            "WDC_STORAGE_PREFLIGHT_OK",
            "WDC_STORAGE_FINAL_OK",
            "--consume-source-db",
            "--link-serving-sqlite",
            "if: always()",
            'EXPECTED_APP_NAME="dsl-wdc-snapshot-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity",
            "SELECT count(*) FROM pg_stat_activity WHERE application_name = '$app_name'",
            '[[ "$remaining" == "0" ]]',
            "VPS2_RELAY_BACKEND_CLEAN",
            "WDC_EXACT_INCOMING_CLEAN",
            'exit "$cleanup_status"',
        ):
            self.assertIn(required,workflow)
        for forbidden in (
            "build-serving-sqlite.py",
            "PUBLIC_BASE",
            "https://ytb-song-rank.culua.com",
            "/api/rankings?range=",
            "VPS2_RUNTIME_DB",
            "snapshot-runtime-db.py",
            "/var/lib/culua/ytb-song-rank/song-rank.sqlite",
            "PGHOST=/var/run/postgresql",
            "Legacy VPS2",
            "REMOTE_ROOT",
            "/tmp/ssh",
            "StrictHostKeyChecking=no",
            "actions/upload-artifact",
            "actions/download-artifact",
            "Materialize + build bundle on old production",
            "/tmp/dsl-wdc-pages",
            "/tmp/dsl-wdc-bundles",
            "--property=LimitFSIZE=6G",
            "VPS2_STORAGE_PREFLIGHT_OK",
            "VPS2_FILESYSTEM_RUNTIME_GUARD",
            "VPS2_CANONICAL_RELEASED",
            "VPS2_SERVING_HARDLINK_MISMATCH",
            "RUNNER_ARCHIVE_READY",
            "if: always() &&",
            "-mindepth",
            "ionice",
        ):
            self.assertNotIn(forbidden,workflow)
        self.assertIn('[[ "$project_root" == "/opt/culua/ytb-song-rank" ]]',workflow)
        self.assertIn('[[ "$releases_root" == "$project_root/releases" ]]',workflow)
        self.assertIn('projected_bytes=$((current_bytes + incoming_bytes))',workflow)
        self.assertLess(
            workflow.index("SOURCE_TRIPLET_STABLE_BEFORE_WDC_WRITE"),
            workflow.index('install -d -m 0750 "$project_root/incoming"'),
        )
        self.assertLess(
            workflow.index('[[ "$remaining" == "0" ]]'),
            workflow.index('rm -rf -- "$relay_root"'),
        )
        self.assertLess(
            workflow.index('.codex-owned-run" 2>/dev/null)'),
            workflow.index('rm -rf -- "$EXPECTED_MAC_ROOT"'),
        )
        self.assertNotIn('du -s /opt/culua',workflow)
        self.assertNotIn('rm -rf /opt/culua',workflow)
        self.assertIn("DEPLOY_ROLLBACK",installer)
        self.assertIn("PREVIOUS_RELEASE_HEALTH_OK",installer)
        self.assertIn("--previous-release-sha",installer)
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
