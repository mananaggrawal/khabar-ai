import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { motion } from "motion/react";
import {
  Home,
  Search,
  Library,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Mic,
  Bookmark,
  ChevronRight,
  Sparkles,
  Radio,
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
          "A Spotify-grade, voice-first news prototype. Daily AI briefings, listen-anywhere, ask anything.",
      },
    ],
  }),
});

type Screen = "home" | "now" | "library";

function PrototypePage() {
  const [screen, setScreen] = useState<Screen>("home");

  return (
    <div className="min-h-screen w-full bg-neutral-950 text-white font-sans">
      <div className="mx-auto max-w-6xl px-6 py-10">
        <header className="mb-10 flex flex-col items-center text-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-[0.3em] text-indigo-400">
            Prototype · v1
          </span>
          <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight">
            Khabar AI — Voice-first News
          </h1>
          <p className="text-sm text-neutral-400 max-w-md">
            Inspired by Spotify. Built around the voice orb. Three screens you can flip between below.
          </p>
        </header>

        {/* Three phones, side by side on desktop, stacked on mobile */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-10 place-items-center">
          <PhoneFrame label="Home" active={screen === "home"} onClick={() => setScreen("home")}>
            <HomeScreen />
          </PhoneFrame>
          <PhoneFrame
            label="Now Playing"
            active={screen === "now"}
            onClick={() => setScreen("now")}
          >
            <NowPlayingScreen />
          </PhoneFrame>
          <PhoneFrame
            label="Library"
            active={screen === "library"}
            onClick={() => setScreen("library")}
          >
            <LibraryScreen />
          </PhoneFrame>
        </div>

        <p className="mt-12 text-center text-xs text-neutral-500">
          Tap a phone to highlight it. All copy and artwork are placeholders for the prototype.
        </p>
      </div>
    </div>
  );
}

/* ───────────────────── Phone shell ───────────────────── */

function PhoneFrame({
  children,
  label,
  active,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-3">
      <button
        type="button"
        onClick={onClick}
        className={`relative w-[340px] h-[720px] bg-black rounded-[44px] border-8 overflow-hidden shadow-2xl transition-all ${
          active
            ? "border-indigo-500/60 shadow-indigo-500/20 scale-[1.02]"
            : "border-neutral-900 hover:border-neutral-800"
        }`}
      >
        <div className="absolute inset-0 flex flex-col text-white">{children}</div>
        {/* Ambient glows shared across all screens */}
        <div className="pointer-events-none absolute -top-24 -left-24 w-64 h-64 bg-indigo-500/10 blur-[100px] rounded-full" />
        <div className="pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-80 h-80 bg-purple-500/5 blur-[120px] rounded-full" />
      </button>
      <span className="text-xs font-semibold uppercase tracking-widest text-neutral-400">
        {label}
      </span>
    </div>
  );
}

/* ───────────────────── HOME ───────────────────── */

function HomeScreen() {
  return (
    <>
      <TopBar />
      <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-40 space-y-7">
        {/* Today's Briefing hero */}
        <section>
          <h2 className="text-xl font-bold mb-3">Today's Briefing</h2>
          <div className="relative rounded-2xl overflow-hidden aspect-[4/5] bg-neutral-900 border border-white/10">
            <img
              src={heroImg}
              alt="Today's briefing cover"
              className="w-full h-full object-cover"
              width={800}
              height={1024}
            />
            <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/30 to-black/95" />
            <div className="absolute bottom-0 p-5">
              <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-indigo-300 mb-2">
                Wed · 17 min listen
              </p>
              <h3 className="text-lg font-bold leading-snug">
                Fed holds rates; Nifty closes at 24,712; ISRO docks two satellites in orbit
              </h3>
              <div className="mt-3 flex items-center gap-2">
                <button className="bg-white text-black px-4 py-2 rounded-full text-xs font-bold inline-flex items-center gap-1.5">
                  <Play className="w-3.5 h-3.5 fill-current" /> Play
                </button>
                <button className="bg-white/10 backdrop-blur-md text-white px-3 py-2 rounded-full text-xs font-semibold border border-white/10">
                  Ask anything
                </button>
              </div>
            </div>
          </div>
        </section>

        {/* Topic chips */}
        <section className="flex gap-2 flex-wrap">
          {["India", "World", "Markets", "Tech", "Sports", "Quick hits"].map((t) => (
            <span
              key={t}
              className="px-3 py-1.5 rounded-full text-[11px] font-semibold bg-white/5 border border-white/10 text-neutral-200"
            >
              {t}
            </span>
          ))}
        </section>

        {/* Made for you rail */}
        <Rail title="Made for you">
          <Cover img={marketsImg} tag="Markets" title="Why the rupee is sliding" len="4 min" />
          <Cover img={worldImg} tag="World" title="Gaza ceasefire, day three" len="6 min" />
          <Cover img={sportsImg} tag="Sports" title="India squad, 2nd Test" len="3 min" />
        </Rail>

        {/* For You list */}
        <section>
          <div className="flex justify-between items-end mb-3">
            <h3 className="text-base font-bold">For you</h3>
            <span className="text-[10px] text-neutral-500 uppercase font-bold tracking-wider">
              See all
            </span>
          </div>
          <div className="space-y-2">
            <RowItem
              img={marketsImg}
              kicker="Global Markets"
              title="Index surge as inflation cooling continues"
            />
            <RowItem
              img={worldImg}
              kicker="World"
              title="EU agrees €50bn aid package; Hungary drops veto"
            />
            <RowItem
              img={sportsImg}
              kicker="Sports"
              title="Bumrah ruled out of Sydney Test with back niggle"
            />
          </div>
        </section>
      </div>

      <BottomDock />
    </>
  );
}

/* ───────────────────── NOW PLAYING ───────────────────── */

function NowPlayingScreen() {
  return (
    <div className="relative h-full flex flex-col overflow-hidden">
      {/* Atmospheric background */}
      <div className="absolute inset-0">
        <img src={heroImg} alt="" className="w-full h-full object-cover opacity-30 blur-2xl" />
        <div className="absolute inset-0 bg-gradient-to-b from-indigo-950/40 via-black/80 to-black" />
      </div>

      <div className="relative z-10 flex flex-col h-full">
        <div className="pt-12 px-5 flex items-center justify-between">
          <ChevronRight className="w-5 h-5 rotate-180 text-white/70" />
          <span className="text-[10px] font-bold uppercase tracking-[0.3em] text-indigo-300">
            Today's Briefing · Story 3 of 8
          </span>
          <Bookmark className="w-5 h-5 text-white/70" />
        </div>

        {/* The orb */}
        <div className="flex-1 flex items-center justify-center">
          <Orb />
        </div>

        {/* Now playing meta */}
        <div className="px-6 pb-6 space-y-5">
          <div className="text-center">
            <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-indigo-300 mb-2">
              Markets · 4 min
            </p>
            <h3 className="text-lg font-bold leading-snug">
              Sensex jumps 612 pts as IT and banking stocks rally; rupee at 83.21
            </h3>
            <p className="text-xs text-neutral-400 mt-2">Khabar AI · Voice of Aanya</p>
          </div>

          {/* waveform / progress */}
          <div>
            <div className="flex items-end justify-between h-8 gap-[2px]">
              {Array.from({ length: 48 }).map((_, i) => {
                const playedRatio = i / 48;
                const played = playedRatio < 0.42;
                const h = 4 + Math.abs(Math.sin(i * 0.7)) * 24;
                return (
                  <div
                    key={i}
                    style={{ height: `${h}px` }}
                    className={`w-[3px] rounded-full ${
                      played ? "bg-indigo-400" : "bg-white/15"
                    }`}
                  />
                );
              })}
            </div>
            <div className="flex justify-between mt-2 text-[10px] text-neutral-500 font-mono">
              <span>1:42</span>
              <span>4:08</span>
            </div>
          </div>

          {/* Controls */}
          <div className="flex items-center justify-between">
            <button className="text-white/70 text-[11px] font-semibold uppercase tracking-wider">
              Save
            </button>
            <div className="flex items-center gap-6">
              <SkipBack className="w-6 h-6 text-white" />
              <button className="w-14 h-14 rounded-full bg-white grid place-items-center shadow-lg">
                <Pause className="w-6 h-6 text-black fill-current" />
              </button>
              <SkipForward className="w-6 h-6 text-white" />
            </div>
            <button className="text-white/70 text-[11px] font-semibold uppercase tracking-wider">
              Tell&nbsp;more
            </button>
          </div>

          {/* Mic hint */}
          <div className="flex items-center justify-center gap-2 text-[11px] text-indigo-200/80">
            <Mic className="w-3.5 h-3.5" />
            <span>Just say "next" to skip ahead</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Orb() {
  return (
    <div className="relative w-56 h-56">
      <motion.div
        className="absolute inset-0 rounded-full bg-indigo-500/30 blur-3xl"
        animate={{ scale: [1, 1.15, 1], opacity: [0.5, 0.8, 0.5] }}
        transition={{ duration: 3.5, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.div
        className="absolute inset-6 rounded-full"
        style={{
          background:
            "radial-gradient(circle at 30% 30%, #ffd7a8, #c879ff 40%, #4f46e5 75%, #0a0a1a)",
          boxShadow: "0 0 80px rgba(139,92,246,0.55), inset 0 0 60px rgba(255,255,255,0.15)",
        }}
        animate={{ scale: [1, 1.04, 1] }}
        transition={{ duration: 2.4, repeat: Infinity, ease: "easeInOut" }}
      />
      <div className="absolute inset-0 grid place-items-center">
        <div className="flex items-end gap-1 h-10">
          {[14, 28, 38, 22, 32, 18, 26].map((h, i) => (
            <motion.div
              key={i}
              className="w-1 bg-white/90 rounded-full"
              style={{ height: h }}
              animate={{ scaleY: [0.4, 1, 0.5, 0.9, 0.4] }}
              transition={{ duration: 1.2 + i * 0.12, repeat: Infinity, ease: "easeInOut" }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

/* ───────────────────── LIBRARY ───────────────────── */

function LibraryScreen() {
  return (
    <>
      <TopBar />
      <div className="flex-1 overflow-y-auto no-scrollbar px-5 pb-40 space-y-6">
        <h2 className="text-xl font-bold">Your library</h2>

        {/* Filter chips */}
        <div className="flex gap-2">
          {["Briefings", "Saved", "Topics", "Sources"].map((t, i) => (
            <span
              key={t}
              className={`px-3 py-1.5 rounded-full text-[11px] font-semibold border ${
                i === 0
                  ? "bg-white text-black border-white"
                  : "bg-white/5 text-neutral-300 border-white/10"
              }`}
            >
              {t}
            </span>
          ))}
        </div>

        {/* Topic tiles */}
        <section>
          <h3 className="text-sm font-bold mb-3 text-neutral-300">Topics you follow</h3>
          <div className="grid grid-cols-2 gap-3">
            <TopicTile name="Politics" color="from-rose-500 to-orange-500" />
            <TopicTile name="Business" color="from-emerald-500 to-teal-500" />
            <TopicTile name="Tech" color="from-indigo-500 to-purple-500" />
            <TopicTile name="Sport" color="from-amber-400 to-rose-500" />
            <TopicTile name="Culture" color="from-pink-500 to-fuchsia-500" />
            <TopicTile name="Local" color="from-cyan-400 to-blue-500" />
          </div>
        </section>

        {/* Recent briefings */}
        <section>
          <h3 className="text-sm font-bold mb-3 text-neutral-300">Recent briefings</h3>
          <div className="space-y-2">
            {[
              { d: "Today · Wed", len: "17 min", img: heroImg },
              { d: "Tue", len: "14 min", img: marketsImg },
              { d: "Mon", len: "16 min", img: worldImg },
              { d: "Sun", len: "9 min", img: sportsImg },
            ].map((b) => (
              <div
                key={b.d}
                className="flex items-center gap-3 p-2 rounded-xl bg-white/[0.03] border border-white/5"
              >
                <img
                  src={b.img}
                  className="w-12 h-12 rounded-lg object-cover"
                  alt=""
                  width={48}
                  height={48}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate">Daily briefing — {b.d}</p>
                  <p className="text-[10px] text-neutral-500">Khabar AI · {b.len}</p>
                </div>
                <button className="w-8 h-8 rounded-full border border-white/15 grid place-items-center">
                  <Play className="w-3 h-3 fill-current" />
                </button>
              </div>
            ))}
          </div>
        </section>

        {/* Sources */}
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
      <BottomDock />
    </>
  );
}

function TopicTile({ name, color }: { name: string; color: string }) {
  return (
    <div
      className={`relative h-20 rounded-xl overflow-hidden bg-gradient-to-br ${color} p-3 flex items-start`}
    >
      <span className="font-bold text-sm text-white drop-shadow">{name}</span>
      <Sparkles className="absolute bottom-2 right-2 w-4 h-4 text-white/60" />
    </div>
  );
}

/* ───────────────────── Shared pieces ───────────────────── */

function TopBar() {
  return (
    <div className="pt-12 px-5 pb-4 flex justify-between items-center">
      <div className="flex items-center gap-2">
        <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-indigo-500 to-purple-500 grid place-items-center">
          <Radio className="w-4 h-4 text-white" />
        </div>
        <span className="font-bold text-base tracking-tight">Khabar AI</span>
      </div>
      <div className="w-9 h-9 rounded-full bg-neutral-800 grid place-items-center border border-white/5">
        <div className="w-2 h-2 bg-emerald-400 rounded-full animate-pulse" />
      </div>
    </div>
  );
}

function Rail({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex justify-between items-end mb-3">
        <h3 className="text-base font-bold">{title}</h3>
        <span className="text-[10px] text-neutral-500 uppercase font-bold tracking-wider">
          See all
        </span>
      </div>
      <div className="flex gap-3 overflow-x-auto no-scrollbar -mx-5 px-5">{children}</div>
    </section>
  );
}

function Cover({
  img,
  tag,
  title,
  len,
}: {
  img: string;
  tag: string;
  title: string;
  len: string;
}) {
  return (
    <div className="shrink-0 w-36">
      <div className="relative w-36 h-36 rounded-xl overflow-hidden bg-neutral-900 border border-white/5">
        <img src={img} alt="" className="w-full h-full object-cover" width={144} height={144} />
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 to-transparent" />
        <span className="absolute top-2 left-2 text-[9px] font-bold uppercase tracking-wider text-white/90 bg-black/40 backdrop-blur px-1.5 py-0.5 rounded">
          {tag}
        </span>
        <button className="absolute bottom-2 right-2 w-8 h-8 rounded-full bg-white grid place-items-center shadow">
          <Play className="w-3.5 h-3.5 text-black fill-current ml-0.5" />
        </button>
      </div>
      <p className="mt-2 text-xs font-semibold leading-tight line-clamp-2">{title}</p>
      <p className="text-[10px] text-neutral-500 mt-0.5">{len}</p>
    </div>
  );
}

function RowItem({
  img,
  kicker,
  title,
}: {
  img: string;
  kicker: string;
  title: string;
}) {
  return (
    <div className="flex items-center gap-3 p-2.5 rounded-xl bg-white/[0.03] border border-white/5">
      <img
        src={img}
        alt=""
        className="w-14 h-14 rounded-lg object-cover shrink-0"
        width={56}
        height={56}
      />
      <div className="flex-1 min-w-0">
        <p className="text-[10px] text-indigo-300 font-bold uppercase tracking-wider">{kicker}</p>
        <p className="text-sm font-semibold leading-tight truncate">{title}</p>
      </div>
      <button className="w-8 h-8 rounded-full border border-white/15 grid place-items-center shrink-0">
        <Play className="w-3 h-3 fill-current ml-0.5" />
      </button>
    </div>
  );
}

function BottomDock() {
  return (
    <div className="absolute bottom-0 inset-x-0 px-3 pb-3 space-y-2 bg-gradient-to-t from-black via-black/95 to-transparent">
      {/* Mini player */}
      <div className="bg-neutral-900/85 backdrop-blur-xl rounded-2xl border border-white/10 p-2.5 flex items-center gap-3">
        <div className="relative w-10 h-10 grid place-items-center">
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
          <p className="text-[11px] font-bold truncate">Markets Recap · Sensex up 612</p>
          <p className="text-[10px] text-neutral-400 truncate">Today's Briefing · 1:42 / 4:08</p>
        </div>
        <Mic className="w-4 h-4 text-indigo-300" />
        <Pause className="w-5 h-5 text-white fill-current" />
      </div>

      {/* Nav */}
      <nav className="flex justify-around items-center pt-1 pb-2">
        <NavBtn icon={<Home className="w-5 h-5" />} label="Home" active />
        <NavBtn icon={<Search className="w-5 h-5" />} label="Browse" />
        <NavBtn icon={<Library className="w-5 h-5" />} label="Library" />
      </nav>
    </div>
  );
}

function NavBtn({
  icon,
  label,
  active,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center gap-0.5 ${
        active ? "text-white" : "text-neutral-500"
      }`}
    >
      {icon}
      <span className="text-[10px] font-semibold">{label}</span>
    </div>
  );
}
