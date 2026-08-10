#!/usr/bin/env python3
"""Patch assets/app.js to obey server capabilities and version immutable requests."""
from __future__ import annotations
import argparse
import sys
from pathlib import Path
from typing import Sequence


def replace_once(source:str,old:str,new:str,label:str)->str:
    count=source.count(old)
    if count!=1:raise RuntimeError(f"{label}: expected one old snippet, found {count}")
    return source.replace(old,new,1)


def patch_app(path:Path)->bool:
    original=path.read_text(encoding="utf-8")
    if "function runtimeReleaseVersion()" in original:
        required=("function runtimeApiCapabilities()","function runtimeSupportsLocalSources(","capabilities?.localSearch === true","capabilities.rankingScopes",'params.set("v", releaseVersion)',
                  'const sourceCacheMode = isRuntimeSourceDetailPath(path) && runtimeReleaseVersion()')
        missing=[x for x in required if x not in original]
        if missing:raise RuntimeError("frontend patch partially applied; missing: "+", ".join(missing))
        return False
    source=original
    source=replace_once(source,
'''function shouldUseRuntimeApiForRequest(request) {
  if (!state.runtimeApi.available) return false;
  return true;
}
''',
'''function runtimeReleaseVersion() {
  return cleanText(state.runtimeApi?.meta?.meta?.content_sha256 || state.runtimeMeta?.dataVersion || "");
}
function runtimeApiCapabilities() {
  const capabilities = state.runtimeApi?.meta?.capabilities;
  return capabilities && typeof capabilities === "object" ? capabilities : null;
}
function runtimeCapabilityIncludes(values, expected) {
  return Array.isArray(values) && values.map((value) => String(value)).includes(String(expected));
}
function runtimeSupportsLocalSources(rangeValue = state.range) {
  if (!state.runtimeApi.available) return false;
  const capabilities = runtimeApiCapabilities();
  if (capabilities?.localSources !== true) return false;
  const ranges = capabilities.localSourcesRanges || capabilities.ranges;
  return runtimeCapabilityIncludes(ranges, canonicalRangeId(rangeValue));
}
function shouldUseRuntimeApiForRequest(request) {
  if (!state.runtimeApi.available) return false;
  const capabilities = runtimeApiCapabilities();
  if (!capabilities) return false;
  const range = canonicalRangeId(request.range);
  const view = apiViewForRequestView(request.view);
  const rawMetric = apiMetricForRequest(request);
  const metric = rawMetric === "count" ? "occurrences" : rawMetric;
  if (!runtimeCapabilityIncludes(capabilities.ranges, range)) return false;
  if (!runtimeCapabilityIncludes(capabilities.views, view)) return false;
  if (!runtimeCapabilityIncludes(capabilities.metrics, metric)) return false;
  const filters = requestFiltersForView(request.view, request.filters || {});
  if (cleanText(filters.q || "") && capabilities.localSearch !== true) return false;
  const rankingScope = filters.nicheOnly
    ? (filters.hideUnknownArtist ? "visibleNiche" : "niche")
    : (filters.hideUnknownArtist ? "visible" : "all");
  if (rankingScope !== "all" && !runtimeCapabilityIncludes(capabilities.rankingScopes, rankingScope)) return false;
  return true;
}
''',"capability gate")
    source=replace_once(source,
'  const releaseVersion = state.runtimeApi?.meta?.meta?.content_sha256 || state.runtimeMeta?.dataVersion || "";\n',
'  const releaseVersion = runtimeReleaseVersion();\n',"ranking release version")
    source=replace_once(source,
'''async function loadRequestSearchRecords(query, signal) {
  const range = state.range;
  if (state.runtimeApi.available) {
    const params = new URLSearchParams({
      range,
      view: "songs",
      metric: "occurrences",
      page: "1",
      pageSize: "12",
      q: cleanText(query),
    });
    const payload = await readJson(`${API_RANKINGS_PATH}?${params.toString()}`, {
      cache: "no-cache",
      signal,
    });
''',
'''async function loadRequestSearchRecords(query, signal) {
  const range = state.range;
  const capabilities = runtimeApiCapabilities();
  if (state.runtimeApi.available &&
      capabilities?.localSearch === true &&
      runtimeCapabilityIncludes(capabilities.ranges, canonicalRangeId(range)) &&
      runtimeCapabilityIncludes(capabilities.views, "songs") &&
      runtimeCapabilityIncludes(capabilities.metrics, "occurrences")) {
    const params = new URLSearchParams({
      range,
      view: "songs",
      metric: "occurrences",
      page: "1",
      pageSize: "12",
      q: cleanText(query),
    });
    const releaseVersion = runtimeReleaseVersion();
    if (releaseVersion) params.set("v", releaseVersion);
    const payload = await readJson(`${API_RANKINGS_PATH}?${params.toString()}`, {
      cache: releaseVersion ? "force-cache" : "default",
      signal,
    });
''',"search capability/version")
    source=replace_once(source,
'''function sourceDetailPathForRecord(record, occurrences = []) {
  const ownerRecord = record?._record || {};
  const explicitPath = cleanText(record?.sourceDetailPath || ownerRecord?.sourceDetailPath);
  if (explicitPath) return explicitPath;
  const detailKey = cleanText(record?.sourceDetailKey || ownerRecord?.sourceDetailKey);
  const vtuberAlias = cleanText(record?.channelId || ownerRecord?.channelId || (record?.type === "vtuber" ? record?.key : "") || (ownerRecord?.type === "vtuber" ? ownerRecord?.key : ""));
  if (detailKey || vtuberAlias) {
    return `/api/sources/${encodeURIComponent(detailKey || vtuberAlias)}`;
  }
  const candidates = [
    record?.sourceDetail?.path,
    record?.sourceDetails?.path,
    record?.detailPath,
    record?.detail?.path,
    ownerRecord?.sourceDetail?.path,
    ownerRecord?.sourceDetails?.path,
    ownerRecord?.detailPath,
    ownerRecord?.detail?.path,
    occurrences?.[0]?.sourceDetailPath,
    occurrences?.[0]?.sourceDetail?.path,
    occurrences?.[0]?.item?.sourceDetailPath,
    occurrences?.[0]?.item?.sourceDetail?.path,
    sourceDetailPathFromShard(record, occurrences),
  ];
  return cleanText(candidates.find(Boolean));
}
''',
'''function sourceDetailPathForRecord(record, occurrences = []) {
  const ownerRecord = record?._record || {};
  const supportsRuntimeSources = runtimeSupportsLocalSources();
  const explicitPath = cleanText(record?.sourceDetailPath || ownerRecord?.sourceDetailPath);
  if (explicitPath && (!isRuntimeSourceDetailPath(explicitPath) || supportsRuntimeSources)) return explicitPath;
  const detailKey = cleanText(record?.sourceDetailKey || ownerRecord?.sourceDetailKey);
  const vtuberAlias = cleanText(record?.channelId || ownerRecord?.channelId || (record?.type === "vtuber" ? record?.key : "") || (ownerRecord?.type === "vtuber" ? ownerRecord?.key : ""));
  if ((detailKey || vtuberAlias) && supportsRuntimeSources) {
    return `/api/sources/${encodeURIComponent(detailKey || vtuberAlias)}`;
  }
  const candidates = [
    record?.sourceDetail?.path,
    record?.sourceDetails?.path,
    record?.detailPath,
    record?.detail?.path,
    ownerRecord?.sourceDetail?.path,
    ownerRecord?.sourceDetails?.path,
    ownerRecord?.detailPath,
    ownerRecord?.detail?.path,
    occurrences?.[0]?.sourceDetailPath,
    occurrences?.[0]?.sourceDetail?.path,
    occurrences?.[0]?.item?.sourceDetailPath,
    occurrences?.[0]?.item?.sourceDetail?.path,
    sourceDetailPathFromShard(record, occurrences),
  ];
  return cleanText(candidates.find((path) => path && (!isRuntimeSourceDetailPath(path) || supportsRuntimeSources)));
}
''',"source capability gate")
    source=replace_once(source,
'''  const load = readJson(requestPath, { cache: cacheModeForPath(path) })
    .then((payload) => normalizeSourceDetailOccurrences(payload, key))
''',
'''  const sourceCacheMode = isRuntimeSourceDetailPath(path) && runtimeReleaseVersion() ? "force-cache" : cacheModeForPath(path);
  const load = readJson(requestPath, { cache: sourceCacheMode })
    .then((payload) => normalizeSourceDetailOccurrences(payload, key))
''',"source occurrence cache")
    source=replace_once(source,
'''  const load = readJson(requestPath, { cache: cacheModeForPath(path) })
    .then((payload) => {
''',
'''  const sourceCacheMode = isRuntimeSourceDetailPath(path) && runtimeReleaseVersion() ? "force-cache" : cacheModeForPath(path);
  const load = readJson(requestPath, { cache: sourceCacheMode })
    .then((payload) => {
''',"source page cache")
    source=replace_once(source,
'''  params.set("range", cleanText(state.range) || "all");
  const suffix = params.toString();
''',
'''  params.set("range", cleanText(state.range) || "all");
  const releaseVersion = runtimeReleaseVersion();
  if (releaseVersion) params.set("v", releaseVersion);
  const suffix = params.toString();
''',"source release version")
    path.write_text(source,encoding="utf-8");return True


def main(argv:Sequence[str]|None=None)->int:
    p=argparse.ArgumentParser(description=__doc__);p.add_argument("--app",type=Path,default=Path("assets/app.js"));p.add_argument("--check",action="store_true");args=p.parse_args(argv)
    if not args.app.is_file():print(f"FRONTEND_PATCH_ERROR missing file: {args.app}",file=sys.stderr);return 1
    target=args.app
    temp=None
    if args.check:
        temp=args.app.with_name(args.app.name+".patch-check.tmp");temp.write_text(args.app.read_text(encoding="utf-8"),encoding="utf-8");target=temp
    try:changed=patch_app(target)
    except Exception as exc:print(f"FRONTEND_PATCH_ERROR {type(exc).__name__}: {exc}",file=sys.stderr);return 1
    finally:
        if temp:temp.unlink(missing_ok=True)
    print(f"FRONTEND_PATCH_OK changed={1 if changed else 0} check={1 if args.check else 0}");return 0

if __name__=="__main__":raise SystemExit(main())
