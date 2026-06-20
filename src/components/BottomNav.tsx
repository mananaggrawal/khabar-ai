import { Link, useRouterState } from "@tanstack/react-router";
import { Home, Search, Library } from "lucide-react";
import { cn } from "@/lib/utils";

export function BottomNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const tabs = [
    { to: "/" as const, label: "Home", Icon: Home },
    { to: "/browse" as const, label: "Browse", Icon: Search },
    { to: "/history" as const, label: "Library", Icon: Library },
  ];

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 flex h-[68px] items-center justify-around border-t border-border bg-background/95 backdrop-blur-sm"
      style={{ paddingBottom: "env(safe-area-inset-bottom, 0px)" }}
    >
      {tabs.map(({ to, label, Icon }) => {
        const active = pathname === to || (to !== "/" && pathname.startsWith(to));
        return (
          <Link
            key={to}
            to={to}
            className={cn(
              "flex flex-col items-center gap-1 text-[10px] transition-colors px-6 py-1",
              active ? "text-foreground" : "text-muted-foreground"
            )}
          >
            <Icon className={cn("size-[22px]", active && "stroke-[2.5]")} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
