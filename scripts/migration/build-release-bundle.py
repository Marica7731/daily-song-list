#!/usr/bin/env python3
"""Build one complete immutable release whose hash covers pages, SQLite and server code."""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Any, Sequence

RELEASE_SCHEMA_VERSION = 2
MAX_PREVIEWS_PER_CARD = 3


def canonical_json(value: Any) -> bytes:
    return json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":"),default=str).encode("utf-8")


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest=hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda:stream.read(1024*1024),b""):
            digest.update(chunk)
    return digest.hexdigest()


def release_content_sha(meta: dict[str,Any],manifest: dict[str,Any]) -> str:
    """Recompute the release identity without trusting embedded identity fields."""
    meta_identity=dict(meta);manifest_identity=dict(manifest)
    meta_identity.pop("contentSha256",None);manifest_identity.pop("contentSha256",None)
    return sha256_bytes(canonical_json({"meta":meta_identity,"manifest":manifest_identity}))


def discover_pages(input_root: Path) -> list[tuple[Path,str]]:
    rankings=input_root/"rankings"
    if not rankings.is_dir():
        return []
    return [(p,p.relative_to(input_root).with_name(p.name+".gz").as_posix()) for p in sorted(rankings.rglob("page-*.json"))]


def validate_page(path: Path,payload: Any) -> None:
    if not isinstance(payload,dict) or not isinstance(payload.get("records"),list):
        raise ValueError(f"{path}: invalid page payload")
    for index,record in enumerate(payload["records"]):
        if not isinstance(record,dict):
            raise ValueError(f"{path}: record {index} is not an object")
        previews=record.get("occurrences")
        if previews is not None and not isinstance(previews,list):
            raise ValueError(f"{path}: record {index} occurrences is not an array")
        if isinstance(previews,list) and len(previews)>MAX_PREVIEWS_PER_CARD:
            raise ValueError(f"{path}: card {record.get('key')!r} has {len(previews)} previews")


def artifact_entry(path: Path,relative: str,content_type: str) -> dict[str,Any]:
    return {"path":relative,"bytes":path.stat().st_size,"sha256":sha256_file(path),"contentType":content_type}


def verify_existing(final: Path, expected_sha: str) -> None:
    manifest_path=final/"manifest.json";meta_path=final/"meta.json";complete_path=final/".complete"
    if not manifest_path.is_file() or not meta_path.is_file() or not complete_path.is_file():
        raise ValueError(f"existing release is incomplete: {final}")
    manifest=json.loads(manifest_path.read_text(encoding="utf-8"))
    meta=json.loads(meta_path.read_text(encoding="utf-8"))
    if manifest.get("contentSha256")!=expected_sha or meta.get("contentSha256")!=expected_sha:
        raise ValueError(f"existing release marker mismatch: {final}")
    if release_content_sha(meta,manifest)!=expected_sha:
        raise ValueError(f"existing release computed hash mismatch: {final}")
    if complete_path.read_text(encoding="ascii").strip()!=expected_sha:
        raise ValueError(f"existing release completion marker mismatch: {final}")
    resolved_final=final.resolve()
    for item in [*(manifest.get("pages") or []),*(manifest.get("artifacts") or [])]:
        relative=str(item.get("path") or "")
        path=(resolved_final/relative).resolve()
        if resolved_final not in path.parents:
            raise ValueError(f"existing release path traversal: {relative}")
        if not path.is_file() or sha256_file(path)!=item.get("sha256"):
            raise ValueError(f"existing release object mismatch: {path}")


def build_bundle(input_root: Path,output_root: Path,*,serving_sqlite: Path,server_artifact: Path,
                 release_meta: dict[str,Any],frontend_root: Path|None=None,
                 nginx_artifact: Path|None=None,systemd_artifact: Path|None=None,
                 link_serving_sqlite: bool=False) -> tuple[str,Path]:
    pages=discover_pages(input_root)
    if not pages:
        raise ValueError("no ranking pages found")
    if not serving_sqlite.is_file(): raise FileNotFoundError(serving_sqlite)
    if not server_artifact.is_file(): raise FileNotFoundError(server_artifact)
    deployment_inputs=(frontend_root,nginx_artifact,systemd_artifact)
    if any(value is not None for value in deployment_inputs) and not all(value is not None for value in deployment_inputs):
        raise ValueError("frontend_root, nginx_artifact and systemd_artifact must be supplied together")
    output_root.mkdir(parents=True,exist_ok=True)
    staging=Path(tempfile.mkdtemp(prefix=".release-staging-",dir=output_root))
    try:
        page_entries=[]
        for source,relative in pages:
            payload=json.loads(source.read_text(encoding="utf-8"))
            validate_page(source,payload)
            plain=canonical_json(payload)
            compressed=gzip.compress(plain,compresslevel=6,mtime=0)
            target=staging/relative
            target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes(compressed)
            page_entries.append({"path":relative,"bytes":len(compressed),"sha256":sha256_bytes(compressed),
                                 "jsonSha256":sha256_bytes(plain),"contentType":"application/gzip"})
        serving_target=staging/"serving.sqlite"
        if link_serving_sqlite:
            source_stat=serving_sqlite.stat();staging_stat=staging.stat()
            if source_stat.st_dev!=staging_stat.st_dev:
                raise OSError("serving SQLite and release staging are on different filesystems")
            os.link(serving_sqlite,serving_target)
            target_stat=serving_target.stat()
            if (target_stat.st_dev,target_stat.st_ino)!=(source_stat.st_dev,source_stat.st_ino):
                raise OSError("serving SQLite hard-link verification failed")
        else:
            shutil.copyfile(serving_sqlite,serving_target)
        server_relative="artifacts/release_serving_server.py"
        server_target=staging/server_relative
        server_target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(server_artifact,server_target)
        os.chmod(server_target,0o755)
        artifacts=[artifact_entry(serving_target,"serving.sqlite","application/vnd.sqlite3"),
                   artifact_entry(server_target,server_relative,"text/x-python")]
        if frontend_root is not None and nginx_artifact is not None and systemd_artifact is not None:
            frontend_root=frontend_root.resolve()
            frontend_manifest_path=frontend_root/"frontend-manifest.json"
            frontend_index_path=frontend_root/"index.html"
            if not frontend_manifest_path.is_file() or not frontend_index_path.is_file():
                raise FileNotFoundError("prepared frontend manifest or index is missing")
            frontend_manifest=json.loads(frontend_manifest_path.read_text(encoding="utf-8"))
            app_relative=str(frontend_manifest.get("appPath") or "")
            if not re.fullmatch(r"assets/app-h[0-9a-f]{12}\.js",app_relative):
                raise ValueError(f"invalid prepared app path: {app_relative!r}")
            frontend_files=(
                (frontend_index_path,"artifacts/frontend/index.html","text/html"),
                (frontend_root/app_relative,f"artifacts/frontend/{app_relative}","application/javascript"),
                (frontend_manifest_path,"artifacts/frontend/frontend-manifest.json","application/json"),
                (nginx_artifact,"artifacts/deploy/next.ytb-song-rank.culua.com.conf","text/plain"),
                (systemd_artifact,"artifacts/deploy/daily-song-list-api.service","text/plain"),
            )
            for source,relative,content_type in frontend_files:
                if not source.is_file():raise FileNotFoundError(source)
                target=staging/relative;target.parent.mkdir(parents=True,exist_ok=True)
                shutil.copyfile(source,target)
                artifacts.append(artifact_entry(target,relative,content_type))
        meta={
            "schemaVersion":RELEASE_SCHEMA_VERSION,
            "activeRevisionId":str(release_meta.get("activeRevisionId") or ""),
            "expectedParentRevisionId":str(release_meta.get("expectedParentRevisionId") or ""),
            "sourceCommitSha":str(release_meta.get("sourceCommitSha") or ""),
            "serverCommitSha":str(release_meta.get("serverCommitSha") or ""),
            "buildLogicSha":str(release_meta.get("buildLogicSha") or ""),
            "generatedAt":str(release_meta.get("generatedAt") or ""),
            "latestEventTime":str(release_meta.get("latestEventTime") or ""),
        }
        if not meta["activeRevisionId"]: raise ValueError("activeRevisionId is required")
        if not meta["serverCommitSha"]: raise ValueError("serverCommitSha is required")
        if not meta["buildLogicSha"]: raise ValueError("buildLogicSha is required")
        manifest={"schemaVersion":RELEASE_SCHEMA_VERSION,"candidateRevisionId":meta["activeRevisionId"],
                  "sourceCommitSha":meta["sourceCommitSha"],"serverCommitSha":meta["serverCommitSha"],
                  "buildLogicSha":meta["buildLogicSha"],"generatedAt":meta["generatedAt"],"latestEventTime":meta["latestEventTime"],
                  "pages":sorted(page_entries,key=lambda x:x["path"]),
                  "artifacts":sorted(artifacts,key=lambda x:x["path"])}
        content_sha=release_content_sha(meta,manifest)
        meta["contentSha256"]=content_sha
        manifest["contentSha256"]=content_sha
        (staging/"meta.json").write_bytes(canonical_json(meta))
        (staging/"manifest.json").write_bytes(canonical_json(manifest))
        (staging/".complete").write_text(content_sha+"\n",encoding="ascii")
        final=output_root/content_sha
        if final.exists():
            verify_existing(final,content_sha)
            shutil.rmtree(staging)
            return content_sha,final
        os.replace(staging,final)
        return content_sha,final
    except Exception:
        shutil.rmtree(staging,ignore_errors=True)
        raise


def parse_args(argv: Sequence[str]|None=None) -> argparse.Namespace:
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument("--input",required=True,type=Path);p.add_argument("--output",required=True,type=Path)
    p.add_argument("--serving-sqlite",required=True,type=Path);p.add_argument("--server-artifact",required=True,type=Path)
    p.add_argument("--frontend-root",type=Path);p.add_argument("--nginx-artifact",type=Path);p.add_argument("--systemd-artifact",type=Path)
    p.add_argument("--active-revision-id",required=True);p.add_argument("--expected-parent-revision-id",default="")
    p.add_argument("--source-commit-sha",default="");p.add_argument("--server-commit-sha",required=True)
    p.add_argument("--build-logic-sha",required=True)
    p.add_argument("--link-serving-sqlite",action="store_true")
    p.add_argument("--generated-at",required=True);p.add_argument("--latest-event-time",default="")
    return p.parse_args(argv)


def main(argv: Sequence[str]|None=None) -> int:
    args=parse_args(argv)
    meta={"activeRevisionId":args.active_revision_id,"expectedParentRevisionId":args.expected_parent_revision_id,
          "sourceCommitSha":args.source_commit_sha,"serverCommitSha":args.server_commit_sha,"buildLogicSha":args.build_logic_sha,
          "generatedAt":args.generated_at,"latestEventTime":args.latest_event_time}
    try:
        sha,path=build_bundle(args.input,args.output,serving_sqlite=args.serving_sqlite,
                              server_artifact=args.server_artifact,release_meta=meta,
                              frontend_root=args.frontend_root,nginx_artifact=args.nginx_artifact,
                              systemd_artifact=args.systemd_artifact,
                              link_serving_sqlite=args.link_serving_sqlite)
    except Exception as exc:
        print(f"RELEASE_BUNDLE_ERROR {type(exc).__name__}: {exc}",file=sys.stderr);return 1
    print(f"RELEASE_BUNDLE_OK contentSha256={sha} dir={path}");return 0

if __name__=="__main__": raise SystemExit(main())
