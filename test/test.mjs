// End-to-end test: fake DN page + fake ntfy server, run the real watcher for ~16 s with a 1 s interval.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const page = (body) => `<html><head><script>var x=1;</script></head><body><nav>Meny Hem</nav><h1>Lediga lägenheter</h1>${body}<footer>&copy; DN Fastigheter 2015</footer></body></html>`;
const EMPTY = "<p>Just nu finns det inga lediga lägenheter tillgängliga, välkommen åter!</p>";
const APT1 = `<div class="obj"><h2>Storgatan 12</h2><p>2 rum och kök, 58 kvm</p><p>Hyra: 7 900 kr/mån</p></div>`;
const APT2 = `<div class="obj"><h2>Kungsgatan 3</h2><p>1 rum och kök, 34 kvm</p><p>Hyra: 5 800 kr/mån</p></div>`;
let current = page(EMPTY);
const posts = [];

const server = http.createServer((req, res) => {
  if (req.method === "POST") { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { posts.push(JSON.parse(b)); res.end("{}"); }); }
  else { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(current); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dnw-"));
const stateFile = path.join(dir, "state.json");
const run = (seconds) => new Promise((resolve) => {
  const p = spawn(process.execPath, [fileURLToPath(new URL("../watch.mjs", import.meta.url))], {
    env: { ...process.env, DN_URL: base + "/page", NTFY_SERVER: base + "/ntfy", NTFY_TOPIC: "test-topic", INTERVAL: "1", FORCE_WINDOW: "1", FORCE_SECONDS: String(seconds), STATE_FILE: stateFile },
    stdio: ["ignore", "inherit", "inherit"],
  });
  p.on("exit", resolve);
});

const at = (ms, fn) => setTimeout(fn, ms);
at(3500, () => (current = page(EMPTY.replace("<p>", "<p class=x>") + APT1)));   // "07:11" first apartment appears
at(7500, () => (current = page(APT1 + APT2)));                                  // "09:25" a second one appears; empty message gone
at(11500, () => (current = page(APT2)));                                        // first apartment rented out -> must NOT alert
at(13500, () => (current = page(EMPTY)));                                       // page empty again -> must NOT alert

await run(17);
const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`); };
check("exactly 2 alerts during the run", posts.length === 2, `(got ${posts.length})`);
check("alert 1 mentions Storgatan 12", /Storgatan 12/.test(posts[0]?.message ?? ""));
check("alert 2 mentions Kungsgatan 3 but not Storgatan", /Kungsgatan 3/.test(posts[1]?.message ?? "") && !/Storgatan/.test(posts[1]?.message ?? ""));
check("alerts are high priority and go to the topic", posts.every((p) => p.priority === 4 && p.topic === "test-topic"));
check("no alert for baseline, removal or empty page", posts.length === 2);
const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
check("state persisted with lines and lastRun", st.lines.length > 5 && !!st.lastRun && st.baseline === true);

// second run with the same state: current page = EMPTY (all lines known) -> no alerts
posts.length = 0;
await run(4);
check("second run with saved state sends no alert", posts.length === 0, `(got ${posts.length})`);

// a failing ntfy must not lose the alert: next poll retries
current = page(APT2 + APT1.replace("Storgatan 12", "Sandgatan 9"));
let failOnce = true;
server.removeAllListeners("request");
server.on("request", (req, res) => {
  if (req.method === "POST") { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { if (failOnce) { failOnce = false; res.statusCode = 500; return res.end("x"); } posts.push(JSON.parse(b)); res.end("{}"); }); }
  else { res.setHeader("content-type", "text/html; charset=utf-8"); res.end(current); }
});
await run(6);
check("failed ntfy post is retried and delivered", posts.length === 1 && /Sandgatan 9/.test(posts[0].message), `(got ${posts.length})`);

server.close();
console.log(results.every(Boolean) ? "\nALL PASSED" : "\nSOME FAILED");
process.exit(results.every(Boolean) ? 0 : 1);
