import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useRouterState,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { PlayerProvider } from "@/context/player";
import { CityNudge } from "@/components/CityNudge";
import { useOnboarding } from "@/hooks/useOnboardingGate";
import { VoiceOrb } from "@/components/VoiceOrb";

// Absolute base URL for social-share previews. Set VITE_PUBLIC_URL in Render for
// guaranteed-absolute og:image (WhatsApp/iMessage need absolute); falls back to a
// root-relative path otherwise.
const SITE_URL = ((import.meta as any).env?.VITE_PUBLIC_URL || "").replace(/\/$/, "");
const OG_IMAGE = `${SITE_URL}/og-image.jpg`;

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { title: "Khabar AI — Today's news, spoken." },
      { name: "description", content: "An AI-native voice agent that hears, learns, and discusses the day's global news with you." },
      { name: "theme-color", content: "#0c0717" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { name: "apple-mobile-web-app-title", content: "Khabar AI" },
      { property: "og:site_name", content: "Khabar AI" },
      { property: "og:title", content: "Khabar AI — Today's news, spoken." },
      { property: "og:description", content: "Your daily news, spoken. Khabar AI reads the day's top stories to you in a few minutes." },
      { property: "og:type", content: "website" },
      { property: "og:image", content: OG_IMAGE },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: "Khabar AI — Today's news, spoken." },
      { name: "twitter:description", content: "Your daily news, spoken. Khabar AI reads the day's top stories to you in a few minutes." },
      { name: "twitter:image", content: OG_IMAGE },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Instrument+Serif:ital@0;1&display=swap" },
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon-v2.png" },
      { rel: "icon", type: "image/x-icon", href: "/favicon.ico" },
      { rel: "icon", type: "image/png", href: "/favicon-v2.png" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

// Shown instead of the real app while the mandatory city/language onboarding
// (see CityNudge) is still unresolved for a brand-new signup — otherwise
// whichever page the user lands on (Home included) would flash its content
// for a moment underneath the dialog right after login (2026-07-08).
function OnboardingGateScreen() {
  return (
    <div className="fixed inset-0 z-10 flex flex-col items-center justify-center gap-5 bg-background">
      <VoiceOrb state="idle" size={160} />
      <div className="flex flex-col items-center gap-1">
        <span className="font-serif text-2xl tracking-tight">
          Khabar <em className="italic text-primary">AI</em>
        </span>
        <p className="text-xs text-muted-foreground animate-pulse">Setting things up…</p>
      </div>
    </div>
  );
}

// BUG FIX (2026-07-08): this used to live in _authenticated/route.tsx,
// wrapping only that layout's <Outlet /> — but "/" (Home, routes/index.tsx)
// is a SEPARATE top-level route, a sibling of "_authenticated" rather than a
// child of it (TanStack Router's file-based routing doesn't nest a bare
// routes/index.tsx under routes/_authenticated/ just because they're both
// under src/routes/). So the gate was never actually wrapping Home at all —
// Home rendered immediately and unblocked, while CityNudge only ever
// appeared once the user navigated into an actual _authenticated/* page
// (Settings, History, Browse), which is exactly the "asks me on Settings,
// but showed Home first" behavior reported. Moved here, to the one common
// ancestor of every route, so it actually gates everything including Home.
//
// Skips gating entirely on /auth — that page has no logged-in user yet, so
// running the check there would just add a pointless blocking flash in
// front of the login screen itself before resolving unblocked.
function OnboardingGate({ children }: { children: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const isAuthPage = pathname.startsWith("/auth");
  const { shouldPrompt, ready, userId } = useOnboarding();

  if (isAuthPage) return <>{children}</>;

  return (
    <>
      {ready ? children : <OnboardingGateScreen />}
      <CityNudge shouldPrompt={shouldPrompt} userId={userId} />
    </>
  );
}

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="light">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  // Register the service worker eagerly at app boot (2026-07-06) — previously
  // this only happened lazily inside usePushNotifications when that hook
  // mounted/ran, so a user who never touched notification settings would
  // never get a controlling service worker. Chrome's PWA-installability check
  // (which gates whether beforeinstallprompt ever fires, powering the new
  // install nudge) generally wants an active service worker; registering here
  // makes that reliable regardless of whether push notifications are ever
  // used. Safe to also call from usePushNotifications — register() with the
  // same URL is idempotent and just returns the existing registration.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }, []);

  // Defensive OAuth-hash cleanup (2026-07-06). Google's redirect back through
  // Supabase lands as "/#access_token=...&..."; supabase-js is supposed to
  // parse that itself and strip it via history.replaceState, but users kept
  // seeing the URL linger on a bare "/#" after signing in. Belt-and-suspenders:
  // wait long enough for supabase-js's own hash parsing to finish (it happens
  // on client init, well under a second), then force-clear anything left over
  // so the address bar doesn't keep showing a stray hash.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!window.location.hash || window.location.hash === "#") {
      // Still worth clearing a truly empty "#" — some browsers keep it visible.
      if (window.location.hash === "#") {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
      return;
    }
    const t = setTimeout(() => {
      if (window.location.hash) {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
    }, 1500);
    return () => clearTimeout(t);
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      {/* Player lives above the routes so audio + mini-player persist across tabs. */}
      <PlayerProvider>
        <OnboardingGate>
          {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
          <Outlet />
        </OnboardingGate>
      </PlayerProvider>
    </QueryClientProvider>
  );
}
