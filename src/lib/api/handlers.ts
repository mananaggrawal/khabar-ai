/**
 * Raw HTTP handlers for admin and Q&A endpoints.
 * Mounted as request middleware in src/start.ts so they work without
 * needing routeTree.gen.ts to be updated.
 */
import { generateDailyBriefing, getTodayBriefing } from "@/lib/news/generator";
import { googleTTS } from "@/lib/tts/google";
import { loadBriefingFromStorage } from "@/lib/supabase-storage";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// POST /api/admin/generate — streams SSE log events during generation
export async function handleGenerate(request: Request): Promise<Response> {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return json({ error: "ADMIN_KEY not configured" }, 500);
  if (request.headers.get("x-admin-key") !== adminKey)
    return json({ error: "Unauthorized" }, 401);

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();

  const send = (data: object) => {
    try { writer.write(enc.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch {}
  };

  // Fire-and-forget — don't await so we return the stream immediately
  (async () => {
    try {
      console.log("[admin] generation triggered");
      const briefing = await generateDailyBriefing((msg) => send({ type: "log", msg }));
      send({
        type: "done",
        date: briefing.date,
        sections: briefing.sections.length,
        totalTopics: briefing.sections.reduce((n, s) => n + s.topics.length, 0),
      });
    } catch (err: any) {
      console.error("[admin] generation failed", err);
      send({ type: "error", msg: err?.message ?? "Generation failed" });
    } finally {
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

// GET /api/admin/status  — last 3 days' generation status
export async function handleStatus(request: Request): Promise<Response> {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return json({ error: "ADMIN_KEY not configured" }, 500);
  if (request.headers.get("x-admin-key") !== adminKey)
    return json({ error: "Unauthorized" }, 401);

  const days: object[] = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const date = d.toISOString().slice(0, 10);
    try {
      const briefing: any = await loadBriefingFromStorage(date);
      if (briefing) {
        days.push({
          date,
          status: "generated",
          sections: briefing.sections?.length ?? 0,
          totalTopics: briefing.sections?.reduce((n: number, s: any) => n + (s.topics?.length ?? 0), 0) ?? 0,
          generatedAt: briefing.generatedAt ?? null,
        });
      } else {
        days.push({ date, status: "missing" });
      }
    } catch {
      days.push({ date, status: "error" });
    }
  }

  return json({ days });
}

// GET /api/admin/download?date=YYYY-MM-DD — proxy briefing JSON as a file download
export async function handleDownload(request: Request): Promise<Response> {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return json({ error: "ADMIN_KEY not configured" }, 500);
  if (request.headers.get("x-admin-key") !== adminKey)
    return json({ error: "Unauthorized" }, 401);

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

// POST /api/ask  { question: string }
export async function handleAsk(request: Request): Promise<Response> {
  try {
    const body = await request.json().catch(() => ({}));
    const question = typeof body?.question === "string" ? body.question.trim() : "";
    if (!question) return json({ error: "question is required" }, 400);

    const briefing = await getTodayBriefing();
    if (!briefing?.sections?.length)
      return json({ error: "No briefing available for today" }, 404);

    const combinedScript = briefing.sections.map((s) => s.monologueScript).filter(Boolean).join("\n\n");
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
  return googleTTS(text, `answer-${Date.now()}`);
}
