export const BARK_SIGNAL_FEED_URL = "https://raw.githubusercontent.com/MraJJqq/Vegasbark/main/public/signals.json";

export function formatSignalText(payload) {
  if (!payload || payload.schema_version !== 1 || payload.source !== "Vegasbark" || !Array.isArray(payload.symbols)) {
    throw new TypeError("Invalid Bark signal feed");
  }
  const symbols = payload.symbols
    .map(value => String(value).trim())
    .filter(value => /^[A-Z0-9]{2,16}$/.test(value));
  return symbols.length ? symbols.join(" ▰\u00A0") : "𝐍𝐨 𝐒𝐢𝐠𝐧𝐚𝐥";
}

function mountSignalTicker() {
  const ticker = document.getElementById("signal-ticker");
  if (!ticker) return;

  let timer = null;
  let request = null;
  let stopped = false;

  async function refresh() {
    if (stopped || document.hidden) return;
    const controller = new AbortController();
    request = controller;
    try {
      const response = await fetch(BARK_SIGNAL_FEED_URL, {
        cache: "no-store",
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      if (!response.ok) throw new Error("Bark feed HTTP " + response.status);
      const payload = await response.json();
      const nextText = formatSignalText(payload);
      ticker.replaceChildren();
      ticker.textContent = nextText;
      ticker.hidden = false;
    } catch (error) {
      if (error.name !== "AbortError") console.warn("[VEGAS V9 Bark feed]", error);
    } finally {
      if (request === controller) request = null;
    }
  }

  function start() {
    if (stopped || timer !== null) return;
    void refresh();
    timer = window.setInterval(refresh, 15000);
  }

  function stop() {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    request?.abort();
    request = null;
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stop();
    else start();
  });
  window.addEventListener("pagehide", () => {
    stopped = true;
    stop();
  }, { once: true });

  start();
}

if (typeof document !== "undefined") mountSignalTicker();
