const { blocklistHash, createBlockedSourceMatcher, loadBlocklist } = require("./blocked-vtuber-utils");

const BLOCKED_REGIONAL_VTUBER_CHANNELS = loadBlocklist();
const BLOCKLIST_HASH = blocklistHash(BLOCKED_REGIONAL_VTUBER_CHANNELS);
const BLOCKLIST_VERSION = BLOCKED_REGIONAL_VTUBER_CHANNELS.listVersion;
const matchBlockedSource = createBlockedSourceMatcher(BLOCKED_REGIONAL_VTUBER_CHANNELS);

function isBlockedSource(item) {
  return Boolean(matchBlockedSource(item));
}

function filterBlockedVideos(items) {
  return (items || []).filter((item) => !isBlockedSource(item));
}

module.exports = {
  BLOCKED_REGIONAL_VTUBER_CHANNELS,
  BLOCKLIST_HASH,
  BLOCKLIST_VERSION,
  filterBlockedVideos,
  isBlockedSource,
  matchBlockedSource,
};
