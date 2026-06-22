/**
 * Raw HTTP handlers for admin and Q&A endpoints.
 * Mounted as request middleware in src/start.ts so they work without
 * needing routeTree.gen.ts to be updated.
 */
import { generateDailyBriefing, generateMissingSections, generateMissingTTS, getLatestBriefing as getTodayBriefing, type TtsProvider } from "@/lib/news/generator";
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

  const reqUrl  = new URL(request.url, "http://localhost");
  const provider = (reqUrl.searchParams.get("provider") ?? "google") as TtsProvider;
  const languages = (reqUrl.searchParams.get("languages") ?? "en,hi").split(",").map(l => l.trim()).filter(Boolean);

  generating = true;
  runningJob = `generate:${provider}`;
  resetAbort();
  resetQuota();
  resetDailyQuota();
  // Fire-and-forget — don't await so we return the stream immediately
  (async () => {
    try {
      console.log(`[admin] generation triggered (provider: ${provider}, langs: ${languages.join(",")})`);
      const briefing = await generateDailyBriefing((msg) => send({ type: "log", msg }), undefined, provider, languages);
      const rs = briefing.runSummary;
      send({
        type: "done",
        date:        briefing.date,
        stories:     briefing.stories.length,
        elapsedSec:  rs?.elapsedSec   ?? 0,
        clubSec:     rs?.clubSec      ?? 0,
        ttsSec:      rs?.ttsSec       ?? 0,
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

  const patchReqUrl = new URL(request.url, "http://localhost");
  const patchProvider = (patchReqUrl.searchParams.get("provider") ?? "google") as TtsProvider;

  generating = true;
  runningJob = `patch-tts:${patchProvider}`;
  resetAbort();
  resetQuota();
  resetDailyQuota();
  (async () => {
    try {
      const { patched, briefing } = await generateMissingTTS((msg) => send({ type: "log", msg }), patchProvider);
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
