import test from "node:test";
import assert from "node:assert/strict";
import { formatSignalText, BARK_SIGNAL_FEED_URL } from "../modules/signal-ticker/signal-ticker.js";

test("Bark feed URL points to the Vegasbark public signal feed", () => {
  assert.equal(BARK_SIGNAL_FEED_URL, "https://raw.githubusercontent.com/MraJJqq/Vegasbark/main/public/signals.json");
});

test("signal text preserves Bark order and separator spacing", () => {
  const payload = { schema_version: 1, source: "Vegasbark", symbols: ["BTC", "ETH", "XAU"] };
  assert.equal(formatSignalText(payload), "BTC ▰\u00A0ETH ▰\u00A0XAU");
});

test("empty successful Bark feed displays the exact no-signal text", () => {
  const payload = { schema_version: 1, source: "Vegasbark", symbols: [] };
  assert.equal(formatSignalText(payload), "𝐍𝐨 𝐒𝐢𝐠𝐧𝐚𝐥");
});

test("invalid feed payload is rejected instead of being displayed as no signal", () => {
  assert.throws(() => formatSignalText({ schema_version: 1, source: "other", symbols: [] }), /Invalid Bark signal feed/);
});
