/**
 * Raw HTTP handlers for admin and Q&A endpoints.
 * Mounted as request middleware in src/start.ts so they work without
 * needing routeTree.gen.ts to be updated.
 */
import { generateDailyBriefing, generateMissingSections, generateMissingTTS, patchScripts, getLatestBriefing as getTodayBriefing, type TtsProvider } from "@/lib/news/generator";
import { elevenLabsTTS, isQuotaExhausted, resetQuota } from "@/lib/tts/elevenlabs";
import { resetDailyQuota } from "@/lib/tts/google";
import { loadBriefingFromStorage } from "@/lib/supabase-storage";
import { requestAbort, resetAbort } from "@/lib/abort";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let generating = false;
let runningJob: string | null = null;

function authCheck(request: Request): Response | null {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return json({ error: "ADMIN_KEY not configured" }, 500);
  if (request.headers.get("x-admin-key") !== adminKey)
    return json({ error: "Unauthorized" }, 401);
  return null;
}

// Analytics is restricted to specific email(s) via Supabase login (not the admin key).
const ANALYTICS_EMAILS = (process.env.ANALYTICS_ADMIN_EMAILS ?? "manan190303@gmail.com")
  .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);

async function requireAnalyticsUser(request: Request): Promise<Response | null> {
  const authz = request.headers.get("authorization") || "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";
  if (!token) return json({ error: "Sign in required" }, 401);
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await (supabaseAdmin as any).auth.getUser(token);
    const email = String(data?.user?.email ?? "").toLowerCase();
    if (error || !email) return json({ error: "Invalid session" }, 401);
    if (!ANALYTICS_EMAILS.includes(email)) return json({ error: "Not authorized" }, 403);
    return null;
  } catch {
    return json({ error: "Auth check failed" }, 401);
  }
}

// Verify any valid Supabase user (not restricted to analytics emails).
async function requireSupabaseUser(request: Request): Promise<Response | null> {
  const authz = request.headers.get("authorization") || "";
  const token = authz.startsWith("Bearer ") ? authz.slice(7) : "";
  if (!token) return json({ error: "Sign in required" }, 401);
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await (supabaseAdmin as any).auth.getUser(token);
    if (error || !data?.user) return json({ error: "Invalid session" }, 401);
    return null;
  } catch {
    return json({ error: "Auth check failed" }, 401);
  }
}

// GET /api/briefing — returns today's DailyBriefing for authenticated users (Flutter + PWA).
export async function handleBriefing(request: Request): Promise<Response> {
  const err = await requireSupabaseUser(request);
  if (err) return err;
  const briefing = await getTodayBriefing();
  if (!briefing) return json({ error: "No briefing available yet" }, 404);
  return json(briefing);
}

// POST /api/admin/generate — streams SSE log events during generation
export async function handleGenerate(request: Request): Promise<Response> {
  const err = authCheck(request);
  if (err) return err;

  if (generating) return json({ error: "Already generating" }, 409);

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  const send = (data: object) => {
    try { writer.write(enc.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch {}
  };

  const reqUrl       = new URL(request.url, "http://localhost");
  const provider     = (reqUrl.searchParams.get("provider") ?? "edge") as TtsProvider;
  const languages    = (reqUrl.searchParams.get("languages") ?? "en,hi,ta,mr").split(",").map(l => l.trim()).filter(Boolean);
  const city         = reqUrl.searchParams.get("city")?.trim() || undefined;
  const scriptProvider = reqUrl.searchParams.get("scriptProvider");
  const scriptModel    = reqUrl.searchParams.get("scriptModel");
  const ttsModel       = reqUrl.searchParams.get("ttsModel");

  // Apply per-request model overrides via env vars (safe: generation is gated to one job at a time)
  if (scriptProvider) process.env.SCRIPT_PROVIDER   = scriptProvider;
  if (scriptModel)    process.env.OPENAI_SCRIPT_MODEL = scriptModel;
  if (ttsModel)       process.env.OPENAI_TTS_MODEL    = ttsModel;

  generating = true;
  runningJob = `generate:${provider}`;
  resetAbort();
  resetQuota();
  resetDailyQuota();
  // Fire-and-forget — don't await so we return the stream immediately
  (async () => {
    try {
      console.log(`[admin] generation triggered (provider: ${provider}, langs: ${languages.join(",")})`);
      const briefing = await generateDailyBriefing((msg) => send({ type: "log", msg }), city, provider, languages);
      const rs = briefing.runSummary;
      void logServerEvent("generation_run", {
        date:        briefing.date,
        provider,
        languages:   languages.join(","),
        stories:     briefing.stories.length,
        elapsedSec:  rs?.elapsedSec ?? 0,
        scriptSec:   rs?.scriptSec ?? 0,
        ttsSec:      rs?.ttsSec ?? 0,
        rawStories:  rs?.rawStories ?? 0,
        ttsChars:    rs?.tts.totalChars ?? 0,
        ttsEstUsd:   rs?.tts.estimatedUsd ?? 0,
      });
      send({
        type: "done",
        date:        briefing.date,
        stories:     briefing.stories.length,
        elapsedSec:  rs?.elapsedSec    ?? 0,
        clusterSec:  rs?.clusterSec   ?? 0,
        scriptSec:   rs?.scriptSec    ?? 0,
        ttsSec:      rs?.ttsSec       ?? 0,
        rawStories:  rs?.rawStories   ?? 0,
        selected:    rs?.selectedStories ?? 0,
        ttsChars:    rs?.tts.totalChars ?? 0,
        ttsEstUsd:   rs?.tts.estimatedUsd ?? 0,
        ttsProvider: rs?.tts.provider ?? provider,
      });
    } catch (err: any) {
      console.error("[admin] generation failed", err);
      send({ type: "error", msg: err?.message ?? "Generation failed" });
    } finally {
      generating = false;
      runningJob = null;
      try { writer.close(); } catch {}
    }
  })();

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",  // disable nginx/render buffering
    },
  });
}

// POST /api/admin/cron — fire-and-forget trigger for cron jobs (returns immediately)
export async function handleCron(request: Request): Promise<Response> {
  const err = authCheck(request);
  if (err) return err;

  if (generating) return json({ ok: false, message: "Already generating" });

  generating = true;
  runningJob = "cron";
  resetAbort();
  resetQuota();
  resetDailyQuota();
  generateDailyBriefing()
    .catch((err) => console.error("[cron] generation failed:", err?.message ?? err))
    .finally(() => { generating = false; runningJob = null; });

  return json({ ok: true, message: "Generation started" });
}

// GET /api/admin/status  — last 3 days' generation status + running job info
export async function handleStatus(request: Request): Promise<Response> {
  const err = authCheck(request);
  if (err) return err;

  const days: object[] = [];
  let todayStats: object | null = null;

  for (let i = 0; i < 3; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const date = d.toISOString().slice(0, 10);
    try {
      const briefing: any = await loadBriefingFromStorage(date);
      if (briefing) {
        const stories: any[] = briefing.stories ?? [];
        const sections = new Set(stories.map((s: any) => s.section)).size;
        const enScript = stories.filter((s: any) => s.scriptEn).length;
        const hiScript = stories.filter((s: any) => s.scriptHi).length;
        const taScript = stories.filter((s: any) => s.scriptTa).length;
        const mrScript = stories.filter((s: any) => s.scriptMr).length;
        const enAudio  = stories.filter((s: any) => s.audioUrlEn).length;
        const hiAudio  = stories.filter((s: any) => s.audioUrlHi).length;
        const taAudio  = stories.filter((s: any) => s.audioUrlTa).length;
        const mrAudio  = stories.filter((s: any) => s.audioUrlMr).length;

        const entry = {
          date,
          status: "generated",
          sections,
          totalTopics: stories.length,
          enScript,
          hiScript,
          taScript,
          mrScript,
          enAudio,
          hiAudio,
          taAudio,
          mrAudio,
          generatedLanguages: briefing.generatedLanguages ?? null,
          generatedAt: briefing.generatedAt ?? null,
        };
        days.push(entry);
        if (i === 0) todayStats = entry;
      } else {
        days.push({ date, status: "missing" });
      }
    } catch {
      days.push({ date, status: "error" });
    }
  }

  return json({
    days,
    running: generating,
    runningJob,
    todayStats,
    ttsQuotaExhausted: isQuotaExhausted(),
  });
}

// GET /api/admin/download?date=YYYY-MM-DD — proxy briefing JSON as a file download
export async function handleDownload(request: Request): Promise<Response> {
  const err = authCheck(request);
  if (err) return err;

  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return json({ error: "Invalid date — use YYYY-MM-DD" }, 400);

  try {
    const briefing = await loadBriefingFromStorage(date);
    if (!briefing) return json({ error: "Briefing not found for " + date }, 404);
    return new Response(JSON.stringify(briefing, null, 2), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="khabar-${date}.json"`,
      },
    });
  } catch (err: any) {
    return json({ error: err?.message ?? "Download failed" }, 500);
  }
}

// POST /api/admin/patch-missing — generate only sections absent from today's briefing
export async function handlePatchMissing(request: Request): Promise<Response> {
  const err = authCheck(request);
  if (err) return err;

  if (generating) return json({ error: "Already generating" }, 409);

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (data: object) => {
    try { writer.write(enc.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch {}
  };

  generating = true;
  runningJob = "patch-missing";
  resetAbort();
  resetQuota();
  (async () => {
    try {
      const { added, briefing } = await generateMissingSections((msg) => send({ type: "log", msg }));
      send({
        type: "done",
        added,
        stories: briefing.stories.length,
      });
    } catch (err: any) {
      send({ type: "error", msg: err?.message ?? "Patch failed" });
    } finally {
      generating = false;
      runningJob = null;
      try { writer.close(); } catch {}
    }
  })();

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}

// POST /api/admin/patch-tts — generate audio for stories that have scripts but no audio
export async function handlePatchTTS(request: Request): Promise<Response> {
  const err = authCheck(request);
  if (err) return err;

  if (generating) return json({ error: "Already generating" }, 409);

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (data: object) => {
    try { writer.write(enc.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch {}
  };

  const patchReqUrl   = new URL(request.url, "http://localhost");
  const patchProvider = (patchReqUrl.searchParams.get("provider") ?? "google") as TtsProvider;
  const patchTtsModel = patchReqUrl.searchParams.get("ttsModel");
  const patchLangs    = (patchReqUrl.searchParams.get("languages") ?? "en,hi").split(",").map(l => l.trim()).filter(Boolean);
  if (patchTtsModel) process.env.OPENAI_TTS_MODEL = patchTtsModel;

  generating = true;
  runningJob = `patch-tts:${patchProvider}`;
  resetAbort();
  resetQuota();
  resetDailyQuota();
  (async () => {
    try {
      const { patched, briefing } = await generateMissingTTS((msg) => send({ type: "log", msg }), patchProvider, patchLangs);
      send({ type: "done", patched, stories: briefing.stories.length });
    } catch (err: any) {
      send({ type: "error", msg: err?.message ?? "TTS patch failed" });
    } finally {
      generating = false;
      runningJob = null;
      try { writer.close(); } catch {}
    }
  })();

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}

// POST /api/admin/patch-scripts — re-generate scripts for garbled stories
export async function handlePatchScripts(request: Request): Promise<Response> {
  const err = authCheck(request);
  if (err) return err;

  if (generating) return json({ error: "Already generating" }, 409);

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  const send = (data: object) => {
    try { writer.write(enc.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch {}
  };

  generating = true;
  runningJob = "patch-scripts";
  resetAbort();
  (async () => {
    try {
      const { patched, briefing } = await patchScripts((msg) => send({ type: "log", msg }));
      send({ type: "done", patched, stories: briefing.stories.length });
    } catch (err: any) {
      send({ type: "error", msg: err?.message ?? "Script patch failed" });
    } finally {
      generating = false;
      runningJob = null;
      try { writer.close(); } catch {}
    }
  })();

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}

// POST /api/admin/stop — request abort of running job
export async function handleStop(request: Request): Promise<Response> {
  const err = authCheck(request);
  if (err) return err;

  if (!generating) return json({ ok: false, message: "No job running" });
  requestAbort();
  return json({ ok: true, message: `Stop requested for: ${runningJob}` });
}

// POST /api/ask  { question: string }
export async function handleAsk(request: Request): Promise<Response> {
  try {
    const body = await request.json().catch(() => ({}));
    const question = typeof body?.question === "string" ? body.question.trim() : "";
    if (!question) return json({ error: "question is required" }, 400);

    const briefing = await getTodayBriefing();
    if (!briefing?.stories?.length)
      return json({ error: "No briefing available for today" }, 404);

    const combinedScript = briefing.stories.map((s) => s.scriptEn).filter(Boolean).join("\n\n");
    const answerText = await answerQuestion(question, combinedScript);
    const audioUrl = await textToSpeech(answerText);
    return json({ audioUrl, answerText });
  } catch (err: any) {
    console.error("[ask]", err);
    return json({ error: err?.message ?? "Failed" }, 500);
  }
}

// ── Analytics ingestion ──────────────────────────────────────────────────────

/** Insert a single analytics event (server-side, service role — clients can't forge). */
async function insertEvent(row: Record<string, unknown>): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await (supabaseAdmin as any).from("analytics_events").insert(row);
  if (error) console.error("[track] insert failed:", error.message);
}

/** Fire a server-originated analytics event (e.g. generation_run). Never throws. */
export async function logServerEvent(event: string, props: Record<string, unknown> = {}): Promise<void> {
  try {
    await insertEvent({
      event: event.slice(0, 120),
      user_id: null,
      platform: "server",
      props,
      occurred_at: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error("[track] server event failed:", err?.message ?? err);
  }
}

// POST /api/track — client analytics ingestion. Best-effort; never fails the UX.
export async function handleTrack(request: Request): Promise<Response> {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body.event !== "string" || !body.event) {
      return json({ error: "event required" }, 400);
    }
    const props = (body.props && typeof body.props === "object") ? body.props : {};
    await insertEvent({
      event:       String(body.event).slice(0, 120),
      user_id:     typeof body.userId === "string" && body.userId ? body.userId : null,
      platform:    typeof props.platform === "string" ? props.platform : null,
      language:    typeof props.language === "string" ? props.language : null,
      app_version: typeof props.appVersion === "string" ? props.appVersion : null,
      props,
      occurred_at: typeof body.ts === "string" ? body.ts : new Date().toISOString(),
    });
    return new Response(null, { status: 204 });
  } catch (err: any) {
    console.error("[track]", err?.message ?? err);
    return json({ ok: false }, 200); // swallow — analytics must never break the app
  }
}

// GET /api/admin/analytics?days=30 — aggregates from analytics_events for the dashboard
export async function handleAnalytics(request: Request): Promise<Response> {
  const err = await requireAnalyticsUser(request);
  if (err) return err;
  try {
    const url  = new URL(request.url, "http://localhost");
    const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 30), 1), 90);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await (supabaseAdmin as any)
      .from("analytics_events")
      .select("event,user_id,occurred_at,props")
      .gte("occurred_at", since)
      .order("occurred_at", { ascending: false })
      .limit(50000);
    if (error) return json({ error: error.message }, 500);

    const rows: any[] = data ?? [];

    // Users seen BEFORE this window — so "new users" in range excludes anyone
    // who already existed. Only user_id is pulled (cheap).
    const preExisting = new Set<string>();
    try {
      const { data: prior } = await (supabaseAdmin as any)
        .from("analytics_events")
        .select("user_id")
        .lt("occurred_at", since)
        .not("user_id", "is", null)
        .limit(50000);
      for (const r of (prior ?? [])) if (r.user_id) preExisting.add(r.user_id);
    } catch { /* best-effort; new-user counts may be slightly high without it */ }

    // Simple model: app_open = a visit; story_start = a story played; heartbeat =
    // HEARTBEAT_SEC seconds of activity (tagged playing/visible). Everything below
    // is just sums of those — minutes on app, minutes listened, time per story.
    const day = (iso: string) => istDay(iso);
    const dayMap = new Map<string, { users: Set<string>; appSec: number; listenSec: number; stories: number }>();
    const userMap = new Map<string, { appSec: number; listenSec: number; stories: number; days: Set<string>; last: string }>();
    const storyListenSec = new Map<string, number>();
    const hourly = new Array(24).fill(0);      // listen-seconds by hour-of-day (IST)
    let totalAppSec = 0, totalListenSec = 0, totalStories = 0;

    const IST_MS = 5.5 * 3_600_000;
    const istDay  = (iso: string) => new Date(new Date(iso).getTime() + IST_MS).toISOString().slice(0, 10);
    const istHour = (iso: string) => new Date(new Date(iso).getTime() + IST_MS).getUTCHours();
    const prevDay = (k: string) => new Date(new Date(k + "T00:00:00Z").getTime() - 86_400_000).toISOString().slice(0, 10);

    const dayRec = (k: string) => {
      let d = dayMap.get(k);
      if (!d) { d = { users: new Set(), appSec: 0, listenSec: 0, stories: 0 }; dayMap.set(k, d); }
      return d;
    };
    const userRec = (id: string) => {
      let u = userMap.get(id);
      if (!u) { u = { appSec: 0, listenSec: 0, stories: 0, days: new Set(), last: "" }; userMap.set(id, u); }
      return u;
    };

    for (const r of rows) {
      const k = day(r.occurred_at);
      const d = dayRec(k);
      const p = r.props || {};
      const uid = r.user_id as string | null;
      if (uid) { d.users.add(uid); const u = userRec(uid); u.days.add(k); if (r.occurred_at > u.last) u.last = r.occurred_at; }

      if (r.event === "heartbeat") {
        const sec = Number(p.seconds) || 20;
        if (p.visible !== false) { d.appSec += sec; totalAppSec += sec; if (uid) userRec(uid).appSec += sec; }
        if (p.playing === true) {
          d.listenSec += sec; totalListenSec += sec;
          hourly[istHour(r.occurred_at)] += sec;
          if (uid) userRec(uid).listenSec += sec;
          if (p.storyId) storyListenSec.set(String(p.storyId), (storyListenSec.get(String(p.storyId)) ?? 0) + sec);
        }
      } else if (r.event === "story_start") {
        d.stories++; totalStories++; if (uid) userRec(uid).stories++;
      }
    }

    // Depth: how many minutes each day's briefing actually contained, so we can show
    // "% of the briefing you finished". Fetch only days with listening (bounded).
    const activeDays = [...dayMap.keys()].filter((k) => (dayMap.get(k)!.listenSec) > 0);
    const availMinByDay = new Map<string, number>();
    await Promise.all(activeDays.map(async (k) => {
      try {
        const { data: file } = await (supabaseAdmin as any).storage.from("khabar").download(`briefings/${k}.json`);
        if (!file) return;
        const b = JSON.parse(await file.text());
        let sec = Number(b?.meta?.estimatedDurationSec) || 0;
        if (!sec && Array.isArray(b?.stories)) sec = b.stories.reduce((n: number, s: any) => n + ((Number(s.wordCount) || 115) / 150) * 60, 0);
        if (sec > 0) availMinByDay.set(k, sec / 60);
      } catch { /* no briefing for that day → completion unknown */ }
    }));

    const perDay = [...dayMap.keys()].sort().map((k) => {
      const d = dayMap.get(k)!;
      const listenMin = +(d.listenSec / 60).toFixed(1);
      const availMin  = availMinByDay.get(k);
      const completionPct = availMin && availMin > 0 ? Math.min(100, Math.round((listenMin / availMin) * 100)) : null;
      return { day: k, users: d.users.size, appMin: +(d.appSec / 60).toFixed(1), listenMin, stories: d.stories, availMin: availMin ? +availMin.toFixed(1) : null, completionPct };
    });

    // Habit: current listening streak (consecutive days up to today, IST) + days listened.
    const listenedSet = new Set(perDay.filter((d) => d.listenMin > 0).map((d) => d.day));
    const todayIST = istDay(new Date().toISOString());
    let streak = 0;
    let cursor = listenedSet.has(todayIST) ? todayIST : prevDay(todayIST); // today optional so an unlistened today doesn't zero the streak mid-day
    while (listenedSet.has(cursor)) { streak++; cursor = prevDay(cursor); }
    const daysListened = listenedSet.size;
    const completions = perDay.map((d) => d.completionPct).filter((v): v is number => v != null);
    const avgCompletionPct = completions.length ? Math.round(completions.reduce((a, b) => a + b, 0) / completions.length) : null;

    // ── Multi-user: engagement, growth, retention ──────────────────────────────
    const allDays = [...dayMap.keys()].sort();
    const maxDay  = allDays[allDays.length - 1] ?? todayIST;
    const dayPlus = (k: string, n: number) => new Date(new Date(k + "T00:00:00Z").getTime() + n * 86_400_000).toISOString().slice(0, 10);

    // First active day per user (within window)
    const userFirstDay = new Map<string, string>();
    for (const [id, u] of userMap) {
      const ds = [...u.days].sort();
      if (ds.length) userFirstDay.set(id, ds[0]);
    }
    const isNew = (id: string) => !preExisting.has(id);   // first-ever activity is in-window

    // New vs returning + cumulative user base, per day
    let cumNew = 0;
    const perDayGrowth = allDays.map((k) => {
      const d = dayMap.get(k)!;
      let newUsers = 0, returning = 0;
      for (const id of d.users) {
        if (isNew(id) && userFirstDay.get(id) === k) newUsers++;
        else returning++;
      }
      cumNew += newUsers;
      return { day: k, dau: d.users.size, newUsers, returning, cumUsers: cumNew };
    });

    // DAU (latest day) / WAU (rolling 7) / MAU (rolling 30) + stickiness
    const activeInLastNDays = (n: number) => {
      const cutoff = dayPlus(maxDay, -(n - 1));
      const set = new Set<string>();
      for (const [id, u] of userMap) { for (const dd of u.days) if (dd >= cutoff) { set.add(id); break; } }
      return set.size;
    };
    const dau = dayMap.get(maxDay)?.users.size ?? 0;
    const wau = activeInLastNDays(7);
    const mau = activeInLastNDays(30);
    const stickiness = wau ? Math.round((dau / wau) * 100) : 0;

    const totalUsers = userMap.size;                              // distinct active in window
    const newUsersInRange = [...userMap.keys()].filter(isNew).length;

    // Retention among NEW users (their first-ever activity landed in this window)
    let d1Elig = 0, d1Ret = 0, d7Elig = 0, d7Ret = 0;
    for (const [id, u] of userMap) {
      if (!isNew(id)) continue;
      const f = userFirstDay.get(id)!;
      if (dayPlus(f, 1) <= maxDay) { d1Elig++; if (u.days.has(dayPlus(f, 1))) d1Ret++; }
      if (dayPlus(f, 7) <= maxDay) {
        d7Elig++;
        for (let n = 1; n <= 7; n++) if (u.days.has(dayPlus(f, n))) { d7Ret++; break; }
      }
    }
    const d1Pct = d1Elig ? Math.round((d1Ret / d1Elig) * 100) : null;
    const d7Pct = d7Elig ? Math.round((d7Ret / d7Elig) * 100) : null;

    const avgMinPerActiveUser = totalUsers ? +((totalListenSec / 60) / totalUsers).toFixed(1) : 0;

    // user_id → email so the admin sees who's who
    const emailById = new Map<string, string>();
    try {
      const { data: list } = await (supabaseAdmin as any).auth.admin.listUsers({ page: 1, perPage: 1000 });
      for (const u of (list?.users ?? [])) emailById.set(u.id, u.email ?? u.id);
    } catch { /* fall back to ids */ }

    const users = [...userMap.entries()]
      .map(([id, u]) => ({
        email: emailById.get(id) ?? id,
        appMin: Math.round(u.appSec / 60),
        listenMin: Math.round(u.listenSec / 60),
        stories: u.stories,
        daysActive: u.days.size,
        lastActive: u.last,
      }))
      .sort((a, b) => b.listenMin - a.listenMin)
      .slice(0, 50);

    return json({
      days,
      perDay,
      perDayGrowth,
      hourly,
      // Engagement
      dau, wau, mau, stickiness,
      // Growth
      totalUsers,
      newUsers: newUsersInRange,
      // Retention (new-user cohort)
      d1Pct, d7Pct, d1Elig, d7Elig,
      // Usage volume
      minutesListened: Math.round(totalListenSec / 60),
      storiesPlayed:   totalStories,
      avgCompletionPct,
      avgMinPerActiveUser,
      timeOnAppMin:    Math.round(totalAppSec / 60),
      avgSecPerStory:  totalStories ? Math.round(totalListenSec / totalStories) : 0,
      // Kept for compatibility
      streak,
      daysListened,
      activeUsers: totalUsers,
      avgMinPerDay:    daysListened ? +((totalListenSec / 60) / daysListened).toFixed(1) : 0,
      avgMinPerUser:   totalUsers ? +((totalAppSec / 60) / totalUsers).toFixed(1) : 0,
      totalEvents: rows.length,
      heartbeats:  rows.filter((r: any) => r.event === "heartbeat").length,
      users,
    });
  } catch (e: any) {
    return json({ error: e?.message ?? "analytics failed" }, 500);
  }
}

// ── Gemini Q&A (search grounding + briefing context) ─────────────────────────

async function answerQuestion(question: string, script: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");

  // Include briefing as context in the user turn (not system instruction —
  // can't use systemInstruction together with google_search tool).
  const prompt = [
    script
      ? `You have the following context from today's Khabar AI news briefing:\n\n${script}\n\n---\n\n`
      : "",
    `A listener asks: "${question}"\n\n`,
    `Answer as Khabar AI — warm, clear, 2–4 sentences. `,
    `Use the briefing context above if relevant. `,
    `If the question goes beyond the briefing, search the web for current information. `,
    `Never say you cannot search — just answer.`,
  ].join("");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        tools: [{ google_search: {} }],
        generationConfig: { maxOutputTokens: 300 },
      }),
    },
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts
    ?.filter((p: any) => p.text)
    ?.map((p: any) => p.text)
    ?.join("") ?? "I couldn't find an answer to that.";
  return text.trim();
}

async function textToSpeech(text: string): Promise<string> {
  const { url } = await elevenLabsTTS(text, `answer-${Date.now()}`);
  return url;
}
