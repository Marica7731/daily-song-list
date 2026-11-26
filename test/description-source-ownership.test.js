"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { extractDescriptionCandidates } = require("../scripts/update-songlist");

const currentId = "7xLlPJS65JQ";
const otherId = "ZuJRgyDWars";
const officialDescription = "19:22 over the limits / angela\n25:28 アポリア / ヨルシカ";
const unrelated = "防衛大臣臨時記者会見｜令和8年10月29日（木)18:25-18:39（現地時間）";

function watch(description, layout = "twoColumnWatchNextResults") {
  return {
    currentVideoEndpoint: { watchEndpoint: { videoId: currentId } },
    contents: {
      [layout]: {
        results: { results: { contents: [{ videoSecondaryInfoRenderer: description }] } },
        secondaryResults: {
          secondaryResults: {
            results: [
              { compactVideoRenderer: { videoId: otherId, title: { simpleText: unrelated } } },
              { compactVideoRenderer: {
                videoId: otherId, title: { runs: [{ text: unrelated }] },
                attributedDescription: { content: unrelated },
              } },
            ],
          },
        },
      },
    },
  };
}

test("only watch-owner description candidates are selected", () => {
  const data = watch({ attributedDescription: { content: officialDescription } });
  data.engagementPanels = [
    { engagementPanelSectionListRenderer: {
      targetId: "engagement-panel-structured-description",
      content: { structuredDescriptionContentRenderer: { items: [
        { expandableVideoDescriptionBodyRenderer: { attributedDescriptionBodyText: { content: officialDescription } } },
      ] } },
    } },
  ];
  assert.deepEqual(extractDescriptionCandidates(data, { videoId: currentId }, currentId), [officialDescription]);
  assert.deepEqual(extractDescriptionCandidates(data, { videoId: otherId }, currentId), []);
  assert.deepEqual(extractDescriptionCandidates(data, { videoId: currentId }, otherId), []);
});

test("preserves single genuine songs in attributed and legacy first-party descriptions", () => {
  const single = "0:12 Lemonade / THE BAWDIES";
  for (const layout of ["twoColumnWatchNextResults", "singleColumnWatchNextResults"]) {
    for (const description of [
      { attributedDescription: { content: single } },
      { description: { simpleText: single } },
      { description: { runs: [{ text: single }] } },
    ]) {
      assert.deepEqual(extractDescriptionCandidates(watch(description, layout), null, currentId), [single]);
    }
  }
});

test("an ordinary cover with no description yields no fake source from related content", () => {
  const data = watch({});
  assert.deepEqual(extractDescriptionCandidates(data, { videoId: currentId }, currentId), []);
  delete data.currentVideoEndpoint;
  assert.deepEqual(extractDescriptionCandidates(data, {}, currentId), []);
});
