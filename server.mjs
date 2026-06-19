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
    res.end(adminPage(
      process.env.VITE_SUPABASE_URL || "",
      process.env.VITE_SUPABASE_PUBLISHABLE_KEY || "",
    ));
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

function adminPage(supabaseUrl, supabaseKey) {
  const ALLOWED_EMAIL = "manan190303@gmail.com";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Khabar AI — Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #0f0f0f; color: #e5e5e5; min-height: 100vh; }
    .center { display: flex; flex-direction: column; align-items: center;
              justify-content: center; min-height: 100vh; gap: 16px; }
    .page { padding: 24px; max-width: 600px; margin: 0 auto; }
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
    .btn { background: #2563eb; color: #fff; border: none; padding: 10px 20px;
           border-radius: 8px; font-size: 0.9rem; cursor: pointer; display: inline-flex;
           align-items: center; gap: 8px; }
    .btn:hover { background: #1d4ed8; }
    .btn:disabled { background: #374151; color: #6b7280; cursor: not-allowed; }
    .btn.google { background: #fff; color: #111; font-weight: 500; }
    .btn.google:hover { background: #f3f3f3; }
    .btn.sm { padding: 6px 14px; font-size: 0.8rem; background: #374151; }
    .btn.sm:hover { background: #4b5563; }
    #gen-result { margin-top: 12px; font-size: 0.85rem; color: #4ade80; }
    .user-row { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; }
    .avatar { width: 32px; height: 32px; border-radius: 50%; }
    .user-email { font-size: 0.85rem; color: #888; flex: 1; }
  </style>
</head>
<body>

<!-- Login screen -->
<div class="center" id="login-screen">
  <div style="font-size:2rem">📰</div>
  <div style="font-size:1.2rem;font-weight:600">Khabar AI Admin</div>
  <div style="color:#888;font-size:0.85rem">Sign in with your Google account</div>
  <button class="btn google" onclick="signIn()">
    <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
    Sign in with Google
  </button>
  <div id="login-error" style="color:#ef4444;font-size:0.82rem;display:none"></div>
</div>

<!-- Denied screen -->
<div class="center" id="denied-screen" style="display:none">
  <div style="font-size:2rem">🚫</div>
  <div style="font-weight:600">Access Denied</div>
  <div style="color:#888;font-size:0.85rem">This account is not authorised.</div>
  <button class="btn sm" onclick="signOut()">Sign out</button>
</div>

<!-- Admin dashboard -->
<div id="admin-screen" style="display:none">
  <div class="page">
    <div class="user-row">
      <img id="avatar" class="avatar" src="" style="display:none" />
      <span id="user-email" class="user-email"></span>
      <button class="btn sm" onclick="signOut()">Sign out</button>
    </div>
    <h1>📰 Khabar AI Admin</h1>
    <p class="sub">Daily briefing status &amp; generation console</p>

    <div id="status-area"><p style="color:#888">Loading status…</p></div>

    <div class="card" style="margin-top:8px">
      <div style="font-weight:600;margin-bottom:8px">Generate Today's Briefing</div>
      <div class="meta" style="margin-bottom:12px">Takes 3–5 minutes. Do not close this tab.</div>
      <button class="btn" id="generate-btn" onclick="runGenerate()">▶ Generate Now</button>
      <div id="gen-result"></div>
    </div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js"></script>
<script>
  const SUPABASE_URL = ${JSON.stringify(supabaseUrl)};
  const SUPABASE_KEY = ${JSON.stringify(supabaseKey)};
  const ALLOWED_EMAIL = ${JSON.stringify(ALLOWED_EMAIL)};
  const ADMIN_KEY = ${JSON.stringify(process.env.ADMIN_KEY || "")};

  const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  async function init() {
    // Handle OAuth callback hash
    const { data: { session } } = await sb.auth.getSession();
    showFor(session);

    sb.auth.onAuthStateChange((_e, session) => showFor(session));
  }

  function showFor(session) {
    if (!session) {
      show('login-screen');
      return;
    }
    const email = session.user?.email || '';
    if (email !== ALLOWED_EMAIL) {
      show('denied-screen');
      return;
    }
    // Authorised
    document.getElementById('user-email').textContent = email;
    const avatar = session.user?.user_metadata?.avatar_url;
    if (avatar) {
      const img = document.getElementById('avatar');
      img.src = avatar; img.style.display = 'block';
    }
    show('admin-screen');
    loadStatus();
  }

  function show(id) {
    ['login-screen','denied-screen','admin-screen'].forEach(s => {
      document.getElementById(s).style.display = s === id ? (id === 'admin-screen' ? 'block' : 'flex') : 'none';
    });
  }

  async function signIn() {
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.href }
    });
    if (error) {
      const el = document.getElementById('login-error');
      el.textContent = error.message; el.style.display = 'block';
    }
  }

  async function signOut() {
    await sb.auth.signOut();
    show('login-screen');
  }

  async function loadStatus() {
    const area = document.getElementById('status-area');
    try {
      const r = await fetch('/api/admin/status', { headers: { 'x-admin-key': ADMIN_KEY } });
      const data = await r.json();
      if (!r.ok) { area.innerHTML = '<p style="color:#ef4444">' + (data.error || 'Error') + '</p>'; return; }
      renderStatus(data.days);
    } catch(e) {
      area.innerHTML = '<p style="color:#ef4444">Could not load status</p>';
    }
  }

  function renderStatus(days) {
    const today = new Date().toISOString().slice(0,10);
    const html = days.map(d => {
      const isToday = d.date === today;
      const bc = d.status === 'generated' ? 'generated' : d.status === 'missing' ? 'missing' : 'error';
      const bt = d.status === 'generated' ? '✓ Generated' : d.status === 'missing' ? '✗ Missing' : '! Error';
      const meta = d.status === 'generated'
        ? d.sections + ' sections · ' + d.totalTopics + ' topics' + (d.generatedAt ? ' · ' + new Date(d.generatedAt).toLocaleTimeString() : '')
        : '';
      return '<div class="card"><div class="row">'
        + '<span class="date">' + d.date + '</span>'
        + (isToday ? '<span class="today-tag">TODAY</span>' : '')
        + '<span class="badge ' + bc + '">' + bt + '</span>'
        + '</div>' + (meta ? '<div class="meta">' + meta + '</div>' : '') + '</div>';
    }).join('');
    document.getElementById('status-area').innerHTML = html;
  }

  async function runGenerate() {
    const btn = document.getElementById('generate-btn');
    const result = document.getElementById('gen-result');
    btn.disabled = true; btn.textContent = '⏳ Generating… (3–5 min)';
    result.style.color = '#4ade80'; result.textContent = '';
    try {
      const r = await fetch('/api/admin/generate', { method: 'POST', headers: { 'x-admin-key': ADMIN_KEY } });
      const data = await r.json();
      if (r.ok) {
        result.textContent = '✓ Done — ' + data.sections + ' sections, ' + data.totalTopics + ' topics for ' + data.date;
        loadStatus();
      } else {
        result.style.color = '#ef4444';
        result.textContent = '✗ ' + (data.error || 'Generation failed');
      }
    } catch(e) {
      result.style.color = '#ef4444'; result.textContent = '✗ Network error';
    }
    btn.disabled = false; btn.textContent = '▶ Generate Now';
  }

  init();
</script>
</body>
</html>`;
}
