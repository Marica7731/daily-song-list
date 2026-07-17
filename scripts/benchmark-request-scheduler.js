const { performance } = require("node:perf_hooks");
const { createRequestScheduler, PRIORITIES } = require("../assets/request-scheduler");

const KB = 1024;
const RESOURCES = Object.freeze({
  prefetch: { url: "/data/page-next-prefetch.json", size: 1536 * KB },
  source: { url: "/data/source-first-chunk.json", size: 80 * KB },
  page: { url: "/data/page-details.json", size: 200 * KB },
  search: { url: "/data/search-shard.json", size: 50 * KB },
});
const CLICK_DELAY_MS = 20;
const MS_PER_KB = 0.2;

runBenchmark()
  .then((result) => {
    const improvement = ((result.naive.sourceCompletedMs - result.scheduled.sourceCompletedMs) / result.naive.sourceCompletedMs) * 100;
    const lines = [
      "REQUEST_SCHEDULER_BENCHMARK_OK",
      `no_scheduler_source_ms=${result.naive.sourceCompletedMs.toFixed(1)}`,
      `scheduler_source_ms=${result.scheduled.sourceCompletedMs.toFixed(1)}`,
      `scheduler_source_queue_delay_ms=${result.scheduled.sourceQueueDelayMs.toFixed(1)}`,
      `scheduler_prefetch_aborted=${result.scheduled.prefetchAborted}`,
      `improvement_percent=${improvement.toFixed(1)}`,
    ];
    for (const line of lines) console.log(line);

    if (!result.scheduled.prefetchAborted) {
      throw new Error("scheduled prefetch was not aborted");
    }
    if (result.scheduled.sourceCompletedMs >= result.naive.sourceCompletedMs * 0.5) {
      throw new Error("scheduled source request did not finish clearly faster than the FIFO baseline");
    }
  })
  .catch((error) => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });

async function runBenchmark() {
  const naive = await runNaiveScenario();
  const scheduled = await runScheduledScenario();
  return { naive, scheduled };
}

async function runNaiveScenario() {
  const connection = createFifoConnection();
  const startedAt = performance.now();
  connection.request(RESOURCES.prefetch.url, RESOURCES.prefetch.size);
  await sleep(CLICK_DELAY_MS);
  const source = connection.request(RESOURCES.source.url, RESOURCES.source.size);
  connection.request(RESOURCES.page.url, RESOURCES.page.size);
  connection.request(RESOURCES.search.url, RESOURCES.search.size);
  const sourceTask = await source;
  return {
    sourceCompletedMs: sourceTask.completedAt - startedAt,
  };
}

async function runScheduledScenario() {
  const fetchLog = [];
  const scheduler = createRequestScheduler({
    fetch: createTimedFetch(fetchLog),
    connection: { saveData: false, effectiveType: "4g", downlink: 5 },
    timeoutMs: 2000,
  });
  const startedAt = performance.now();
  const prefetch = scheduler.requestResource({
    key: "prefetch:next",
    url: RESOURCES.prefetch.url,
    priority: PRIORITIES.IDLE,
    prefetch: true,
    preemptible: true,
  });
  await sleep(CLICK_DELAY_MS);
  const source = scheduler.requestResource({
    key: "source:first-chunk",
    url: RESOURCES.source.url,
    priority: PRIORITIES.USER_BLOCKING,
  });
  scheduler.requestResource({
    key: "page:details",
    url: RESOURCES.page.url,
    priority: PRIORITIES.USER_BLOCKING,
  });
  scheduler.requestResource({
    key: "search:shard",
    url: RESOURCES.search.url,
    priority: PRIORITIES.USER_BLOCKING,
  });

  const sourceResult = await source;
  const prefetchResult = await prefetch;
  return {
    sourceCompletedMs: sourceResult.telemetry.completedAt - startedAt,
    sourceQueueDelayMs: sourceResult.telemetry.queueDelay,
    prefetchAborted: prefetchResult.status === "aborted" && fetchLog.some((item) => item.url === RESOURCES.prefetch.url && item.aborted),
  };
}

function createFifoConnection() {
  const queue = [];
  let active = false;

  function request(url, size) {
    const task = {
      url,
      size,
      completedAt: null,
      resolve: null,
      promise: null,
    };
    task.promise = new Promise((resolve) => {
      task.resolve = resolve;
    });
    queue.push(task);
    pump();
    return task.promise;
  }

  function pump() {
    if (active || queue.length === 0) return;
    active = true;
    const task = queue.shift();
    setTimeout(() => {
      task.completedAt = performance.now();
      active = false;
      task.resolve(task);
      pump();
    }, durationForSize(task.size));
  }

  return { request };
}

function createTimedFetch(log) {
  return (url, options = {}) => {
    const resource = Object.values(RESOURCES).find((item) => item.url === url);
    const size = resource?.size || 10 * KB;
    const record = {
      url,
      startedAt: performance.now(),
      completedAt: null,
      aborted: false,
    };
    log.push(record);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        record.completedAt = performance.now();
        resolve(createResponse({ url, size }, size));
      }, durationForSize(size));
      if (options.signal) {
        options.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            record.aborted = true;
            record.completedAt = performance.now();
            reject(createAbortError(options.signal.reason));
          },
          { once: true },
        );
      }
    });
  };
}

function durationForSize(size) {
  return Math.max(1, Math.round((size / KB) * MS_PER_KB));
}

function createResponse(data, size) {
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

function createAbortError(reason = "aborted") {
  const error = new Error(String(reason || "aborted"));
  error.name = "AbortError";
  return error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
