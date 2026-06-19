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
const { handleGenerate, handleAsk, handleStatus } = await import(API_BUNDLE);

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
  const isStatic =
    pathname.startsWith("/assets/") ||
    pathname === "/favicon.ico" ||
    pathname === "/favicon.svg" ||
    pathname === "/favicon.png" ||
    pathname === "/icon-192.png" ||
    pathname === "/icon-512.png" ||
    pathname === "/apple-touch-icon.png" ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/robots.txt" ||
    pathname === "/site.webmanifest";

  if (isStatic) {
    const filePath = join(CLIENT_DIR, pathname);
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      const mime = MIME[extname(filePath)] || "application/octet-stream";
      res.setHeader("Content-Type", mime);
      res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
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
    res.end(adminPage());
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

function adminPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Khabar AI — Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #0f0f0f; color: #e5e5e5; padding: 24px; }
    h1 { font-size: 1.4rem; font-weight: 600; margin-bottom: 4px; }
    .sub { color: #888; font-size: 0.85rem; margin-bottom: 24px; }
    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px;
            padding: 20px; margin-bottom: 16px; }
    .row { display: flex; align-items: center; gap: 12px; margin-bottom: 10px; }
    .badge { padding: 3px 10px; border-radius: 20px; font-size: 0.75rem; font-weight: 600; }
    .badge.generated { background: #14532d; color: #4ade80; }
    .badge.missing { background: #431407; color: #fb923c; }
    .badge.error { background: #3b0764; color: #c084fc; }
    .date { font-weight: 600; font-size: 0.95rem; min-width: 100px; }
    .meta { color: #888; font-size: 0.82rem; }
    .today-tag { background: #1e3a5f; color: #60a5fa; padding: 2px 8px;
                 border-radius: 20px; font-size: 0.72rem; }
    button { background: #2563eb; color: #fff; border: none; padding: 10px 20px;
             border-radius: 8px; font-size: 0.9rem; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    button:disabled { background: #374151; color: #6b7280; cursor: not-allowed; }
    #key-form { display: flex; gap: 10px; margin-bottom: 24px; }
    input { background: #1a1a1a; border: 1px solid #2a2a2a; color: #e5e5e5;
            padding: 10px 14px; border-radius: 8px; font-size: 0.9rem; flex: 1; }
    #status-msg { color: #888; font-size: 0.85rem; margin-top: 8px; }
    #generate-btn { margin-top: 4px; }
    #gen-result { margin-top: 12px; font-size: 0.85rem; color: #4ade80; }
  </style>
</head>
<body>
  <h1>📰 Khabar AI Admin</h1>
  <p class="sub">Daily briefing status &amp; generation console</p>

  <div id="key-form">
    <input type="password" id="admin-key" placeholder="Admin key" />
    <button onclick="loadStatus()">Load Status</button>
  </div>

  <div id="status-area"></div>

  <div class="card" id="generate-card" style="display:none">
    <div style="font-weight:600;margin-bottom:8px">Generate Today's Briefing</div>
    <div class="meta" style="margin-bottom:12px">Takes 3–5 minutes. Do not close this tab.</div>
    <button id="generate-btn" onclick="runGenerate()">▶ Generate Now</button>
    <div id="gen-result"></div>
  </div>

  <script>
    function key() { return document.getElementById('admin-key').value.trim(); }

    async function loadStatus() {
      const k = key();
      if (!k) return;
      const area = document.getElementById('status-area');
      area.innerHTML = '<p style="color:#888">Loading…</p>';
      try {
        const r = await fetch('/api/admin/status', { headers: { 'x-admin-key': k } });
        const data = await r.json();
        if (!r.ok) { area.innerHTML = '<p style="color:#ef4444">' + (data.error || 'Error') + '</p>'; return; }
        renderStatus(data.days);
        document.getElementById('generate-card').style.display = 'block';
      } catch(e) {
        area.innerHTML = '<p style="color:#ef4444">Network error</p>';
      }
    }

    function renderStatus(days) {
      const today = new Date().toISOString().slice(0,10);
      const html = days.map((d, i) => {
        const isToday = d.date === today;
        const badgeClass = d.status === 'generated' ? 'generated' : d.status === 'missing' ? 'missing' : 'error';
        const badgeText = d.status === 'generated' ? '✓ Generated' : d.status === 'missing' ? '✗ Missing' : '! Error';
        const meta = d.status === 'generated'
          ? \`\${d.sections} sections · \${d.totalTopics} topics\${d.generatedAt ? ' · ' + new Date(d.generatedAt).toLocaleTimeString() : ''}\`
          : '';
        return \`<div class="card">
          <div class="row">
            <span class="date">\${d.date}</span>
            \${isToday ? '<span class="today-tag">TODAY</span>' : ''}
            <span class="badge \${badgeClass}">\${badgeText}</span>
          </div>
          \${meta ? '<div class="meta">' + meta + '</div>' : ''}
        </div>\`;
      }).join('');
      document.getElementById('status-area').innerHTML = html;
    }

    async function runGenerate() {
      const k = key();
      if (!k) return;
      const btn = document.getElementById('generate-btn');
      const result = document.getElementById('gen-result');
      btn.disabled = true;
      btn.textContent = '⏳ Generating… (3–5 min)';
      result.textContent = '';
      try {
        const r = await fetch('/api/admin/generate', {
          method: 'POST',
          headers: { 'x-admin-key': k }
        });
        const data = await r.json();
        if (r.ok) {
          result.textContent = '✓ Done — ' + data.sections + ' sections, ' + data.totalTopics + ' topics for ' + data.date;
          loadStatus();
        } else {
          result.style.color = '#ef4444';
          result.textContent = '✗ ' + (data.error || 'Generation failed');
        }
      } catch(e) {
        result.style.color = '#ef4444';
        result.textContent = '✗ Network error';
      }
      btn.disabled = false;
      btn.textContent = '▶ Generate Now';
    }

    document.getElementById('admin-key').addEventListener('keydown', e => {
      if (e.key === 'Enter') loadStatus();
    });
  </script>
</body>
</html>`;
}
