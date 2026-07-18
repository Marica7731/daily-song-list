function parseRobotsTxt(text) {
  const groups = [];
  let current = null;

  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (key === "user-agent") {
      current = { userAgents: [value.toLowerCase()], rules: [], crawlDelay: null, sitemaps: [] };
      groups.push(current);
      continue;
    }
    if (!current) continue;
    if (key === "allow" || key === "disallow") current.rules.push({ type: key, pattern: value });
    else if (key === "crawl-delay") current.crawlDelay = Number.parseFloat(value);
    else if (key === "sitemap") current.sitemaps.push(value);
  }

  return { groups };
}

function policyForUserAgent(policy, userAgent = "*") {
  const lowered = String(userAgent || "*").toLowerCase();
  return (
    policy.groups.find((group) => group.userAgents.some((agent) => agent === "*" || lowered.includes(agent))) ||
    policy.groups.find((group) => group.userAgents.includes("*")) ||
    { rules: [], crawlDelay: null, sitemaps: [] }
  );
}

function isAllowed(policy, urlOrPath, userAgent = "*") {
  const group = policyForUserAgent(policy, userAgent);
  const target = toPathWithSearch(urlOrPath);
  let best = null;

  for (const rule of group.rules) {
    if (!rule.pattern) {
      if (rule.type === "disallow") continue;
      continue;
    }
    if (!robotsMatch(rule.pattern, target)) continue;
    const score = rule.pattern.replace(/[*$]/g, "").length;
    if (!best || score > best.score || (score === best.score && rule.type === "allow")) {
      best = { ...rule, score };
    }
  }

  return best ? best.type === "allow" : true;
}

function crawlDelaySeconds(policy, userAgent = "*") {
  const delay = policyForUserAgent(policy, userAgent).crawlDelay;
  return Number.isFinite(delay) ? delay : null;
}

function toPathWithSearch(urlOrPath) {
  try {
    const url = new URL(urlOrPath, "https://vsinger-moment.jp");
    return `${url.pathname}${url.search}`;
  } catch {
    return String(urlOrPath || "/");
  }
}

function robotsMatch(pattern, target) {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\$/g, "$");
  return new RegExp(`^${escaped}`).test(target);
}

module.exports = {
  crawlDelaySeconds,
  isAllowed,
  parseRobotsTxt,
  policyForUserAgent,
};
