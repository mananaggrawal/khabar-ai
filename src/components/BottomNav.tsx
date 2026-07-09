import { Link, useRouterState } from "@tanstack/react-router";
import { Home, Bookmark, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { to: "/",         label: "Home",    Icon: Home     },
  { to: "/history",  label: "Saved",   Icon: Bookmark },
  { to: "/settings", label: "Settings", Icon: Settings },
] as const;

export function BottomNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 bg-background/95 backdrop-blur-sm"
      // GPU-layer promotion (2026-07-09) — iOS Safari doesn't always keep a
      // position:fixed element reliably pinned to the viewport during active/
      // momentum scroll using software repaint alone, which is what "the
      // navbar scrolls up when I scroll" actually is. Forcing this onto its
      // own compositing layer makes Safari track it via hardware compositing
      // instead, which is the standard fix for this specific, long-documented
      // class of bug.
      style={{
        paddingBottom: "env(safe-area-inset-bottom, 0px)",
        transform: "translateZ(0)",
        WebkitTransform: "translateZ(0)",
        backfaceVisibility: "hidden",
      }}
    >
      <div className="h-[56px] flex items-center justify-around">
        {TABS.map(({ to, label, Icon }) => {
          const active = to === "/" ? pathname === "/" : pathname.startsWith(to);
          return (
            <Link
              key={to}
              to={to}
              className={cn(
                "flex flex-col items-center gap-1 px-6 text-[10px] font-medium transition-colors",
                active ? "text-primary" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className={cn("size-5", active && "stroke-[2.5px]")} />
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
