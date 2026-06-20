import { useRouterState } from "@tanstack/react-router";
import { Home, Search, Settings } from "lucide-react";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/",        label: "Home",     Icon: Home     },
  { href: "/browse",  label: "Browse",   Icon: Search   },
  { href: "/settings", label: "Settings", Icon: Settings },
] as const;

export function BottomNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 flex h-[60px] items-center justify-around border-t border-border/50 bg-background/95 backdrop-blur-sm"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      {TABS.map(({ href, label, Icon }) => {
        const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
        return (
          <a
            key={href}
            href={href}
            className={cn(
              "flex flex-col items-center gap-1 text-[10px] font-medium transition-colors px-6 py-1",
              active ? "text-primary" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className={cn("size-[22px]", active && "stroke-[2.5px]")} />
            {label}
          </a>
        );
      })}
    </nav>
  );
}
