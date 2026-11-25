import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { migrateLegacyViewportState, VIEWPORT_STORAGE_KEY } from "../kline/v9-viewport-state.js";

await import("../modules/shared/instrument-catalog.js");
const { INSTRUMENTS, GATE_CONTRACTS } = await import("../modules/shared/universe-v9.js");
const root = new URL("../", import.meta.url);
const source = path => readFile(new URL(path, root), "utf8");

test("legacy V6 viewport state migrates into the V9 key without being discarded", () => {
  const values = new Map([["vegas-v6-kline-viewport-v2", JSON.stringify({ version: 2, barW: 11, anchorTime: 1700000000, anchorOffset: 0.25 })]]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const migrated = migrateLegacyViewportState(storage);
  assert.equal(migrated.barW, 11);
  assert.equal(JSON.parse(values.get(VIEWPORT_STORAGE_KEY)).anchorTime, 1700000000);
  assert.equal(values.has("vegas-v6-kline-viewport-v2"), false);
});

test("catalog contains 22 unique instruments", () => {
  assert.equal(INSTRUMENTS.length, 22);
  assert.equal(new Set(INSTRUMENTS.map(item => item.symbol)).size, 22);
});
test("instrument categories are explicit and preserve the existing 18/4 grouping", () => {
  assert.equal(INSTRUMENTS.filter(item => item.category === "美股巨头").length, 18);
  assert.equal(INSTRUMENTS.filter(item => item.category === "核心能源").length, 4);
  assert.ok(INSTRUMENTS.every(item => item.category === "美股巨头" || item.category === "核心能源"));
  for (const item of INSTRUMENTS) {
    assert.equal(GATE_CONTRACTS[item.symbol], item.contract.replace(/USDT$/, "_USDT"));
  }
});

test("cards expose only batch quote updates and direct card ordering", async () => {
  const cards = await source("cards/rolling-cards.js");
  assert.match(cards, /window\.updateQuotes=function/);
  assert.match(cards, /window\.V9_INSTRUMENT_CATALOG/);
  assert.doesNotMatch(cards, /V6_INSTRUMENT_CATALOG/);
  assert.match(cards, /window\.setCardOrder=function/);
  assert.doesNotMatch(cards, /window\.updateQuote\s*=/);
  assert.doesNotMatch(cards, /VEGAS_SET_CARD_ORDER/);
  assert.match(cards, /VEGAS_CARD_INTERACTION/);
  assert.match(cards, /VEGAS_CARD_SELECT/);
});

test("background is an independent system and preserves current visual baseline", async () => {
  const html = await source("index.html"), css = await source("background/background.css");
  assert.match(html, /id="background-layer"/);
  assert.match(css, /#background-layer\{[^}]*background:#07110D/);
});
test("logo consumes catalog-owned identity", async () => {
  const logo = await source("modules/logo/logo.js");
  assert.match(logo, /CATALOG\.map\(item=>\[item\.symbol/);
  assert.match(logo, /createLifecycleScope/);
  assert.match(logo, /lifecycle\.timeout/);
  assert.match(logo, /ROOT\+entry\[1\]/);
});

test("five timeframe controls and the full-screen stylesheet own the outer iframe geometry", async () => {
  const html = await source("modules/timeframe-switch/index.html");
  const host = await source("modules/timeframe-switch/host.css");
  const full = await source("assets/css/full-screen-dynamic.css");
  const buttons = [...html.matchAll(/<button aria-pressed="(?:true|false)">([^<]+)<\/button>/g)].map(match => match[1]);
  assert.deepEqual(buttons, ["1H", "2H", "4H", "8H", "D"]);
  assert.match(html, /height:\s*20%/);
  assert.match(html, /flex:\s*0\s+0\s+20%/);
  assert.doesNotMatch(host, /#app\s+#timeframe-frame\s*\{[^}]*\bheight\s*:/);
  assert.match(full, /#timeframe-frame\{[^}]*height:calc\(100vh/);
  assert.match(full, /#timeframe-frame\{height:calc\(100dvh/);
});

test("K-line host fills the viewport and both canvases share its geometry and viewport", async () => {
  const full = await source("assets/css/full-screen-dynamic.css");
  const view = await source("kline/v9-kline-view.js");
  assert.match(full, /#app\{[^}]*position:relative/);
  assert.match(full, /#kline-host\{[^}]*position:absolute;inset:0;width:100%;height:100%/);
  assert.match(view, /host\.appendChild\(canvas\)/);
  assert.match(view, /host\.appendChild\(overlayCanvas\)/);
  assert.match(view, /observer\.observe\(host\)/);
  assert.match(view, /overlay\.setView\(viewport\(\)\)/);
  assert.match(view, /if\(!n\)\{ctx\.setTransform\(dpr,0,0,dpr,0,0\);ctx.clearRect\(0,0,W,H\);return;\}/);
});

test("lifecycle scope disposes owned resources once, including child scopes", async () => {
  const { createLifecycleScope } = await import("../modules/shared/lifecycle.js");
  const parent = createLifecycleScope();
  let disposed = 0;
  const release = parent.own(() => disposed++);
  const child = parent.child();
  child.own(() => disposed++);
  release(); parent.destroy(); parent.destroy();
  assert.equal(disposed, 2);
  assert.equal(parent.disposed, true);
  assert.equal(child.disposed, true);
});

test("page lifecycle suspends and resumes once across visibility and BFCache events", async () => {
  const { createPageLifecycle } = await import("../modules/shared/page-lifecycle-v9.js");
  const documentRef = new EventTarget(), windowRef = new EventTarget();
  documentRef.hidden = false;
  let suspended = 0, resumed = 0;
  const lifecycle = createPageLifecycle({
    documentRef, windowRef,
    onSuspend: () => suspended++, onResume: () => resumed++
  });
  documentRef.hidden = true;
  documentRef.dispatchEvent(new Event("visibilitychange"));
  documentRef.dispatchEvent(new Event("visibilitychange"));
  documentRef.hidden = false;
  documentRef.dispatchEvent(new Event("visibilitychange"));
  const hide = new Event("pagehide");
  Object.defineProperty(hide, "persisted", { value: true });
  windowRef.dispatchEvent(hide);
  windowRef.dispatchEvent(new Event("pageshow"));
  assert.equal(suspended, 2);
  assert.equal(resumed, 2);
  lifecycle.destroy();
  assert.equal(lifecycle.isSuspended(), true);
});


test("operating-flow documentation matches the current catalog and card interfaces", async () => {
  const docs = await source("OPERATING-FLOWS.md").catch(() => source("docs/SIX-SYSTEMS.md"));
  assert.match(docs, /modules\/shared\/instrument-catalog\.js/);
  assert.match(docs, /modules\/shared\/universe-v9\.js/);
  assert.doesNotMatch(docs, /gate-universe\.js/);
  assert.match(docs, /window\.updateQuotes/);
  assert.match(docs, /window\.setCardOrder/);
  assert.doesNotMatch(docs, /updateQuote\s*\/\s*updateQuotes/);
});

test("drawing hit areas resync after stable orientation and page resume", async () => {
  const runtime = await source("modules/v9-runtime.js");
  const full = await source("assets/css/full-screen-dynamic.css");
  assert.match(runtime, /drawingLayoutRefreshSecond=lifecycle\.animationFrame/);
  assert.match(runtime, /screen\?\.orientation/);
  assert.match(runtime, /function resumeRuntime\(\)[\s\S]*?refreshDrawingLayout\(\)/);
  assert.match(full, /#v9-drawing-tools button[^}]*min-height:44px/);
});

test("responsive layout contracts retain dynamic viewport and safe-area handling", async () => {
  const full = await source("assets/css/full-screen-dynamic.css");
  const cards = await source("cards/rolling-cards.css");
  assert.match(full, /100dvh/);
  assert.match(full, /safe-area-inset/);
  assert.match(full, /orientation|landscape|portrait/i);
  assert.match(cards, /ResizeObserver|touch-action|pointer-events|overflow/i);
});


test("K-line touch gestures retain pan, pinch zoom and host interaction locking", async () => {
  const view = await source("kline/v9-kline-view.js");
  assert.match(view, /pointerdown/);
  assert.match(view, /pointermove/);
  assert.match(view, /startPinch/);
  assert.match(view, /updatePinch/);
  assert.match(view, /interaction\("kline-pointer",true\)/);
  assert.match(view, /interaction\("kline-pointer",false\)/);
});

test("all 22 catalog logos resolve to real local SVG assets", async () => {
  for (const item of INSTRUMENTS) {
    assert.ok(item.logo && item.logoGroup, `missing logo mapping for ${item.symbol}`);
    const svg = await source(`assets/logos/${item.logoGroup}/${item.logo}.svg`);
    assert.match(svg, /<svg[\s>]/i);
  }
});

test("host, cards, timeframe and Logo retain their message integration contracts", async () => {
  const runtime = await source("modules/v9-runtime.js");
  const cards = await source("cards/rolling-cards.js");
  const timeframe = await source("modules/timeframe-switch/index.html");
  const logo = await source("modules/logo/logo.js");
  assert.match(runtime, /event\.origin!==location\.origin/);
  assert.match(runtime, /vegas-v9-selected-timeframe/);
  assert.match(runtime, /vegas-v9-last-random-start/);
  assert.match(runtime, /vegas-v6-selected-timeframe/);
  assert.match(runtime, /localStorage\.setItem\(STORAGE,saved\)/);
  assert.match(runtime, /vegas-v6-last-random-start/);
  assert.match(runtime, /event\.source===timeframeFrame\?\.contentWindow/);
  assert.match(runtime, /localStorage\.setItem\(STORAGE,next\)/);
  assert.match(runtime, /VEGAS_TIMEFRAME_READY/);
  assert.match(timeframe, /VEGAS_TIMEFRAME_READY/);
  assert.match(runtime, /VEGAS_CARD_INTERACTION/);
  assert.match(runtime, /VEGAS_CARD_SELECT/);
  assert.match(runtime, /VEGAS_LOGO_SET_SYMBOL/);
  assert.match(runtime, /VEGAS_TIMEFRAME_SET/);
  assert.match(cards, /VEGAS_CARD_INTERACTION/);
  assert.match(cards, /VEGAS_CARD_SELECT/);
  assert.match(timeframe, /VEGAS_TIMEFRAME_SELECT/);
  assert.match(logo, /VEGAS_LOGO_SET_SYMBOL/);
  assert.match(logo, /VEGAS_LOGO_SET_TIMEFRAME/);
});

test("Gate quotes retain bounded foreground refresh and failure handling", async () => {
  const runtime = await source("modules/v9-runtime.js");
  assert.match(runtime, /300000/);
  assert.match(runtime, /api\.gateio\.ws\/api\/v4\/futures\/usdt\/tickers/);
  assert.match(runtime, /attempt<3/);
  assert.match(runtime, /new AbortController\(\)/);
});


test("EMA renders from available local history while backfill continues", async () => {
  const controller = await readFile(new URL("../kline/gate-kline-controller.js", import.meta.url), "utf8");
  const overlay = await readFile(new URL("../kline/v9-vegas-ema.js", import.meta.url), "utf8");
  const view = await readFile(new URL("../kline/v9-kline-view.js", import.meta.url), "utf8");
  assert.doesNotMatch(controller, /cloudDataBase|syncCloudSnapshot|cloudLoaded|cloudDataReady|market-data/);
  assert.match(controller, /async function readEmaSeries\(key,rows,db\)/);
  assert.match(controller, /timezone=utc8/);
  assert.match(controller, /timeframe==="2H"\|\|timeframe==="D"/);
  assert.match(controller, /mergePendingWriteRows\(pendingWrites\.get\(key\)/);
  assert.match(controller, /w\.setVegasEmaCandles\?\.\(rows,emaValues\)/);
  assert.match(controller, /w\.setVegasEmaCandles\?\.\(rows\)/);
  assert.doesNotMatch(controller, /w\.setVegasEmaCandles\?\.\(complete\?rows:\[\]\)/);
  assert.doesNotMatch(controller, /payload\.ema|cloudEma/);
  assert.match(controller, /from "\.\/ema-engine\.js\?v=/);
  assert.match(overlay, /from "\.\/ema-engine\.js\?v=/);
  assert.doesNotMatch(overlay, /function calculateEmaFrom\(/);
  assert.match(view, /host\.dataset\.emaAvailablePeriods=/);
  assert.match(view, /overlay\.setCandles\(a,values\)/);
  assert.match(overlay, /function setCandles\(next,precomputed=null\)/);
  assert.match(view, /viewportSaveTimer/);
  assert.match(view, /persistViewport\(\)/);
  assert.doesNotMatch(controller, /getContracts|assertContract|contractsPromise/);
  const activeSelect = controller.slice(controller.indexOf("async function select("), controller.indexOf("async function refresh("));
  assert.ok(activeSelect.indexOf("await updateLatest(c,tf,token,forceLatest)") < activeSelect.indexOf("startHistoryQueue(forceLatest)"), "active latest data must load before background full-history queue");
  assert.match(controller, /history-backfill-paused/);
  assert.match(controller, /markDBUnavailable/);
});


