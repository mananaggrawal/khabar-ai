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
const { handleGenerate, handleAsk, handleStatus, handleDownload, handleCron } = await import(API_BUNDLE);

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
  const adminKey = process.env.ADMIN_KEY || "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Khabar AI</title>
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
      <div class="group" style="padding:0 20px;">
        <div id="days-list" style="padding:20px 0;"></div>
      </div>
      <div style="height:16px;"></div>
      <div class="group">
        <div class="gen-sub">Regenerate today's briefing if missing or outdated.</div>
        <button class="btn-primary" id="gen-btn" onclick="runGenerate()">Generate now</button>
        <div id="gen-log" class="log-terminal"></div>
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
        meta.textContent = day.sections + ' sections · ' + day.totalTopics + ' topics'
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

  async function loadStatus() {
    const list = document.getElementById('days-list');
    list.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0;">Checking…</div>';
    try {
      const r = await fetch('/api/admin/status', { headers: { 'x-admin-key': AKEY } });
      const d = await r.json();
      renderDays(d.days || []);
    } catch {
      list.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0;">Could not load status</div>';
    }
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

    try {
      const r = await fetch('/api/admin/generate', { method: 'POST', headers: { 'x-admin-key': AKEY } });
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
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data: ')) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            if (ev.type === 'log') {
              appendLog('log', ev.msg);
            } else if (ev.type === 'done') {
              appendLog('done', 'Done — ' + ev.sections + ' sections, ' + ev.totalTopics + ' topics');
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

  init();
</script>
</body>
</html>`;
}
