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
const { handleGenerate, handleAsk, handleStatus, handleDownload, handleCron, handlePatchMissing, handlePatchTTS, handlePatchScripts, handleStop, handleTrack, handleAnalytics } = await import(API_BUNDLE);

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

  const isStatic = pathname.startsWith("/assets/") || isIcon;

  if (isStatic) {
    const filePath = join(CLIENT_DIR, pathname);
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      const mime = MIME[extname(filePath)] || "application/octet-stream";
      res.setHeader("Content-Type", mime);
      // Icons/manifests: no-cache so PWA and browser always get latest
      // Hashed assets (JS/CSS in /assets/): immutable 1-year cache
      const cacheControl = isIcon
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
    res.end(adminAnalyticsPage(process.env.ADMIN_KEY || ""));
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

  // ── SSR handler ────────────────────────────────────────────────────────
  try {
    const request = await toRequest(req);
    const response = await ssrHandler.fetch(request);
    await sendResponse(response, res);
  } catch (err) {
    console.error("[khabar] SSR error:", err);
    res.writeHead(500);
    res.end("Internal Server Error");
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[khabar] Server listening on http://0.0.0.0:${PORT}`);
});

function adminAnalyticsPage(adminKey) {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Khabar Analytics</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
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
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #271b45}
  th{color:#8b7fb0;font-weight:600}
  .muted{color:#8b7fb0}
  #err{color:#fca5a5}
  @media(max-width:640px){.cards{grid-template-columns:repeat(2,1fr)}}
</style>
</head><body>
  <div class="row">
    <div><h1>Khabar — Analytics</h1><div class="muted" style="font-size:12px"><a href="/admin">← Admin</a> · first-party events</div></div>
    <div class="seg" id="seg">
      <button data-d="7">7d</button><button data-d="30" class="on">30d</button><button data-d="90">90d</button>
    </div>
  </div>
  <div id="err"></div>
  <div class="cards">
    <div class="card"><div class="k">Total events</div><div class="v" id="kpiEvents">–</div></div>
    <div class="card"><div class="k">Plays</div><div class="v" id="kpiPlays">–</div></div>
    <div class="card"><div class="k">Completion</div><div class="v" id="kpiCompletion">–</div></div>
    <div class="card"><div class="k">Avg story</div><div class="v" id="kpiAvg">–</div></div>
  </div>
  <div class="panel"><h2>Activity per day</h2><canvas id="dailyChart" height="110"></canvas></div>
  <div class="panel"><h2>Funnel — open → briefing → play → complete</h2><canvas id="funnelChart" height="90"></canvas></div>
  <div class="panel"><h2>Story starts by section</h2><canvas id="sectionChart" height="90"></canvas></div>
  <div class="panel"><h2>Top stories <span class="muted">(by play; ids until titles are joined)</span></h2><table id="topTbl"><thead><tr><th>Story id</th><th>Plays</th></tr></thead><tbody></tbody></table></div>
  <div class="panel"><h2>Recent generation runs</h2><table id="genTbl"><thead><tr><th>Date</th><th>Stories</th><th>TTS $</th><th>Elapsed</th></tr></thead><tbody></tbody></table></div>

<script>
  var AKEY = ${JSON.stringify(adminKey)};
  var days = 30;
  var charts = {};

  function txt(id, v){ document.getElementById(id).textContent = v; }

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

  function render(d){
    txt('kpiEvents', d.totalEvents);
    txt('kpiPlays', d.eventCounts.play || 0);
    txt('kpiCompletion', d.completionRate + '%');
    txt('kpiAvg', d.avgStorySec + 's');

    var labels = d.perDay.map(function(x){ return x.day.slice(5); });
    drawChart('dailyChart', 'line', labels, [
      { label:'Events', data:d.perDay.map(function(x){return x.events;}), borderColor:'#a78bfa', backgroundColor:'#a78bfa33', tension:.3 },
      { label:'Plays',  data:d.perDay.map(function(x){return x.plays;}),  borderColor:'#34d399', backgroundColor:'#34d39933', tension:.3 },
      { label:'Users',  data:d.perDay.map(function(x){return x.users;}),  borderColor:'#f59e0b', backgroundColor:'#f59e0b33', tension:.3 }
    ]);
    drawChart('funnelChart', 'bar', ['Open','Briefing','Play','Complete'],
      [{ label:'Count', data:[d.funnel.app_open,d.funnel.briefing_loaded,d.funnel.play,d.funnel.story_complete], backgroundColor:'#a78bfa' }]);
    drawChart('sectionChart', 'bar', d.sections.map(function(s){return s.section;}),
      [{ label:'Starts', data:d.sections.map(function(s){return s.count;}), backgroundColor:'#34d399' }]);

    var tb = document.querySelector('#topTbl tbody'); tb.innerHTML = '';
    d.topStories.forEach(function(s){
      var tr = document.createElement('tr');
      tr.innerHTML = '<td class="muted">' + s.storyId + '</td><td>' + s.count + '</td>';
      tb.appendChild(tr);
    });

    var gb = document.querySelector('#genTbl tbody'); gb.innerHTML = '';
    d.generationRuns.forEach(function(g){
      var tr = document.createElement('tr');
      var usd = g.ttsEstUsd != null ? ('$' + Number(g.ttsEstUsd).toFixed(3)) : '–';
      var el  = g.elapsedSec != null ? (Math.round(g.elapsedSec) + 's') : '–';
      tr.innerHTML = '<td>' + (g.date || (g.at || '').slice(0,10)) + '</td><td>' + (g.stories != null ? g.stories : '–') + '</td><td>' + usd + '</td><td>' + el + '</td>';
      gb.appendChild(tr);
    });
  }

  async function load(){
    document.getElementById('err').textContent = '';
    try {
      var res = await fetch('/api/admin/analytics?days=' + days, { headers: { 'x-admin-key': AKEY } });
      if (!res.ok) { document.getElementById('err').textContent = 'Error ' + res.status + ' — check ADMIN_KEY / migration'; return; }
      render(await res.json());
    } catch (e) {
      document.getElementById('err').textContent = 'Failed to load: ' + (e && e.message ? e.message : e);
    }
  }

  document.getElementById('seg').addEventListener('click', function(e){
    var b = e.target.closest('button'); if (!b) return;
    days = Number(b.getAttribute('data-d'));
    Array.prototype.forEach.call(this.querySelectorAll('button'), function(x){ x.classList.toggle('on', x === b); });
    load();
  });

  load();
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
          <label><input type="checkbox" name="gen-lang" value="ta"><span>TA</span></label>
          <label><input type="checkbox" name="gen-lang" value="mr"><span>MR</span></label>
        </div>

        <button class="btn-primary" id="gen-btn" onclick="runGenerate()">Generate now</button>
        <div id="gen-log" class="log-terminal"></div>
      </div>
      <div style="height:12px;"></div>
      <div class="group">
        <div class="gen-sub">Regenerate today's briefing, preserving existing language selection.</div>
        <button class="btn-primary" id="patch-btn" onclick="runPatch()">Refresh briefing</button>
        <div id="patch-log" class="log-terminal"></div>
      </div>
      <div style="height:12px;"></div>
      <div class="group">
        <div class="gen-sub">Re-generate scripts for stories with garbled text (e.g. &amp;nbsp; entities from older RSS fetches).</div>
        <button class="btn-primary" id="patch-scripts-btn" onclick="runPatchScripts()">Patch garbled scripts</button>
        <div id="patch-scripts-log" class="log-terminal"></div>
      </div>
      <div style="height:12px;"></div>
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
          <label><input type="checkbox" name="tts-patch-lang" value="ta"><span>TA</span></label>
          <label><input type="checkbox" name="tts-patch-lang" value="mr"><span>MR</span></label>
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
      { code: 'ta', label: 'TA', script: todayStats.taScript ?? 0, audio: todayStats.taAudio ?? 0 },
      { code: 'mr', label: 'MR', script: todayStats.mrScript ?? 0, audio: todayStats.mrAudio ?? 0 },
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
    } catch {
      list.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0;">Could not load status</div>';
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

  async function runPatch() {
    const btn = document.getElementById('patch-btn');
    const logEl = document.getElementById('patch-log');

    btn.disabled = true;
    btn.innerHTML = '<span class="spin">&#9696;</span> Patching…';
    logEl.innerHTML = '';
    logEl.classList.add('visible');
    startPolling();

    try {
      const r = await fetch('/api/admin/patch-missing', { method: 'POST', headers: { 'x-admin-key': AKEY } });
      if (r.status === 409) {
        appendPatchLog('log', 'Generation already in progress — check back in a few minutes.');
        btn.disabled = false; btn.textContent = 'Patch missing sections';
        return;
      }
      if (!r.ok || !r.body) {
        appendPatchLog('error', 'Request failed: HTTP ' + r.status);
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
              appendPatchLog('log', ev.msg);
            } else if (ev.type === 'done') {
              const added = ev.added?.length ? ev.added.join(', ') : 'none';
              appendPatchLog('done', 'Done — added: ' + added + ' · ' + ev.stories + ' stories total');
              loadStatus();
            } else if (ev.type === 'error') {
              appendPatchLog('error', ev.msg);
            }
          } catch {}
        }
      }
    } catch (err) {
      appendPatchLog('error', 'Network error: ' + (err.message || err));
    }

    btn.disabled = false;
    btn.textContent = 'Patch missing sections';
  }

  function appendPatchLog(type, msg) {
    const el = document.getElementById('patch-log');
    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const line = document.createElement('div');
    line.className = 'log-line' + (type !== 'log' ? ' log-' + type : '');
    line.textContent = ts + '  ' + msg;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
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

  async function runPatchScripts() {
    const btn = document.getElementById('patch-scripts-btn');
    const logEl = document.getElementById('patch-scripts-log');

    btn.disabled = true;
    btn.innerHTML = '<span class="spin">&#9696;</span> Patching scripts…';
    logEl.innerHTML = '';
    logEl.classList.add('visible');
    startPolling();

    try {
      const r = await fetch('/api/admin/patch-scripts', { method: 'POST', headers: { 'x-admin-key': AKEY } });
      if (r.status === 409) {
        appendScriptsLog('log', 'Generation already in progress — check back shortly.');
        btn.disabled = false; btn.textContent = 'Patch garbled scripts';
        return;
      }
      if (!r.ok || !r.body) {
        appendScriptsLog('error', 'Request failed: HTTP ' + r.status);
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
              appendScriptsLog('log', ev.msg);
            } else if (ev.type === 'done') {
              appendScriptsLog('done', 'Done — patched ' + ev.patched + ' scripts · ' + ev.stories + ' stories total');
              loadStatus();
            } else if (ev.type === 'error') {
              appendScriptsLog('error', ev.msg);
            }
          } catch {}
        }
      }
    } catch (err) {
      appendScriptsLog('error', 'Network error: ' + (err.message || err));
    }

    btn.disabled = false;
    btn.textContent = 'Patch garbled scripts';
  }

  function appendScriptsLog(type, msg) {
    const el = document.getElementById('patch-scripts-log');
    const ts = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const line = document.createElement('div');
    line.className = 'log-line' + (type !== 'log' ? ' log-' + type : '');
    line.textContent = ts + '  ' + msg;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
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
