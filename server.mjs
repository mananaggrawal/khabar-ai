/**
 * Production HTTP server for Khabar AI on Render.
 * - Serves dist/client/ as static assets (JS, CSS, images)
 * - Intercepts /api/* routes before SSR (bypasses TanStack Start middleware issues)
 * - Passes all other requests to the TanStack Start SSR handler
 */
import { createServer } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "3000", 10);
const CLIENT_DIR = join(__dirname, "dist", "client");
const SERVER_BUNDLE = join(__dirname, "dist", "server", "server.js");
const API_BUNDLE = join(__dirname, "dist", "server", "api-entry.js");

// MIME types for static assets
const MIME = {
  ".js":    "application/javascript",
  ".mjs":   "application/javascript",
  ".css":   "text/css",
  ".html":  "text/html; charset=utf-8",
  ".json":  "application/json",
  ".png":   "image/png",
  ".jpg":   "image/jpeg",
  ".jpeg":  "image/jpeg",
  ".svg":   "image/svg+xml",
  ".ico":   "image/x-icon",
  ".webp":  "image/webp",
  ".woff":  "font/woff",
  ".woff2": "font/woff2",
  ".ttf":   "font/ttf",
  ".wav":   "audio/wav",
  ".mp3":   "audio/mpeg",
};

if (!existsSync(SERVER_BUNDLE)) {
  console.error(`[khabar] Server bundle not found: ${SERVER_BUNDLE}`);
  process.exit(1);
}

const { default: ssrHandler } = await import(SERVER_BUNDLE);
const { handleGenerate, handleAsk, handleStatus, handleDownload, handleCron, handlePatchMissing, handlePatchTTS, handlePatchScripts, handleStop, handleTrack, handleAnalytics, handleLogs, handlePushSubscribe, handlePushUnsubscribe, handlePushSend, handlePushLog, currentGenerationStatus } = await import(API_BUNDLE);

// Make deploy-triggered restarts loud when they interrupt a run (2026-07-06).
// A generation takes ~10 minutes with no HTTP connection attached to signal
// "wait, I'm not done" — a platform deploy just replaces the process outright,
// which previously looked like a silent, unexplained mid-run stall. There's
// no way to actually finish a 10-minute job inside a shutdown grace period,
// so this can't prevent the interruption — it just makes the cause obvious
// in the logs instead of requiring guesswork next time.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    try {
      const { generating, runningJob } = currentGenerationStatus();
      if (generating) {
        console.error(`[khabar] ${sig} received while a generation was running (job: ${runningJob ?? "unknown"}) — it will be interrupted mid-run, likely by a new deploy replacing this process.`);
      } else {
        console.log(`[khabar] ${sig} received, shutting down (no generation in progress).`);
      }
    } catch {}
    process.exit(0);
  });
}

// Convert Node.js IncomingMessage to a Web Fetch Request
async function toRequest(req) {
  const host = req.headers["host"] || "localhost";
  const url = `http://${host}${req.url}`;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const body = hasBody
    ? await new Promise((resolve) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks)));
      })
    : undefined;

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((vi) => headers.append(k, vi));
    else if (v != null) headers.set(k, v);
  }

  return new Request(url, { method: req.method, headers, body });
}

// Pipe a Web Fetch Response back to Node's ServerResponse
async function sendResponse(webRes, res) {
  res.statusCode = webRes.status;
  for (const [k, v] of webRes.headers.entries()) {
    res.setHeader(k, v);
  }
  if (webRes.body) {
    const reader = webRes.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);
  const pathname = url.pathname;

  // ── Static file serving ────────────────────────────────────────────────
  // Icons and manifests — never cache so updates show immediately
  const isIcon =
    pathname === "/favicon.ico" ||
    pathname === "/favicon.svg" ||
    pathname === "/favicon.png" ||
    pathname === "/favicon-v2.png" ||
    pathname === "/icon-192.png" ||
    pathname === "/icon-192-v2.png" ||
    pathname === "/icon-512.png" ||
    pathname === "/icon-512-v2.png" ||
    pathname === "/apple-touch-icon.png" ||
    pathname === "/apple-touch-icon-v2.png" ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/robots.txt" ||
    pathname === "/site.webmanifest";

  // Any static image/font file that exists in the client build (e.g. /hero-orb.jpg)
  const staticExt = /\.(png|jpe?g|webp|gif|svg|ico|woff2?|ttf|otf)$/i.test(pathname);
  // Real service worker file — must be served from disk verbatim (not SSR'd as
  // HTML) and never cached, so updates to it are picked up on next launch.
  const isServiceWorker = pathname === "/sw.js";
  const isStatic =
    !pathname.includes("..") && (pathname.startsWith("/assets/") || isIcon || staticExt || isServiceWorker);

  if (isStatic) {
    const filePath = join(CLIENT_DIR, pathname);
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      const mime = MIME[extname(filePath)] || "application/octet-stream";
      res.setHeader("Content-Type", mime);
      // Icons/manifests/service worker: no-cache so PWA and browser always get latest
      // Hashed assets (JS/CSS in /assets/): immutable 1-year cache
      const cacheControl = isIcon || isServiceWorker
        ? "no-cache, no-store, must-revalidate"
        : "public, max-age=31536000, immutable";
      res.setHeader("Cache-Control", cacheControl);
      createReadStream(filePath).pipe(res);
      return;
    }
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  // ── API routes (intercepted before SSR) ───────────────────────────────
  if (pathname === "/api/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (pathname === "/admin") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(adminPage(
      process.env.VITE_SUPABASE_URL || "",
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY || "",
    ));
    return;
  }

  if (pathname === "/admin/analytics") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(adminAnalyticsPage(
      process.env.VITE_SUPABASE_URL || "",
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY || "",
    ));
    return;
  }

  if (pathname === "/admin/manifest.json") {
    res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" });
    res.end(JSON.stringify({
      name: "Khabar Admin",
      short_name: "Khabar Admin",
      description: "Khabar AI admin dashboard",
      start_url: "/admin",
      display: "standalone",
      background_color: "#0c0714",
      theme_color: "#0c0714",
      icons: [
        { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      ],
    }));
    return;
  }

  if (pathname === "/admin-sw.js") {
    res.writeHead(200, { "Content-Type": "application/javascript", "Cache-Control": "no-cache" });
    res.end(`
const CACHE = 'khabar-admin-v1';
const SHELL = ['/admin'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(clients.claim());
});
self.addEventListener('fetch', e => {
  if (e.request.url.includes('/api/')) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
`);
    return;
  }

  if (pathname === "/api/admin/status" && req.method === "GET") {
    try {
      const request = await toRequest(req);
      const response = await handleStatus(request);
      await sendResponse(response, res);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
    return;
  }

  if (pathname === "/api/admin/cron" && req.method === "POST") {
    const key = req.headers["x-admin-key"] || "";
    if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    // Respond 200 immediately — no body reading, no async
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    // Fire generation after response is flushed
    setImmediate(() => {
      handleCron(new Request("http://localhost/api/admin/cron", {
        method: "POST",
        headers: { "x-admin-key": key },
      })).catch((err) => console.error("[cron]", err?.message ?? err));
    });
    return;
  }

  if (pathname === "/api/admin/generate" && req.method === "POST") {
    try {
      const request = await toRequest(req);
      const response = await handleGenerate(request);
      await sendResponse(response, res);
    } catch (err) {
      console.error("[khabar] /api/admin/generate error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
    return;
  }

  if (pathname === "/api/admin/patch-missing" && req.method === "POST") {
    try {
      const request = await toRequest(req);
      const response = await handlePatchMissing(request);
      await sendResponse(response, res);
    } catch (err) {
      console.error("[khabar] /api/admin/patch-missing error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
    return;
  }

  if (pathname === "/api/admin/patch-scripts" && req.method === "POST") {
    try {
      const response = await handlePatchScripts(request);
      return response;
    } catch (err) {
      console.error("[khabar] /api/admin/patch-scripts error:", err);
    }
  }

  if (pathname === "/api/admin/patch-tts" && req.method === "POST") {
    try {
      const request = await toRequest(req);
      const response = await handlePatchTTS(request);
      await sendResponse(response, res);
    } catch (err) {
      console.error("[khabar] /api/admin/patch-tts error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
    return;
  }

  if (pathname === "/api/admin/stop" && req.method === "POST") {
    try {
      const request = await toRequest(req);
      const response = await handleStop(request);
      await sendResponse(response, res);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
    return;
  }

  if (pathname === "/api/admin/download" && req.method === "GET") {
    try {
      const request = await toRequest(req);
      const response = await handleDownload(request);
      await sendResponse(response, res);
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
    return;
  }

  if (pathname === "/api/ask" && req.method === "POST") {
    try {
      const request = await toRequest(req);
      const response = await handleAsk(request);
      await sendResponse(response, res);
    } catch (err) {
      console.error("[khabar] /api/ask error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
    return;
  }

  if (pathname === "/api/track" && req.method === "POST") {
    try {
      const request = await toRequest(req);
      const response = await handleTrack(request);
      await sendResponse(response, res);
    } catch (err) {
      console.error("[khabar] /api/track error:", err);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false }));
    }
    return;
  }

  if (pathname === "/api/admin/analytics" && req.method === "GET") {
    try {
      const request = await toRequest(req);
      const response = await handleAnalytics(request);
      await sendResponse(response, res);
    } catch (err) {
      console.error("[khabar] /api/admin/analytics error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
    return;
  }

  if (pathname === "/api/admin/logs" && req.method === "GET") {
    try {
      const request = await toRequest(req);
      const response = await handleLogs(request);
      await sendResponse(response, res);
    } catch (err) {
      console.error("[khabar] /api/admin/logs error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
    return;
  }

  if (pathname === "/api/push/subscribe" && req.method === "POST") {
    try {
      const request = await toRequest(req);
      const response = await handlePushSubscribe(request);
      await sendResponse(response, res);
    } catch (err) {
      console.error("[khabar] /api/push/subscribe error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
    return;
  }

  if (pathname === "/api/push/unsubscribe" && req.method === "POST") {
    try {
      const request = await toRequest(req);
      const response = await handlePushUnsubscribe(request);
      await sendResponse(response, res);
    } catch (err) {
      console.error("[khabar] /api/push/unsubscribe error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
    return;
  }

  if (pathname === "/api/admin/push-send" && req.method === "POST") {
    try {
      const request = await toRequest(req);
      const response = await handlePushSend(request);
      await sendResponse(response, res);
    } catch (err) {
      console.error("[khabar] /api/admin/push-send error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
    return;
  }

  if (pathname === "/api/admin/push-log" && req.method === "GET") {
    try {
      const request = await toRequest(req);
      const response = await handlePushLog(request);
      await sendResponse(response, res);
    } catch (err) {
      console.error("[khabar] /api/admin/push-log error:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
    return;
  }

  // ── SSR handler ────────────────────────────────────────────────────────
  try {
    const request = await toRequest(req);
    const response = await ssrHandler.fetch(request);
    // Force the HTML document itself to always revalidate (2026-07-06).
    // Hashed assets under /assets/ are safely immutable-cached above, but the
    // document that REFERENCES those hashed filenames must never be served
    // stale — otherwise a hard navigation (e.g. the OAuth redirect landing
    // back on "/") can fetch an old cached page pointing at JS/CSS files a
    // newer deploy already deleted, which loads nothing and shows a blank
    // screen. Users reported exactly this ("fixed by killing and reopening
    // the app" — a fresh network fetch finally got a current document).
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("text/html")) {
      const headers = new Headers(response.headers);
      headers.set("Cache-Control", "no-cache, no-store, must-revalidate");
      await sendResponse(new Response(response.body, { status: response.status, headers }), res);
    } else {
      await sendResponse(response, res);
    }
  } catch (err) {
    console.error("[khabar] SSR error:", err);
    res.writeHead(500);
    res.end("Internal Server Error");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[khabar] Server listening on http://0.0.0.0:${PORT}`);
});

function adminAnalyticsPage(supabaseUrl, supabaseKey) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Khabar Analytics</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;background:#0c0714;color:#e8e4f0;font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:20px;max-width:1000px;margin:0 auto}
  h1{font-size:20px;margin:0}
  a{color:#a78bfa}
  .row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:16px}
  .seg button{background:#1c1330;color:#cbb8f0;border:1px solid #2e2150;border-radius:999px;padding:5px 12px;margin-left:6px;cursor:pointer;font-weight:600}
  .seg button.on{background:#a78bfa;color:#140b22;border-color:#a78bfa}
  .cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px}
  .card{background:#160d27;border:1px solid #271b45;border-radius:14px;padding:14px}
  .card .k{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#8b7fb0}
  .card .v{font-size:24px;font-weight:700;margin-top:4px}
  .panel{background:#160d27;border:1px solid #271b45;border-radius:14px;padding:14px;margin-bottom:16px}
  .panel h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#8b7fb0;margin:0 0 10px}
  .chartbox{position:relative;width:100%}
  .chartbox canvas{position:absolute;inset:0;width:100%!important;height:100%!important}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #271b45}
  th{color:#8b7fb0;font-weight:600}
  .muted{color:#8b7fb0}
  #err{color:#fca5a5}
  .grouplbl{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:#8b7fb0;margin:6px 2px 8px;font-weight:700}
  .card .sub{font-size:10px;color:#7a6ea0;margin-top:2px}
  .tablewrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin-top:10px}
  #usersTbl th,#usersTbl td{white-space:nowrap}
  details.panel summary{list-style:none;cursor:pointer;color:#8b7fb0;font-size:12px;text-transform:uppercase;letter-spacing:.06em}
  details.panel summary::-webkit-details-marker{display:none}
  @media(max-width:640px){.cards{grid-template-columns:repeat(2,1fr)}}
</style>
</head><body>
  <div id="gate" style="display:none;text-align:center;padding:64px 20px">
    <h1>Khabar — Analytics</h1>
    <p id="gateMsg" class="muted" style="margin:14px 0">Sign in to continue.</p>
    <button id="signinBtn" style="background:#a78bfa;color:#140b22;border:0;border-radius:999px;padding:10px 18px;font-weight:700;cursor:pointer">Sign in with Google</button>
  </div>
  <div id="app" style="display:none">
  <div class="row">
    <div><h1>Khabar — Analytics</h1><div class="muted" style="font-size:12px"><a href="/admin">← Admin</a> · <span id="who"></span></div></div>
    <div class="seg" id="seg">
      <button data-d="7">7d</button><button data-d="30" class="on">30d</button><button data-d="90">90d</button>
    </div>
    <div class="seg" id="gran">
      <button data-g="day" class="on">Daily</button><button data-g="week">Weekly</button>
    </div>
  </div>
  <div id="err"></div>
  <div class="muted" id="dataNote" style="font-size:11px;margin:-4px 0 12px"></div>
  <!-- Engagement -->
  <div class="grouplbl">Engagement</div>
  <div class="cards">
    <div class="card"><div class="k">DAU (latest)</div><div class="v" id="kDau">–</div></div>
    <div class="card"><div class="k">WAU</div><div class="v" id="kWau">–</div></div>
    <div class="card"><div class="k">MAU</div><div class="v" id="kMau">–</div></div>
    <div class="card"><div class="k">Stickiness</div><div class="v" id="kStick">–</div><div class="sub">DAU / WAU</div></div>
  </div>

  <!-- Growth & retention -->
  <div class="grouplbl">Growth & retention</div>
  <div class="cards">
    <div class="card"><div class="k">Total users</div><div class="v" id="kTotal">–</div></div>
    <div class="card"><div class="k">New users</div><div class="v" id="kNew">–</div></div>
    <div class="card"><div class="k">D1 return</div><div class="v" id="kD1">–</div><div class="sub" id="kD1n"></div></div>
    <div class="card"><div class="k">D7 return</div><div class="v" id="kD7">–</div><div class="sub" id="kD7n"></div></div>
  </div>
  <div class="cards">
    <div class="card"><div class="k">Referral visits</div><div class="v" id="kRefVisit">–</div><div class="sub">/?ref= link opens</div></div>
    <div class="card"><div class="k">Referred signups</div><div class="v" id="kRefSignup">–</div><div class="sub">word-of-mouth</div></div>
  </div>

  <div class="panel"><h2>Active users per day — new vs returning · total user base</h2><div class="chartbox" style="height:240px"><canvas id="dauChart"></canvas></div></div>

  <!-- Usage volume -->
  <div class="grouplbl">Usage</div>
  <div class="cards">
    <div class="card"><div class="k">Minutes listened</div><div class="v" id="kListen">–</div><div class="sub">audio actually played</div></div>
    <div class="card"><div class="k">Stories played</div><div class="v" id="kStories">–</div><div class="sub">stories started</div></div>
    <div class="card"><div class="k">Avg min / user</div><div class="v" id="kPerUser">–</div><div class="sub">listened ÷ users</div></div>
    <div class="card"><div class="k">Avg / story</div><div class="v" id="kPerStory">–</div><div class="sub">listen time per story</div></div>
  </div>

  <div class="panel"><h2>Listening time by section — what people actually hear</h2><div class="chartbox" style="height:260px"><canvas id="sectionChart"></canvas></div></div>
  <div class="panel"><h2>When users listen — hour of day (IST)</h2><div class="chartbox" style="height:200px"><canvas id="hourChart"></canvas></div></div>

  <details class="panel">
    <summary>Per-user breakdown ▾</summary>
    <div class="tablewrap"><table id="usersTbl"><thead><tr><th>User</th><th>Active days</th><th>On app (min)</th><th>Listened (min)</th><th>Stories</th><th>Last seen</th></tr></thead><tbody></tbody></table></div>
  </details>
  </div> <!-- /#app -->

<script>
  var SUPABASE_URL = ${JSON.stringify(supabaseUrl)};
  var SUPABASE_KEY = ${JSON.stringify(supabaseKey)};
  var SB = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
  var TOKEN = '';
  var days = 30;
  var granularity = 'day';
  var charts = {};

  function txt(id, v){ document.getElementById(id).textContent = v; }

  // All timestamps from the server are UTC ISO strings — this dashboard should
  // always read in IST regardless of the viewing browser's own timezone, so
  // convert explicitly rather than relying on toLocaleString()'s local default.
  function toIST(iso, opts){
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString('en-IN', Object.assign({ timeZone: 'Asia/Kolkata' }, opts || {}));
  }

  function drawChart(id, type, labels, datasets){
    var ctx = document.getElementById(id).getContext('2d');
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart(ctx, {
      type: type,
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#cbb8f0', boxWidth: 12 } } },
        scales: {
          x: { ticks: { color: '#8b7fb0' }, grid: { color: '#241941' } },
          y: { ticks: { color: '#8b7fb0' }, grid: { color: '#241941' }, beginAtZero: true }
        }
      }
    });
  }

  function fmtMin(m){ return m >= 60 ? (Math.floor(m/60) + 'h ' + (m%60) + 'm') : (m + 'm'); }

  function ctx(id){ return document.getElementById(id).getContext('2d'); }

  function render(d){
    var dn = document.getElementById('dataNote');
    if (dn) dn.textContent = (d.totalEvents || 0) + ' events in range';

    // Engagement
    txt('kDau', d.dau != null ? d.dau : 0);
    txt('kWau', d.wau != null ? d.wau : 0);
    txt('kMau', d.mau != null ? d.mau : 0);
    txt('kStick', (d.stickiness || 0) + '%');

    // Growth & retention
    txt('kTotal', d.totalUsers != null ? d.totalUsers : 0);
    txt('kNew', d.newUsers != null ? d.newUsers : 0);
    txt('kD1', d.d1Pct != null ? (d.d1Pct + '%') : '—');
    txt('kD7', d.d7Pct != null ? (d.d7Pct + '%') : '—');
    txt('kD1n', d.d1Elig ? ('of ' + d.d1Elig + ' new') : '');
    txt('kD7n', d.d7Elig ? ('of ' + d.d7Elig + ' new') : '');
    txt('kRefVisit', d.referralVisits != null ? d.referralVisits : 0);
    txt('kRefSignup', d.referredSignups != null ? d.referredSignups : 0);

    // Usage volume
    txt('kListen', fmtMin(d.minutesListened || 0));
    txt('kStories', d.storiesPlayed != null ? d.storiesPlayed : 0);
    txt('kPerUser', (d.avgMinPerActiveUser || 0) + 'm');
    txt('kPerStory', (d.avgSecPerStory || 0) + 's');

    // Active users per day: new vs returning (stacked bars) + total base (line)
    var g = d.perDayGrowth || [];
    var isWeekly = d.granularity === 'week';
    // Weekly keys are the Monday date of that week — show a short "Wk of"
    // label so it's clear these aren't single days.
    var glabels = g.map(function(x){ return isWeekly ? ('Wk ' + x.day.slice(5)) : x.day.slice(5); });
    if (charts.dauChart) charts.dauChart.destroy();
    charts.dauChart = new Chart(ctx('dauChart'), {
      data: { labels: glabels, datasets: [
        { type:'bar',  label:'New',        data:g.map(function(x){return x.newUsers;}),  backgroundColor:'#34d399', stack:'u', yAxisID:'y', borderRadius:3 },
        { type:'bar',  label:'Returning',  data:g.map(function(x){return x.returning;}), backgroundColor:'#a78bfa', stack:'u', yAxisID:'y', borderRadius:3 },
        { type:'line', label:'Total users',data:g.map(function(x){return x.cumUsers;}),  borderColor:'#f59e0b', backgroundColor:'#f59e0b22', tension:.3, yAxisID:'y1' }
      ]},
      options: {
        responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ labels:{ color:'#cbb8f0', boxWidth:12 } } },
        scales:{
          x:{ stacked:true, ticks:{ color:'#8b7fb0', maxRotation:0, autoSkip:true }, grid:{ color:'#241941' } },
          y:{ stacked:true, beginAtZero:true, ticks:{ color:'#8b7fb0', precision:0 }, grid:{ color:'#241941' }, title:{ display:true, text:'active users', color:'#8b7fb0' } },
          y1:{ position:'right', beginAtZero:true, ticks:{ color:'#f59e0b', precision:0 }, grid:{ drawOnChartArea:false }, title:{ display:true, text:'total', color:'#f59e0b' } }
        }
      }
    });

    // Listening time by section (horizontal bars, most-listened first)
    var bs = d.bySection || [];
    var SEC_COLOR = { headlines:'#EF4444', india:'#F97316', world:'#0D9488', business:'#16A34A', technology:'#6366F1', sports:'#DB2777', science:'#0EA5E9', health:'#65A30D', quick15:'#A78BFA' };
    if (charts.sectionChart) charts.sectionChart.destroy();
    charts.sectionChart = new Chart(ctx('sectionChart'), {
      type: 'bar',
      data: { labels: bs.map(function(x){ return x.section; }), datasets: [
        { label:'Min listened', data:bs.map(function(x){ return x.min; }), backgroundColor:bs.map(function(x){ return SEC_COLOR[x.section] || '#a78bfa'; }), borderRadius:4 }
      ]},
      options: {
        indexAxis:'y', responsive:true, maintainAspectRatio:false,
        plugins:{ legend:{ display:false } },
        scales:{
          x:{ beginAtZero:true, ticks:{ color:'#8b7fb0' }, grid:{ color:'#241941' }, title:{ display:true, text:'minutes', color:'#8b7fb0' } },
          y:{ ticks:{ color:'#cbb8f0' }, grid:{ display:false } }
        }
      }
    });

    // Hour-of-day chart
    var hrs = d.hourly || [];
    drawChart('hourChart', 'bar', hrs.map(function(_,i){ return (i<10?'0':'')+i; }), [
      { label:'Min listened', data:hrs.map(function(s){ return +(s/60).toFixed(1); }), backgroundColor:'#a78bfa', borderRadius:3 }
    ]);

    var ub = document.querySelector('#usersTbl tbody'); ub.innerHTML = '';
    (d.users || []).forEach(function(u){
      var tr = document.createElement('tr');
      var la = toIST(u.lastActive, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      tr.innerHTML = '<td>' + (u.email || '–') + '</td><td>' + u.daysActive + '</td><td>' + u.appMin + '</td><td>' + u.listenMin + '</td><td>' + u.stories + '</td><td class="muted">' + la + '</td>';
      ub.appendChild(tr);
    });
  }

  function showGate(msg, showBtn){
    document.getElementById('app').style.display = 'none';
    document.getElementById('gate').style.display = 'block';
    document.getElementById('gateMsg').textContent = msg;
    document.getElementById('signinBtn').style.display = showBtn ? 'inline-block' : 'none';
  }
  function showApp(){
    document.getElementById('gate').style.display = 'none';
    document.getElementById('app').style.display = 'block';
  }

  async function load(){
    document.getElementById('err').textContent = '';
    try {
      var res = await fetch('/api/admin/analytics?days=' + days + '&granularity=' + granularity, { headers: { 'Authorization': 'Bearer ' + TOKEN } });
      if (res.status === 401) { showGate('Session expired — sign in again.', true); return; }
      if (res.status === 403) { showGate('This account is not authorized to view analytics.', false); return; }
      if (!res.ok) { document.getElementById('err').textContent = 'Error ' + res.status; return; }
      showApp();
      render(await res.json());
    } catch (e) {
      document.getElementById('err').textContent = 'Failed to load: ' + (e && e.message ? e.message : e);
    }
  }

  async function boot(){
    var s = await SB.auth.getSession();
    var session = s && s.data ? s.data.session : null;
    if (!session) { showGate('Sign in to view analytics.', true); return; }
    TOKEN = session.access_token;
    var who = document.getElementById('who'); if (who) who.textContent = session.user.email || '';
    load();
  }

  document.getElementById('signinBtn').addEventListener('click', function(){
    SB.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + '/admin/analytics' } });
  });

  document.getElementById('seg').addEventListener('click', function(e){
    var b = e.target.closest('button'); if (!b) return;
    days = Number(b.getAttribute('data-d'));
    Array.prototype.forEach.call(this.querySelectorAll('button'), function(x){ x.classList.toggle('on', x === b); });
    load();
  });

  document.getElementById('gran').addEventListener('click', function(e){
    var b = e.target.closest('button'); if (!b) return;
    granularity = b.getAttribute('data-g');
    Array.prototype.forEach.call(this.querySelectorAll('button'), function(x){ x.classList.toggle('on', x === b); });
    load();
  });

  boot();
</script>
</body></html>`;
}

function adminPage(supabaseUrl, supabaseKey) {
  const ALLOWED_EMAIL = "manan190303@gmail.com";
  const adminKey = process.env.ADMIN_KEY || "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="theme-color" content="#0c0714">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Khabar Admin">
  <title>Khabar AI — Admin</title>
  <link rel="icon" type="image/png" href="/favicon.png">
  <link rel="manifest" href="/admin/manifest.json">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Geist:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg:        oklch(0.13 0.035 295);
      --surface:   oklch(0.17 0.04 295);
      --fg:        oklch(0.98 0.005 300);
      --primary:   oklch(0.72 0.19 300);
      --primary-fg:oklch(0.15 0.03 295);
      --muted:     oklch(0.7 0.03 295);
      --border:    oklch(1 0 0 / 8%);
      --surface2:  oklch(1 0 0 / 2%);
      --divider:   oklch(1 0 0 / 5%);
    }
    html, body {
      background: var(--bg); color: var(--fg); min-height: 100vh;
      font-family: 'Geist', ui-sans-serif, system-ui, sans-serif;
      font-size: 14px; letter-spacing: -0.01em;
      -webkit-font-smoothing: antialiased;
    }
    .serif { font-family: 'Instrument Serif', ui-serif, Georgia, serif; letter-spacing: -0.02em; }

    /* Gradient glow — same as main app */
    .glow {
      position: fixed; inset: 0; pointer-events: none; z-index: 0;
      background:
        radial-gradient(ellipse at 50% 30%, oklch(0.22 0.04 290 / 0.7), transparent 60%),
        radial-gradient(ellipse at 80% 80%, oklch(0.25 0.08 30 / 0.35), transparent 65%);
    }
    .z1 { position: relative; z-index: 1; }

    /* Screens */
    .screen { display: none; }
    .screen.active { display: block; }
    .screen.flex { display: none; }
    .screen.flex.active { display: flex; }

    /* Centred layout (login / denied) */
    .center { flex-direction: column; align-items: center; justify-content: center;
              min-height: 100vh; gap: 12px; padding: 24px; }

    /* Top bar */
    .topbar { display: flex; align-items: center; justify-content: space-between;
              padding: 28px 24px 0; max-width: 640px; margin: 0 auto; }
    .wordmark { font-size: 20px; }
    .wordmark em { font-style: italic; color: var(--primary); }
    .user-row { display: flex; align-items: center; gap: 10px; }
    .avatar { width: 28px; height: 28px; border-radius: 50%; object-fit: cover; }
    .avatar-init {
      width: 28px; height: 28px; border-radius: 50%; background: oklch(0.72 0.19 300 / 0.2);
      display: flex; align-items: center; justify-content: center;
      font-size: 11px; font-weight: 500; color: var(--primary);
    }

    /* Content */
    .content { padding: 32px 24px 48px; max-width: 640px; margin: 0 auto; }

    /* Card group — same as SectionGroup */
    .group {
      background: var(--surface2); border: 1px solid var(--border);
      border-radius: 16px; overflow: hidden; padding: 20px;
    }
    .date-label {
      font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
      color: var(--muted); margin-bottom: 14px;
    }
    .status-row { display: flex; align-items: center; gap: 10px; margin-bottom: 5px; }
    .dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .dot-ok { background: var(--primary); }
    .dot-warn { background: oklch(0.75 0.15 70); }
    .dot-err { background: oklch(0.65 0.22 25); }
    .day-row { padding: 14px 0; }
    .day-row:first-child { padding-top: 0; }
    .day-row:last-child { padding-bottom: 0; }
    .day-date { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
    .day-status { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .day-status-left { display: flex; align-items: center; gap: 8px; }
    .status-main { font-size: 14px; font-weight: 500; }
    .status-meta { font-size: 12px; color: var(--muted); }
    .btn-dl { background: none; border: 1px solid var(--border); border-radius: 999px;
              font-family: 'Geist', ui-sans-serif, system-ui, sans-serif;
              font-size: 12px; color: var(--muted); cursor: pointer; padding: 4px 12px;
              transition: color 0.15s, border-color 0.15s; white-space: nowrap; }
    .btn-dl:hover { color: var(--fg); border-color: oklch(1 0 0 / 20%); }
    .divider { height: 1px; background: var(--divider); margin: 0; }
    .gen-sub { font-size: 13px; color: var(--muted); margin-bottom: 14px; }

    /* Log terminal */
    .log-terminal {
      display: none; margin-top: 14px;
      background: oklch(0.10 0.02 295); border: 1px solid var(--border);
      border-radius: 10px; padding: 12px 14px;
      max-height: 260px; overflow-y: auto;
      font-family: ui-monospace, 'SFMono-Regular', 'Cascadia Code', monospace;
      font-size: 12px; line-height: 1.65;
    }
    .log-terminal.visible { display: block; }
    .log-line { color: oklch(0.62 0.025 295); word-break: break-word; }
    .log-done { color: var(--primary); font-weight: 500; }
    .log-error { color: oklch(0.65 0.22 25); }

    /* Quota warning banner */
    .quota-banner {
      display: none;
      align-items: center; gap: 10px;
      background: oklch(0.65 0.22 25 / 0.1); border: 1px solid oklch(0.65 0.22 25 / 0.35);
      border-radius: 12px; padding: 12px 16px; margin-bottom: 16px;
      font-size: 13px; color: oklch(0.80 0.15 25);
    }
    .quota-banner.visible { display: flex; }

    /* Running banner */
    .running-banner {
      display: none;
      align-items: center; justify-content: space-between; gap: 12px;
      background: oklch(0.72 0.19 300 / 0.12); border: 1px solid oklch(0.72 0.19 300 / 0.3);
      border-radius: 12px; padding: 12px 16px; margin-bottom: 16px;
    }
    .running-banner.visible { display: flex; }
    .running-left { display: flex; align-items: center; gap: 10px; }
    .running-label { font-size: 13px; font-weight: 500; color: var(--primary); }
    .running-sub { font-size: 12px; color: var(--muted); margin-top: 2px; }
    .btn-stop {
      flex-shrink: 0; padding: 6px 14px; border-radius: 999px;
      background: oklch(0.65 0.22 25 / 0.15); border: 1px solid oklch(0.65 0.22 25 / 0.4);
      color: oklch(0.75 0.22 25); font-family: 'Geist', ui-sans-serif, system-ui, sans-serif;
      font-size: 12px; font-weight: 500; cursor: pointer; transition: opacity 0.15s;
    }
    .btn-stop:hover { opacity: 0.8; }

    /* Stats grid */
    .stats-grid {
      display: grid; grid-template-columns: 1fr 1fr;
      gap: 8px; margin-bottom: 16px;
    }
    .stat-card {
      background: var(--surface2); border: 1px solid var(--border);
      border-radius: 10px; padding: 12px 14px;
    }
    .stat-label { font-size: 11px; color: var(--muted); letter-spacing: 0.06em; text-transform: uppercase; margin-bottom: 4px; }
    .stat-value { font-size: 20px; font-weight: 600; color: var(--fg); line-height: 1; }
    .stat-sub { font-size: 11px; color: var(--muted); margin-top: 2px; }
    .stat-bar { height: 3px; background: var(--border); border-radius: 999px; margin-top: 6px; overflow: hidden; }
    .stat-bar-fill { height: 100%; background: var(--primary); border-radius: 999px; transition: width 0.4s; }

    /* Buttons */
    .btn-primary {
      display: flex; align-items: center; justify-content: center; gap: 8px;
      width: 100%; padding: 12px 20px; border-radius: 999px;
      background: var(--primary); color: var(--primary-fg); border: none;
      font-family: 'Geist', ui-sans-serif, system-ui, sans-serif;
      font-size: 14px; font-weight: 500; cursor: pointer; letter-spacing: -0.01em;
      transition: opacity 0.15s;
    }
    .btn-primary:hover { opacity: 0.88; }
    .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-ghost {
      background: none; border: none; font-family: inherit;
      font-size: 13px; color: var(--muted); cursor: pointer; padding: 0;
    }
    .btn-ghost:hover { color: var(--fg); }
    .btn-google {
      display: flex; align-items: center; gap: 10px; padding: 11px 24px;
      border-radius: 999px; background: var(--fg); color: #111;
      border: none; font-family: 'Geist', ui-sans-serif, system-ui, sans-serif;
      font-size: 14px; font-weight: 500; cursor: pointer;
    }
    .btn-google:hover { opacity: 0.92; }

    /* Login page titles */
    .login-title { font-size: 28px; margin-bottom: 4px; }
    .login-sub { font-size: 13px; color: var(--muted); margin-bottom: 16px; }
    .login-err { font-size: 12px; color: oklch(0.65 0.22 25); margin-top: 8px; display: none; }

    /* Denied */
    .denied-title { font-size: 16px; font-weight: 500; margin-bottom: 4px; }
    .denied-sub { font-size: 13px; color: var(--muted); margin-bottom: 16px; }

    /* Spinner */
    @keyframes spin { to { transform: rotate(360deg); } }
    .spin { animation: spin 0.8s linear infinite; display: inline-block; }

    /* Config row — pill-style selector */
    .config-row {
      display: flex; align-items: center; gap: 6px;
      margin-bottom: 10px; flex-wrap: wrap;
    }
    .config-label {
      font-size: 10px; font-weight: 600; letter-spacing: .08em;
      text-transform: uppercase; color: var(--muted);
      min-width: 70px; flex-shrink: 0;
    }
    .config-row label {
      display: inline-flex; align-items: center; gap: 0;
      cursor: pointer; font-size: 12px; font-weight: 500;
      padding: 5px 11px; border-radius: 999px;
      border: 1px solid var(--border); color: var(--muted);
      transition: all 0.15s; user-select: none;
    }
    .config-row label:has(input:checked) {
      background: var(--primary); color: var(--primary-fg);
      border-color: transparent;
    }
    .config-row label:hover:not(:has(input:checked)) {
      color: var(--fg); border-color: oklch(1 0 0 / 18%);
    }
    .config-row input[type="radio"],
    .config-row input[type="checkbox"] { display: none; }
    .config-note { font-size: 11px; color: var(--muted); margin-left: 4px; }
  </style>
</head>
<body>
<div class="glow"></div>
<div class="z1">

  <!-- Login -->
  <div id="s-login" class="screen flex">
    <div class="center">
      <div class="serif login-title">Khabar <em style="font-style:italic;color:var(--primary)">AI</em></div>
      <div class="login-sub">Admin — sign in to continue</div>
      <button class="btn-google" onclick="signIn()">
        <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
        Sign in with Google
      </button>
      <div id="login-err" class="login-err"></div>
    </div>
  </div>

  <!-- Denied -->
  <div id="s-denied" class="screen flex">
    <div class="center">
      <div class="denied-title">Access denied</div>
      <div class="denied-sub">This account is not authorised.</div>
      <button class="btn-ghost" onclick="signOut()">Sign out</button>
    </div>
  </div>

  <!-- Dashboard -->
  <div id="s-dash" class="screen">
    <div class="topbar">
      <div class="serif wordmark">Khabar <em>AI</em></div>
      <div class="user-row">
        <img id="u-avatar" class="avatar" src="" style="display:none" alt="">
        <div id="u-init" class="avatar-init" style="display:none"></div>
        <button class="btn-ghost" onclick="signOut()">Sign out</button>
      </div>
    </div>
    <div class="content">
      <!-- Running job banner -->
      <div id="running-banner" class="running-banner">
        <div class="running-left">
          <span class="spin" style="color:var(--primary);font-size:16px;">&#9696;</span>
          <div>
            <div class="running-label" id="running-label">Running…</div>
            <div class="running-sub" id="running-sub"></div>
          </div>
        </div>
        <button class="btn-stop" onclick="stopJob()">Stop</button>
      </div>

      <!-- Today's script / audio stats -->
      <div id="stats-section" style="display:none;">
        <div class="stats-grid" id="stats-grid">
          <!-- Populated dynamically based on generated languages -->
        </div>
      </div>

      <div class="group" style="padding:0 20px;">
        <div id="days-list" style="padding:20px 0;"></div>
      </div>
      <div style="height:16px;"></div>

      <!-- Run logs — persisted per day, so cron-triggered runs (nobody watching
           live) are still visible after the fact -->
      <div class="group" style="padding:16px 20px;">
        <div class="gen-sub" style="margin-bottom:10px;">Generation logs (cron + manual runs, persisted per day)</div>
        <div style="display:flex; gap:8px; align-items:center; margin-bottom:10px;">
          <input type="date" id="logs-date" style="background:#1a1330; border:1px solid #3a2d5c; color:#e8e0fb; border-radius:8px; padding:6px 10px; font-size:13px;">
          <button class="btn-dl" onclick="loadLogs()">Load</button>
          <span id="logs-status" style="color:var(--muted); font-size:12px;"></span>
        </div>
        <pre id="logs-output" style="max-height:420px; overflow:auto; background:#0d0820; border:1px solid #241941; border-radius:10px; padding:12px; font-size:11px; line-height:1.5; color:#cbb8f0; white-space:pre-wrap; word-break:break-word; margin:0;">Pick a date and hit Load.</pre>
      </div>
      <div style="height:16px;"></div>

      <div class="group">
        <div class="gen-sub">Regenerate today's briefing from scratch.</div>

        <!-- Scripting provider -->
        <div class="config-row">
          <span class="config-label">Scripting</span>
          <label><input type="radio" name="script-provider" value="gemini" checked><span>Gemini Flash <span class="config-note">(free)</span></span></label>
          <label><input type="radio" name="script-provider" value="openai-4o"><span>GPT-4o</span></label>
          <label><input type="radio" name="script-provider" value="openai-4omini"><span>GPT-4o Mini</span></label>
        </div>

        <!-- TTS provider -->
        <div class="config-row">
          <span class="config-label">TTS</span>
          <label><input type="radio" name="tts-provider" value="edge" checked><span>Edge <span class="config-note">(free)</span></span></label>
          <label><input type="radio" name="tts-provider" value="openai-tts1"><span>OpenAI TTS-1</span></label>
          <label><input type="radio" name="tts-provider" value="openai-ttsHD"><span>OpenAI TTS-HD</span></label>
          <label><input type="radio" name="tts-provider" value="google"><span>Google</span></label>
          <label><input type="radio" name="tts-provider" value="elevenlabs"><span>ElevenLabs</span></label>
          <label><input type="radio" name="tts-provider" value="kokoro"><span>Kokoro <span class="config-note">(EN)</span></span></label>
        </div>

        <!-- Languages -->
        <div class="config-row" style="margin-bottom:16px;">
          <span class="config-label">Languages</span>
          <label><input type="checkbox" name="gen-lang" value="en" checked><span>EN</span></label>
          <label><input type="checkbox" name="gen-lang" value="hi" checked><span>HI</span></label>
        </div>

        <button class="btn-primary" id="gen-btn" onclick="runGenerate()">Generate now</button>
        <div id="gen-log" class="log-terminal"></div>
      </div>
      <div style="height:12px;"></div>

      <!-- Manual push notification trigger -->
      <div class="group">
        <div class="gen-sub">Send a push notification to every subscribed device right now. Leave both fields blank to send the same auto-picked "briefing ready" message the cron uses.</div>
        <div style="display:flex; flex-direction:column; gap:8px; margin-bottom:12px;">
          <input type="text" id="push-title" placeholder="Title (optional)" maxlength="60"
            style="background:#1a1330; border:1px solid #3a2d5c; color:#e8e0fb; border-radius:8px; padding:8px 12px; font-size:13px;">
          <input type="text" id="push-body" placeholder="Message (optional)" maxlength="150"
            style="background:#1a1330; border:1px solid #3a2d5c; color:#e8e0fb; border-radius:8px; padding:8px 12px; font-size:13px;">
        </div>
        <button class="btn-primary" id="push-btn" onclick="runPushSend()">Send notification now</button>
        <div id="push-log" class="log-terminal"></div>
      </div>
      <div style="height:12px;"></div>

      <!-- Notification history — every push send (cron-automatic or manual),
           persisted per day, same pattern as generation logs above -->
      <div class="group" style="padding:16px 20px;">
        <div class="gen-sub" style="margin-bottom:10px;">Notification log (cron + manual sends, persisted per day)</div>
        <div style="display:flex; gap:8px; align-items:center; margin-bottom:10px;">
          <input type="date" id="notiflog-date" style="background:#1a1330; border:1px solid #3a2d5c; color:#e8e0fb; border-radius:8px; padding:6px 10px; font-size:13px;">
          <button class="btn-dl" onclick="loadNotifLog()">Load</button>
        </div>
        <pre id="notiflog-output" style="max-height:300px; overflow:auto; background:#0d0820; border:1px solid #241941; border-radius:10px; padding:12px; font-size:11px; line-height:1.5; color:#cbb8f0; white-space:pre-wrap; word-break:break-word; margin:0;">Pick a date and hit Load.</pre>
      </div>
      <div style="height:16px;"></div>

      <div class="group">
        <div class="gen-sub">Generate audio for stories that have scripts but no audio (e.g. after quota reset).</div>
        <div class="config-row" style="margin-bottom:14px;">
          <span class="config-label">TTS</span>
          <label><input type="radio" name="tts-patch-provider" value="edge" checked><span>Edge <span class="config-note">(free)</span></span></label>
          <label><input type="radio" name="tts-patch-provider" value="openai-tts1"><span>OpenAI TTS-1</span></label>
          <label><input type="radio" name="tts-patch-provider" value="openai-ttsHD"><span>OpenAI TTS-HD</span></label>
          <label><input type="radio" name="tts-patch-provider" value="google"><span>Google</span></label>
          <label><input type="radio" name="tts-patch-provider" value="elevenlabs"><span>ElevenLabs</span></label>
          <label><input type="radio" name="tts-patch-provider" value="kokoro"><span>Kokoro <span class="config-note">(EN)</span></span></label>
        </div>
        <div class="config-row" style="margin-bottom:16px;">
          <span class="config-label">Languages</span>
          <label><input type="checkbox" name="tts-patch-lang" value="en" checked><span>EN</span></label>
          <label><input type="checkbox" name="tts-patch-lang" value="hi" checked><span>HI</span></label>
        </div>
        <button class="btn-primary" id="tts-btn" onclick="runPatchTTS()">Patch missing TTS</button>
        <div id="tts-log" class="log-terminal"></div>
      </div>
    </div>
  </div>

</div>

<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
<script>
  const SB_URL = ${JSON.stringify(supabaseUrl)};
  const SB_KEY = ${JSON.stringify(supabaseKey)};
  const ALLOWED = ${JSON.stringify(ALLOWED_EMAIL)};
  const AKEY   = ${JSON.stringify(adminKey)};

  const sb = supabase.createClient(SB_URL, SB_KEY);

  const today = new Date().toISOString().slice(0, 10);

  async function init() {
    const { data: { session } } = await sb.auth.getSession();
    render(session);
    sb.auth.onAuthStateChange((_, s) => render(s));
  }

  function render(session) {
    if (!session) { show('s-login'); return; }
    if (session.user?.email !== ALLOWED) { show('s-denied'); return; }
    const meta = session.user?.user_metadata || {};
    const avatar = meta.avatar_url || '';
    const name = (meta.name || session.user.email || 'M')[0].toUpperCase();
    if (avatar) {
      const img = document.getElementById('u-avatar');
      img.src = avatar; img.style.display = 'block';
      document.getElementById('u-init').style.display = 'none';
    } else {
      document.getElementById('u-init').textContent = name;
      document.getElementById('u-init').style.display = 'flex';
    }
    show('s-dash');
    loadStatus();
    document.getElementById('logs-date').value = new Date().toISOString().slice(0, 10);
    loadLogs();
    document.getElementById('notiflog-date').value = new Date().toISOString().slice(0, 10);
    loadNotifLog();
  }

  function show(id) {
    ['s-login','s-denied','s-dash'].forEach(s => {
      const el = document.getElementById(s);
      el.classList.remove('active');
    });
    document.getElementById(id).classList.add('active');
  }

  async function signIn() {
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.href } });
    if (error) { const el = document.getElementById('login-err'); el.textContent = error.message; el.style.display = 'block'; }
  }

  async function signOut() { await sb.auth.signOut(); show('s-login'); }

  function dayLabel(date, i) {
    if (i === 0) return 'Today';
    if (i === 1) return 'Yesterday';
    return new Date(date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }

  function renderDays(days) {
    const list = document.getElementById('days-list');
    list.innerHTML = '';
    days.forEach((day, i) => {
      const row = document.createElement('div');
      row.className = 'day-row';

      const dateEl = document.createElement('div');
      dateEl.className = 'day-date';
      dateEl.textContent = dayLabel(day.date, i) + ' — ' + day.date;
      row.appendChild(dateEl);

      const statusRow = document.createElement('div');
      statusRow.className = 'day-status';

      const left = document.createElement('div');
      left.className = 'day-status-left';

      const dot = document.createElement('div');
      const label = document.createElement('div');
      label.className = 'status-main';

      if (day.status === 'generated') {
        dot.className = 'dot dot-ok';
        label.textContent = 'Generated';
        left.appendChild(dot);
        left.appendChild(label);
        const meta = document.createElement('div');
        meta.className = 'status-meta';
        const langBadges = day.generatedLanguages?.length ? ' · ' + day.generatedLanguages.map(l => l.toUpperCase()).join(' ') : '';
        meta.textContent = day.sections + ' sections · ' + day.totalTopics + ' topics'
          + langBadges
          + (day.generatedAt ? ' · ' + new Date(day.generatedAt).toLocaleTimeString() : '');
        left.appendChild(meta);

        const dlBtn = document.createElement('button');
        dlBtn.className = 'btn-dl';
        dlBtn.textContent = 'Download';
        dlBtn.onclick = () => downloadBriefing(day.date);
        statusRow.appendChild(left);
        statusRow.appendChild(dlBtn);
      } else {
        dot.className = day.status === 'error' ? 'dot dot-err' : 'dot dot-warn';
        label.textContent = day.status === 'error' ? 'Error' : 'Not generated';
        label.style.color = day.status === 'error' ? 'oklch(0.65 0.22 25)' : 'oklch(0.75 0.15 70)';
        left.appendChild(dot);
        left.appendChild(label);
        statusRow.appendChild(left);
      }

      row.appendChild(statusRow);
      list.appendChild(row);

      if (i < days.length - 1) {
        const div = document.createElement('div');
        div.className = 'divider';
        div.style.margin = '0 -20px';
        list.appendChild(div);
      }
    });

    const todayStatus = days[0]?.status;
    document.getElementById('gen-btn').textContent = todayStatus === 'generated' ? 'Regenerate' : 'Generate now';
  }

  let _pollTimer = null;

  function startPolling() {
    if (_pollTimer) return;
    _pollTimer = setInterval(loadStatus, 4000);
  }

  function stopPolling() {
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
  }

  function jobLabel(job) {
    if (!job) return 'Running…';
    if (job.startsWith('generate:'))  return 'Generating full briefing (' + job.split(':')[1] + ')';
    if (job.startsWith('patch-tts:')) return 'Patching missing TTS (' + job.split(':')[1] + ')';
    return { 'patch-missing': 'Patching missing sections', 'patch-scripts': 'Re-scripting garbled stories', 'patch-tts': 'Patching missing TTS', cron: 'Running cron job' }[job] ?? 'Running…';
  }

  function updateRunningBanner(running, runningJob) {
    const banner = document.getElementById('running-banner');
    const label = document.getElementById('running-label');
    const sub = document.getElementById('running-sub');
    if (running) {
      label.textContent = jobLabel(runningJob);
      sub.textContent = 'Polling for updates every 4 seconds…';
      banner.classList.add('visible');
      startPolling();
    } else {
      banner.classList.remove('visible');
      stopPolling();
    }
  }

  function updateStats(todayStats) {
    const sec = document.getElementById('stats-section');
    if (!todayStats || todayStats.status !== 'generated') { sec.style.display = 'none'; return; }
    sec.style.display = 'block';
    const total = todayStats.totalTopics || 1;
    const grid = document.getElementById('stats-grid');
    grid.innerHTML = '';

    const langs = [
      { code: 'en', label: 'EN', script: todayStats.enScript ?? 0, audio: todayStats.enAudio ?? 0 },
      { code: 'hi', label: 'HI', script: todayStats.hiScript ?? 0, audio: todayStats.hiAudio ?? 0 },
    ].filter(l => l.script > 0 || l.audio > 0);

    for (const lang of langs) {
      const card = document.createElement('div');
      card.className = 'stat-card';
      const scriptPct = Math.round(lang.script / total * 100);
      const audioPct  = lang.script > 0 ? Math.round(lang.audio / lang.script * 100) : 0;
      card.innerHTML =
        '<div class="stat-label">' + lang.label + ' Scripts</div>' +
        '<div class="stat-value">' + lang.script + '</div>' +
        '<div class="stat-sub">of ' + total + ' stories</div>' +
        '<div class="stat-bar"><div class="stat-bar-fill" style="width:' + scriptPct + '%"></div></div>';
      grid.appendChild(card);

      const aCard = document.createElement('div');
      aCard.className = 'stat-card';
      aCard.innerHTML =
        '<div class="stat-label">' + lang.label + ' Audio</div>' +
        '<div class="stat-value">' + lang.audio + '</div>' +
        '<div class="stat-sub">of ' + lang.script + ' with script (' + audioPct + '%)</div>' +
        '<div class="stat-bar"><div class="stat-bar-fill" style="width:' + audioPct + '%"></div></div>';
      grid.appendChild(aCard);
    }
  }

  async function loadStatus() {
    const list = document.getElementById('days-list');
    if (!list.children.length) list.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0;">Checking…</div>';
    try {
      const r = await fetch('/api/admin/status', { headers: { 'x-admin-key': AKEY } });
      const d = await r.json();
      const days = d.days ?? [];
      renderDays(days);
      updateRunningBanner(d.running, d.runningJob);
      updateStats(d.todayStats);
      // While a run is active, auto-refresh the logs panel too (server flushes
      // every ~5s during a run) — if the viewer is on today's date, so a cron
      // run shows live progress without manually clicking Load repeatedly.
      if (d.running) {
        const dateInput = document.getElementById('logs-date');
        if (dateInput && dateInput.value === new Date().toISOString().slice(0, 10)) loadLogs();
      }
    } catch {
      list.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0;">Could not load status</div>';
    }
  }

  async function loadLogs() {
    const dateInput = document.getElementById('logs-date');
    const date = dateInput.value || new Date().toISOString().slice(0, 10);
    dateInput.value = date;
    const out = document.getElementById('logs-output');
    const status = document.getElementById('logs-status');
    status.textContent = 'Loading…';
    try {
      const r = await fetch('/api/admin/logs?date=' + date, { headers: { 'x-admin-key': AKEY } });
      const d = await r.json();
      if (!d.log) {
        out.textContent = 'No logs found for ' + date + (d.running ? ' — a run (' + d.runningJob + ') is currently in progress; refresh to see it partway or after it finishes.' : '.');
      } else {
        out.textContent = d.log;
        out.scrollTop = out.scrollHeight;
      }
      status.textContent = d.running ? 'Run in progress: ' + d.runningJob : '';
    } catch {
      out.textContent = 'Could not load logs.';
      status.textContent = '';
    }
  }

  async function loadNotifLog() {
    const dateInput = document.getElementById('notiflog-date');
    const date = dateInput.value || new Date().toISOString().slice(0, 10);
    dateInput.value = date;
    const out = document.getElementById('notiflog-output');
    out.textContent = 'Loading…';
    try {
      const r = await fetch('/api/admin/push-log?date=' + date, { headers: { 'x-admin-key': AKEY } });
      const d = await r.json();
      out.textContent = d.log || ('No notifications logged for ' + date + '.');
      out.scrollTop = out.scrollHeight;
    } catch {
      out.textContent = 'Could not load notification log.';
    }
  }

  async function stopJob() {
    try {
      const r = await fetch('/api/admin/stop', { method: 'POST', headers: { 'x-admin-key': AKEY } });
      const d = await r.json();
      if (d.ok) {
        document.getElementById('running-sub').textContent = 'Stop requested — finishing current section…';
      }
    } catch {}
  }

  async function downloadBriefing(date) {
    try {
      const r = await fetch('/api/admin/download?date=' + date, { headers: { 'x-admin-key': AKEY } });
      if (!r.ok) { alert('Download failed'); return; }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'khabar-' + date + '.json';
      document.body.appendChild(a); a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch { alert('Download failed'); }
  }

  function appendLog(type, msg) {
    const el = document.getElementById('gen-log');
    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const line = document.createElement('div');
    line.className = 'log-line' + (type !== 'log' ? ' log-' + type : '');
    line.textContent = ts + '  ' + msg;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }

  async function runGenerate() {
    const btn = document.getElementById('gen-btn');
    const logEl = document.getElementById('gen-log');

    btn.disabled = true;
    btn.innerHTML = '<span class="spin">&#9696;</span> Generating…';
    logEl.innerHTML = '';
    logEl.classList.add('visible');
    startPolling();

    try {
      // Script provider + model
      const scriptRaw = document.querySelector('input[name="script-provider"]:checked')?.value ?? 'gemini';
      const scriptProvider = scriptRaw.startsWith('openai') ? 'openai' : 'gemini';
      const scriptModel = scriptRaw === 'openai-4o' ? 'gpt-4o' : scriptRaw === 'openai-4omini' ? 'gpt-4o-mini' : 'gemini-2.5-flash';

      // TTS provider + model
      const ttsRaw = document.querySelector('input[name="tts-provider"]:checked')?.value ?? 'edge';
      const ttsProvider = ttsRaw.startsWith('openai') ? 'openai' : ttsRaw;
      const ttsModel = ttsRaw === 'openai-tts1' ? 'tts-1' : ttsRaw === 'openai-ttsHD' ? 'tts-1-hd' : '';

      const selectedLangs = [...document.querySelectorAll('input[name="gen-lang"]:checked')].map(el => el.value);
      if (selectedLangs.length === 0) {
        appendLog('error', 'Select at least one language before generating.');
        btn.disabled = false; btn.textContent = 'Generate now';
        return;
      }
      const params = new URLSearchParams({ provider: ttsProvider, languages: selectedLangs.join(','), scriptProvider, scriptModel });
      if (ttsModel) params.set('ttsModel', ttsModel);
      const r = await fetch('/api/admin/generate?' + params, { method: 'POST', headers: { 'x-admin-key': AKEY } });
      if (r.status === 409) {
        appendLog('log', 'Generation already in progress — check back in a few minutes.');
        btn.disabled = false; btn.textContent = 'Regenerate';
        return;
      }
      if (!r.ok || !r.body) {
        appendLog('error', 'Request failed: HTTP ' + r.status);
        btn.disabled = false; btn.textContent = 'Retry';
        return;
      }

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\\n\\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === 'log') {
              appendLog('log', ev.msg);
            } else if (ev.type === 'done') {
              const mins = Math.floor((ev.elapsedSec || 0) / 60);
              const secs = Math.round((ev.elapsedSec || 0) % 60);
              const cost = ev.ttsEstUsd != null ? ' · est. $' + ev.ttsEstUsd.toFixed(2) + ' (' + (ev.ttsProvider || '') + ')' : '';
              const timing = ev.elapsedSec ? ' · ' + mins + 'm ' + secs + 's (club ' + Math.round(ev.clubSec || 0) + 's, TTS ' + Math.round(ev.ttsSec || 0) + 's)' : '';
              appendLog('done', '✓ ' + ev.stories + ' stories · ' + ev.date + timing + cost);
              loadStatus();
            } else if (ev.type === 'error') {
              appendLog('error', ev.msg);
            }
          } catch {}
        }
      }
    } catch (err) {
      appendLog('error', 'Network error: ' + (err.message || err));
    }

    btn.disabled = false;
    btn.textContent = 'Regenerate';
  }

  function appendTTSLog(type, msg) {
    const el = document.getElementById('tts-log');
    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const line = document.createElement('div');
    line.className = 'log-line' + (type !== 'log' ? ' log-' + type : '');
    line.textContent = ts + '  ' + msg;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }

  function appendPushLog(type, msg) {
    const el = document.getElementById('push-log');
    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const line = document.createElement('div');
    line.className = 'log-line' + (type !== 'log' ? ' log-' + type : '');
    line.textContent = ts + '  ' + msg;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }

  async function runPushSend() {
    const btn = document.getElementById('push-btn');
    const logEl = document.getElementById('push-log');
    const title = document.getElementById('push-title').value.trim();
    const bodyText = document.getElementById('push-body').value.trim();

    btn.disabled = true;
    btn.innerHTML = '<span class="spin">&#9696;</span> Sending…';
    logEl.innerHTML = '';
    logEl.classList.add('visible');

    try {
      const r = await fetch('/api/admin/push-send', {
        method: 'POST',
        headers: { 'x-admin-key': AKEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(title || bodyText ? { title, body: bodyText } : {}),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        appendPushLog('error', 'Request failed: HTTP ' + r.status + (d.error ? ' — ' + d.error : ''));
      } else {
        (d.logs || []).forEach((line) => appendPushLog('log', line));
        appendPushLog('done', 'Done' + (d.period ? ' (' + d.period + ' message)' : '') + (d.total != null ? ' — ' + d.sent + '/' + d.total + ' delivered' : ''));
      }
    } catch (err) {
      appendPushLog('error', 'Network error: ' + (err.message || err));
    }

    btn.disabled = false;
    btn.textContent = 'Send notification now';
  }

  async function runPatchTTS() {
    const btn = document.getElementById('tts-btn');
    const logEl = document.getElementById('tts-log');

    btn.disabled = true;
    btn.innerHTML = '<span class="spin">&#9696;</span> Patching TTS…';
    logEl.innerHTML = '';
    logEl.classList.add('visible');
    startPolling();

    try {
      const ttsPatchRaw = document.querySelector('input[name="tts-patch-provider"]:checked')?.value ?? 'edge';
      const ttsPatchProvider = ttsPatchRaw.startsWith('openai') ? 'openai' : ttsPatchRaw;
      const ttsPatchModel = ttsPatchRaw === 'openai-tts1' ? 'tts-1' : ttsPatchRaw === 'openai-ttsHD' ? 'tts-1-hd' : '';
      const ttsPatchLangs = [...document.querySelectorAll('input[name="tts-patch-lang"]:checked')].map(el => el.value);
      const patchParams = new URLSearchParams({ provider: ttsPatchProvider, languages: ttsPatchLangs.join(',') });
      if (ttsPatchModel) patchParams.set('ttsModel', ttsPatchModel);
      const r = await fetch('/api/admin/patch-tts?' + patchParams, { method: 'POST', headers: { 'x-admin-key': AKEY } });
      if (r.status === 409) {
        appendTTSLog('log', 'Generation already in progress — check back shortly.');
        btn.disabled = false; btn.textContent = 'Patch missing TTS';
        return;
      }
      if (!r.ok || !r.body) {
        appendTTSLog('error', 'Request failed: HTTP ' + r.status);
        btn.disabled = false; btn.textContent = 'Retry';
        return;
      }

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\\n\\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === 'log') {
              appendTTSLog('log', ev.msg);
            } else if (ev.type === 'done') {
              appendTTSLog('done', 'Done — patched ' + ev.patched + ' stories (' + ev.stories + ' total)');
              loadStatus();
            } else if (ev.type === 'error') {
              appendTTSLog('error', ev.msg);
            }
          } catch {}
        }
      }
    } catch (err) {
      appendTTSLog('error', 'Network error: ' + (err.message || err));
    }

    btn.disabled = false;
    btn.textContent = 'Patch missing TTS';
  }

  init();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/admin-sw.js').catch(() => {});
  }
</script>
</body>
</html>`;
}
