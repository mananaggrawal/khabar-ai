/**
 * Web Push sending — server-side only. Fires after a successful generation
 * run (see handlers.ts handleCron) to tell subscribed devices the new
 * briefing is ready. Works on Android (full support) and iOS 16.4+, but only
 * for users who've actually installed the PWA to their home screen — Safari
 * doesn't support push for a PWA just open in a browser tab.
 */
import webpush from "web-push";

const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY ?? "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY ?? "";
const VAPID_SUBJECT      = process.env.VAPID_SUBJECT ?? "mailto:manan.aggrawal@vegapay.tech";

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
  { title: "☀️ Rise and hear it", body: "Your morning briefing just dropped — today's world, in your ears." },
  { title: "Good morning!", body: "Fresh headlines are ready. Press play before the coffee kicks in." },
  { title: "Today, spoken.", body: "Your morning news is live — catch up in minutes, not scrolling." },
  { title: "☕ Briefing's up", body: "The day's biggest stories are ready to listen to, right now." },
];

const EVENING_MESSAGES = [
  { title: "🌙 Evening wrap-up", body: "Today's update just landed — catch what you missed before it's tomorrow." },
  { title: "Your evening briefing is ready", body: "Wind down and hear how the day actually went." },
  { title: "One more listen before bed?", body: "The evening briefing is live — today's news, quickly." },
  { title: "📻 Fresh update", body: "Your evening briefing just came in — a few minutes, fully caught up." },
];

function pickMessage(period: BriefingPeriod): { title: string; body: string } {
  const list = period === "morning" ? MORNING_MESSAGES : EVENING_MESSAGES;
  return list[Math.floor(Math.random() * list.length)];
}

/** Sends title/body to every currently-subscribed device, cleaning up any
 *  subscriptions the browser has revoked (404/410) along the way. Shared by
 *  the automatic post-generation send and the admin panel's manual trigger. */
export async function sendPushToAll(title: string, body: string, logger: (msg: string) => void = () => {}): Promise<{ sent: number; removed: number; failed: number; total: number }> {
  if (!ensureConfigured()) {
    logger("[push] skipped — VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not configured");
    return { sent: 0, removed: 0, failed: 0, total: 0 };
  }

  let rows: any[] = [];
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await (supabaseAdmin as any).from("push_subscriptions").select("id, endpoint, p256dh, auth_key");
    if (error) throw error;
    rows = data ?? [];
  } catch (e: any) {
    logger(`[push] failed to load subscriptions: ${e?.message ?? e}`);
    return { sent: 0, removed: 0, failed: 0, total: 0 };
  }

  if (rows.length === 0) {
    logger("[push] no subscribed devices, nothing to send");
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

  logger(`[push] "${title}": sent ${sent}, removed ${removed} stale, ${failed} failed (of ${rows.length} subscribed)`);
  return { sent, removed, failed, total: rows.length };
}

export async function sendBriefingPushNotifications(period: BriefingPeriod, logger: (msg: string) => void = () => {}): Promise<void> {
  const { title, body } = pickMessage(period);
  await sendPushToAll(title, body, logger);
}
