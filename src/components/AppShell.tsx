import { BottomNav } from "@/components/BottomNav";
import { MiniPlayer } from "@/components/MiniPlayer";
import { PlayerSheet } from "@/components/PlayerSheet";
import { usePlayer } from "@/contexts/PlayerContext";
import type { ReactNode } from "react";

export function AppShell({ children }: { children: ReactNode }) {
  const { mono } = usePlayer();
  const hasMiniPlayer = mono.state !== "idle";

  return (
    <div className="relative min-h-screen bg-background text-foreground">
      {/* Scrollable content — padded for mini player + nav */}
      <div
        style={{
          paddingBottom: hasMiniPlayer ? "132px" : "72px",
          minHeight: "100svh",
        }}
      >
        {children}
      </div>

      {/* Persistent overlays */}
      <MiniPlayer />
      <BottomNav />
      <PlayerSheet />
    </div>
  );
}
