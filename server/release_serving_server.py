#!/usr/bin/env python3
"""Fail-closed immutable release server for the WDC site.

No route contacts the old production site. Rankings come from local immutable
chunks or local SQLite; source detail and search come only from serving.sqlite
inside the same content-addressed release.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import http.client
import json
import math
import os
import re
import socket
import sqlite3
import sys
import threading
import time
import traceback
import uuid
from collections import OrderedDict
from contextlib import closing
from copy import deepcopy
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence
from urllib.parse import parse_qs, unquote, urlparse

SERVER_API_VERSION=3
SERVING_SCHEMA_VERSION=4
CHUNK_SIZE=200
MAX_PAGE_SIZE=200
SHA_RE=re.compile(r"^[0-9a-f]{64}$")
REQUEST_ID_RE=re.compile(r"^[A-Za-z0-9._:-]{1,96}$")
SOURCE_KEY_RE=re.compile(r"^[^/\\\x00]{1,512}$")
THUMBNAIL_RE=re.compile(r"^/api/thumbnails/([A-Za-z0-9_-]{11})/(default|mqdefault|hqdefault|sddefault|maxresdefault)\.jpg$")
METRIC_ALIASES={"count":"occurrences"}
DB_METRIC_CANDIDATES={"occurrences":("count","occurrences"),"songs":("songs",),"videos":("videos",)}
SEARCH_FIELDS={"title","artist","channel","video","source"}


class ApiError(Exception):
    def __init__(self,status:int,code:str,message:str,**details:Any):
        super().__init__(message);self.status=int(status);self.code=code;self.message=message;self.details=details


class BoundedCache:
    def __init__(self,max_bytes:int,max_entries:int):
        self.max_bytes=max(0,int(max_bytes));self.max_entries=max(1,int(max_entries))
        self.bytes=0;self.items:OrderedDict[Any,tuple[Any,int]]=OrderedDict();self.lock=threading.Lock()
    def get(self,key:Any)->Any|None:
        with self.lock:
            item=self.items.get(key)
            if item is None:return None
            self.items.move_to_end(key);return item[0]
    def put(self,key:Any,value:Any,size:int)->None:
        size=max(0,int(size))
        with self.lock:
            old=self.items.pop(key,None)
            if old:self.bytes-=old[1]
            self.items[key]=(value,size);self.bytes+=size
            while self.items and (len(self.items)>self.max_entries or self.bytes>self.max_bytes):
                _,evicted=self.items.popitem(last=False);self.bytes-=evicted[1]


CHUNK_CACHE=BoundedCache(96*1024*1024,512)
RESPONSE_CACHE=BoundedCache(64*1024*1024,2000)
STATUS_CACHE=BoundedCache(4*1024*1024,64)
THUMBNAIL_CACHE=BoundedCache(32*1024*1024,256)
KEY_LOCKS:dict[tuple[Any,...],threading.Lock]={}
KEY_LOCKS_GUARD=threading.Lock()


def key_lock(key:tuple[Any,...])->threading.Lock:
    with KEY_LOCKS_GUARD:
        return KEY_LOCKS.setdefault(key,threading.Lock())


def json_object(value:Any)->dict[str,Any]:
    if isinstance(value,dict):return value
    if isinstance(value,str) and value.strip():
        try:parsed=json.loads(value)
        except json.JSONDecodeError:return {}
        return parsed if isinstance(parsed,dict) else {}
    return {}


def canonical_json(value:Any)->bytes:
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":"),default=str).encode("utf-8")


def sha256_bytes(value:bytes)->str:return hashlib.sha256(value).hexdigest()

def sha256_file(path:Path)->str:
    digest=hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b""):digest.update(chunk)
    return digest.hexdigest()


def release_content_sha(meta:Mapping[str,Any],manifest:Mapping[str,Any])->str:
    meta_identity=dict(meta);manifest_identity=dict(manifest)
    meta_identity.pop("contentSha256",None);manifest_identity.pop("contentSha256",None)
    return sha256_bytes(canonical_json({"meta":meta_identity,"manifest":manifest_identity}))


def qvalue(query:Mapping[str,list[str]],key:str,default:str="")->str:
    values=query.get(key) or [];return str(values[-1]).strip() if values else default


def qint(query:Mapping[str,list[str]],key:str,default:int,*,minimum:int=1,maximum:int=MAX_PAGE_SIZE)->int:
    try:value=int(qvalue(query,key,str(default)))
    except (TypeError,ValueError):value=default
    return max(minimum,min(maximum,value))


def qpagination(query:Mapping[str,list[str]],key:str,default:int,*,maximum:int)->int:
    raw=qvalue(query,key)
    if not raw:return default
    try:value=int(raw)
    except (TypeError,ValueError) as exc:raise ApiError(400,"invalid_pagination",f"{key} must be an integer",field=key,value=raw) from exc
    if value<1 or value>maximum:
        raise ApiError(400,"invalid_pagination",f"{key} is out of range",field=key,value=value,minimum=1,maximum=maximum)
    return value


def qbool(query:Mapping[str,list[str]],key:str)->bool:return qvalue(query,key).casefold() in {"1","true","yes","on"}

def like_escape(value:str)->str:return value.replace("\\","\\\\").replace("%","\\%").replace("_","\\_")

def fts_phrase(value:str)->str:return '"'+value.replace('"','""')+'"'


def compact_record(record:Mapping[str,Any],view:str)->dict[str,Any]:
    drop={"payload","payload_json","occurrence_payload_json","video_payload_json","searchText"}
    result:dict[str,Any]={}
    for key,value in record.items():
        if key.startswith("_") or key in drop:continue
        if isinstance(value,(str,int,float,bool)) or value is None:result[key]=deepcopy(value)
        elif key=="artists" and isinstance(value,list):result[key]=deepcopy(value)
        elif key=="songs" and isinstance(value,list) and view!="vtubers":result[key]=deepcopy(value[:3] if view in {"artists","videos"} else value)
    previews=[];seen=set()
    for item in record.get("occurrences") or []:
        if not isinstance(item,Mapping):continue
        nested=item.get("item") if isinstance(item.get("item"),Mapping) else {}
        video_id=str(item.get("videoId") or nested.get("videoId") or "")
        identity=f"video:{video_id}" if video_id else json.dumps(item,ensure_ascii=False,sort_keys=True)
        if identity in seen:continue
        seen.add(identity);preview=deepcopy(dict(item))
        for key in drop:preview.pop(key,None)
        previews.append(preview)
        if len(previews)>=3:break
    result["occurrences"]=previews;result["sourcePreviewCount"]=len(previews)
    try:total=int(record.get("count") or record.get("timestampCount") or 0)
    except (TypeError,ValueError):total=0
    result["occurrencePreviewLimited"]=bool(record.get("occurrencePreviewLimited") or total>len(previews))
    return result


def normalize_occurrence(row:sqlite3.Row)->dict[str,Any]:
    item=json_object(row["payload_json"])
    if isinstance(item.get("payload"),Mapping):item=dict(item["payload"])
    fields={"videoId":row["video_id"],"title":row["title"],"channelName":row["channel_name"],
            "channelId":row["channel_id"],"channelHandle":row["channel_handle"],"channelUrl":row["channel_url"],
            "publishedAt":row["published_timestamp"],"seconds":row["seconds"]}
    for key,value in fields.items():
        if key not in item:item[key]=value
    return item


def scope_key(niche_only:bool,hide_unknown:bool)->str:
    if niche_only and hide_unknown:return "visibleNiche"
    if niche_only:return "niche"
    if hide_unknown:return "visible"
    return "all"


def declared_ranking_scopes(connection:sqlite3.Connection)->dict[str,int]:
    row=connection.execute(
        "SELECT value FROM serving_meta WHERE key='ranking_scope_counts_json'"
    ).fetchone()
    if not row or not str(row[0] or "").strip():return {}
    try:value=json.loads(str(row[0]))
    except json.JSONDecodeError as exc:raise ValueError("ranking scope marker is invalid") from exc
    if not isinstance(value,dict):raise ValueError("ranking scope marker is not an object")
    result={}
    for key,count in value.items():
        try:result[str(key)]=int(count)
        except (TypeError,ValueError) as exc:raise ValueError("ranking scope count is invalid") from exc
    return result


class ReleaseStore:
    def __init__(self,releases_root:Path):
        self.releases_root=releases_root.resolve();self.running_server_sha256=sha256_file(Path(__file__).resolve())

    def release_dir(self,sha:str)->Path:
        if not SHA_RE.fullmatch(sha):raise ApiError(400,"invalid_release","invalid release hash")
        path=(self.releases_root/sha).resolve()
        if path.parent!=self.releases_root or not path.is_dir():raise ApiError(404,"release_not_found","release does not exist")
        return path

    def current_sha(self)->str:
        try:path=(self.releases_root/"current").resolve(strict=True)
        except (OSError,RuntimeError) as exc:raise ApiError(503,"no_current_release","current release pointer unavailable") from exc
        if path.parent!=self.releases_root or not path.is_dir() or not SHA_RE.fullmatch(path.name):
            raise ApiError(503,"invalid_current_release","current release pointer invalid")
        return path.name

    def resolve_sha(self,requested:str="")->str:
        if requested:self.release_dir(requested);return requested
        return self.current_sha()

    def read_json(self,sha:str,name:str)->dict[str,Any]:
        path=self.release_dir(sha)/name
        if not path.is_file():raise ApiError(503,"release_incomplete",f"missing {name}")
        try:value=json.loads(path.read_text(encoding="utf-8"))
        except (OSError,json.JSONDecodeError) as exc:raise ApiError(503,"release_invalid",f"invalid {name}") from exc
        if not isinstance(value,dict):raise ApiError(503,"release_invalid",f"invalid {name}")
        return value

    def meta(self,sha:str)->dict[str,Any]:return self.read_json(sha,"meta.json")
    def manifest(self,sha:str)->dict[str,Any]:return self.read_json(sha,"manifest.json")

    def open_db(self,sha:str)->sqlite3.Connection:
        path=self.release_dir(sha)/"serving.sqlite"
        if not path.is_file():raise ApiError(503,"serving_store_missing","serving.sqlite is missing")
        connection=sqlite3.connect(f"file:{path}?mode=ro",uri=True,timeout=10.0)
        connection.row_factory=sqlite3.Row;connection.execute("PRAGMA query_only=ON");connection.execute("PRAGMA busy_timeout=10000")
        return connection

    def artifact(self,manifest:Mapping[str,Any],path:str)->Mapping[str,Any]|None:
        for item in manifest.get("artifacts") or []:
            if isinstance(item,Mapping) and item.get("path")==path:return item
        return None

    def validate_release(self,sha:str)->dict[str,Any]:
        cache_key=(str(self.releases_root),sha,self.running_server_sha256);cached=STATUS_CACHE.get(cache_key)
        if cached is not None:return deepcopy(cached)
        with key_lock(("status",)+cache_key):
            cached=STATUS_CACHE.get(cache_key)
            if cached is not None:return deepcopy(cached)
            meta=self.meta(sha);manifest=self.manifest(sha);errors=[]
            if meta.get("contentSha256")!=sha or manifest.get("contentSha256")!=sha:errors.append("content hash marker mismatch")
            try:
                if release_content_sha(meta,manifest)!=sha:errors.append("computed content hash mismatch")
            except (TypeError,ValueError) as exc:
                errors.append(f"content hash computation failed: {type(exc).__name__}: {exc}")
            if int(meta.get("schemaVersion") or 0)<2 or int(manifest.get("schemaVersion") or 0)<2:errors.append("release schema is older than 2")
            complete_path=self.release_dir(sha)/".complete"
            if not complete_path.is_file():errors.append("completion marker missing")
            else:
                try:
                    if complete_path.read_text(encoding="ascii").strip()!=sha:errors.append("completion marker mismatch")
                except (OSError,UnicodeError) as exc:errors.append(f"completion marker unreadable: {type(exc).__name__}: {exc}")
            db_entry=self.artifact(manifest,"serving.sqlite");server_entry=self.artifact(manifest,"artifacts/release_serving_server.py")
            db_path=self.release_dir(sha)/"serving.sqlite"
            if not db_entry or not db_path.is_file():errors.append("serving.sqlite missing from release")
            elif sha256_file(db_path)!=str(db_entry.get("sha256") or ""):errors.append("serving.sqlite hash mismatch")
            if not server_entry:errors.append("server artifact missing from release")
            elif self.running_server_sha256!=str(server_entry.get("sha256") or ""):errors.append("running server differs from release artifact")
            db_meta={};ranges=[];views=[];metrics=[];ranking_scopes=[];counts={}
            try:
                with closing(self.open_db(sha)) as connection:
                    tables={str(r[0]) for r in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                    missing={"serving_meta","source_details","source_occurrences","source_videos","ranking_rows","ranking_search_fts"}-tables
                    if missing:errors.append("serving store missing tables: "+",".join(sorted(missing)))
                    else:
                        db_meta={str(r[0]):str(r[1]) for r in connection.execute("SELECT key,value FROM serving_meta")}
                        if int(db_meta.get("schema_version") or 0)!=SERVING_SCHEMA_VERSION:errors.append("serving schema mismatch")
                        if db_meta.get("active_revision_id")!=str(meta.get("activeRevisionId") or ""):errors.append("serving revision mismatch")
                        ranges=[str(r[0]) for r in connection.execute("SELECT DISTINCT range_id FROM source_details ORDER BY range_id")]
                        views=[str(r[0]) for r in connection.execute("SELECT DISTINCT view FROM ranking_rows ORDER BY view")]
                        metrics=sorted({METRIC_ALIASES.get(str(r[0]),str(r[0])) for r in connection.execute("SELECT DISTINCT metric FROM ranking_rows")})
                        declared_scopes=declared_ranking_scopes(connection)
                        ranking_scopes=sorted({key.rsplit("/",1)[-1] for key in declared_scopes})
                        counts={"ranking_rows":int(connection.execute("SELECT count(*) FROM ranking_rows").fetchone()[0]),
                                "occurrences":int(connection.execute("SELECT count(*) FROM source_occurrences").fetchone()[0]),
                                "videos":int(connection.execute("SELECT count(*) FROM source_videos").fetchone()[0]),
                                "source_details":int(connection.execute("SELECT count(*) FROM source_details").fetchone()[0]),
                                "ranking_search_rows":int(connection.execute("SELECT count(*) FROM ranking_search_fts").fetchone()[0])}
                        if counts["ranking_search_rows"]!=counts["ranking_rows"]:errors.append("ranking search index row mismatch")
                        quick=str(connection.execute("PRAGMA quick_check").fetchone()[0])
                        if quick.casefold()!="ok":errors.append(f"SQLite quick_check failed: {quick}")
            except (sqlite3.DatabaseError,OSError,ValueError) as exc:errors.append(f"serving validation failed: {type(exc).__name__}: {exc}")
            status={"ok":not errors,"errors":errors,"releaseContentSha":sha,
                    "activeRevision":str(meta.get("activeRevisionId") or ""),"sourceCommit":str(meta.get("sourceCommitSha") or ""),
                    "serverCommit":str(meta.get("serverCommitSha") or ""),"buildLogicSha":str(meta.get("buildLogicSha") or ""),
                    "runningServerSha256":self.running_server_sha256,"searchTokenizer":db_meta.get("search_tokenizer",""),"servingSchemaVersion":int(db_meta.get("schema_version") or 0),"localSourcesRanges":ranges,
                    "localSearchReady":db_meta.get("local_search_ready")=="1" and bool(counts.get("ranking_rows")),
                    "views":views,"metrics":metrics,"rankingScopes":ranking_scopes,"counts":counts,"generatedAt":str(meta.get("generatedAt") or "")}
            STATUS_CACHE.put(cache_key,deepcopy(status),len(canonical_json(status)));return status

    def require_ready(self,sha:str)->dict[str,Any]:
        status=self.validate_release(sha)
        if not status["ok"]:raise ApiError(503,"release_not_ready","local release failed integrity validation",release=sha,reasons=status["errors"])
        return status

    def health(self)->dict[str,Any]:
        try:status=self.validate_release(self.current_sha())
        except ApiError as exc:return {"status":"degraded","apiVersion":SERVER_API_VERSION,"error":exc.code,"message":exc.message}
        return {"status":"ok" if status["ok"] else "degraded","apiVersion":SERVER_API_VERSION,**status,
                "oldOriginDependency":False,"sourceFallbackEnabled":False}

    def api_meta(self)->dict[str,Any]:
        sha=self.current_sha();status=self.require_ready(sha);meta=self.meta(sha);manifest=self.manifest(sha)
        pages=[x for x in manifest.get("pages") or [] if isinstance(x,Mapping)]
        return {"schemaVersion":SERVER_API_VERSION,
                "meta":{"active_revision_id":status["activeRevision"],"source_commit_sha":status["sourceCommit"],
                        "server_commit_sha":status["serverCommit"],"build_logic_sha":status["buildLogicSha"],"content_sha256":sha,"generated_at":status["generatedAt"],
                        "latest_event_time":str(meta.get("latestEventTime") or ""),"release_schema_version":int(meta.get("schemaVersion") or 0),
                        "serving_schema_version":status["servingSchemaVersion"],"search_tokenizer":status["searchTokenizer"]},
                "counts":status["counts"],"release":{"pages":len(pages),"bytes":sum(int(x.get("bytes") or 0) for x in pages)},
                "capabilities":{"ranges":status["localSourcesRanges"],"views":status["views"],"metrics":status["metrics"],
                                "localSources":bool(status["localSourcesRanges"]),"localSourcesRanges":status["localSourcesRanges"],
                                "localSearch":bool(status["localSearchReady"]),"rankingScopes":status["rankingScopes"],
                                "sourceFallbackEnabled":False,"oldOriginDependency":False}}

    def chunk_records(self,sha:str,range_id:str,view:str,metric:str,chunk_page:int)->list[dict[str,Any]]|None:
        key=(sha,range_id,view,metric,chunk_page);cached=CHUNK_CACHE.get(key)
        if cached is not None:return cached
        with key_lock(("chunk",)+key):
            cached=CHUNK_CACHE.get(key)
            if cached is not None:return cached
            path=self.release_dir(sha)/"rankings"/range_id/view/metric/f"page-{chunk_page:04d}.json.gz"
            if not path.is_file():return None
            try:
                with gzip.open(path,"rt",encoding="utf-8") as stream:payload=json.load(stream)
            except (OSError,json.JSONDecodeError) as exc:raise ApiError(503,"ranking_chunk_invalid",str(path)) from exc
            records=payload.get("records") if isinstance(payload,dict) else None
            if not isinstance(records,list):raise ApiError(503,"ranking_chunk_invalid",str(path))
            records=[x for x in records if isinstance(x,dict)];CHUNK_CACHE.put(key,records,len(canonical_json(records)));return records

    def series_total(self,sha:str,range_id:str,view:str,metric:str)->int:
        key=("total",sha,range_id,view,metric);cached=RESPONSE_CACHE.get(key)
        if cached is not None:return int(cached)
        summary=self.series_summary(sha,range_id,view,metric)
        if summary is not None:
            total=int(summary.get("totalCount") or 0);RESPONSE_CACHE.put(key,total,64);return total
        directory=self.release_dir(sha)/"rankings"/range_id/view/metric
        pages=list(directory.glob("page-*.json.gz")) if directory.is_dir() else []
        if not pages:return 0
        last_number=max(int(p.name.split("page-")[1].split(".")[0]) for p in pages)
        total=(last_number-1)*CHUNK_SIZE+len(self.chunk_records(sha,range_id,view,metric,last_number) or [])
        RESPONSE_CACHE.put(key,total,64);return total

    def series_summary(self,sha:str,range_id:str,view:str,metric:str)->dict[str,Any]|None:
        key=("summary",sha,range_id,view,metric);cached=RESPONSE_CACHE.get(key)
        if cached is not None:return cached
        path=self.release_dir(sha)/"rankings"/range_id/view/metric/"page-0001.json.gz"
        if not path.is_file():return None
        try:
            with gzip.open(path,"rt",encoding="utf-8") as stream:payload=json.load(stream)
        except (OSError,json.JSONDecodeError) as exc:raise ApiError(503,"ranking_chunk_invalid",str(path)) from exc
        if not isinstance(payload,dict):raise ApiError(503,"ranking_chunk_invalid",str(path))
        summary={key:payload.get(key) for key in ("totalCount","totalOccurrenceCount","totalSongCount","totalVideoCount")}
        RESPONSE_CACHE.put(key,summary,len(canonical_json(summary)));return summary

    def static_page(self,sha:str,range_id:str,view:str,metric:str,page:int,page_size:int)->dict[str,Any]|None:
        start=(page-1)*page_size;end=start+page_size;first_chunk=start//CHUNK_SIZE+1;last_chunk=(end-1)//CHUNK_SIZE+1
        first=self.chunk_records(sha,range_id,view,metric,first_chunk)
        if first is None:return None
        combined=list(first)
        if last_chunk!=first_chunk:combined.extend(self.chunk_records(sha,range_id,view,metric,last_chunk) or [])
        records=combined[start%CHUNK_SIZE:start%CHUNK_SIZE+page_size];total=self.series_total(sha,range_id,view,metric);summary=self.series_summary(sha,range_id,view,metric) or {}
        return {"schemaVersion":1,"rangeId":range_id,"view":view,"metric":metric,"scopeKey":"all","page":page,"pageSize":page_size,
                "totalCount":total,"filteredBaseCount":total,"totalOccurrenceCount":int(summary.get("totalOccurrenceCount") or 0),
                "totalSongCount":int(summary.get("totalSongCount") or 0),"totalVideoCount":int(summary.get("totalVideoCount") or 0),
                "pageCount":max(1,math.ceil(total/page_size)),"compact":True,"records":records}

    def resolve_db_metric(self,connection:sqlite3.Connection,range_id:str,view:str,metric:str)->str|None:
        candidates=DB_METRIC_CANDIDATES.get(metric,(metric,));placeholders=",".join("?" for _ in candidates)
        values={str(r[0]) for r in connection.execute(f"SELECT DISTINCT metric FROM ranking_rows WHERE range_id=? AND view=? AND metric IN ({placeholders})",(range_id,view,*candidates))}
        return next((x for x in candidates if x in values),None)

    def dynamic_page(self,sha:str,query:Mapping[str,list[str]],range_id:str,view:str,metric:str,page:int,page_size:int)->dict[str,Any]:
        q=qvalue(query,"q").casefold();min_count=qint(query,"minCount",1,minimum=0,maximum=2_147_483_647)
        scope=scope_key(qbool(query,"nicheOnly"),qbool(query,"hideUnknownArtist"));search_scope=qvalue(query,"searchScope","all")
        search_fields={x.strip() for x in qvalue(query,"searchFields").split(",") if x.strip()}
        invalid_fields=sorted(search_fields-SEARCH_FIELDS)
        if invalid_fields:raise ApiError(400,"invalid_search_fields","searchFields contains unsupported values",fields=invalid_fields)
        if not search_fields and search_scope!="all":
            mapped_scope="channel" if search_scope in {"channel","vtuber"} else search_scope
            if mapped_scope not in SEARCH_FIELDS:raise ApiError(400,"invalid_search_scope","searchScope is unsupported",searchScope=search_scope)
            search_fields={mapped_scope}
        with closing(self.open_db(sha)) as connection:
            db_metric=self.resolve_db_metric(connection,range_id,view,metric)
            if db_metric is None:raise ApiError(404,"ranking_series_missing","ranking series missing",range=range_id,view=view,metric=metric)
            if not connection.execute("SELECT 1 FROM ranking_rows WHERE range_id=? AND view=? AND metric=? AND scope_key=? LIMIT 1",(range_id,view,db_metric,scope)).fetchone():
                try:declared=declared_ranking_scopes(connection)
                except ValueError as exc:raise ApiError(503,"ranking_scope_marker_invalid",str(exc)) from exc
                declared_count=declared.get(f"{range_id}/{view}/{db_metric}/{scope}")
                if declared_count==0:
                    base=connection.execute(
                        "SELECT count(*) FROM ranking_rows WHERE range_id=? AND view=? AND metric=? AND scope_key='all'",
                        (range_id,view,db_metric),
                    ).fetchone()
                    return {"schemaVersion":1,"rangeId":range_id,"view":view,"metric":metric,"scopeKey":scope,"searchScope":search_scope,
                            "searchFields":sorted(search_fields),"page":1,"pageSize":page_size,"totalCount":0,
                            "filteredBaseCount":int(base[0] or 0),"totalOccurrenceCount":0,"totalSongCount":0,
                            "totalVideoCount":0,"pageCount":1,"compact":True,"records":[]}
                if scope!="all":raise ApiError(404,"ranking_scope_missing","filtered scope missing",scope=scope)
                scope="all"
            conditions=["ranking_rows.range_id=?","ranking_rows.view=?","ranking_rows.metric=?","ranking_rows.scope_key=?"];params:list[Any]=[range_id,view,db_metric,scope]
            metric_column={"occurrences":"row_count","songs":"song_count","videos":"video_count"}.get(metric,"row_count")
            conditions.append(f"ranking_rows.{metric_column}>=?");params.append(min_count)
            tokens=[x for x in q.split() if x];channel_only=search_fields=={"channel"}
            tokenizer_row=connection.execute("SELECT value FROM serving_meta WHERE key='search_tokenizer'").fetchone()
            tokenizer=str(tokenizer_row[0] if tokenizer_row else "")
            use_fts=bool(tokens) and tokenizer=="trigram" and all(len(token)>=3 for token in tokens) and (not search_fields or channel_only)
            from_clause="ranking_rows"
            if use_fts:
                from_clause="ranking_rows JOIN ranking_search_fts ON ranking_search_fts.rowid=ranking_rows.id"
                phrases=[]
                for token in tokens:
                    phrase=fts_phrase(token);phrases.append(f"channel_search_text : {phrase}" if channel_only else phrase)
                conditions.append("ranking_search_fts MATCH ?");params.append(" AND ".join(phrases))
            else:
                for token in tokens:
                    pattern=f"%{like_escape(token)}%"
                    if not search_fields:
                        conditions.append("(lower(ranking_rows.search_text) LIKE lower(?) ESCAPE '\\' OR lower(ranking_rows.channel_search_text) LIKE lower(?) ESCAPE '\\')");params.extend([pattern,pattern])
                        continue
                    field_clauses=[]
                    if "title" in search_fields:
                        field_clauses.append("lower(ranking_rows.title) LIKE lower(?) ESCAPE '\\'");params.append(pattern)
                    if "artist" in search_fields:
                        field_clauses.append("lower(ranking_rows.artist) LIKE lower(?) ESCAPE '\\'");params.append(pattern)
                        if view=="artists":field_clauses.append("lower(ranking_rows.name) LIKE lower(?) ESCAPE '\\'");params.append(pattern)
                    if "channel" in search_fields:
                        field_clauses.append("lower(ranking_rows.channel_search_text) LIKE lower(?) ESCAPE '\\'");params.append(pattern)
                    if search_fields & {"video","source"}:
                        field_clauses.append("lower(ranking_rows.search_text) LIKE lower(?) ESCAPE '\\'");params.append(pattern)
                    conditions.append("("+" OR ".join(field_clauses)+")")
            where=" AND ".join(conditions)
            summary=connection.execute(f"SELECT count(*),coalesce(sum(ranking_rows.row_count),0),coalesce(sum(ranking_rows.song_count),0),coalesce(sum(ranking_rows.video_count),0) FROM {from_clause} WHERE {where}",params).fetchone()
            total=int(summary[0] or 0);page_count=max(1,math.ceil(total/page_size));page=min(page,page_count)
            base_params=list(params);base_params[3]="all"
            filtered_base=int(connection.execute(f"SELECT count(*) FROM {from_clause} WHERE {where}",base_params).fetchone()[0] or 0)
            rows=connection.execute(f"SELECT ranking_rows.rank,ranking_rows.payload_json FROM {from_clause} WHERE {where} ORDER BY ranking_rows.rank LIMIT ? OFFSET ?",(*params,page_size,(page-1)*page_size)).fetchall()
            records=[]
            for row in rows:
                payload=json_object(row["payload_json"]);payload["rank"]=int(row["rank"] or payload.get("rank") or 0);records.append(compact_record(payload,view))
            return {"schemaVersion":1,"rangeId":range_id,"view":view,"metric":metric,"scopeKey":scope,"searchScope":search_scope,
                    "searchFields":sorted(search_fields),"page":page,"pageSize":page_size,"totalCount":total,"filteredBaseCount":filtered_base,
                    "totalOccurrenceCount":int(summary[1] or 0),"totalSongCount":int(summary[2] or 0),"totalVideoCount":int(summary[3] or 0),
                    "pageCount":page_count,"compact":True,"records":records}

    def ranking_page(self,query:Mapping[str,list[str]])->tuple[str,dict[str,Any],str]:
        sha=self.resolve_sha(qvalue(query,"v"));self.require_ready(sha);range_id=qvalue(query,"range","all");view=qvalue(query,"view","songs")
        raw_metric=qvalue(query,"metric","occurrences");metric=METRIC_ALIASES.get(raw_metric,raw_metric)
        page=qpagination(query,"page",1,maximum=10_000_000);page_size=qpagination(query,"pageSize",30,maximum=MAX_PAGE_SIZE)
        dynamic=bool(qvalue(query,"q") or qint(query,"minCount",1,minimum=0,maximum=2_147_483_647)>1 or qbool(query,"nicheOnly") or qbool(query,"hideUnknownArtist"))
        if not dynamic:
            payload=self.static_page(sha,range_id,view,metric,page,page_size)
            if payload is not None:return sha,payload,"local-release-chunk"
        return sha,self.dynamic_page(sha,query,range_id,view,metric,page,page_size),"local-serving-sqlite"

    def source_page(self,sha:str,source_key:str,query:Mapping[str,list[str]])->dict[str,Any]:
        self.require_ready(sha);range_id=qvalue(query,"range","all");page=qpagination(query,"page",1,maximum=10_000_000);page_size=qpagination(query,"pageSize",20,maximum=MAX_PAGE_SIZE)
        q=qvalue(query,"q").casefold();niche=qbool(query,"nicheOnly");hide_unknown=qbool(query,"hideUnknownArtist")
        with closing(self.open_db(sha)) as connection:
            detail=connection.execute("SELECT entity_type,payload_json FROM source_details WHERE range_id=? AND source_key=?",(range_id,source_key)).fetchone()
            if detail is None:raise ApiError(404,"source_not_found_in_local_release","source key missing from local release",range=range_id,sourceKey=source_key,releaseSha=sha)
            conditions=["range_id=?","source_key=?"];params:list[Any]=[range_id,source_key]
            if niche:conditions.append("is_niche=1")
            if hide_unknown:conditions.append("is_unknown_artist=0")
            if q:conditions.append("lower(search_text) LIKE lower(?) ESCAPE '\\'");params.append(f"%{like_escape(q)}%")
            where=" AND ".join(conditions)
            summary=connection.execute(f"SELECT count(*),count(DISTINCT video_id),count(DISTINCT nullif(canonical_song_key,'')) FROM source_occurrences WHERE {where}",params).fetchone()
            total_occ=int(summary[0] or 0);total_videos=int(summary[1] or 0);total_songs=int(summary[2] or 0);page_count=max(1,math.ceil(total_videos/page_size));page=min(page,page_count)
            video_ids=[str(r[0] or "") for r in connection.execute(f"SELECT video_id FROM source_occurrences WHERE {where} GROUP BY video_id ORDER BY min(position),video_id LIMIT ? OFFSET ?",(*params,page_size,(page-1)*page_size))]
            rows=[]
            if video_ids:
                placeholders=",".join("?" for _ in video_ids)
                rows=connection.execute(f"SELECT video_id,title,channel_name,channel_id,channel_handle,channel_url,published_timestamp,seconds,payload_json FROM source_occurrences WHERE {where} AND video_id IN ({placeholders}) ORDER BY position,video_id",(*params,*video_ids)).fetchall()
            occurrences=[normalize_occurrence(r) for r in rows];record=json_object(detail["payload_json"]);entity_type=str(detail["entity_type"] or "")
            if entity_type in {"vtuber","song","artist","video"}:
                song_rows=connection.execute(f"SELECT canonical_song_key,min(canonical_song_name) AS canonical_song_name,count(*) AS occurrence_count,count(DISTINCT canonical_song_name) AS name_count FROM source_occurrences WHERE {where} AND canonical_song_key<>'' GROUP BY canonical_song_key ORDER BY occurrence_count DESC,canonical_song_name,canonical_song_key",params).fetchall()
                if any(not str(row[0] or "") or not str(row[1] or "") or int(row[2] or 0)<=0 or (entity_type=="vtuber" and int(row[3] or 0)!=1) for row in song_rows):raise ApiError(503,"source_song_identity_invalid","source canonical song identity is inconsistent",sourceKey=source_key,range=range_id)
                if len(song_rows)!=total_songs:raise ApiError(503,"source_song_count_mismatch","source canonical song count is inconsistent",sourceKey=source_key,range=range_id)
                record["songs"]=[{"key":str(row[0]),"name":str(row[1]),"count":int(row[2])} for row in song_rows]
            record.update({"sourceDetailKey":source_key,"rangeId":range_id,"occurrences":occurrences,"count":total_occ,
                           "occurrenceCount":total_occ,"timestampCount":total_occ,"videoCount":total_videos,"songCount":total_songs,"sourceFilterQuery":q,
                           "occurrencePreviewLimited":total_occ>len(occurrences)})
            return {"schemaVersion":1,"found":True,"sourceKey":source_key,"sourceRevisionId":self.meta(sha).get("activeRevisionId",""),
                    "record":record,"page":page,"pageSize":page_size,"pageCount":page_count,"totalCount":total_videos,
                    "totalVideoCount":total_videos,"totalOccurrenceCount":total_occ,"totalSongCount":total_songs}


def make_handler(store:ReleaseStore)->type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        server_version="daily-song-list-release-serving/4";protocol_version="HTTP/1.1"
        def log_message(self,format:str,*args:Any)->None:sys.stderr.write("%s - - [%s] %s\n"%(self.address_string(),self.log_date_time_string(),format%args))
        def do_GET(self)->None:
            started=time.monotonic();request_id=self.headers.get("X-Request-Id","")
            if not REQUEST_ID_RE.fullmatch(request_id):request_id=uuid.uuid4().hex
            try:
                parsed=urlparse(self.path);query=parse_qs(parsed.query,keep_blank_values=True)
                if parsed.path=="/healthz":
                    payload=store.health();self.send_json(200 if payload.get("status")=="ok" else 503,payload,request_id,started,release_sha=str(payload.get("releaseContentSha") or ""),cache_control="no-store");return
                if parsed.path=="/api/meta":
                    meta_sha=store.current_sha();self.send_json(200,store.api_meta(),request_id,started,release_sha=meta_sha,cache_control="public, max-age=30, must-revalidate",data_source="local-release");return
                if parsed.path=="/api/rankings":
                    resolved_sha=store.resolve_sha(qvalue(query,"v"));cache_key=("ranking",resolved_sha,tuple(sorted((k,tuple(v)) for k,v in query.items() if k!="v")))
                    cached=RESPONSE_CACHE.get(cache_key)
                    if cached is None:
                        with key_lock(cache_key):
                            cached=RESPONSE_CACHE.get(cache_key)
                            if cached is None:
                                cached=store.ranking_page(query);RESPONSE_CACHE.put(cache_key,cached,len(canonical_json(cached[1])))
                        cache="MISS"
                    else:cache="HIT"
                    sha,payload,data_source=cached
                    immutable=bool(qvalue(query,"v"));self.send_json(200,payload,request_id,started,cache=cache,release_sha=sha,data_source=data_source,
                        cache_control="public, max-age=31536000, immutable" if immutable else "public, max-age=60, must-revalidate");return
                if parsed.path.startswith("/api/sources/"):
                    source_key=unquote(parsed.path.removeprefix("/api/sources/"))
                    if not SOURCE_KEY_RE.fullmatch(source_key):raise ApiError(400,"invalid_source_key","source key invalid")
                    sha=store.resolve_sha(qvalue(query,"v"));payload=store.source_page(sha,source_key,query);immutable=bool(qvalue(query,"v"))
                    self.send_json(200,payload,request_id,started,release_sha=sha,data_source="local-serving-sqlite",
                        cache_control="public, max-age=31536000, immutable" if immutable else "public, max-age=60, must-revalidate");return
                if parsed.path.startswith("/api/thumbnails/"):
                    self.send_thumbnail(parsed.path,request_id,started);return
                raise ApiError(404,"not_found","route not found")
            except ApiError as exc:self.send_json(exc.status,{"error":exc.code,"message":exc.message,**exc.details},request_id,started,cache_control="no-store")
            except (BrokenPipeError,ConnectionResetError):return
            except Exception as exc:
                traceback.print_exc(file=sys.stderr);self.send_json(500,{"error":"internal_error","message":"request failed","type":type(exc).__name__},request_id,started,cache_control="no-store")

        def send_json(self,status:int,payload:Any,request_id:str,started:float,*,cache:str="BYPASS",release_sha:str="",data_source:str="",cache_control:str="no-store")->None:
            body=canonical_json(payload);etag='"'+sha256_bytes(body)+'"'
            if self.headers.get("If-None-Match")==etag and status==200:
                self.send_response(304);self.send_header("ETag",etag);self.send_header("Cache-Control",cache_control);self.send_header("Access-Control-Allow-Origin","*");self.send_header("X-Request-Id",request_id);self.send_header("Content-Length","0");self.end_headers();return
            encoding=""
            if len(body)>=1024 and "gzip" in self.headers.get("Accept-Encoding","").casefold():body=gzip.compress(body,compresslevel=5,mtime=0);encoding="gzip"
            duration=(time.monotonic()-started)*1000;self.send_response(status);self.send_header("Content-Type","application/json; charset=utf-8");self.send_header("Content-Length",str(len(body)))
            self.send_header("Cache-Control",cache_control);self.send_header("ETag",etag);self.send_header("Vary","Accept-Encoding");self.send_header("Access-Control-Allow-Origin","*");self.send_header("X-Request-Id",request_id)
            self.send_header("X-Cache",cache);self.send_header("X-Duration-Ms",f"{duration:.1f}");self.send_header("Server-Timing",f"app;dur={duration:.1f}")
            if status in {429,502,503,504}:self.send_header("Retry-After","3")
            error_code=str(payload.get("error") or "") if isinstance(payload,Mapping) else ""
            if error_code and re.fullmatch(r"[a-z0-9_:-]{1,80}",error_code):self.send_header("X-Error-Code",error_code)
            if release_sha:
                self.send_header("X-Release-Sha",release_sha);self.send_header("X-Content-Sha256",release_sha)
                release_status=store.validate_release(release_sha)
                self.send_header("X-Active-Revision",str(release_status.get("activeRevision") or ""))
                self.send_header("X-Server-Commit",str(release_status.get("serverCommit") or ""))
                self.send_header("X-Build-Logic-Sha",str(release_status.get("buildLogicSha") or ""))
            if data_source:self.send_header("X-Data-Source",data_source)
            if encoding:self.send_header("Content-Encoding",encoding)
            self.end_headers();self.wfile.write(body)

        def send_thumbnail(self,path:str,request_id:str,started:float)->None:
            match=THUMBNAIL_RE.fullmatch(path)
            if not match:raise ApiError(400,"invalid_thumbnail","thumbnail path not allowlisted")
            video_id,quality=match.groups();cache_key=(video_id,quality);cached=THUMBNAIL_CACHE.get(cache_key)
            if cached is None:
                connection=http.client.HTTPSConnection("i.ytimg.com",timeout=5.0)
                try:
                    connection.request("GET",f"/vi/{video_id}/{quality}.jpg",headers={"User-Agent":"daily-song-list-wdc/3","Accept":"image/*"})
                    response=connection.getresponse();body=response.read(512*1024+1)
                    if response.status!=200 or len(body)>512*1024:raise ApiError(502,"thumbnail_upstream_error","thumbnail origin failed")
                    cached=((response.getheader("Content-Type") or "image/jpeg").split(";",1)[0],body);THUMBNAIL_CACHE.put(cache_key,cached,len(body))
                except (socket.timeout,OSError,http.client.HTTPException) as exc:raise ApiError(502,"thumbnail_upstream_error","thumbnail origin failed") from exc
                finally:connection.close()
            content_type,body=cached;duration=(time.monotonic()-started)*1000;self.send_response(200);self.send_header("Content-Type",content_type);self.send_header("Content-Length",str(len(body)))
            self.send_header("Cache-Control","public, max-age=86400, immutable");self.send_header("Access-Control-Allow-Origin","*");self.send_header("X-Request-Id",request_id);self.send_header("X-Duration-Ms",f"{duration:.1f}");self.end_headers();self.wfile.write(body)
    return Handler


def make_server(host:str,port:int,backlog:int,store:ReleaseStore)->ThreadingHTTPServer:
    class ReleaseHTTPServer(ThreadingHTTPServer):
        daemon_threads=True
        request_queue_size=max(16,int(backlog))
    return ReleaseHTTPServer((host,port),make_handler(store))


def parse_args(argv:Sequence[str]|None=None)->argparse.Namespace:
    p=argparse.ArgumentParser(description=__doc__);p.add_argument("--releases-root",type=Path,default=Path(os.environ.get("DAILY_SONG_RELEASES_ROOT","/opt/culua/ytb-song-rank/releases")))
    p.add_argument("--host",default=os.environ.get("DAILY_SONG_HOST","127.0.0.1"));p.add_argument("--port",type=int,default=int(os.environ.get("DAILY_SONG_PORT","18777")))
    p.add_argument("--backlog",type=int,default=int(os.environ.get("DAILY_SONG_BACKLOG","128")));return p.parse_args(argv)


def main(argv:Sequence[str]|None=None)->int:
    args=parse_args(argv);store=ReleaseStore(args.releases_root);httpd=make_server(args.host,args.port,args.backlog,store)
    print(f"RELEASE_SERVING_START host={args.host} port={args.port} root={args.releases_root} serverSha256={store.running_server_sha256}",flush=True)
    try:httpd.serve_forever(poll_interval=.25)
    except KeyboardInterrupt:pass
    finally:httpd.server_close()
    return 0

if __name__=="__main__":raise SystemExit(main())
