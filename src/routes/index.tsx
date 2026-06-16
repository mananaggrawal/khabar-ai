import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { AnimatePresence, motion } from "motion/react";
import { History, MicOff, Mic, Settings, X, Loader2, AlertTriangle } from "lucide-react";
import { ConversationProvider } from "@elevenlabs/react";

import { VoiceOrb } from "@/components/VoiceOrb";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { fetchBriefing, type Briefing } from "@/lib/news/briefing.functions";
import { useVoiceAgent } from "@/hooks/useVoiceAgent";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "NewsPilot — Today's news, spoken." },
      { name: "description", content: "An AI-native voice agent that hears, learns, and discusses the day's global news with you. Tap once to listen." },
      { property: "og:title", content: "NewsPilot — Today's news, spoken." },
      { property: "og:description", content: "Voice-first daily news briefing. Interrupt anytime to go deeper." },
    ],
  }),
  component: Home,
});

function Home() {
  const router = useRouter();
  const [authReady, setAuthReady] = useState(false);
  const [signedIn, setSignedIn] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      const isIn = !!data.session;
      setSignedIn(isIn);
      setAuthReady(true);
      if (!isIn) router.navigate({ to: "/auth", replace: true });
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setSignedIn(!!session);
      if (!session) router.navigate({ to: "/auth", replace: true });
    });
    return () => sub.subscription.unsubscribe();
  }, [router]);

  if (!authReady || !signedIn) {
    return <FullScreenCanvas><BootingOrb /></FullScreenCanvas>;
  }
  return (
    <ConversationProvider>
      <FullScreenCanvas><BriefingSurface /></FullScreenCanvas>
    </ConversationProvider>
  );
}

function FullScreenCanvas({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen overflow-hidden bg-background text-foreground">
      {/* Ambient deep-ink gradient */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse at 50% 30%, oklch(0.22 0.04 290 / 0.7), transparent 60%), radial-gradient(ellipse at 80% 80%, oklch(0.25 0.08 30 / 0.35), transparent 65%)",
        }}
      />
      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-4xl flex-col">
        {children}
      </div>
    </div>
  );
}

function BootingOrb() {
  return (
    <div className="flex flex-1 items-center justify-center">
      <VoiceOrb state="idle" size={220} />
    </div>
  );
}

function LandingHero({ onSignIn }: { onSignIn: () => void }) {
  return (
    <>
      <TopBar minimal />
      <div className="flex flex-1 flex-col items-center justify-center gap-10 px-6 text-center">
        <VoiceOrb state="idle" size={260} />
        <div className="max-w-xl space-y-4">
          <h1 className="font-serif text-5xl leading-[1.05] tracking-tight md:text-6xl">
            Today's news,<br /><span className="italic text-primary">spoken</span>.
          </h1>
          <p className="text-base text-muted-foreground md:text-lg">
            A voice-first daily briefing on global affairs. Listen, interrupt, go deeper — like talking to a very well-read friend who reads every paper before breakfast.
          </p>
        </div>
        <Button onClick={onSignIn} size="lg" className="rounded-full px-8 text-base font-medium">
          Sign in to start
        </Button>
      </div>
      <footer className="px-6 pb-8 text-center text-xs text-muted-foreground">
        Built on Lovable Cloud · Voice by ElevenLabs · News from Google, Reuters, AP, BBC, HN
      </footer>
    </>
  );
}

function BriefingSurface() {
  const fetchFn = useServerFn(fetchBriefing);
  const briefingQuery = useQuery({
    queryKey: ["briefing"],
    queryFn: () => fetchFn({ data: {} }),
    staleTime: 60 * 60 * 1000,
    retry: 1,
  });
  const refresh = useMutation({
    mutationFn: () => fetchFn({ data: { force: true } }),
    onSuccess: (data) => briefingQuery.refetch(),
  });

  const briefing: Briefing | null = briefingQuery.data ?? null;
  const voice = useVoiceAgent({ briefing });
  const [muted, setMuted] = useState(false);

  const connected = voice.status === "connected";
  const dateLabel = useMemo(() => new Date().toLocaleDateString(undefined, {
    weekday: "long", month: "long", day: "numeric",
  }), []);

  const topicCount = briefing?.topics.length ?? 0;
  const minutes = Math.max(3, topicCount);
  const subtitle = briefingQuery.isLoading
    ? "Gathering the day's stories…"
    : briefingQuery.isError
    ? "Couldn't load the briefing. Tap retry."
    : connected
    ? voice.orbState === "speaking" ? "NewsPilot is speaking" : "Listening — talk anytime"
    : `${topicCount} ${topicCount === 1 ? "story" : "stories"} · about ${minutes} min`;

  return (
    <>
      <TopBar />
      <main className="flex flex-1 flex-col items-center justify-between px-6 pb-8">
        <div className="flex flex-1 flex-col items-center justify-center gap-8">
          <div className="text-center text-xs uppercase tracking-[0.25em] text-muted-foreground">
            {dateLabel}
          </div>

          <VoiceOrb
            state={voice.orbState}
            amplitude={voice.amplitude}
            frequencyData={voice.frequencyData}
            size={300}
            onClick={() => {
              if (briefingQuery.isError) { refresh.mutate(); return; }
              if (!briefing) return;
              if (connected) { voice.stop(); } else { voice.start(); }
            }}
          />

          <div className="flex min-h-[3rem] flex-col items-center gap-2 text-center">
            <p className="font-serif text-2xl tracking-tight">
              {connected ? "NewsPilot" : "Tap to start briefing"}
            </p>
            <p className="text-sm text-muted-foreground">{subtitle}</p>
            {voice.configError && (
              <p className="mt-1 flex items-center gap-1.5 text-xs text-amber-400/90">
                <AlertTriangle className="size-3.5" />
                {voice.configError === "missing_api_key" || voice.configError === "missing_agent_id"
                  ? "Voice not configured yet — add ElevenLabs keys to enable."
                  : "Couldn't reach the voice agent. Try again."}
              </p>
            )}
          </div>
        </div>

        <Transcript lines={voice.transcript} />

        <div className="mt-6 flex items-center gap-3">
          {connected ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setMuted((m) => !m)}
                className="rounded-full text-muted-foreground hover:text-foreground"
              >
                {muted ? <MicOff className="size-4" /> : <Mic className="size-4" />}
                {muted ? "Muted" : "Mic on"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => voice.stop()}
                className="rounded-full text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" /> End
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => refresh.mutate()}
              disabled={refresh.isPending || briefingQuery.isLoading}
              className="rounded-full text-muted-foreground hover:text-foreground"
            >
              {refresh.isPending && <Loader2 className="size-4 animate-spin" />}
              Refresh briefing
            </Button>
          )}
        </div>
      </main>
    </>
  );
}

function TopBar({ minimal }: { minimal?: boolean } = {}) {
  return (
    <header className="flex items-center justify-between px-6 pt-6">
      <Link to="/" className="font-serif text-xl tracking-tight">
        News<span className="italic text-primary">Pilot</span>
      </Link>
      {!minimal && (
        <div className="flex items-center gap-1">
          <Link
            to="/history"
            className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-white/5 hover:text-foreground"
            aria-label="History"
          >
            <History className="size-4" />
          </Link>
          <Link
            to="/settings"
            className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-white/5 hover:text-foreground"
            aria-label="Settings"
          >
            <Settings className="size-4" />
          </Link>
        </div>
      )}
    </header>
  );
}

function Transcript({ lines }: { lines: { id: string; role: "user" | "agent"; text: string }[] }) {
  const recent = lines.slice(-6);
  if (recent.length === 0) {
    return <div className="h-24" />;
  }
  return (
    <div className="mt-6 w-full max-w-xl space-y-1.5">
      <AnimatePresence initial={false}>
        {recent.map((l) => (
          <motion.p
            key={l.id}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.25 }}
            className={
              l.role === "agent"
                ? "text-center text-sm leading-relaxed text-foreground/95"
                : "text-center text-xs leading-relaxed text-muted-foreground/70"
            }
          >
            {l.role === "user" && <span className="mr-1.5 text-[10px] uppercase tracking-widest">you · </span>}
            {l.text}
          </motion.p>
        ))}
      </AnimatePresence>
    </div>
  );
}
