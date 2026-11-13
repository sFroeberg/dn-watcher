#!/usr/bin/env node
// Watches https://dnfast.se/lediga-objekt/lediga-laegenheter/ and pushes every NEW piece of content to ntfy.
// Runs on weekdays 07:00-10:00 Swedish time (DST-proof: the time is computed with Intl, not cron).
//
// How "new" works: the page text is split into lines. State (state.json) remembers every line ever seen.
// A line that is not in the state = new content = alert. A listing that disappears does NOT alert, and a
// second apartment appearing later alerts again. The first ever run only records a baseline (no alert).
//
// Env: NTFY_TOPIC (required, secret), NTFY_SERVER (default https://ntfy.sh), DN_URL, INTERVAL (seconds, 60),
//      FORCE_WINDOW=1 + FORCE_SECONDS (testing: ignore the clock and run for N seconds), STATE_FILE.
import fs from "node:fs";

const URL_ = process.env.DN_URL || "https://dnfast.se/lediga-objekt/lediga-laegenheter/";
const PUBLIC_URL = "https://dnfast.se/lediga-objekt/lediga-laegenheter/";
const NTFY = process.env.NTFY_SERVER || "https://ntfy.sh";
const TOPIC = process.env.NTFY_TOPIC;
const INTERVAL = Number(process.env.INTERVAL || 60) * 1000;
const FORCE = process.env.FORCE_WINDOW === "1";
const STATE_FILE = process.env.STATE_FILE || new URL("./state.json", import.meta.url);
const WINDOW = { startMin: 7 * 60, endMin: 10 * 60 }; // 07:00 <= t < 10:00, Mon-Fri
if (!TOPIC) { console.error("Set NTFY_TOPIC"); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

function stockholm(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Stockholm", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d).map((x) => [x.type, x.value]));
  return { weekday: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday) + 1, min: (Number(p.hour) % 24) * 60 + Number(p.minute) };
}

const decode = (s) => s.replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCharCode(parseInt(x, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"');

function extractLines(html) {
  html = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const start = html.search(/<h1[^>]*>/i);
  const end = html.search(/&copy;|<footer/i);
  let body = html.slice(start >= 0 ? start : 0, end > start ? end : undefined);
  body = body.replace(/<\/?(p|div|li|ul|ol|tr|td|th|h[1-6]|section|article|br|a|span|tbody|table)[^>]*>/gi, "\n").replace(/<[^>]*>/g, " ");
  return [...new Set(decode(body).split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l.length > 1))];
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch (e) { if (e.code !== "ENOENT") log("state unreadable:", e.message); return null; }
}
const saveState = (st) => fs.writeFileSync(STATE_FILE, JSON.stringify({ ...st, lines: st.lines.slice(-3000), lastRun: new Date().toISOString() }, null, 1));

async function notify(newLines) {
  const text = newLines.join("\n").slice(0, 700);
  const r = await fetch(NTFY, {
    method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(15_000),
    body: JSON.stringify({ topic: TOPIC, title: "Nytt hos DN Fastigheter!", message: text, click: PUBLIC_URL, priority: 4, tags: ["rotating_light", "house"] }),
  });
  if (!r.ok) throw new Error(`ntfy HTTP ${r.status}`);
}

async function main() {
  const state = loadState() ?? { lines: [], baseline: false };
  const known = new Set(state.lines);
  const forceEnd = FORCE ? Date.now() + Number(process.env.FORCE_SECONDS || 120) * 1000 : Infinity;
  let polls = 0, alerts = 0, failures = 0;

  for (;;) {
    if (FORCE) { if (Date.now() >= forceEnd) break; }
    else {
      const t = stockholm();
      if (t.weekday > 5 || t.min >= WINDOW.endMin) { log("outside window (weekend or after 10:00) - done"); break; }
      if (t.min < WINDOW.startMin) {
        if (WINDOW.startMin - t.min > 240) { log("more than 4h before the window - done"); break; }
        await sleep(20_000); continue; // waiting for 07:00
      }
    }
    try {
      const res = await fetch(URL_, { headers: { "User-Agent": "Mozilla/5.0 dn-watcher", Accept: "text/html,*/*;q=0.8", "Accept-Language": "sv-SE,sv;q=0.9" }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const lines = extractLines(await res.text());
      if (!lines.length) throw new Error("page parsed to zero lines (layout change?)");
      polls++; failures = 0;
      const fresh = lines.filter((l) => !known.has(l));
      if (!state.baseline) { lines.forEach((l) => known.add(l)); state.baseline = true; log(`baseline recorded (${lines.length} lines), no alert`); }
      else if (fresh.length) {
        log(`NEW content (${fresh.length} lines):`, fresh.join(" | ").slice(0, 300));
        try { await notify(fresh); fresh.forEach((l) => known.add(l)); alerts++; } catch (e) { log("notify failed, will retry next poll:", e.message); }
      }
    } catch (e) { failures++; log(`poll failed (${failures} in a row): ${e.message}`); }
    await sleep(INTERVAL);
  }
  saveState({ ...state, lines: [...known] });
  log(`finished: ${polls} polls, ${alerts} alerts`);
}

await main();
