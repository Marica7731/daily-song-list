const assert = require("node:assert/strict");
const test = require("node:test");

const { createRequestScheduler, PRIORITIES } = require("../assets/request-scheduler");

test("source click preempts an active next-page prefetch", async () => {
  const network = createControlledFetch();
  const scheduler = createRequestScheduler({
    fetch: network.fetch,
    connection: { effectiveType: "4g", downlink: 5, saveData: false },
    timeoutMs: 1000,
  });

  const prefetch = scheduler.requestResource({
    key: "page:next",
    url: "/data/page-next.json",
    priority: PRIORITIES.IDLE,
    prefetch: true,
    preemptible: true,
  });
  assert.equal(network.requests.length, 1);

  const source = scheduler.requestResource({
    key: "source:first",
    url: "/data/source-first.json",
    priority: PRIORITIES.USER_BLOCKING,
  });

  assert.equal(network.requests[0].aborted, true);
  assert.equal(network.requests.length, 2);
  assert.equal(network.requests[1].url, "/data/source-first.json");

  network.requests[1].resolve({ chunk: "first" }, 80 * 1024);
  const sourceResult = await source;
  const prefetchResult = await prefetch;

  assert.equal(sourceResult.status, "success");
  assert.equal(prefetchResult.status, "aborted");
  assert.equal(prefetchResult.abortReason, "preempted-by-user-blocking");
  assert.equal(sourceResult.telemetry.priority, PRIORITIES.USER_BLOCKING);
});

test("quick page switches mark older page responses stale", async () => {
  const network = createControlledFetch();
  const scheduler = createRequestScheduler({ fetch: network.fetch, timeoutMs: 1000 });

  const firstRevision = scheduler.bumpRevision("page");
  const firstPage = scheduler.requestResource({
    key: "page:1",
    url: "/data/page-1.json",
    priority: PRIORITIES.USER_BLOCKING,
    revision: firstRevision,
  });
  const secondRevision = scheduler.bumpRevision("page");
  const secondPage = scheduler.requestResource({
    key: "page:2",
    url: "/data/page-2.json",
    priority: PRIORITIES.USER_BLOCKING,
    revision: secondRevision,
  });

  network.requests[0].resolve({ page: 1 });
  network.requests[1].resolve({ page: 2 });

  assert.equal((await firstPage).status, "stale");
  const secondResult = await secondPage;
  assert.equal(secondResult.status, "success");
  assert.deepEqual(secondResult.data, { page: 2 });
});

test("quick search typing only leaves the newest query response current", async () => {
  const network = createControlledFetch();
  const scheduler = createRequestScheduler({ fetch: network.fetch, timeoutMs: 1000 });

  const oldSearch = scheduler.requestResource({
    key: "search:a",
    url: "/data/search-a.json",
    priority: PRIORITIES.USER_BLOCKING,
    revision: scheduler.bumpRevision("query"),
  });
  const midSearch = scheduler.requestResource({
    key: "search:ab",
    url: "/data/search-ab.json",
    priority: PRIORITIES.USER_BLOCKING,
    revision: scheduler.bumpRevision("query"),
  });
  const newSearch = scheduler.requestResource({
    key: "search:abc",
    url: "/data/search-abc.json",
    priority: PRIORITIES.USER_BLOCKING,
    revision: scheduler.bumpRevision("query"),
  });

  network.requests[2].resolve({ term: "abc" });
  network.requests[1].resolve({ term: "ab" });
  network.requests[0].resolve({ term: "a" });

  assert.equal((await oldSearch).status, "stale");
  assert.equal((await midSearch).status, "stale");
  const result = await newSearch;
  assert.equal(result.status, "success");
  assert.deepEqual(result.data, { term: "abc" });
});

test("range switch after search invalidates the old search response", async () => {
  const network = createControlledFetch();
  const scheduler = createRequestScheduler({ fetch: network.fetch, timeoutMs: 1000 });

  const search = scheduler.requestResource({
    key: "search:before-range",
    url: "/data/search-before-range.json",
    priority: PRIORITIES.USER_BLOCKING,
    revision: [scheduler.bumpRevision("query"), scheduler.captureRevision("range")],
  });
  scheduler.bumpRevision("range");
  network.requests[0].resolve({ term: "before-range" });

  assert.equal((await search).status, "stale");
});

test("identical resource requests are de-duplicated", async () => {
  const network = createControlledFetch();
  const scheduler = createRequestScheduler({ fetch: network.fetch, timeoutMs: 1000 });

  const first = scheduler.requestResource({
    key: "same",
    url: "/data/same.json",
    priority: PRIORITIES.NORMAL,
  });
  const second = scheduler.requestResource({
    key: "same",
    url: "/data/same.json",
    priority: PRIORITIES.NORMAL,
  });

  assert.equal(first, second);
  assert.equal(network.requests.length, 1);

  network.requests[0].resolve({ same: true });
  assert.deepEqual((await first).data, { same: true });
});

test("saveData disables automatic prefetch", async () => {
  const network = createControlledFetch();
  const scheduler = createRequestScheduler({
    fetch: network.fetch,
    connection: { saveData: true, effectiveType: "4g", downlink: 5 },
  });

  const result = await scheduler.scheduleIdlePrefetch(
    {
      key: "page:next",
      url: "/data/page-next.json",
      prefetchKind: "next-page",
    },
    idleContext(),
  );

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "prefetch-conditions-not-met");
  assert.equal(network.requests.length, 0);
});

test("2g disables automatic prefetch", async () => {
  const network = createControlledFetch();
  const scheduler = createRequestScheduler({
    fetch: network.fetch,
    connection: { saveData: false, effectiveType: "2g", downlink: 0.2 },
  });

  const result = await scheduler.scheduleIdlePrefetch(
    {
      key: "page:previous",
      url: "/data/page-previous.json",
      prefetchKind: "previous-page",
    },
    idleContext(),
  );

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "prefetch-conditions-not-met");
  assert.equal(network.requests.length, 0);
});

test("3g keeps idle concurrency to one request", async () => {
  const network = createControlledFetch();
  const scheduler = createRequestScheduler({
    fetch: network.fetch,
    connection: { saveData: false, effectiveType: "3g", downlink: 1 },
    timeoutMs: 1000,
  });

  const first = scheduler.requestResource({
    key: "idle:1",
    url: "/data/idle-1.json",
    priority: PRIORITIES.IDLE,
    prefetch: true,
  });
  const second = scheduler.requestResource({
    key: "idle:2",
    url: "/data/idle-2.json",
    priority: PRIORITIES.IDLE,
    prefetch: true,
  });

  assert.equal(network.requests.length, 1);
  network.requests[0].resolve({ idle: 1 });
  assert.equal((await first).status, "success");
  assert.equal(network.requests.length, 2);
  network.requests[1].resolve({ idle: 2 });
  assert.equal((await second).status, "success");
});

test("hidden pages do not start idle prefetch", async () => {
  const network = createControlledFetch();
  const scheduler = createRequestScheduler({ fetch: network.fetch });

  const result = await scheduler.scheduleIdlePrefetch(
    {
      key: "page:hidden",
      url: "/data/page-hidden.json",
      prefetchKind: "next-page",
    },
    { ...idleContext(), visibilityState: "hidden" },
  );

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "prefetch-conditions-not-met");
  assert.equal(network.requests.length, 0);
});

test("failed requests retry before returning success", async () => {
  let calls = 0;
  const scheduler = createRequestScheduler({
    fetch: () => {
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("temporary network failure"));
      return Promise.resolve(createResponse({ retried: true }));
    },
    retries: 1,
    timeoutMs: 1000,
  });

  const result = await scheduler.requestResource({
    key: "retry",
    url: "/data/retry.json",
    priority: PRIORITIES.NORMAL,
  });

  assert.equal(calls, 2);
  assert.equal(result.status, "success");
  assert.deepEqual(result.data, { retried: true });
});

test("external AbortController cancels a user request", async () => {
  const network = createControlledFetch();
  const scheduler = createRequestScheduler({ fetch: network.fetch, timeoutMs: 1000 });
  const controller = new AbortController();

  const request = scheduler.requestResource({
    key: "copy:setlist",
    url: "/data/setlist.json",
    priority: PRIORITIES.USER_BLOCKING,
    signal: controller.signal,
  });

  controller.abort("user-cancelled");
  const result = await request;

  assert.equal(result.status, "aborted");
  assert.equal(result.abortReason, "user-cancelled");
  assert.equal(network.requests[0].aborted, true);
});

test("cache hits avoid a second fetch and keep telemetry", async () => {
  const network = createControlledFetch();
  const scheduler = createRequestScheduler({ fetch: network.fetch, timeoutMs: 1000 });

  const first = scheduler.requestResource({
    key: "cached",
    url: "/data/cached.json",
    priority: PRIORITIES.NORMAL,
  });
  network.requests[0].resolve({ cached: true }, 128);
  assert.equal((await first).status, "success");

  const second = await scheduler.requestResource({
    key: "cached",
    url: "/data/cached.json",
    priority: PRIORITIES.NORMAL,
  });

  assert.equal(network.requests.length, 1);
  assert.equal(second.status, "success");
  assert.equal(second.cacheHit, true);
  assert.equal(second.telemetry.cacheHit, true);
  assert.deepEqual(second.data, { cached: true });
});

test("stale revisions do not return cached data as current", async () => {
  const network = createControlledFetch();
  const scheduler = createRequestScheduler({ fetch: network.fetch, timeoutMs: 1000 });

  const revision = scheduler.bumpRevision("source");
  const first = scheduler.requestResource({
    key: "source:cached",
    url: "/data/source-cached.json",
    priority: PRIORITIES.USER_BLOCKING,
    revision,
  });
  network.requests[0].resolve({ cached: "old" });
  assert.equal((await first).status, "success");

  scheduler.bumpRevision("source");
  const second = await scheduler.requestResource({
    key: "source:cached",
    url: "/data/source-cached.json",
    priority: PRIORITIES.USER_BLOCKING,
    revision,
  });

  assert.equal(second.status, "stale");
  assert.equal(second.cacheHit, true);
  assert.equal(second.data, undefined);
});

function createControlledFetch() {
  const requests = [];
  const fetch = (url, options = {}) => {
    const deferred = createDeferred();
    const request = {
      url,
      options,
      aborted: false,
      resolve(data = { url }, size = 64) {
        deferred.resolve(createResponse(data, size));
      },
      reject(error) {
        deferred.reject(error);
      },
    };
    if (options.signal) {
      if (options.signal.aborted) {
        request.aborted = true;
        deferred.reject(createAbortError(options.signal.reason));
      } else {
        options.signal.addEventListener(
          "abort",
          () => {
            request.aborted = true;
            deferred.reject(createAbortError(options.signal.reason));
          },
          { once: true },
        );
      }
    }
    requests.push(request);
    return deferred.promise;
  };
  return { fetch, requests };
}

function createResponse(data, size = 64) {
  return {
    ok: true,
    status: 200,
    headers: {
      get(name) {
        return String(name).toLowerCase() === "content-length" ? String(size) : null;
      },
    },
    async json() {
      return data;
    },
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createAbortError(reason = "aborted") {
  const error = new Error(String(reason || "aborted"));
  error.name = "AbortError";
  return error;
}

function idleContext() {
  return {
    visibilityState: "visible",
    mainRequestActive: false,
    queryPanelOpen: false,
    searchTyping: false,
    sourceDetailLoading: false,
  };
}
