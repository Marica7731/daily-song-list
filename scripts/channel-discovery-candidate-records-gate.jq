def normalized_handle:
  tostring | gsub("^/+"; "") | gsub("/+$"; "") | sub("^@"; "") | ascii_downcase | "@" + .;

def canonical_response_url:
  type == "string" and test("^https://www\\.youtube\\.com/@[a-z0-9._-]{3,30}(/(featured|streams|videos|shorts|live|community))?$");

def canonical_api_url:
  type == "string" and . == "https://www.youtube.com/youtubei/v1/browse";

def exact_channel_identity($expectedChannelId; $expectedChannelHandle; $expectedChannelUrl):
  (.channelId // "") == $expectedChannelId and
  (.channelUrl // "") == $expectedChannelUrl and
  (.observedChannelId // "") == $expectedChannelId and
  ((.channelHandle // "") | normalized_handle) == $expectedChannelHandle and
  ((.observedChannelHandle // "") | normalized_handle) == $expectedChannelHandle and
  (.observedChannelUrl // "") == $expectedChannelUrl and
  ((.discoverySourceUrl // "") | type == "string" and startswith($expectedChannelUrl + "/"));

def record_evidence_bound($record; $pages; $expectedChannelId; $expectedChannelHandle):
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
      ($ref.rendererOwnerChannelId == $expectedChannelId) and
      (($ref.rendererOwnerChannelHandle == "") or (($ref.rendererOwnerChannelHandle | normalized_handle) == $expectedChannelHandle)) and
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
          (.ownerChannelIds | index($expectedChannelId)) != null))
    else false end
  )) and
  any($record.discoveryEvidenceRefs[];
    .sourceUrl == $record.observedChannelSourceUrl and
    .responseUrl == $record.observedChannelResponseUrl);

def initial_pages_bound($pages; $expectedChannelId; $expectedChannelHandle; $expectedChannelUrl; $maxChannelPages):
  ($pages | type == "array" and length == 2 and map(.tab) == ["streams", "videos"] and all(.[];
    . as $page |
    (.reachedEnd == true) and
    (.status == 200) and
    (.bytes | type == "number" and . >= 0) and
    (.rawSha256 | type == "string" and test("^[a-f0-9]{64}$")) and
    (.evidencePath | type == "string" and test("^pages/[0-9]{2}-(streams|videos)\\.html$")) and
    ($page.continuationRounds | type == "number" and . >= 0 and . <= ($maxChannelPages - 1)) and
    ($page.pageCount == ($page.continuationRounds + 1)) and
    (($page.continuationEvidence | type) == "array") and
    (($page.continuationEvidence | length) == $page.continuationRounds) and
    all($page.continuationEvidence[];
      .apiPath == "/youtubei/v1/browse" and
      (.requestTokenSha256 | test("^[a-f0-9]{64}$")) and
      ((.nextTokenSha256 == "") or (.nextTokenSha256 | test("^[a-f0-9]{64}$"))) and
      (.tokenChainSha256 | test("^[a-f0-9]{64}$")) and
      (.evidencePath | test("^pages/[0-9]{2}-(streams|videos)-continuation-[0-9]{3}\\.json$")) and
      (.sha256 | test("^[a-f0-9]{64}$")) and
      (.bytes | type == "number" and . >= 0) and
      (.ownerChannelIds | type == "array" and all(.[]; . == $expectedChannelId)) and
      (.ownerChannelHandles | type == "array" and all(.[]; normalized_handle == $expectedChannelHandle))
    ) and
    ([$page.continuationEvidence[].requestTokenSha256] | length == (unique | length)) and
    all($page.continuationEvidence | to_entries[]; . as $entry | $entry.key == 0 or $entry.value.requestTokenSha256 == $page.continuationEvidence[$entry.key - 1].nextTokenSha256) and
    (($page.continuationEvidence | length) == 0 or $page.continuationEvidence[-1].nextTokenSha256 == "") and
    (($page.requiresContinuation // false) == false) and
    (($page.pageUrl | split("?")[0] | split("#")[0]) == ($expectedChannelUrl + "/" + $page.tab)) and
    ($page.observedChannelId == $expectedChannelId) and
    (($page.observedChannelHandle // "") | normalized_handle) == $expectedChannelHandle and
    ($page.observedChannelUrl == $expectedChannelUrl) and
    ($page.observedChannelResponseUrl | canonical_response_url) and
    (($page.pageUrl | split("?")[0] | split("#")[0]) == $page.observedChannelResponseUrl)
  ));

($sourceManifestFile[0]) as $source |
($expectedChannelHandle | normalized_handle) as $expectedHandle |
. as $records |
($records | type == "array") and
($records | length > 0) and
($records | length <= $maxVideos) and
($records | map(.youtubeVideoId | type == "string" and length > 0) | index(false) == null) and
($records | map(.youtubeVideoId) | length == (unique | length)) and
($source.schemaVersion == 1) and
($source.complete == true) and
($source.partial == false) and
($source.sourceCommit == $expectedSourceCommit) and
($source.channelId == $expectedChannelId) and
(($source.channelHandle // "") | normalized_handle) == $expectedHandle and
($source.channelUrl == $expectedChannelUrl) and
($source.sourceReachedEnd == true) and
($source.maxChannelPages | type == "number" and . >= 1) and
initial_pages_bound($source.pageSummaries; $expectedChannelId; $expectedHandle; $expectedChannelUrl; $source.maxChannelPages) and
($source.pageEvidenceFiles | type == "array" and length == ([ $source.pageSummaries[] | 1 + (.continuationEvidence | length) ] | add)) and
([ $source.pageSummaries[] | .evidencePath, (.continuationEvidence[]?.evidencePath) ] | sort) == ([ $source.pageEvidenceFiles[] | .path ] | sort) and
all($source.pageSummaries[];
  . as $page |
  any($source.pageEvidenceFiles[]; .path == $page.evidencePath and .sha256 == $page.rawSha256 and .bytes == $page.bytes) and
  all($page.continuationEvidence[]; . as $continuation | any($source.pageEvidenceFiles[]; .path == $continuation.evidencePath and .sha256 == $continuation.sha256 and .bytes == $continuation.bytes))
) and
($source.rawItemCount == ([$source.pageSummaries[] | .rawItemCount] | add)) and
($source.pageCandidateCountSum == ([$source.pageSummaries[] | .candidateCount] | add)) and
($source.uniqueCandidateCount == ($records | length)) and
($source.candidateCount == $source.uniqueCandidateCount) and
($records | map(exact_channel_identity($expectedChannelId; $expectedHandle; $expectedChannelUrl) and record_evidence_bound(.; $source.pageSummaries; $expectedChannelId; $expectedHandle)) | index(false) == null)
