import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import "fake-indexeddb/auto";

const { aggregate2H, createGateKlineController, expectedLatestCandleTimestamp, findCandleGaps, GATE_REQUEST_TIMEOUT_MS, hasLatestCoverage, historyRetryDelay, twoHourRangeWindows, mergePendingWriteRows } = await import("../kline/gate-kline-controller.js");
const hour = 3600;
const candle = (t, close = 100) => ({ t, o: close, h: close + 2, l: close - 2, c: close + 1 });
const utc = value => Math.floor(Date.parse(value) / 1000);
globalThis.window = { indexedDB: globalThis.indexedDB };
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { storage: { estimate: async () => ({ usage: 1, quota: 100 }) } } });

class TestWebSocket { static OPEN = 1; constructor() { this.readyState = 0; } send() {} close() { this.readyState = 3; } }
Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: TestWebSocket });

function response(rows) { return { ok: true, status: 200, json: async () => rows }; }
function waitForState(expected, timeoutMs = 6000) {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  const timer = setTimeout(() => reject(new Error("Timed out waiting for controller state: " + expected)), timeoutMs);
  const controller = createGateKlineController({ instruments: [], isHidden: () => false, onState: state => {
    if (state.status === expected) { clearTimeout(timer); resolve(state); }
  }});
  return { controller, promise };
}
function wait(promise, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Controller integration test timed out")), timeoutMs);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

async function openTestDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("vegas-v9-market-cache", 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("candles")) db.createObjectStore("candles", { keyPath: "id" });
      if (!db.objectStoreNames.contains("candleRows")) {
        const rows = db.createObjectStore("candleRows", { keyPath: "id" });
        rows.createIndex("series", "series", { unique: false });
      }
      if (!db.objectStoreNames.contains("seriesMeta")) db.createObjectStore("seriesMeta", { keyPath: "id" });
      if (!db.objectStoreNames.contains("emaRows")) {
        const ema = db.createObjectStore("emaRows", { keyPath: "id" });
        ema.createIndex("series", "series", { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readStore(storeName, key) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("vegas-v9-market-cache", 3);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction([storeName], "readonly");
      const get = tx.objectStore(storeName).get(key);
      get.onsuccess = () => { const result = get.result || null; db.close(); resolve(result); };
      get.onerror = () => { db.close(); reject(get.error); };
    };
  });
}

test("daily candles align to Beijing midnight rather than UTC midnight", () => {
  const first = candle(utc("2026-11-20T16:00:00Z")), second = candle(utc("2026-11-21T16:00:00Z"));
  assert.equal(findCandleGaps([first, second], "D").length, 0);
  assert.equal(findCandleGaps([candle(utc("2026-11-20T00:00:00Z")), candle(utc("2026-11-21T00:00:00Z"))], "D").length, 1);
  assert.equal(expectedLatestCandleTimestamp("D", Date.parse("2026-11-21T16:05:00Z")), utc("2026-11-20T16:00:00Z"));
});
test("debounced websocket writes merge distinct candle timestamps", () => {
  const a = candle(100), b = candle(200);
  const merged = mergePendingWriteRows({ rows: [a], done: true, status: "ok" }, { rows: [b], done: true, status: "ok" });
  assert.deepEqual(merged.rows.map(row => row.t), [100, 200]);
  assert.equal(merged.done, true);
});
test("detects isolated and consecutive historical gaps", () => {
  const rows = [candle(0), candle(2 * hour), candle(6 * hour)];
  assert.deepEqual(findCandleGaps(rows, "1H"), [
    { from: hour, to: hour, missingCount: 1, misaligned: false },
    { from: 3 * hour, to: 5 * hour, missingCount: 3, misaligned: false }
  ]);
});

test("rejects off-grid and non-integral candle timestamps", () => {
  const rows = [candle(0), candle(hour + 60)];
  assert.equal(findCandleGaps(rows, "1H")[0].misaligned, true);
  assert.equal(hasLatestCoverage(rows, "1H", 2 * hour + 5 * 60 * 1000), false);
});

test("computes the exact latest required timestamp for all five timeframes", () => {
  const now = Date.parse("2026-11-21T14:05:00Z");
  for (const [tf, step] of [["1H", 3600], ["2H", 7200], ["4H", 14400], ["8H", 28800], ["D", 86400]]) {
    const offset = tf === "D" ? 16 * 3600 : 0;
    const expected = Math.floor((Math.floor(now / 1000) - offset) / step) * step + offset - step;
    assert.equal(expectedLatestCandleTimestamp(tf, now), expected, tf);
  }
});

test("checks latest closed-candle coverage across all five timeframes", () => {
  const now = Date.parse("2026-11-21T14:05:00Z");
  for (const [tf, step] of [["1H", 3600], ["2H", 7200], ["4H", 14400], ["8H", 28800], ["D", 86400]]) {
    const offset = tf === "D" ? 16 * 3600 : 0;
    const currentBucket = Math.floor((Math.floor(now / 1000) - offset) / step) * step + offset;
    const expected = currentBucket - step;
    assert.equal(hasLatestCoverage([candle(expected)], tf, now), true, tf + " complete latest candle");
    assert.equal(hasLatestCoverage([candle(expected - step)], tf, now), false, tf + " missing latest candle");
  }
});

test("allows Gate publication grace immediately after a timeframe boundary", () => {
  const now = Date.parse("2026-11-21T14:00:30Z");
  assert.equal(hasLatestCoverage([candle(utc("2026-11-21T12:00:00Z"))], "1H", now), true);
  assert.equal(hasLatestCoverage([candle(utc("2026-11-21T12:00:00Z"))], "1H", Date.parse("2026-11-21T14:03:00Z")), false);
});

test("2H aggregation rejects a missing first or second historical 1H candle", () => {
  const now = Date.parse("2026-11-21T16:30:00Z");
  const firstMissing = aggregate2H([candle(utc("2026-11-21T15:00:00Z"))], now);
  const secondMissing = aggregate2H([candle(utc("2026-11-21T14:00:00Z"))], now);
  assert.equal(firstMissing.some(row => row.t === utc("2026-11-21T14:00:00Z")), false);
  assert.equal(secondMissing.some(row => row.t === utc("2026-11-21T14:00:00Z")), false);
});

test("2H aggregation preserves OHLC and partial active bucket across UTC boundary", () => {
  const now = Date.parse("2026-11-22T00:30:00Z");
  const rows = aggregate2H([
    candle(utc("2026-11-21T22:00:00Z"), 100),
    candle(utc("2026-11-21T23:00:00Z"), 110),
    candle(utc("2026-11-22T00:00:00Z"), 120)
  ], now);
  assert.deepEqual(rows.find(row => row.t === utc("2026-11-21T22:00:00Z")), { t: utc("2026-11-21T22:00:00Z"), o: 100, h: 112, l: 98, c: 111 });
  assert.deepEqual(rows.find(row => row.t === utc("2026-11-22T00:00:00Z")), { t: utc("2026-11-22T00:00:00Z"), o: 120, h: 122, l: 118, c: 121 });
});

test("retry backoff grows exponentially and caps at five minutes", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map(historyRetryDelay), [30000, 60000, 120000, 240000, 300000, 300000, 300000]);
});

test("controller repairs a real latest-end gap and persists verified candles", async () => {
  const contract = "SIM_REPAIR_USDT", key = "gate-usdt:" + contract + ":1H";
  const current = Math.floor(Date.now() / 3600000) * 3600;
  const missing = candle(current - hour), latestRows = [candle(current - 3 * hour), candle(current - 2 * hour)];
  const oldFetch = globalThis.fetch, oldNow = Date.now;
  // Keep this fixture outside Gate's two-minute publication-grace window.
  Date.now = () => current * 1000 + 180000;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.searchParams.has("from")) return response([missing]);
    return response(latestRows);
  };
  const waiting = waitForState("latest-gap-repaired");
  try {
    await waiting.controller.select("SIM_REPAIR", contract, "1H");
    await wait(waiting.promise);
    const meta = await readStore("seriesMeta", key);
    assert.equal(meta.latestGapStatus, "clear");
    assert.equal(meta.candleCount, 3);
  } finally {
    waiting.controller.destroy();
    globalThis.fetch = oldFetch;
    Date.now = oldNow;
  }
});

test("controller retries transient Gate 429 and 5xx responses before accepting fresh candles", async () => {
  const contract = "SIM_RETRY_USDT";
  const current = Math.floor(Date.now() / 3600000) * 3600;
  const rows = [candle(current - 2 * hour), candle(current - hour), candle(current)];
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 429, json: async () => [] };
    if (calls === 2) return { ok: false, status: 503, json: async () => [] };
    return response(rows);
  };
  let resolveRepaired;
  const repairedPromise = new Promise(resolve => { resolveRepaired = resolve; });
  const controller = createGateKlineController({ instruments: [], isHidden: () => false, onState: state => {
    if (state.status === "latest-gap-repaired") resolveRepaired(state);
  }});
  try {
    await controller.select("SIM_RETRY", contract, "1H");
    await wait(repairedPromise, 20000);
    assert.equal(calls, 3);
  } finally {
    controller.destroy();
    globalThis.fetch = oldFetch;
  }
});

test("failed latest-gap repair persists and restores its task after controller recreation", async () => {
  const contract = "SIM_RESTART_USDT", key = "gate-usdt:" + contract + ":1H";
  const current = Math.floor(Date.now() / 3600000) * 3600;
  const incomplete = [candle(current - 2 * hour), candle(current)];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.searchParams.has("from")) return response([]);
    return response(incomplete);
  };
  const observedStates = [];
  const firstController = createGateKlineController({ instruments: [], isHidden: () => false, onState: state => {
    observedStates.push({ status: state.status, error: state.error || null, count: state.count ?? null });
  }});
  try {
    await firstController.select("SIM_RESTART", contract, "1H");
    const repairResult = observedStates.find(state => ["history-gap-pending", "latest-refresh-failed", "latest-gap-repaired"].includes(state.status));
    assert.ok(repairResult, "controller emitted no terminal latest-repair state: " + JSON.stringify(observedStates));
    assert.equal(repairResult.status, "history-gap-pending", "unexpected repair state: " + JSON.stringify(repairResult));
    const task = await readStore("seriesMeta", "repairTask|" + key);
    assert.equal(task.kind, "latest");
    assert.equal(task.status, "pending");
    assert.ok(task.nextRetryAt > Date.now());
  } finally {
    firstController.destroy();
  }
  let resolveRestored;
  const restoredPromise = new Promise(resolve => { resolveRestored = resolve; });
  const complete = [candle(current - 2 * hour), candle(current - hour), candle(current)];
  globalThis.fetch = async () => response(incomplete);
  const second = createGateKlineController({ instruments: [], isHidden: () => false, onState: state => {
    if (state.status === "repair-tasks-restored") resolveRestored(state);
  }});
  try {
    await second.select("SIM_RESTART", contract, "1H");
    const restored = await wait(restoredPromise);
    assert.equal(restored.count, 1);
    assert.ok(restored.keys.includes(key));
    for (let attempt = 0; second.state.historyQueue.running && attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(second.state.historyQueue.running, false);
    globalThis.fetch = async () => response(complete);
    await wait(second.refresh());
    assert.equal(await readStore("seriesMeta", "repairTask|" + key), null);
  } finally {
    second.destroy();
    globalThis.fetch = oldFetch;
  }
});


test("bounds each Gate request with an abortable timeout and retries a timed-out request", async () => {
  assert.equal(GATE_REQUEST_TIMEOUT_MS, 15000);
  const contract = "SIM_TIMEOUT_USDT";
  const current = Math.floor(Date.now() / 3600000) * 3600;
  const rows = [candle(current - 2 * hour), candle(current - hour), candle(current)];
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_input, options) => {
    calls++;
    if (calls === 1) return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error("simulated request timeout")), { once: true });
    });
    return response(rows);
  };
  let resolveRepaired;
  const repaired = new Promise(resolve => { resolveRepaired = resolve; });
  const controller = createGateKlineController({
    instruments: [], isHidden: () => false, requestTimeoutMs: 10,
    onState: state => { if (state.status === "latest-gap-repaired") resolveRepaired(state); }
  });
  try {
    await controller.select("SIM_TIMEOUT", contract, "1H");
    await wait(repaired, 8000);
    assert.equal(calls, 2);
  } finally {
    controller.destroy();
    globalThis.fetch = oldFetch;
  }
});

test("coalesces a manual refresh while the same series request is still in flight", async () => {
  const contract = "SIM_COALESCE_USDT";
  const current = Math.floor(Date.now() / 3600000) * 3600;
  const rows = [candle(current - 2 * hour), candle(current - hour), candle(current)];
  const oldFetch = globalThis.fetch;
  let calls = 0, release;
  let resolveStarted;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) {
      resolveStarted();
      return new Promise(resolve => { release = () => resolve(response(rows)); });
    }
    return response(rows);
  };
  const controller = createGateKlineController({ instruments: [], isHidden: () => false });
  try {
    const selecting = controller.select("SIM_COALESCE", contract, "1H");
    await wait(started);
    const refresh = controller.refresh();
    assert.equal(calls, 1, "refresh must reuse the active request");
    release();
    await wait(selecting);
    await wait(refresh);
    assert.equal(calls, 1);
  } finally {
    controller.destroy();
    globalThis.fetch = oldFetch;
  }
});

test("resumes the latest-data request after a page-hidden abort", async () => {
  const contract = "SIM_RESUME_USDT";
  const current = Math.floor(Date.now() / 3600000) * 3600;
  const rows = [candle(current - 2 * hour), candle(current - hour), candle(current)];
  const oldFetch = globalThis.fetch;
  let hidden = false, calls = 0, resolveStarted, resolveAborted, resolveRepaired;
  const started = new Promise(resolve => { resolveStarted = resolve; });
  const aborted = new Promise(resolve => { resolveAborted = resolve; });
  const repaired = new Promise(resolve => { resolveRepaired = resolve; });
  globalThis.fetch = async (_input, options) => {
    calls++;
    if (calls === 1) return new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => { resolveAborted(); reject(new Error("page hidden")); }, { once: true });
      resolveStarted();
    });
    return response(rows);
  };
  const controller = createGateKlineController({
    instruments: [], isHidden: () => hidden,
    onState: state => { if (state.status === "latest-gap-repaired") resolveRepaired(state); }
  });
  try {
    const selecting = controller.select("SIM_RESUME", contract, "1H");
    await wait(started);
    hidden = true;
    controller.suspend();
    await wait(aborted);
    hidden = false;
    controller.resume();
    await wait(repaired, 10000);
    await wait(selecting);
    assert.ok(calls >= 2);
  } finally {
    controller.destroy();
    globalThis.fetch = oldFetch;
  }
});

test("migrates legacy candle arrays into per-candle IndexedDB rows without data loss", async () => {
  const contract = "SIM_MIGRATE_USDT", key = "gate-usdt:" + contract + ":1H";
  const current = Math.floor(Date.now() / 3600000) * 3600;
  const existing = candle(current - 3 * hour);
  const legacyRows = [candle(current - 2 * hour), candle(current - hour)];
  const db = await openTestDB();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(["candles", "candleRows"], "readwrite");
    tx.objectStore("candles").put({ id: key, candles: legacyRows, historyBoundaryReached: false, latestGapStatus: "pending" });
    tx.objectStore("candleRows").put({ id: key + "|" + existing.t, series: key, ...existing });
    tx.oncomplete = resolve;
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
  db.close();
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => response([]);
  const controller = createGateKlineController({ instruments: [], isHidden: () => false });
  try {
    const selected = await controller.select("SIM_MIGRATE", contract, "1H");
    assert.equal(selected, true);
    assert.equal(controller.state.count, 3);
    assert.equal(await readStore("candles", key), null);
    for (const row of [existing, ...legacyRows]) {
      assert.ok(await readStore("candleRows", key + "|" + row.t), "migrated candle " + row.t);
    }
  } finally {
    controller.destroy();
    globalThis.fetch = oldFetch;
  }
});

test("keeps K-line updates available when IndexedDB read/write transactions fail", async () => {
  const db = await openTestDB();
  const prototype = Object.getPrototypeOf(db);
  const originalTransaction = prototype.transaction;
  prototype.transaction = function(storeNames, mode, ...options) {
    if (mode === "readwrite") throw new Error("simulated IndexedDB transaction failure");
    return originalTransaction.call(this, storeNames, mode, ...options);
  };
  db.close();
  const contract = "SIM_IDB_WRITE_FALLBACK_USDT";
  const current = Math.floor(Date.now() / 3600000) * 3600;
  const rows = [candle(current - 2 * hour), candle(current - hour), candle(current)];
  const oldFetch = globalThis.fetch;
  let cacheReadFailed = false, cacheWriteFailed = false, resolveRepaired;
  const repaired = new Promise(resolve => { resolveRepaired = resolve; });
  globalThis.fetch = async () => response(rows);
  const controller = createGateKlineController({
    instruments: [], isHidden: () => false,
    onState: state => {
      if (state.status === "cache-read-failed") cacheReadFailed = true;
      if (state.status === "cache-write-failed" && state.mode === "memory-fallback") cacheWriteFailed = true;
      if (state.status === "latest-gap-repaired") resolveRepaired(state);
    }
  });
  try {
    await controller.select("SIM_IDB_WRITE_FALLBACK", contract, "1H");
    await wait(repaired);
    assert.equal(cacheReadFailed, true);
    assert.equal(cacheWriteFailed, true);
    assert.equal(controller.state.count, 3);
  } finally {
    controller.destroy();
    globalThis.fetch = oldFetch;
    prototype.transaction = originalTransaction;
  }
});

test("repairs the EMA cache after a full load and incrementally advances it by one candle", async () => {
  const contract = "SIM_EMA_RECOVERY_USDT", key = "gate-usdt:" + contract + ":1H";
  const current = Math.floor(Date.now() / 3600000) * 3600;
  const initial = Array.from({ length: 700 }, (_, index) => candle(current - (700 - index) * hour));
  let rows = initial;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => response(rows);
  let resolveRepaired;
  const repaired = new Promise(resolve => { resolveRepaired = resolve; });
  const controller = createGateKlineController({
    instruments: [], isHidden: () => false,
    onState: state => { if (state.status === "latest-gap-repaired") resolveRepaired(state); }
  });
  try {
    await controller.select("SIM_EMA_RECOVERY", contract, "1H");
    await wait(repaired);
    const firstMeta = await readStore("seriesMeta", "ema|" + key);
    assert.equal(firstMeta.candleCount, 700);
    const db = await openTestDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(["seriesMeta"], "readwrite");
      tx.objectStore("seriesMeta").put({ ...firstMeta, sourceSignature: "interrupted-ema-write" });
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
    db.close();
    await wait(controller.refresh());
    const rebuiltMeta = await readStore("seriesMeta", "ema|" + key);
    assert.notEqual(rebuiltMeta.sourceSignature, "interrupted-ema-write");
    rows = [...initial, candle(current)];
    await wait(controller.refresh());
    const updatedMeta = await readStore("seriesMeta", "ema|" + key);
    assert.equal(updatedMeta.candleCount, 701);
    assert.equal(updatedMeta.newestTimestamp, current);
    const latestEma = await readStore("emaRows", key + "|" + current);
    assert.ok(Number.isFinite(latestEma.e12));
  } finally {
    controller.destroy();
    globalThis.fetch = oldFetch;
  }
});

test("keeps multiple selected symbols in separate K-line cache series", async () => {
  const current = Math.floor(Date.now() / 3600000) * 3600;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const contract = new URL(String(input)).searchParams.get("contract");
    const close = contract === "SIM_SYMBOL_A_USDT" ? 110 : 220;
    return response([candle(current - 2 * hour, close), candle(current - hour, close), candle(current, close)]);
  };
  let resolveA, resolveB;
  const repairedA = new Promise(resolve => { resolveA = resolve; });
  const repairedB = new Promise(resolve => { resolveB = resolve; });
  const controller = createGateKlineController({
    instruments: [], isHidden: () => false,
    onState: state => {
      if (state.status !== "latest-gap-repaired") return;
      if (state.symbol === "SIM_SYMBOL_A") resolveA(state);
      if (state.symbol === "SIM_SYMBOL_B") resolveB(state);
    }
  });
  try {
    await controller.select("SIM_SYMBOL_A", "SIM_SYMBOL_A_USDT", "1H");
    await wait(repairedA);
    await controller.select("SIM_SYMBOL_B", "SIM_SYMBOL_B_USDT", "1H");
    await wait(repairedB);
    const a = await readStore("candleRows", "gate-usdt:SIM_SYMBOL_A_USDT:1H|" + current);
    const b = await readStore("candleRows", "gate-usdt:SIM_SYMBOL_B_USDT:1H|" + current);
    assert.equal(a.c, 111);
    assert.equal(b.c, 221);
    assert.notEqual(a.c, b.c);
  } finally {
    controller.destroy();
    globalThis.fetch = oldFetch;
  }
});

test("validates continuity across a large 20,000-candle historical series", () => {
  const now = Date.parse("2026-11-21T14:05:00Z");
  const expected = expectedLatestCandleTimestamp("1H", now);
  const rows = Array.from({ length: 20000 }, (_, index) => candle(expected - (19999 - index) * hour));
  assert.equal(findCandleGaps(rows, "1H").length, 0);
  assert.equal(hasLatestCoverage(rows, "1H", now), true);
});

test("memory fallback preserves every returned candle row without declaring full history complete", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(indexedDB, "open");
  Object.defineProperty(indexedDB, "open", { configurable: true, writable: true, value: () => { throw new Error("simulated IndexedDB unavailable"); } });
  const contract = "SIM_MEMORY_FULL_USDT";
  const current = Math.floor(Date.now() / 3600000) * 3600;
  const rows = Array.from({ length: 12005 }, (_, index) => candle(current - (12004 - index) * hour));
  const oldFetch = globalThis.fetch;
  let resolveRepaired;
  const repaired = new Promise(resolve => { resolveRepaired = resolve; });
  globalThis.fetch = async () => response(rows);
  const controller = createGateKlineController({
    instruments: [], isHidden: () => false,
    onState: state => { if (state.status === "latest-gap-repaired") resolveRepaired(state); }
  });
  try {
    await controller.select("SIM_MEMORY_FULL", contract, "1H");
    await wait(repaired, 15000);
    assert.equal(controller.state.count, 12005);
    assert.equal(controller.state.historyComplete, false);
  } finally {
    controller.destroy();
    globalThis.fetch = oldFetch;
    if (descriptor) Object.defineProperty(indexedDB, "open", descriptor);
    else delete indexedDB.open;
  }
});


test("2H historical gap windows include the second 1H candle and preserve aligned 2000-row pages", () => {
  const start = utc("2026-11-21T00:00:00Z");
  assert.deepEqual(twoHourRangeWindows(start, start), [
    { from: start, to: start + hour }
  ]);
  // A latest-tail range may end one second before the next 2H boundary.
  assert.deepEqual(twoHourRangeWindows(start, start + 2 * hour - 1), [
    { from: start, to: start + hour }
  ]);
  const windows = twoHourRangeWindows(start, start + 2000 * hour);
  assert.equal(windows.length, 2);
  assert.deepEqual(windows[0], { from: start, to: start + 1999 * hour });
  assert.deepEqual(windows[1], { from: start + 2000 * hour, to: start + 2001 * hour });
  for (const window of windows) {
    assert.equal(window.from % (2 * hour), 0, "each page begins on a UTC 2H pair boundary");
    assert.ok((window.to - window.from) / hour + 1 <= 2000, "Gate page never exceeds 2000 hourly candles");
    assert.equal((window.to - window.from) / hour % 2, 1, "each page contains complete hourly pairs");
  }
  assert.throws(() => twoHourRangeWindows(start + hour, start + 2 * hour), /Invalid 2H history range/);
});


test("controller loads and updates candles directly from Gate without a cloud snapshot dependency", async () => {
  const contract = "SIM_LOCAL_ONLY_USDT";
  const current = Math.floor(Date.now() / 3600000) * 3600;
  const oldFetch = globalThis.fetch;
  const requests = [];
  let resolveUpdated;
  const updated = new Promise(resolve => { resolveUpdated = resolve; });
  globalThis.fetch = async input => {
    const url = String(input);
    requests.push(url);
    assert.ok(url.startsWith("https://api.gateio.ws/api/v4/futures/usdt/candlesticks?"), "all candle requests must go directly to Gate");
    return response([candle(current - 2 * hour), candle(current - hour), candle(current)]);
  };
  const controller = createGateKlineController({
    instruments: [], isHidden: () => false,
    onState: state => { if (state.status === "latest-gap-repaired") resolveUpdated(state); }
  });
  try {
    await controller.select("SIM_LOCAL_ONLY", contract, "1H");
    await wait(updated, 12000);
    assert.ok(requests.length > 0);
    assert.ok(requests.every(url => url.startsWith("https://api.gateio.ws/")));
    assert.equal(controller.state.dataReady, true);
    assert.equal("cloudDataReady" in controller.state, false);
    assert.equal(controller.state.newestTimestamp, current);
  } finally {
    controller.destroy();
    globalThis.fetch = oldFetch;
  }
});


test("does not rewrite unchanged candle rows during a latest refresh", async () => {
  const contract = "SIM_INCREMENTAL_WRITE_USDT";
  const current = Math.floor(Date.now() / 3600000) * 3600;
  const rows = [candle(current - 2 * hour), candle(current - hour), candle(current)];
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.searchParams.has("from")) return response([]);
    const limit = Number(url.searchParams.get("limit")) || rows.length;
    return response(rows.slice(-limit));
  };
  const waiting = waitForState("latest-gap-repaired");
  const Store = globalThis.IDBObjectStore, originalPut = Store.prototype.put;
  let candlePuts = 0;
  try {
    await waiting.controller.select("SIM_INCREMENTAL_WRITE", contract, "1H");
    await wait(waiting.promise);
    Store.prototype.put = function(value, ...args) {
      if (this.name === "candleRows") candlePuts++;
      return originalPut.call(this, value, ...args);
    };
    const before = candlePuts;
    await wait(waiting.controller.refresh());
    assert.equal(candlePuts, before, "unchanged OHLC rows must not be written again");
  } finally {
    Store.prototype.put = originalPut;
    waiting.controller.destroy();
    globalThis.fetch = oldFetch;
  }
});

test("reuses a valid full-history EMA cache after controller restart", async () => {
  const contract = "SIM_EMA_REUSE_USDT", key = "gate-usdt:" + contract + ":1H";
  const current = Math.floor(Date.now() / 3600000) * 3600;
  const rows = Array.from({ length: 700 }, (_, index) => candle(current - (700 - index) * hour));
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.searchParams.has("from")) return response([]);
    const limit = Number(url.searchParams.get("limit")) || 2000;
    return response(rows.slice(-limit));
  };
  const instruments = [{ symbol: "SIM_EMA_REUSE", gateContract: contract }];
  const first = createGateKlineController({ instruments, isHidden: () => false });
  const second = createGateKlineController({ instruments, isHidden: () => false });
  const Store = globalThis.IDBObjectStore, originalPut = Store.prototype.put;
  let secondCandlePuts = 0;
  const waitComplete = async controller => {
    const deadline = Date.now() + 12000;
    while (controller.state.historyQueue.completed < 1) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for full-history EMA preparation");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  try {
    await first.select("SIM_EMA_REUSE", contract, "1H");
    await waitComplete(first);
    const firstMeta = await readStore("seriesMeta", "ema|" + key);
    assert.ok(firstMeta && firstMeta.updatedAt);
    first.destroy();
    Store.prototype.put = function(value, ...args) {
      if (this.name === "candleRows") secondCandlePuts++;
      return originalPut.call(this, value, ...args);
    };
    await second.select("SIM_EMA_REUSE", contract, "1H");
    await waitComplete(second);
    const secondMeta = await readStore("seriesMeta", "ema|" + key);
    assert.equal(secondMeta.updatedAt, firstMeta.updatedAt, "valid EMA cache metadata must not be rewritten on restart");
    assert.equal(secondCandlePuts, 0, "full-history verification must not rewrite cached candles");
  } finally {
    Store.prototype.put = originalPut;first.destroy();second.destroy();globalThis.fetch = oldFetch;
  }
});
