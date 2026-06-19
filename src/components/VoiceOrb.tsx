import { useEffect, useRef } from "react";
import { motion } from "motion/react";
import { cn } from "@/lib/utils";

export type OrbState = "idle" | "connecting" | "listening" | "thinking" | "speaking";

interface VoiceOrbProps {
  state: OrbState;
  /** 0..1 input/output volume amplitude */
  amplitude?: number;
  /** Optional frequency data for richer animation */
  frequencyData?: Uint8Array | null;
  onClick?: () => void;
  size?: number;
}

/**
 * Audio-reactive orb inspired by the ElevenLabs conversational agent UI.
 * Layered radial gradients + a canvas metaball pass driven by amplitude/freq.
 */
export function VoiceOrb({
  state,
  amplitude = 0,
  frequencyData,
  onClick,
  size = 280,
}: VoiceOrbProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ampRef = useRef(amplitude);
  const freqRef = useRef<Uint8Array | null>(frequencyData ?? null);
  const stateRef = useRef<OrbState>(state);

  useEffect(() => { ampRef.current = amplitude; }, [amplitude]);
  useEffect(() => { freqRef.current = frequencyData ?? null; }, [frequencyData]);
  useEffect(() => { stateRef.current = state; }, [state]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    ctx.scale(dpr, dpr);

    let raf = 0;
    let t = 0;

    const draw = () => {
      t += 0.012;
      ctx.clearRect(0, 0, size, size);

      const cx = size / 2;
      const cy = size / 2;
      const baseR = size * 0.28;

      const amp = ampRef.current;
      const freq = freqRef.current;
      const s = stateRef.current;

      // Derive 4 blob radii from frequency bins or sine waves
      const bins = [0, 0, 0, 0];
      if (freq && freq.length > 0) {
        const step = Math.floor(freq.length / 4);
        for (let i = 0; i < 4; i++) {
          let sum = 0;
          for (let j = 0; j < step; j++) sum += freq[i * step + j];
          bins[i] = sum / step / 255;
        }
      } else {
        for (let i = 0; i < 4; i++) {
          bins[i] = (Math.sin(t * (1.2 + i * 0.4) + i) + 1) * 0.5 * 0.4;
        }
      }

      const energy = s === "speaking" ? 1 : s === "listening" ? 0.7 : 0.25;
      const reactive = Math.max(amp, 0.05) * energy;

      // Soft outer glow halo
      const haloR = baseR * (1.55 + reactive * 0.5);
      const halo = ctx.createRadialGradient(cx, cy, baseR * 0.6, cx, cy, haloR);
      const glowAlpha = s === "speaking" ? 0.55 : s === "listening" ? 0.4 : 0.22;
      halo.addColorStop(0, `rgba(248, 180, 90, ${glowAlpha})`);
      halo.addColorStop(0.5, `rgba(190, 120, 220, ${glowAlpha * 0.35})`);
      halo.addColorStop(1, "rgba(20, 16, 40, 0)");
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(cx, cy, haloR, 0, Math.PI * 2);
      ctx.fill();

      // Metaball-style overlapping blobs
      ctx.globalCompositeOperation = "lighter";
      for (let i = 0; i < 4; i++) {
        const angle = t * (0.6 + i * 0.18) + (i * Math.PI) / 2;
        const dist = baseR * (0.25 + bins[i] * 0.45 + reactive * 0.3);
        const bx = cx + Math.cos(angle) * dist;
        const by = cy + Math.sin(angle) * dist;
        const br = baseR * (0.55 + bins[i] * 0.5 + reactive * 0.25);

        const grad = ctx.createRadialGradient(bx, by, 0, bx, by, br);
        const hueShift = s === "listening" ? 1 : 0;
        const colors = hueShift
          ? ["rgba(140, 200, 255, 0.85)", "rgba(120, 90, 220, 0.4)", "rgba(20, 16, 40, 0)"]
          : ["rgba(255, 215, 150, 0.9)", "rgba(220, 110, 200, 0.45)", "rgba(20, 16, 40, 0)"];
        grad.addColorStop(0, colors[0]);
        grad.addColorStop(0.5, colors[1]);
        grad.addColorStop(1, colors[2]);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(bx, by, br, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";

      // Bright inner core
      const coreR = baseR * (0.8 + reactive * 0.2);
      const core = ctx.createRadialGradient(
        cx - baseR * 0.15,
        cy - baseR * 0.2,
        0,
        cx,
        cy,
        coreR,
      );
      core.addColorStop(0, "rgba(255, 245, 220, 0.95)");
      core.addColorStop(0.4, "rgba(255, 180, 110, 0.55)");
      core.addColorStop(1, "rgba(120, 60, 180, 0)");
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.fill();

      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Voice orb"
      className={cn(
        "group relative inline-flex items-center justify-center rounded-full",
        "cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
        "transition-transform active:scale-[0.98]",
      )}
      style={{ width: size, height: size }}
    >
      {/* Breathing wrapper */}
      <motion.div
        className="absolute inset-0 rounded-full"
        animate={{
          scale: state === "idle" ? [1, 1.03, 1] : 1,
        }}
        transition={{
          duration: 4.5,
          ease: "easeInOut",
          repeat: state === "idle" ? Infinity : 0,
        }}
      >
        <canvas
          ref={canvasRef}
          style={{ width: size, height: size }}
          className="rounded-full"
        />
      </motion.div>

      {/* Thinking shimmer ring */}
      {state === "thinking" && (
        <span
          className="pointer-events-none absolute inset-[-6px] rounded-full"
          style={{
            background:
              "conic-gradient(from 0deg, transparent 0%, rgba(248,180,90,0.55) 25%, transparent 50%)",
            animation: "orb-spin 1.8s linear infinite",
            maskImage:
              "radial-gradient(circle, transparent 62%, black 64%, black 70%, transparent 72%)",
            WebkitMaskImage:
              "radial-gradient(circle, transparent 62%, black 64%, black 70%, transparent 72%)",
          }}
        />
      )}

    </button>
  );
}
