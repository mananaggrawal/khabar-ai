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
  const languages    = (reqUrl.searchParams.get("languages") ?? "en").split(",").map(l => l.trim()).filter(Boolean);
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
  const err = authCheck(request);
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
    const dayMap = new Map<string, { events: number; users: Set<string>; plays: number; starts: number; completes: number }>();
    const eventCounts: Record<string, number> = {};
    const sectionCounts: Record<string, number> = {};
    const storyCounts: Record<string, number> = {};
    const userMap = new Map<string, { events: number; plays: number; completes: number; last: string }>();
    let durSum = 0, durN = 0;
    const generationRuns: any[] = [];

    for (const r of rows) {
      const day = String(r.occurred_at).slice(0, 10);
      let d = dayMap.get(day);
      if (!d) { d = { events: 0, users: new Set(), plays: 0, starts: 0, completes: 0 }; dayMap.set(day, d); }
      d.events++;
      if (r.user_id) {
        d.users.add(r.user_id);
        let u = userMap.get(r.user_id);
        if (!u) { u = { events: 0, plays: 0, completes: 0, last: r.occurred_at }; userMap.set(r.user_id, u); }
        u.events++;
        if (r.event === "play") u.plays++;
        if (r.event === "story_complete") u.completes++;
        if (r.occurred_at > u.last) u.last = r.occurred_at;
      }
      eventCounts[r.event] = (eventCounts[r.event] || 0) + 1;
      const p = r.props || {};
      if (r.event === "play") d.plays++;
      if (r.event === "story_start") {
        d.starts++;
        if (p.section) sectionCounts[p.section] = (sectionCounts[p.section] || 0) + 1;
        if (p.storyId) storyCounts[p.storyId] = (storyCounts[p.storyId] || 0) + 1;
      }
      if (r.event === "story_complete") {
        d.completes++;
        const ds = Number(p.durationSec);
        if (ds > 0) { durSum += ds; durN++; }
      }
      if (r.event === "generation_run" && generationRuns.length < 10) generationRuns.push({ ...p, at: r.occurred_at });
    }

    const perDay = [...dayMap.keys()].sort().map((day) => {
      const d = dayMap.get(day)!;
      return { day, events: d.events, users: d.users.size, plays: d.plays, starts: d.starts, completes: d.completes };
    });
    const starts    = eventCounts["story_start"] || 0;
    const completes = eventCounts["story_complete"] || 0;

    // Map user ids → email (service role can read auth.users) so the admin sees who's who
    const emailById = new Map<string, string>();
    try {
      const { data: list } = await (supabaseAdmin as any).auth.admin.listUsers({ page: 1, perPage: 1000 });
      for (const u of (list?.users ?? [])) emailById.set(u.id, u.email ?? u.id);
    } catch { /* fall back to ids */ }

    const users = [...userMap.entries()]
      .map(([id, u]) => ({ email: emailById.get(id) ?? id, events: u.events, plays: u.plays, completes: u.completes, lastActive: u.last }))
      .sort((a, b) => b.events - a.events)
      .slice(0, 50);

    return json({
      days,
      totalEvents: rows.length,
      perDay,
      eventCounts,
      sections: Object.entries(sectionCounts).map(([section, count]) => ({ section, count })).sort((a, b) => b.count - a.count),
      topStories: Object.entries(storyCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([storyId, count]) => ({ storyId, count })),
      funnel: {
        app_open:        eventCounts["app_open"] || 0,
        briefing_loaded: eventCounts["briefing_loaded"] || 0,
        play:            eventCounts["play"] || 0,
        story_complete:  completes,
      },
      completionRate: starts ? +((completes / starts) * 100).toFixed(1) : 0,
      avgStorySec:    durN ? Math.round(durSum / durN) : 0,
      users,
      totalUsers: userMap.size,
      generationRuns,
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
