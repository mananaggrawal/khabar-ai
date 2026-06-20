import { Link, useRouterState } from "@tanstack/react-router";
import { Home, Clock, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { to: "/",         label: "Home",     Icon: Home     },
  { to: "/history",  label: "History",  Icon: Clock    },
  { to: "/settings", label: "Settings", Icon: Settings },
] as const;

export function BottomNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 border-t border-border/50 bg-background/95 backdrop-blur-sm"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
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
