import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Home,
  Search as SearchIcon,
  Library,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Mic,
  Bookmark,
  ChevronLeft,
  Sparkles,
  Radio,
  X,
  Send,
} from "lucide-react";
import heroImg from "@/assets/proto-hero.jpg";
import marketsImg from "@/assets/proto-markets.jpg";
import worldImg from "@/assets/proto-world.jpg";
import sportsImg from "@/assets/proto-sports.jpg";

export const Route = createFileRoute("/prototype")({
  component: PrototypePage,
  head: () => ({
    meta: [
      { title: "Khabar AI — Voice-first News Prototype" },
      {
        name: "description",
        content:
          "An interactive Spotify-grade, voice-first news prototype you can click through.",
      },
    ],
  }),
});

type Tab = "home" | "browse" | "library";

type Story = {
  id: string;
  title: string;
  kicker: string;
  img: string;
  durSec: number;
};

const STORIES: Story[] = [
  {
    id: "s1",
    title: "Sensex jumps 612 pts as IT and banking rally; rupee at 83.21",
    kicker: "Markets",
    img: marketsImg,
    durSec: 248,
  },
  {
    id: "s2",
    title: "EU agrees €50bn aid package; Hungary drops veto after marathon talks",
    kicker: "World",
    img: worldImg,
    durSec: 362,
  },
  {
    id: "s3",
    title: "Bumrah ruled out of Sydney Test with back niggle, Akash Deep in",
    kicker: "Sports",
    img: sportsImg,
    durSec: 184,
  },
  {
    id: "s4",
    title: "ISRO docks two satellites in orbit — a first for India",
    kicker: "Tech",
    img: heroImg,
    durSec: 296,
  },
];

function PrototypePage() {
  // Global player state — persists across tabs
  const [tab, setTab] = useState<Tab>("home");
  const [storyIdx, setStoryIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(102); // seconds elapsed in current story
  const [nowOpen, setNowOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [askValue, setAskValue] = useState("");

  const story = STORIES[storyIdx];

  // Drive progress while playing
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setProgress((p) => {
        if (p + 1 >= story.durSec) {
          // auto-advance
          setStoryIdx((i) => (i + 1) % STORIES.length);
          return 0;
        }
        return p + 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [playing, story.durSec]);

  function playStory(idx: number) {
    setStoryIdx(idx);
    setProgress(0);
    setPlaying(true);
    setNowOpen(true);
  }
  function next() {
    setStoryIdx((i) => (i + 1) % STORIES.length);
    setProgress(0);
  }
  function prev() {
    setStoryIdx((i) => (i - 1 + STORIES.length) % STORIES.length);
    setProgress(0);
  }

  return (
    <div className="min-h-screen w-full bg-neutral-950 text-white font-sans">
      <div className="mx-auto max-w-3xl px-6 py-8 sm:py-12">
        <header className="mb-8 flex flex-col items-center text-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-[0.3em] text-indigo-400">
            Interactive Prototype · v1
          </span>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
            Khabar AI — tap anything
          </h1>
          <p className="text-xs text-neutral-400 max-w-md">
            Click stories to play, tap the mini-player to open Now Playing, use the bottom nav, try the mic.
          </p>
        </header>

        <div className="flex justify-center">
          <PhoneFrame>
            {/* Screens */}
            <div className="absolute inset-0 flex flex-col">
              <AnimatePresence mode="wait">
                {tab === "home" && (
                  <ScreenWrap key="home">
                    <HomeScreen onPlay={playStory} stories={STORIES} />
                  </ScreenWrap>
                )}
                {tab === "browse" && (
                  <ScreenWrap key="browse">
                    <BrowseScreen onPlay={playStory} />
                  </ScreenWrap>
                )}
                {tab === "library" && (
                  <ScreenWrap key="library">
                    <LibraryScreen onPlay={playStory} stories={STORIES} />
                  </ScreenWrap>
                )}
              </AnimatePresence>

              {/* Mini player + nav (always mounted) */}
              <BottomDock
                story={story}
                playing={playing}
                progress={progress}
                onToggle={() => setPlaying((p) => !p)}
                onOpen={() => setNowOpen(true)}
                onMic={() => setAskOpen(true)}
                tab={tab}
                setTab={setTab}
              />
            </div>

            {/* Now Playing sheet */}
            <AnimatePresence>
              {nowOpen && (
                <NowPlayingSheet
                  story={story}
                  playing={playing}
                  progress={progress}
                  onClose={() => setNowOpen(false)}
                  onToggle={() => setPlaying((p) => !p)}
                  onNext={next}
                  onPrev={prev}
                  onMic={() => setAskOpen(true)}
                />
              )}
            </AnimatePresence>

            {/* Ask anything sheet */}
            <AnimatePresence>
              {askOpen && (
                <AskSheet
                  value={askValue}
                  setValue={setAskValue}
                  onClose={() => setAskOpen(false)}
                />
              )}
            </AnimatePresence>
          </PhoneFrame>
        </div>

        <p className="mt-8 text-center text-[11px] text-neutral-500">
          Everything's clickable — nav, play, skip, mic, story rows, "Ask anything".
        </p>
      </div>
    </div>
  );
}

/* ───────── Phone shell ───────── */

function PhoneFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative w-[360px] h-[760px] bg-black rounded-[48px] border-[10px] border-neutral-900 overflow-hidden shadow-2xl shadow-indigo-500/10">
      {/* notch */}
      <div className="absolute top-2 left-1/2 -translate-x-1/2 w-28 h-6 bg-black rounded-full z-50" />
      {/* status bar */}
      <div className="absolute top-3 left-0 right-0 px-8 flex justify-between text-[10px] font-bold text-white z-40">
        <span>9:41</span>
        <span className="opacity-70">●●●●●</span>
      </div>
      {children}
      {/* Ambient glow */}
      <div className="pointer-events-none absolute -top-24 -left-24 w-64 h-64 bg-indigo-500/15 blur-[100px] rounded-full" />
      <div className="pointer-events-none absolute bottom-0 right-0 w-80 h-80 bg-purple-500/10 blur-[120px] rounded-full" />
    </div>
  );
}

function ScreenWrap({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.18 }}
      className="flex-1 flex flex-col min-h-0"
    >
      {children}
    </motion.div>
  );
}

/* ───────── HOME ───────── */

function HomeScreen({ onPlay, stories }: { onPlay: (i: number) => void; stories: Story[] }) {
  return (
    <>
      <TopBar title="Good morning" />
      <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-44 space-y-6">
        {/* Today's Briefing hero */}
        <section>
          <h2 className="text-xl font-bold mb-3">Today's Briefing</h2>
          <button
            onClick={() => onPlay(0)}
            className="relative w-full text-left rounded-2xl overflow-hidden aspect-[4/5] bg-neutral-900 border border-white/10 active:scale-[0.99] transition-transform"
          >
            <img src={heroImg} alt="" className="w-full h-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/30 to-black/95" />
            <div className="absolute bottom-0 p-5 right-0 left-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-indigo-300 mb-2">
                Wed · 17 min listen
              </p>
              <h3 className="text-lg font-bold leading-snug">
                Fed holds rates; Nifty at 24,712; ISRO docks two satellites in orbit
              </h3>
              <div className="mt-3 flex items-center gap-2">
                <span className="bg-white text-black px-4 py-2 rounded-full text-xs font-bold inline-flex items-center gap-1.5">
                  <Play className="w-3.5 h-3.5 fill-current" /> Play briefing
                </span>
              </div>
            </div>
          </button>
        </section>

        <section className="flex gap-2 flex-wrap">
          {["India", "World", "Markets", "Tech", "Sports", "Quick hits"].map((t) => (
            <button
              key={t}
              className="px-3 py-1.5 rounded-full text-[11px] font-semibold bg-white/5 border border-white/10 text-neutral-200 active:bg-white/10"
            >
              {t}
            </button>
          ))}
        </section>

        <section>
          <div className="flex justify-between items-end mb-3">
            <h3 className="text-base font-bold">For you</h3>
            <span className="text-[10px] text-neutral-500 uppercase font-bold tracking-wider">
              See all
            </span>
          </div>
          <div className="space-y-2">
            {stories.map((s, i) => (
              <RowItem key={s.id} story={s} onPlay={() => onPlay(i)} />
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

/* ───────── BROWSE ───────── */

function BrowseScreen({ onPlay }: { onPlay: (i: number) => void }) {
  const tiles = [
    { name: "Politics", color: "from-rose-500 to-orange-500" },
    { name: "Business", color: "from-emerald-500 to-teal-500" },
    { name: "Tech", color: "from-indigo-500 to-purple-500" },
    { name: "Sport", color: "from-amber-400 to-rose-500" },
    { name: "Culture", color: "from-pink-500 to-fuchsia-500" },
    { name: "Local", color: "from-cyan-400 to-blue-500" },
  ];
  return (
    <>
      <TopBar title="Browse" />
      <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-44 space-y-5">
        <div className="relative">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500" />
          <input
            placeholder="Search stories, topics, sources"
            className="w-full bg-white/[0.06] border border-white/10 rounded-full pl-9 pr-3 py-2.5 text-sm placeholder:text-neutral-500 outline-none focus:border-indigo-400/50"
          />
        </div>

        <section>
          <h3 className="text-sm font-bold mb-3 text-neutral-300">Browse all</h3>
          <div className="grid grid-cols-2 gap-3">
            {tiles.map((t) => (
              <button
                key={t.name}
                onClick={() => onPlay(Math.floor(Math.random() * STORIES.length))}
                className={`relative h-24 rounded-xl overflow-hidden bg-gradient-to-br ${t.color} p-3 flex items-start active:scale-[0.98] transition`}
              >
                <span className="font-bold text-sm text-white drop-shadow text-left">{t.name}</span>
                <Sparkles className="absolute bottom-2 right-2 w-4 h-4 text-white/60" />
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3 className="text-sm font-bold mb-3 text-neutral-300">Trending now</h3>
          <div className="space-y-2">
            {STORIES.slice(0, 3).map((s, i) => (
              <RowItem key={s.id} story={s} onPlay={() => onPlay(i)} />
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

/* ───────── LIBRARY ───────── */

function LibraryScreen({
  onPlay,
  stories,
}: {
  onPlay: (i: number) => void;
  stories: Story[];
}) {
  const briefings = [
    { d: "Today · Wed", len: "17 min", img: heroImg },
    { d: "Tue", len: "14 min", img: marketsImg },
    { d: "Mon", len: "16 min", img: worldImg },
    { d: "Sun", len: "9 min", img: sportsImg },
  ];
  return (
    <>
      <TopBar title="Your library" />
      <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-44 space-y-5">
        <div className="flex gap-2">
          {["Briefings", "Saved", "Topics", "Sources"].map((t, i) => (
            <button
              key={t}
              className={`px-3 py-1.5 rounded-full text-[11px] font-semibold border ${
                i === 0
                  ? "bg-white text-black border-white"
                  : "bg-white/5 text-neutral-300 border-white/10"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        <section>
          <h3 className="text-sm font-bold mb-3 text-neutral-300">Recent briefings</h3>
          <div className="space-y-2">
            {briefings.map((b, i) => (
              <button
                key={b.d}
                onClick={() => onPlay(i % stories.length)}
                className="w-full flex items-center gap-3 p-2 rounded-xl bg-white/[0.03] border border-white/5 text-left active:bg-white/[0.07]"
              >
                <img src={b.img} className="w-12 h-12 rounded-lg object-cover" alt="" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate">Daily briefing — {b.d}</p>
                  <p className="text-[10px] text-neutral-500">Khabar AI · {b.len}</p>
                </div>
                <span className="w-8 h-8 rounded-full border border-white/15 grid place-items-center">
                  <Play className="w-3 h-3 fill-current" />
                </span>
              </button>
            ))}
          </div>
        </section>

        <section>
          <h3 className="text-sm font-bold mb-3 text-neutral-300">Following</h3>
          <div className="flex gap-3 overflow-x-auto no-scrollbar">
            {["Reuters", "BBC", "The Hindu", "Bloomberg", "Mint", "Wired"].map((s) => (
              <div
                key={s}
                className="shrink-0 w-20 h-20 rounded-full bg-white/5 border border-white/10 grid place-items-center text-[10px] font-bold text-center px-2"
              >
                {s}
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}

/* ───────── NOW PLAYING SHEET ───────── */

function NowPlayingSheet({
  story,
  playing,
  progress,
  onClose,
  onToggle,
  onNext,
  onPrev,
  onMic,
}: {
  story: Story;
  playing: boolean;
  progress: number;
  onClose: () => void;
  onToggle: () => void;
  onNext: () => void;
  onPrev: () => void;
  onMic: () => void;
}) {
  return (
    <motion.div
      initial={{ y: "100%" }}
      animate={{ y: 0 }}
      exit={{ y: "100%" }}
      transition={{ type: "spring", damping: 32, stiffness: 320 }}
      className="absolute inset-0 z-30 bg-black overflow-hidden"
    >
      <div className="absolute inset-0">
        <img src={story.img} alt="" className="w-full h-full object-cover opacity-40 blur-2xl" />
        <div className="absolute inset-0 bg-gradient-to-b from-indigo-950/40 via-black/85 to-black" />
      </div>

      <div className="relative z-10 flex flex-col h-full pt-10">
        <div className="px-5 flex items-center justify-between">
          <button onClick={onClose} className="p-2 -ml-2">
            <ChevronLeft className="w-5 h-5 text-white/80" />
          </button>
          <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-indigo-300">
            Today's Briefing
          </span>
          <button className="p-2 -mr-2">
            <Bookmark className="w-5 h-5 text-white/80" />
          </button>
        </div>

        <div className="flex-1 flex items-center justify-center">
          <Orb playing={playing} />
        </div>

        <div className="px-6 pb-8 space-y-5">
          <div className="text-center">
            <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-indigo-300 mb-2">
              {story.kicker} · {Math.round(story.durSec / 60)} min
            </p>
            <h3 className="text-lg font-bold leading-snug">{story.title}</h3>
            <p className="text-xs text-neutral-400 mt-2">Khabar AI · Voice of Aanya</p>
          </div>

          <Waveform progress={progress / story.durSec} />
          <div className="flex justify-between -mt-2 text-[10px] text-neutral-500 font-mono">
            <span>{fmt(progress)}</span>
            <span>{fmt(story.durSec)}</span>
          </div>

          <div className="flex items-center justify-between">
            <button className="text-white/70 text-[11px] font-semibold uppercase tracking-wider">
              Save
            </button>
            <div className="flex items-center gap-6">
              <button onClick={onPrev}>
                <SkipBack className="w-6 h-6 text-white" />
              </button>
              <button
                onClick={onToggle}
                className="w-14 h-14 rounded-full bg-white grid place-items-center shadow-lg active:scale-95 transition"
              >
                {playing ? (
                  <Pause className="w-6 h-6 text-black fill-current" />
                ) : (
                  <Play className="w-6 h-6 text-black fill-current ml-0.5" />
                )}
              </button>
              <button onClick={onNext}>
                <SkipForward className="w-6 h-6 text-white" />
              </button>
            </div>
            <button
              onClick={onMic}
              className="text-white/70 text-[11px] font-semibold uppercase tracking-wider"
            >
              Tell more
            </button>
          </div>

          <button
            onClick={onMic}
            className="w-full flex items-center justify-center gap-2 text-[11px] text-indigo-200/80 py-2 rounded-full bg-white/[0.04] border border-white/10"
          >
            <Mic className="w-3.5 h-3.5" />
            <span>Just say "next" to skip ahead</span>
          </button>
        </div>
      </div>
    </motion.div>
  );
}

function Orb({ playing }: { playing: boolean }) {
  return (
    <div className="relative w-56 h-56">
      <motion.div
        className="absolute inset-0 rounded-full bg-indigo-500/30 blur-3xl"
        animate={{
          scale: playing ? [1, 1.18, 1] : 1,
          opacity: playing ? [0.5, 0.85, 0.5] : 0.4,
        }}
        transition={{ duration: 3.5, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute inset-6 rounded-full"
        style={{
          background:
            "radial-gradient(circle at 30% 30%, #ffd7a8, #c879ff 40%, #4f46e5 75%, #0a0a1a)",
          boxShadow: "0 0 80px rgba(139,92,246,0.55), inset 0 0 60px rgba(255,255,255,0.15)",
        }}
        animate={{ scale: playing ? [1, 1.05, 1] : 1 }}
        transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
      />
      <div className="absolute inset-0 grid place-items-center">
        <div className="flex items-end gap-1 h-10">
          {[14, 28, 38, 22, 32, 18, 26].map((h, i) => (
            <motion.div
              key={i}
              className="w-1 bg-white/90 rounded-full"
              style={{ height: h }}
              animate={{ scaleY: playing ? [0.4, 1, 0.5, 0.9, 0.4] : 0.3 }}
              transition={{
                duration: 1.2 + i * 0.12,
                repeat: Infinity,
                ease: "easeInOut",
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function Waveform({ progress }: { progress: number }) {
  return (
    <div className="flex items-end justify-between h-8 gap-[2px]">
      {Array.from({ length: 48 }).map((_, i) => {
        const played = i / 48 < progress;
        const h = 4 + Math.abs(Math.sin(i * 0.7)) * 24;
        return (
          <div
            key={i}
            style={{ height: `${h}px` }}
            className={`w-[3px] rounded-full ${played ? "bg-indigo-400" : "bg-white/15"}`}
          />
        );
      })}
    </div>
  );
}

/* ───────── ASK SHEET ───────── */

function AskSheet({
  value,
  setValue,
  onClose,
}: {
  value: string;
  setValue: (v: string) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const suggestions = [
    "What does this mean for me?",
    "Skip to sports",
    "Summarize in 30 seconds",
    "Why does it matter?",
  ];
  return (
    <motion.div
      initial={{ y: "100%" }}
      animate={{ y: 0 }}
      exit={{ y: "100%" }}
      transition={{ type: "spring", damping: 32, stiffness: 320 }}
      className="absolute inset-x-0 bottom-0 z-40 bg-neutral-950 rounded-t-3xl border-t border-white/10 p-5 space-y-4"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="relative w-7 h-7">
            <div className="absolute inset-0 bg-indigo-500/40 blur-md rounded-full animate-pulse" />
            <div
              className="relative w-7 h-7 rounded-full"
              style={{
                background:
                  "radial-gradient(circle at 30% 30%, #ffd7a8, #c879ff 50%, #4f46e5 90%)",
              }}
            />
          </div>
          <span className="text-sm font-bold">Ask Khabar</span>
        </div>
        <button onClick={onClose} className="p-1">
          <X className="w-4 h-4 text-white/60" />
        </button>
      </div>

      <p className="text-xs text-neutral-400">Listening… or type below.</p>

      <div className="flex gap-2 flex-wrap">
        {suggestions.map((s) => (
          <button
            key={s}
            onClick={() => setValue(s)}
            className="px-3 py-1.5 rounded-full text-[11px] bg-white/5 border border-white/10 text-neutral-200"
          >
            {s}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-2 bg-white/[0.06] border border-white/10 rounded-full pl-4 pr-1 py-1">
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Ask anything about the news…"
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-neutral-500 py-2"
        />
        <button className="w-9 h-9 rounded-full bg-white grid place-items-center">
          <Send className="w-4 h-4 text-black" />
        </button>
      </div>
    </motion.div>
  );
}

/* ───────── Shared bits ───────── */

function TopBar({ title }: { title: string }) {
  return (
    <div className="pt-12 px-5 pb-4 flex justify-between items-center">
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-indigo-500 to-purple-500 grid place-items-center">
          <Radio className="w-4 h-4 text-white" />
        </div>
        <span className="font-bold text-base tracking-tight">{title}</span>
      </div>
      <div className="w-9 h-9 rounded-full bg-neutral-800 grid place-items-center border border-white/5">
        <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
      </div>
    </div>
  );
}

function RowItem({ story, onPlay }: { story: Story; onPlay: () => void }) {
  return (
    <button
      onClick={onPlay}
      className="w-full flex items-center gap-3 p-2.5 rounded-xl bg-white/[0.03] border border-white/5 text-left active:bg-white/[0.07] transition"
    >
      <img src={story.img} alt="" className="w-14 h-14 rounded-lg object-cover shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-[10px] text-indigo-300 font-bold uppercase tracking-wider">
          {story.kicker}
        </p>
        <p className="text-sm font-semibold leading-tight line-clamp-2">{story.title}</p>
      </div>
      <span className="w-8 h-8 rounded-full border border-white/15 grid place-items-center shrink-0">
        <Play className="w-3 h-3 fill-current ml-0.5" />
      </span>
    </button>
  );
}

function BottomDock({
  story,
  playing,
  progress,
  onToggle,
  onOpen,
  onMic,
  tab,
  setTab,
}: {
  story: Story;
  playing: boolean;
  progress: number;
  onToggle: () => void;
  onOpen: () => void;
  onMic: () => void;
  tab: Tab;
  setTab: (t: Tab) => void;
}) {
  const pct = Math.min(100, (progress / story.durSec) * 100);
  return (
    <div className="absolute bottom-0 inset-x-0 px-3 pb-3 space-y-2 bg-gradient-to-t from-black via-black/95 to-transparent z-20">
      <button
        onClick={onOpen}
        className="w-full bg-neutral-900/90 backdrop-blur-xl rounded-2xl border border-white/10 p-2.5 flex items-center gap-3 text-left active:bg-neutral-800/90"
      >
        <div className="relative w-10 h-10 grid place-items-center shrink-0">
          <div className="absolute inset-0 bg-indigo-500/30 blur-lg rounded-full animate-pulse" />
          <div
            className="relative w-9 h-9 rounded-full"
            style={{
              background:
                "radial-gradient(circle at 30% 30%, #ffd7a8, #c879ff 50%, #4f46e5 90%)",
              boxShadow: "0 0 16px rgba(139,92,246,0.6)",
            }}
          />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-bold truncate">{story.title}</p>
          <div className="mt-1 h-[2px] bg-white/10 rounded-full overflow-hidden">
            <div className="h-full bg-indigo-400 transition-all" style={{ width: `${pct}%` }} />
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onMic();
          }}
          className="w-8 h-8 grid place-items-center rounded-full hover:bg-white/5"
        >
          <Mic className="w-4 h-4 text-indigo-300" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="w-9 h-9 grid place-items-center rounded-full hover:bg-white/5"
        >
          {playing ? (
            <Pause className="w-5 h-5 text-white fill-current" />
          ) : (
            <Play className="w-5 h-5 text-white fill-current ml-0.5" />
          )}
        </button>
      </button>

      <nav className="flex justify-around items-center pt-1 pb-2">
        <NavBtn
          icon={<Home className="w-5 h-5" />}
          label="Home"
          active={tab === "home"}
          onClick={() => setTab("home")}
        />
        <NavBtn
          icon={<SearchIcon className="w-5 h-5" />}
          label="Browse"
          active={tab === "browse"}
          onClick={() => setTab("browse")}
        />
        <NavBtn
          icon={<Library className="w-5 h-5" />}
          label="Library"
          active={tab === "library"}
          onClick={() => setTab("library")}
        />
      </nav>
    </div>
  );
}

function NavBtn({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center gap-0.5 px-4 py-1 transition ${
        active ? "text-white" : "text-neutral-500 hover:text-neutral-300"
      }`}
    >
      {icon}
      <span className="text-[10px] font-semibold">{label}</span>
    </button>
  );
}

function fmt(s: number) {
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, "0")}`;
}
