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

// POST /api/admin/generate
export async function handleGenerate(request: Request): Promise<Response> {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return json({ error: "ADMIN_KEY not configured" }, 500);
  if (request.headers.get("x-admin-key") !== adminKey)
    return json({ error: "Unauthorized" }, 401);

  try {
    console.log("[admin] briefing generation triggered");
    const briefing = await generateDailyBriefing();
    return json({
      ok: true,
      date: briefing.date,
      sections: briefing.sections.length,
      totalTopics: briefing.sections.reduce((n, s) => n + s.topics.length, 0),
    });
  } catch (err: any) {
    console.error("[admin] generation failed", err);
    return json({ error: err?.message ?? "Generation failed" }, 500);
  }
}

// GET /api/admin/status  — today's generation status
export async function handleStatus(request: Request): Promise<Response> {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) return json({ error: "ADMIN_KEY not configured" }, 500);
  if (request.headers.get("x-admin-key") !== adminKey)
    return json({ error: "Unauthorized" }, 401);

  const today = new Date().toISOString().slice(0, 10);
  try {
    const briefing: any = await loadBriefingFromStorage(today);
    if (briefing) {
      return json({
        date: today,
        status: "generated",
        sections: briefing.sections?.length ?? 0,
        totalTopics: briefing.sections?.reduce((n: number, s: any) => n + (s.topics?.length ?? 0), 0) ?? 0,
        generatedAt: briefing.generatedAt ?? null,
      });
    }
    return json({ date: today, status: "missing" });
  } catch {
    return json({ date: today, status: "error" }, 500);
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
