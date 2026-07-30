def normalized_handle:
  tostring | gsub("^/+"; "") | gsub("/+$"; "") | sub("^@"; "") | ascii_downcase | "@" + .;

def canonical_response_url:
  type == "string" and test("^https://www\\.youtube\\.com/@[a-z0-9._-]{3,30}(/(featured|streams|videos|shorts|live|community))?$");

def canonical_api_url:
  type == "string" and . == "https://www.youtube.com/youtubei/v1/browse";

def same_page($source; $response):
  ($source | type == "string" and ($source | split("?")[0] | split("#")[0]) == $response);

def exact_identity($value; $request; $expectedSourceCommit; $expectedChannelId; $expectedChannelHandle; $expectedChannelUrl):
  ($value.channelId // "") == $expectedChannelId and
  (($value.channelHandle // "") | normalized_handle) == $expectedChannelHandle and
  ($value.channelUrl // "") == $expectedChannelUrl and
  ($value.channelSlug // "") == ($request.channelSlug // "") and
  ($value.sourceCommit // "") == $expectedSourceCommit;

def page_bound($page; $request):
  ($page.pageUrl // "") as $source |
  ($page.observedChannelResponseUrl // "") as $response |
  ($source | type == "string" and startswith($request.channelUrl + "/")) and
  ($response | canonical_response_url) and
  same_page($source; $response) and
  ($page.reachedEnd == true) and
  ($page.status == 200) and
  ($page.bytes | type == "number" and . >= 0) and
  ($page.rawSha256 | type == "string" and test("^[a-f0-9]{64}$")) and
  ($page.evidencePath | type == "string" and test("^pages/[0-9]{2}-(streams|videos)\\.html$")) and
  ($page.observedChannelId // "") == ($request.channelId // "") and
  (($page.observedChannelHandle // "") | normalized_handle) == (($request.channelHandle // "") | normalized_handle) and
  ($page.observedChannelUrl // "") == ($request.channelUrl // "") and
  ($page.continuationRounds | type == "number" and . >= 0 and . <= ($request.maxChannelPages - 1)) and
  ($page.pageCount == ($page.continuationRounds + 1)) and
  (($page.continuationEvidence | type) == "array") and
  (($page.continuationEvidence | length) == $page.continuationRounds) and
  all($page.continuationEvidence | to_entries[];
    .key + 1 == .value.round and
    .value.tab == $page.tab and
    .value.apiPath == "/youtubei/v1/browse" and
    (.value.requestTokenSha256 | type == "string" and test("^[a-f0-9]{64}$")) and
    ((.value.nextTokenSha256 == "") or (.value.nextTokenSha256 | type == "string" and test("^[a-f0-9]{64}$"))) and
    (.value.tokenChainSha256 | type == "string" and test("^[a-f0-9]{64}$")) and
    (.value.evidencePath == ("pages/" + (($page.pageIndex | tostring) | if length == 1 then "0" + . else . end) + "-" + $page.tab + "-continuation-" + ((.value.round | tostring) | if length == 1 then "00" + . elif length == 2 then "0" + . else . end) + ".json")) and
    (.value.sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
    (.value.bytes | type == "number" and . >= 0) and
    (.value.rawItemCount | type == "number" and . >= 0) and
    (.value.candidateCount | type == "number" and . >= 0) and
    (.value.videoIds | type == "array") and
    (.value.ownerChannelIds | type == "array" and all(.[]; . == $request.channelId)) and
    (.value.ownerChannelHandles | type == "array" and all(.[]; (normalized_handle == ($request.channelHandle | normalized_handle))))
  ) and
  ([$page.continuationEvidence[].requestTokenSha256] | length == (unique | length)) and
  all($page.continuationEvidence | to_entries[]; . as $entry | $entry.key == 0 or $entry.value.requestTokenSha256 == $page.continuationEvidence[$entry.key - 1].nextTokenSha256) and
  (($page.continuationEvidence | length) == 0 or $page.continuationEvidence[-1].nextTokenSha256 == "");

def initial_pages_bound($pages; $request):
  ($pages | type == "array" and length == 2 and map(.tab) == ["streams", "videos"] and all(.[];
    page_bound(.; $request) and
    ((.pageUrl | split("?")[0] | split("#")[0]) == ($request.channelUrl + "/" + .tab)) and
    (.requiresContinuation // false) == false
  ));

def exact_record_identity($record; $request):
  ($record.channelId // "") == ($request.channelId // "") and
  (($record.channelHandle // "") | normalized_handle) == (($request.channelHandle // "") | normalized_handle) and
  ($record.channelUrl // "") == ($request.channelUrl // "") and
  ($record.observedChannelId // "") == ($request.channelId // "") and
  (($record.observedChannelHandle // "") | normalized_handle) == (($request.channelHandle // "") | normalized_handle) and
  ($record.observedChannelUrl // "") == ($request.channelUrl // "") and
  (($record.discoverySourceUrl // "") | type == "string" and startswith($request.channelUrl + "/"));

def record_evidence_bound($record; $pages; $request):
  ($record.discoveryEvidenceRefs | type == "array" and length > 0 and all(.[];
    . as $ref |
    if $ref.kind == "initial-html" then
      ($ref.responseUrl | canonical_response_url) and
      any($pages[]?;
        .pageUrl == $ref.sourceUrl and
        .observedChannelResponseUrl == $ref.responseUrl and
        .evidencePath == $ref.path and
        .rawSha256 == $ref.sha256 and
        .bytes == $ref.bytes)
    elif $ref.kind == "youtubei-continuation" then
      ($ref.responseUrl | canonical_api_url) and
      ($ref.continuationApiPath == "/youtubei/v1/browse") and
      ($ref.rendererOwnerChannelId == $request.channelId) and
      (($ref.rendererOwnerChannelHandle == "") or (($ref.rendererOwnerChannelHandle | normalized_handle) == ($request.channelHandle | normalized_handle))) and
      any($pages[]?;
        .pageUrl == $ref.sourceUrl and
        any(.continuationEvidence[]?;
          .evidencePath == $ref.path and
          .sha256 == $ref.sha256 and
          .bytes == $ref.bytes and
          .round == $ref.continuationRound and
          .apiPath == $ref.continuationApiPath and
          .requestTokenSha256 == $ref.requestTokenSha256 and
          .tokenChainSha256 == $ref.tokenChainSha256 and
          (.videoIds | index($record.youtubeVideoId)) != null and
          (.ownerChannelIds | index($request.channelId)) != null))
    else false end
  )) and
  any($record.discoveryEvidenceRefs[];
    .sourceUrl == $record.observedChannelSourceUrl and
    .responseUrl == $record.observedChannelResponseUrl);

def all_evidence_paths($pages):
  [$pages[] | .evidencePath, (.continuationEvidence[]?.evidencePath)];

($requestFile[0]) as $request |
($sourceManifestFile[0]) as $source |
($checkpointFile[0]) as $checkpoint |
($expectedChannelHandle | normalized_handle) as $expectedHandle |
. as $records |
($records | type == "array") and
($request.kind == "channel-discovery-candidate-run") and
($request.candidateOnly == true) and
($request.forceRefresh | type == "boolean") and
($source.forceRefresh | type == "boolean") and
($source.forceRefresh == $request.forceRefresh) and
($checkpoint.forceRefresh | type == "boolean") and
($checkpoint.forceRefresh == $request.forceRefresh) and
($source.schemaVersion == 1) and
($source.complete == true) and
($source.partial == false) and
($checkpoint.schemaVersion == 1) and
($checkpoint.complete == true) and
($checkpoint.partial == false) and
($checkpoint.discoveryCheckpoint.schemaVersion == 1) and
($checkpoint.discoveryCheckpoint.complete == true) and
($checkpoint.discoveryCheckpoint.partial == false) and
exact_identity($request; $request; $expectedSourceCommit; $expectedChannelId; $expectedHandle; $expectedChannelUrl) and
exact_identity($source; $request; $expectedSourceCommit; $expectedChannelId; $expectedHandle; $expectedChannelUrl) and
exact_identity($checkpoint; $request; $expectedSourceCommit; $expectedChannelId; $expectedHandle; $expectedChannelUrl) and
($source.kind == "channel-discovery-source-manifest") and
($source.candidateOnly == true) and
($source.sourceReachedEnd == true) and
initial_pages_bound($source.pageSummaries; $request) and
($source.pageEvidenceFiles | type == "array" and length == (all_evidence_paths($source.pageSummaries) | length)) and
(all_evidence_paths($source.pageSummaries) | sort) == ([ $source.pageEvidenceFiles[] | .path ] | sort) and
all($source.pageEvidenceFiles[]; (.path | test("^pages/[0-9]{2}-(streams|videos)(-continuation-[0-9]{3}\\.json|\\.html)$")) and (.sha256 | test("^[a-f0-9]{64}$")) and (.bytes | type == "number" and . >= 0)) and
all($source.pageSummaries[];
  . as $page |
  any($source.pageEvidenceFiles[]; .path == $page.evidencePath and .sha256 == $page.rawSha256 and .bytes == $page.bytes) and
  all($page.continuationEvidence[]; . as $continuation | any($source.pageEvidenceFiles[]; .path == $continuation.evidencePath and .sha256 == $continuation.sha256 and .bytes == $continuation.bytes))
) and
($checkpoint.kind == "channel-discovery-candidate-checkpoint") and
($checkpoint.discoveryCheckpoint.channelUrl == $request.channelUrl) and
($checkpoint.discoveryCheckpoint.candidateCount == $source.candidateCount) and
($checkpoint.candidateCount == $source.candidateCount) and
($checkpoint.discoveryCheckpoint.sourceReachedEnd == true) and
($checkpoint.discoveryCheckpoint.pageSummaries | type == "array" and $checkpoint.discoveryCheckpoint.pageSummaries == $source.pageSummaries) and
initial_pages_bound($checkpoint.discoveryCheckpoint.pageSummaries; $request) and
($source.candidateCount == ($records | length)) and
($source.candidateCount > 0) and
($source.candidateCount <= $request.maxVideos) and
($records | map(.youtubeVideoId | type == "string" and length > 0) | index(false) == null) and
($records | map(.youtubeVideoId) | length == (unique | length)) and
($records | map(exact_record_identity(.; $request) and record_evidence_bound(.; $source.pageSummaries; $request)) | index(false) == null)
