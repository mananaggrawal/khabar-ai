import { createContext, useContext, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { fetchBriefing } from "@/lib/news/briefing.functions";
import { useMonologue } from "@/hooks/useMonologue";
import type { DailyBriefing } from "@/lib/news/generator";

interface PlayerContextValue {
  briefing: DailyBriefing | null;
  isLoading: boolean;
  mono: ReturnType<typeof useMonologue>;
  showPlayer: boolean;
  setShowPlayer: (v: boolean) => void;
}

const PlayerContext = createContext<PlayerContextValue | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [showPlayer, setShowPlayer] = useState(false);
  const fetchFn = useServerFn(fetchBriefing);

  const briefingQuery = useQuery({
    queryKey: ["briefing", "today"],
    queryFn: () => fetchFn({ data: undefined as never }),
    staleTime: 5 * 60 * 1000,
  });

  const briefing = briefingQuery.data ?? null;
  const mono = useMonologue({ briefing });

  return (
    <PlayerContext.Provider value={{
      briefing,
      isLoading: briefingQuery.isLoading,
      mono,
      showPlayer,
      setShowPlayer,
    }}>
      {children}
    </PlayerContext.Provider>
  );
}

export function usePlayer() {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error("usePlayer must be used within PlayerProvider");
  return ctx;
}
