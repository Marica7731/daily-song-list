(function initRequestScheduler(root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(typeof globalThis !== "undefined" ? globalThis : root);
    return;
  }

  const api = factory(root);
  root.RequestScheduler = api;
  if (!root.dailySongRequestScheduler) {
    root.dailySongRequestScheduler = api.createRequestScheduler({ root });
  }
  root.printRequestSchedulerStats = function printRequestSchedulerStats() {
    const stats = root.dailySongRequestScheduler.getStats();
    if (root.console?.table) root.console.table(stats.entries);
    return stats;
  };
})(typeof globalThis !== "undefined" ? globalThis : window, function createRequestSchedulerModule(root) {
  const PRIORITIES = Object.freeze({
    USER_BLOCKING: "user-blocking",
    NORMAL: "normal",
    IDLE: "idle",
  });
  const PRIORITY_ORDER = Object.freeze([PRIORITIES.USER_BLOCKING, PRIORITIES.NORMAL, PRIORITIES.IDLE]);
  const DEFAULT_LIMITS = Object.freeze({
    [PRIORITIES.USER_BLOCKING]: 3,
    [PRIORITIES.NORMAL]: 2,
    [PRIORITIES.IDLE]: 1,
  });
  const DEFAULT_REVISIONS = Object.freeze(["page", "query", "source", "range"]);
  const ALLOWED_IDLE_PREFETCH_KINDS = new Set(["previous-page", "next-page"]);
  const CACHE_BYPASS_MODES = new Set(["no-store", "reload"]);

  function createRequestScheduler(options = {}) {
    return new RequestScheduler(options);
  }

  class RequestScheduler {
    constructor(options = {}) {
      this.root = options.root || root || {};
      this.now = typeof options.now === "function" ? options.now : defaultNow;
      this.fetchImpl = options.fetch || this.root.fetch?.bind(this.root);
      this.setTimeoutImpl = options.setTimeout || this.root.setTimeout?.bind(this.root) || setTimeout;
      this.clearTimeoutImpl = options.clearTimeout || this.root.clearTimeout?.bind(this.root) || clearTimeout;
      this.idleScheduler = options.idleScheduler || null;
      this.defaultTimeoutMs = positiveNumber(options.timeoutMs, 30000);
      this.defaultRetries = nonNegativeInteger(options.retries, 0);
      this.connection = normalizeNetworkProfile(options.connection || this.root.navigator?.connection);
      this.limits = deriveConcurrencyLimits(this.connection, options.concurrency);
      this.queues = new Map(PRIORITY_ORDER.map((priority) => [priority, []]));
      this.active = new Set();
      this.activeCounts = new Map(PRIORITY_ORDER.map((priority) => [priority, 0]));
      this.inFlight = new Map();
      this.cache = new Map();
      this.entries = [];
      this.sequence = 0;
      this.revisions = new Map(DEFAULT_REVISIONS.map((scope) => [scope, 0]));
    }

    requestResource(options = {}) {
      if (!this.fetchImpl) {
        return Promise.resolve(this.createSkippedResult(options, "fetch-unavailable"));
      }

      const priority = normalizePriority(options.priority);
      const key = normalizeKey(options);
      const cacheKey = normalizeCacheKey(options, key);
      const cacheMode = options.cacheMode || "default";
      const cacheable = !CACHE_BYPASS_MODES.has(cacheMode);

      if (options.prefetch && !isAutoPrefetchAllowed(this.connection)) {
        return Promise.resolve(this.createSkippedResult({ ...options, key, priority }, "prefetch-disabled-by-network"));
      }

      if (cacheable && this.cache.has(cacheKey)) {
        const cached = this.cache.get(cacheKey);
        const queuedAt = this.now();
        const revision = normalizeRevision(options.revision);
        const status = this.isCurrentRevision(revision) ? "success" : "stale";
        const entry = this.recordTelemetry({
          key,
          url: options.url,
          priority,
          queuedAt,
          startedAt: queuedAt,
          completedAt: queuedAt,
          queueDelay: 0,
          duration: 0,
          cacheHit: true,
          status,
          transferSize: 0,
          decodedBodySize: cached.decodedBodySize,
          revision,
        });
        return Promise.resolve({
          status,
          key,
          url: options.url,
          priority,
          data: status === "success" ? cached.data : undefined,
          cacheHit: true,
          telemetry: cloneTelemetry(entry),
        });
      }

      if (this.inFlight.has(cacheKey)) {
        const existing = this.inFlight.get(cacheKey);
        existing.duplicates += 1;
        return existing.promise;
      }

      const entry = this.createEntry({
        ...options,
        priority,
        key,
        cacheKey,
        cacheMode,
        cacheable,
      });
      this.inFlight.set(cacheKey, entry);
      this.enqueue(entry);
      if (priority === PRIORITIES.USER_BLOCKING) {
        this.preemptIdleRequests("preempted-by-user-blocking");
      }
      this.pump();
      return entry.promise;
    }

    scheduleIdlePrefetch(options = {}, context = {}) {
      const prefetchKind = options.prefetchKind || options.kind;
      if (!ALLOWED_IDLE_PREFETCH_KINDS.has(prefetchKind)) {
        return Promise.resolve(this.createSkippedResult({ ...options, priority: PRIORITIES.IDLE }, "prefetch-kind-not-allowed"));
      }
      if (!this.canStartIdlePrefetch(context)) {
        return Promise.resolve(this.createSkippedResult({ ...options, priority: PRIORITIES.IDLE }, "prefetch-conditions-not-met"));
      }

      return this.waitForBrowserIdle().then(() => {
        if (!this.canStartIdlePrefetch(context)) {
          return this.createSkippedResult({ ...options, priority: PRIORITIES.IDLE }, "prefetch-conditions-not-met");
        }
        return this.requestResource({
          ...options,
          priority: PRIORITIES.IDLE,
          prefetch: true,
          preemptible: options.preemptible !== false,
        });
      });
    }

    canStartIdlePrefetch(context = {}) {
      if (!isAutoPrefetchAllowed(this.connection)) return false;
      const documentRef = context.document || this.root.document;
      const visibilityState = context.visibilityState || documentRef?.visibilityState || "visible";
      if (visibilityState !== "visible") return false;
      if (context.queryPanelOpen || context.searchTyping || context.sourceDetailLoading || context.mainRequestActive) return false;
      if (this.activeCounts.get(PRIORITIES.USER_BLOCKING) > 0 || this.activeCounts.get(PRIORITIES.NORMAL) > 0) return false;
      return true;
    }

    bumpRevision(scope) {
      const normalized = normalizeRevisionScope(scope);
      const next = (this.revisions.get(normalized) || 0) + 1;
      this.revisions.set(normalized, next);
      return { scope: normalized, value: next };
    }

    captureRevision(scope) {
      const normalized = normalizeRevisionScope(scope);
      if (!this.revisions.has(normalized)) this.revisions.set(normalized, 0);
      return { scope: normalized, value: this.revisions.get(normalized) };
    }

    captureRevisions(scopes) {
      return (scopes || DEFAULT_REVISIONS).map((scope) => this.captureRevision(scope));
    }

    isCurrentRevision(revision) {
      return normalizeRevision(revision).every((item) => this.captureRevision(item.scope).value === item.value);
    }

    preemptIdleRequests(reason = "preempted") {
      for (const entry of Array.from(this.active)) {
        if (entry.priority === PRIORITIES.IDLE && entry.preemptible) this.abortEntry(entry, reason);
      }
      for (const entry of [...this.queues.get(PRIORITIES.IDLE)]) {
        if (entry.preemptible) this.abortEntry(entry, reason);
      }
    }

    abortMatching(predicate, reason = "cancelled") {
      for (const entry of [...this.active, ...this.queues.get(PRIORITIES.USER_BLOCKING), ...this.queues.get(PRIORITIES.NORMAL), ...this.queues.get(PRIORITIES.IDLE)]) {
        if (predicate(entry)) this.abortEntry(entry, reason);
      }
    }

    updateConnection(connection) {
      this.connection = normalizeNetworkProfile(connection);
      this.limits = deriveConcurrencyLimits(this.connection);
      this.pump();
    }

    getStats() {
      return {
        entries: this.entries.map(cloneTelemetry),
        active: prioritySnapshot(this.activeCounts),
        queued: Object.fromEntries(PRIORITY_ORDER.map((priority) => [priority, this.queues.get(priority).length])),
        limits: { ...this.limits },
        network: { ...this.connection },
        cacheSize: this.cache.size,
        revisions: Object.fromEntries(this.revisions),
      };
    }

    clearCache() {
      this.cache.clear();
    }

    createEntry(options) {
      const controller = createAbortController(this.root);
      const queuedAt = this.now();
      const revision = normalizeRevision(options.revision);
      const telemetry = this.recordTelemetry({
        id: ++this.sequence,
        key: options.key,
        url: options.url,
        priority: options.priority,
        queuedAt,
        startedAt: null,
        completedAt: null,
        abortedAt: null,
        queueDelay: null,
        duration: null,
        cacheHit: false,
        transferSize: 0,
        decodedBodySize: 0,
        abortReason: "",
        status: "queued",
        revision,
      });
      let resolvePromise;
      const promise = new Promise((resolve) => {
        resolvePromise = resolve;
      });
      const entry = {
        id: telemetry.id,
        key: options.key,
        cacheKey: options.cacheKey,
        url: options.url,
        priority: options.priority,
        revision,
        cacheMode: options.cacheMode,
        cacheable: options.cacheable,
        parser: options.parser,
        fetchOptions: options.fetchOptions || null,
        timeoutMs: positiveNumber(options.timeoutMs, this.defaultTimeoutMs),
        retries: nonNegativeInteger(options.retries, this.defaultRetries),
        preemptible: options.preemptible !== false,
        controller,
        queuedAt,
        telemetry,
        state: "queued",
        timeoutId: null,
        duplicates: 0,
        promise,
        resolve: resolvePromise,
      };

      if (options.signal) {
        if (options.signal.aborted) {
          this.setTimeoutImpl(() => this.abortEntry(entry, abortReasonFromSignal(options.signal)), 0);
        } else {
          options.signal.addEventListener("abort", () => this.abortEntry(entry, abortReasonFromSignal(options.signal)), { once: true });
        }
      }
      return entry;
    }

    enqueue(entry) {
      this.queues.get(entry.priority).push(entry);
    }

    pump() {
      for (const priority of PRIORITY_ORDER) {
        const queue = this.queues.get(priority);
        while (queue.length > 0 && this.canRunPriority(priority)) {
          const entry = queue.shift();
          if (entry.state !== "queued") continue;
          this.startEntry(entry);
        }
      }
    }

    canRunPriority(priority) {
      if (this.activeCounts.get(priority) >= this.limits[priority]) return false;
      if (priority === PRIORITIES.IDLE) {
        return this.activeCounts.get(PRIORITIES.USER_BLOCKING) === 0 && this.activeCounts.get(PRIORITIES.NORMAL) === 0;
      }
      return true;
    }

    startEntry(entry) {
      entry.state = "active";
      entry.telemetry.status = "active";
      entry.telemetry.startedAt = this.now();
      entry.telemetry.queueDelay = entry.telemetry.startedAt - entry.queuedAt;
      this.active.add(entry);
      this.activeCounts.set(entry.priority, this.activeCounts.get(entry.priority) + 1);
      if (entry.timeoutMs > 0) {
        entry.timeoutId = this.setTimeoutImpl(() => this.abortEntry(entry, "timeout"), entry.timeoutMs);
      }
      this.executeEntry(entry);
    }

    async executeEntry(entry) {
      let lastError = null;
      for (let attempt = 0; attempt <= entry.retries; attempt += 1) {
        if (entry.state === "complete") return;
        try {
          const response = await this.fetchImpl(entry.url, buildFetchOptions(entry));
          if (entry.state === "complete") return;
          if (response && response.ok === false) throw new Error(`HTTP ${response.status || "error"}`);
          const parsed = await parseResponse(response, entry.parser);
          if (entry.state === "complete") return;
          this.completeEntry(entry, parsed);
          return;
        } catch (error) {
          lastError = error;
          if (entry.state === "complete") return;
          if (isAbortError(error) || entry.controller.signal?.aborted) {
            this.abortEntry(entry, entry.telemetry.abortReason || "aborted");
            return;
          }
          if (attempt >= entry.retries) break;
        }
      }
      this.failEntry(entry, lastError);
    }

    completeEntry(entry, parsed) {
      if (!this.isCurrentRevision(entry.revision)) {
        this.finishEntry(entry, {
          status: "stale",
          key: entry.key,
          url: entry.url,
          priority: entry.priority,
          revision: entry.revision,
          cacheHit: false,
          data: undefined,
        });
        return;
      }

      entry.telemetry.transferSize = parsed.transferSize;
      entry.telemetry.decodedBodySize = parsed.decodedBodySize;
      if (entry.cacheable) {
        this.cache.set(entry.cacheKey, {
          data: parsed.data,
          decodedBodySize: parsed.decodedBodySize,
        });
      }
      this.finishEntry(entry, {
        status: "success",
        key: entry.key,
        url: entry.url,
        priority: entry.priority,
        revision: entry.revision,
        cacheHit: false,
        data: parsed.data,
      });
    }

    failEntry(entry, error) {
      this.finishEntry(entry, {
        status: "failed",
        key: entry.key,
        url: entry.url,
        priority: entry.priority,
        revision: entry.revision,
        cacheHit: false,
        error,
      });
    }

    abortEntry(entry, reason = "aborted") {
      if (!entry || entry.state === "complete") return;
      entry.telemetry.abortReason = String(reason || "aborted");
      entry.telemetry.abortedAt = this.now();
      try {
        if (!entry.controller.signal?.aborted) entry.controller.abort(reason);
      } catch {
        entry.controller.abort();
      }
      this.finishEntry(entry, {
        status: "aborted",
        key: entry.key,
        url: entry.url,
        priority: entry.priority,
        revision: entry.revision,
        cacheHit: false,
        abortReason: entry.telemetry.abortReason,
      });
    }

    finishEntry(entry, result) {
      if (entry.state === "complete") return;
      const previousState = entry.state;
      entry.state = "complete";
      if (entry.timeoutId) this.clearTimeoutImpl(entry.timeoutId);
      if (previousState === "queued") removeFromQueue(this.queues.get(entry.priority), entry);
      if (previousState === "active") {
        this.active.delete(entry);
        this.activeCounts.set(entry.priority, Math.max(0, this.activeCounts.get(entry.priority) - 1));
      }
      if (this.inFlight.get(entry.cacheKey) === entry) this.inFlight.delete(entry.cacheKey);
      const completedAt = this.now();
      entry.telemetry.completedAt = result.status === "aborted" ? entry.telemetry.completedAt : completedAt;
      if (result.status !== "aborted") entry.telemetry.completedAt = completedAt;
      entry.telemetry.duration =
        entry.telemetry.startedAt === null ? 0 : (entry.telemetry.completedAt || completedAt) - entry.telemetry.startedAt;
      entry.telemetry.status = result.status;
      entry.resolve({
        ...result,
        telemetry: cloneTelemetry(entry.telemetry),
      });
      this.pump();
    }

    waitForBrowserIdle() {
      if (this.idleScheduler) return Promise.resolve().then(() => this.idleScheduler());
      const scheduler = this.root.scheduler;
      if (scheduler?.postTask) {
        return scheduler.postTask(() => undefined, { priority: "background" });
      }
      if (this.root.requestIdleCallback) {
        return new Promise((resolve) => this.root.requestIdleCallback(() => resolve()));
      }
      return new Promise((resolve) => this.setTimeoutImpl(resolve, 0));
    }

    createSkippedResult(options = {}, reason) {
      const queuedAt = this.now();
      const priority = normalizePriority(options.priority || PRIORITIES.NORMAL);
      const telemetry = this.recordTelemetry({
        key: normalizeKey(options),
        url: options.url,
        priority,
        queuedAt,
        startedAt: null,
        completedAt: queuedAt,
        abortedAt: null,
        queueDelay: 0,
        duration: 0,
        cacheHit: false,
        transferSize: 0,
        decodedBodySize: 0,
        abortReason: reason,
        status: "skipped",
        revision: normalizeRevision(options.revision),
      });
      return {
        status: "skipped",
        reason,
        key: normalizeKey(options),
        url: options.url,
        priority,
        telemetry: cloneTelemetry(telemetry),
      };
    }

    recordTelemetry(entry) {
      this.entries.push(entry);
      return entry;
    }
  }

  function normalizeNetworkProfile(connection = {}) {
    const effectiveType = String(connection?.effectiveType || "unknown").toLowerCase();
    const downlink = Number.isFinite(Number(connection?.downlink)) ? Number(connection.downlink) : null;
    return {
      saveData: Boolean(connection?.saveData),
      effectiveType,
      downlink,
      supported: Boolean(connection),
    };
  }

  function deriveConcurrencyLimits(connection, overrides = null) {
    const base = { ...DEFAULT_LIMITS, ...(overrides || {}) };
    const downlink = connection.downlink ?? Number.POSITIVE_INFINITY;
    if (connection.saveData || connection.effectiveType === "slow-2g" || connection.effectiveType === "2g" || downlink < 0.5) {
      return {
        [PRIORITIES.USER_BLOCKING]: Math.min(base[PRIORITIES.USER_BLOCKING], 1),
        [PRIORITIES.NORMAL]: Math.min(base[PRIORITIES.NORMAL], 1),
        [PRIORITIES.IDLE]: Math.min(base[PRIORITIES.IDLE], 1),
      };
    }
    if (connection.effectiveType === "3g" || downlink < 1.5) {
      return {
        [PRIORITIES.USER_BLOCKING]: Math.min(base[PRIORITIES.USER_BLOCKING], 2),
        [PRIORITIES.NORMAL]: Math.min(base[PRIORITIES.NORMAL], 1),
        [PRIORITIES.IDLE]: Math.min(base[PRIORITIES.IDLE], 1),
      };
    }
    return base;
  }

  function isAutoPrefetchAllowed(connection) {
    return !connection.saveData && connection.effectiveType !== "slow-2g" && connection.effectiveType !== "2g";
  }

  function normalizePriority(priority) {
    if (PRIORITY_ORDER.includes(priority)) return priority;
    return PRIORITIES.NORMAL;
  }

  function normalizeKey(options = {}) {
    return String(options.key || options.url || "");
  }

  function normalizeCacheKey(options, key) {
    return String(options.cacheKey || key || options.url || "");
  }

  function normalizeRevisionScope(scope) {
    return String(scope || "").replace(/Revision$/u, "") || "default";
  }

  function normalizeRevision(revision) {
    if (!revision) return [];
    if (Array.isArray(revision)) return revision.flatMap(normalizeRevision).filter(Boolean);
    if (typeof revision === "object" && "scope" in revision) {
      return [{ scope: normalizeRevisionScope(revision.scope), value: Number(revision.value || 0) }];
    }
    if (typeof revision === "object") {
      return Object.entries(revision)
        .filter(([, value]) => Number.isFinite(Number(value)))
        .map(([scope, value]) => ({ scope: normalizeRevisionScope(scope), value: Number(value) }));
    }
    return [];
  }

  function buildFetchOptions(entry) {
    return {
      ...(entry.fetchOptions || {}),
      signal: entry.controller.signal,
      cache: entry.cacheMode === "default" ? undefined : entry.cacheMode,
    };
  }

  async function parseResponse(response, parser) {
    const transferSize = responseHeaderNumber(response, "content-length");
    if (typeof parser === "function") {
      const data = await parser(response);
      return {
        data,
        transferSize,
        decodedBodySize: transferSize || estimateDecodedBodySize(data),
      };
    }
    if (response?.json) {
      const data = await response.json();
      return {
        data,
        transferSize,
        decodedBodySize: transferSize || estimateDecodedBodySize(data),
      };
    }
    if (response?.text) {
      const text = await response.text();
      return {
        data: text,
        transferSize,
        decodedBodySize: transferSize || text.length,
      };
    }
    return {
      data: response,
      transferSize,
      decodedBodySize: estimateDecodedBodySize(response),
    };
  }

  function responseHeaderNumber(response, headerName) {
    const value = response?.headers?.get?.(headerName);
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function estimateDecodedBodySize(data) {
    if (typeof data === "string") return data.length;
    if (data == null) return 0;
    try {
      return JSON.stringify(data).length;
    } catch {
      return 0;
    }
  }

  function createAbortController(rootRef) {
    const Controller = rootRef?.AbortController || (typeof AbortController === "function" ? AbortController : null);
    if (Controller) return new Controller();
    const signal = { aborted: false, addEventListener() {} };
    return {
      signal,
      abort(reason) {
        signal.aborted = true;
        signal.reason = reason;
      },
    };
  }

  function abortReasonFromSignal(signal) {
    return signal?.reason || "user-cancelled";
  }

  function isAbortError(error) {
    return error?.name === "AbortError";
  }

  function removeFromQueue(queue, entry) {
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
  }

  function cloneTelemetry(entry) {
    return {
      ...entry,
      revision: entry.revision ? entry.revision.map((item) => ({ ...item })) : [],
    };
  }

  function prioritySnapshot(map) {
    return Object.fromEntries(PRIORITY_ORDER.map((priority) => [priority, map.get(priority) || 0]));
  }

  function positiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  function nonNegativeInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
  }

  function defaultNow() {
    if (root?.performance?.now) return root.performance.now();
    if (typeof performance !== "undefined" && performance.now) return performance.now();
    return Date.now();
  }

  return {
    ALLOWED_IDLE_PREFETCH_KINDS,
    DEFAULT_LIMITS,
    PRIORITIES,
    RequestScheduler,
    createRequestScheduler,
    deriveConcurrencyLimits,
    isAutoPrefetchAllowed,
    normalizeNetworkProfile,
  };
});
