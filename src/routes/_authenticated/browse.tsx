/**
 * Browse — category tiles + section entry points.
 * 2-col grid of coloured tiles with Lucide icons.
 */
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Newspaper, Flag, Globe, TrendingUp, Laptop,
  Film, Trophy, Microscope, Heart, MapPin,
} from "lucide-react";
import { BottomNav } from "@/components/BottomNav";
import type { SectionId } from "@/lib/news/sources";

export const Route = createFileRoute("/_authenticated/browse")({
  head: () => ({ meta: [{ title: "Browse · Khabar AI" }] }),
  component: BrowsePage,
});

const CATEGORIES: {
  id: SectionId;
  label: string;
  icon: React.ElementType;
  color: string;
}[] = [
  { id: "headlines",     label: "Headlines",     icon: Newspaper,  color: "#4A2FA0" },
  { id: "india",         label: "India",         icon: Flag,       color: "#C94A1E" },
  { id: "world",         label: "World",         icon: Globe,      color: "#0A6B5E" },
  { id: "business",      label: "Business",      icon: TrendingUp, color: "#2D6A1F" },
  { id: "technology",    label: "Technology",    icon: Laptop,     color: "#185FA5" },
  { id: "entertainment", label: "Entertainment", icon: Film,       color: "#8E2A6E" },
  { id: "sports",        label: "Sports",        icon: Trophy,     color: "#A83020" },
  { id: "science",       label: "Science",       icon: Microscope, color: "#1A6B8A" },
  { id: "health",        label: "Health",        icon: Heart,      color: "#C44B6B" },
  { id: "local",         label: "Local",         icon: MapPin,     color: "#6B4E1A" },
];

function BrowsePage() {
  const navigate = useNavigate();

  function goToSection(id: SectionId) {
    // Navigate home — the home page section tabs let the user switch to this section.
    void navigate({ to: "/" });
  }

  return (
    <div
      className="min-h-screen bg-background text-foreground flex flex-col"
      style={{ paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 60px)" }}
    >
      {/* Header */}
      <header
        className="flex items-center justify-between px-5 pb-2"
        style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 1rem)" }}
      >
        <span className="font-serif text-xl tracking-tight">
          Khabar <em className="italic text-primary">AI</em>
        </span>
      </header>

      <div className="flex-1 px-4 py-2 overflow-y-auto">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-3 px-1">
          Browse by topic
        </p>

        {/* 2-col category grid */}
        <div className="grid grid-cols-2 gap-3 mb-6">
          {CATEGORIES.map(({ id, label, icon: Icon, color }) => (
            <button
              key={id}
              onClick={() => goToSection(id)}
              className="relative overflow-hidden rounded-2xl p-4 h-[84px] flex flex-col justify-between text-left transition-transform active:scale-95"
              style={{ backgroundColor: color }}
            >
              <span className="text-[13px] font-semibold text-white leading-tight z-10">
                {label}
              </span>
              <Icon
                className="absolute bottom-2.5 right-2.5 size-7 text-white/40"
                aria-hidden="true"
              />
            </button>
          ))}
        </div>
      </div>

      <BottomNav />
    </div>
  );
}
