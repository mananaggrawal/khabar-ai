/**
 * Web Push sending — server-side only. Fires after a successful generation
 * run (see handlers.ts handleCron) to tell subscribed devices the new
 * briefing is ready. Works on Android (full support) and iOS 16.4+, but only
 * for users who've actually installed the PWA to their home screen — Safari
 * doesn't support push for a PWA just open in a browser tab.
 */
import webpush from "web-push";
import { loadLogFromStorage, saveLogToStorage } from "@/lib/supabase-storage";
import { istDateKey } from "@/lib/ist";

const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY ?? "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? "";
const VAPID_SUBJECT      = process.env.VAPID_SUBJECT ?? "mailto:manan.aggrawal@vegapay.tech";

// Persisted history of every push send attempt (cron-automatic or
// admin-manual), so the admin panel can show "what notifications went out"
// after the fact — mirrors the generation-log storage pattern (one entry per
// IST day, appended, keyed as its own storage "date" so it doesn't collide
// with generation logs). IST, not UTC (2026-07-11 fix) — see src/lib/ist.ts,
// same reasoning as the generation logs it mirrors.
function pushLogKey(): string {
  return `pushlog-${istDateKey()}`;
}

async function recordPushLog(entry: string): Promise<void> {
  try {
    const key = pushLogKey();
    const prev = (await loadLogFromStorage(key).catch(() => null)) ?? "";
    await saveLogToStorage(key, `${prev}${new Date().toISOString()}  ${entry}\n`);
  } catch (e: any) {
    console.error("[push] failed to record push log:", e?.message ?? e);
  }
}

let configured = false;
function ensureConfigured(): boolean {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  if (!configured) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    configured = true;
  }
  return true;
}

export type BriefingPeriod = "morning" | "evening";

// A few variants per period so it doesn't feel like the same robotic ping
// every single day — picked at random per send.
const MORNING_MESSAGES = [
  { title: "☀️ Your morning briefing is ready", body: "Today's biggest stories, narrated and waiting — press play whenever you're ready." },
  { title: "Good morning, Khabar's in", body: "Fresh headlines are live. Skip the scroll, just hit play." },
  { title: "Today, spoken for you", body: "The morning news is ready to listen to — a few minutes, fully caught up." },
  { title: "☕ Briefing's up", body: "The day's biggest stories are ready to hear before you've even had your coffee." },
  { title: "News, narrated. Ready now.", body: "Your morning briefing just landed — tap to start listening." },
];

const EVENING_MESSAGES = [
  { title: "🌙 Your evening briefing is ready", body: "Here's how today actually went — narrated and ready to hear." },
  { title: "Catch up before the day ends", body: "Today's evening update just landed — a few minutes to hear what happened." },
  { title: "One more listen before you wind down?", body: "The evening briefing is live — today's news, quickly." },
  { title: "📻 Today's wrap is ready", body: "Your evening briefing just came in — tap to listen and stay caught up." },
];

function pickMessage(period: BriefingPeriod): { title: string; body: string } {
  const list = period === "morning" ? MORNING_MESSAGES : EVENING_MESSAGES;
  return list[Math.floor(Math.random() * list.length)];
}

/** Sends title/body to every currently-subscribed device, cleaning up any
 *  subscriptions the browser has revoked (404/410) along the way. Shared by
 *  the automatic post-generation send and the admin panel's manual trigger.
 *  `source` is just a label ("cron" | "admin-manual" | ...) recorded in the
 *  persisted push log so the admin panel can show where each send came from. */
export async function sendPushToAll(title: string, body: string, logger: (msg: string) => void = () => {}, source = "manual"): Promise<{ sent: number; removed: number; failed: number; total: number }> {
  const log = (msg: string) => { logger(msg); void recordPushLog(`[${source}] ${msg}`); };

  if (!ensureConfigured()) {
    log('[push] skipped — VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not configured');
    return { sent: 0, removed: 0, failed: 0, total: 0 };
  }

  let rows: any[] = [];
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await (supabaseAdmin as any).from("push_subscriptions").select("id, endpoint, p256dh, auth_key");
    if (error) throw error;
    rows = data ?? [];
  } catch (e: any) {
    log(`[push] failed to load subscriptions: ${e?.message ?? e}`);
    return { sent: 0, removed: 0, failed: 0, total: 0 };
  }

  if (rows.length === 0) {
    log(`[push] "${title}" — no subscribed devices, nothing to send`);
    return { sent: 0, removed: 0, failed: 0, total: 0 };
  }

  const payload = JSON.stringify({ title, body, url: "/", tag: "khabar-briefing" });

  let sent = 0, removed = 0, failed = 0;
  await Promise.all(rows.map(async (row) => {
    const subscription = {
      endpoint: row.endpoint,
      keys: { p256dh: row.p256dh, auth: row.auth_key },
    };
    try {
      await webpush.sendNotification(subscription, payload);
      sent++;
    } catch (e: any) {
      const status = e?.statusCode;
      if (status === 404 || status === 410) {
        // Subscription expired/revoked on the browser's end — clean it up.
        removed++;
        try {
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          await (supabaseAdmin as any).from("push_subscriptions").delete().eq("id", row.id);
        } catch { /* best-effort cleanup */ }
      } else {
        failed++;
      }
    }
  }));

  log(`[push] "${title}": sent ${sent}, removed ${removed} stale, ${failed} failed (of ${rows.length} subscribed)`);
  return { sent, removed, failed, total: rows.length };
}

export async function sendBriefingPushNotifications(period: BriefingPeriod, logger: (msg: string) => void = () => {}, source = "cron"): Promise<void> {
  const { title, body } = pickMessage(period);
  await sendPushToAll(title, body, logger, source);
}

// GET-style read for the admin panel's notification log view — same storage
// pattern as generation logs (src/lib/api/handlers.ts loadLogFromStorage),
// just under the "pushlog-{date}" key instead of "{date}".
export async function loadPushLog(dateKey: string): Promise<string | null> {
  return loadLogFromStorage(`pushlog-${dateKey}`).catch(() => null);
}
