import React, { useMemo } from "react";
import "./MicOrb.css";

export type OrbState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "awaiting-approval"
  | "muted";

export interface MicOrbProps {
  state?: OrbState;
  size?: number;
  onClick?: () => void;
  "aria-label"?: string;
}

/**
 * MicOrb — the single persistent voice affordance.
 * Flat vermilion disc with an offset halftone shadow (risograph print metaphor).
 * Per-state behaviors mirror the handoff prototype:
 *   idle               → ambient disc
 *   listening          → breathing ring + horizontal pulse line inside
 *   thinking           → ink disc, three orbiting dots
 *   speaking           → accent disc, waveform bars inside
 *   awaiting-approval  → accent disc + amber ring (--warn)
 *   muted              → paper-2 disc, dashed ink-3 border, slash
 */
export function MicOrb({
  state = "idle",
  size = 130,
  onClick,
  "aria-label": ariaLabel,
}: MicOrbProps) {
  const diskD = size * 0.62;
  const shadowOff = 6;
  const r = diskD / 2;

  const dots = useMemo(() => {
    const out: { x: number; y: number; r: number }[] = [];
    const step = 5;
    for (let y = -r; y <= r; y += step) {
      for (let x = -r; x <= r; x += step) {
        const d = Math.hypot(x, y);
        if (d > r) continue;
        const fade = Math.max(0, 1 - (d / r) * 0.95);
        const dotR = 1.0 * fade;
        if (dotR > 0.3) out.push({ x, y, r: dotR });
      }
    }
    return out;
  }, [r]);

  const discFill =
    state === "muted"
      ? "var(--paper-2)"
      : state === "thinking"
      ? "var(--ink)"
      : "var(--accent)";
  const discStroke = state === "muted" ? "var(--ink-3)" : "none";
  const discDash = state === "muted" ? "4 3" : undefined;

  const innerTone = state === "thinking" ? "var(--paper)" : "var(--paper)";

  return (
    <button
      type="button"
      className="v2-orb"
      onClick={onClick}
      aria-label={ariaLabel ?? `Mic: ${state}`}
      // Phase 7 Pass B — aria-pressed reports the muted toggle state to
      // screen readers; aria-busy reports work-in-progress states so
      // they don't announce as "available action" repeatedly.
      aria-pressed={state === "muted"}
      aria-busy={state === "thinking" || state === "speaking"}
      data-state={state}
    >
      <svg
        className="v2-orb__svg"
        width={size}
        height={size}
        viewBox={`${-size / 2} ${-size / 2} ${size} ${size}`}
      >
        {/* halftone offset shadow */}
        <g transform={`translate(${shadowOff}, ${shadowOff})`}>
          {dots.map((d, i) => (
            <circle key={i} cx={d.x} cy={d.y} r={d.r} fill="var(--ink)" />
          ))}
        </g>

        {/* breathing ring — listening / speaking */}
        {(state === "listening" || state === "speaking") && (
          <circle
            className="v2-orb-anim-breathe"
            cx={0}
            cy={0}
            r={r + 4}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={1.5}
            style={{
              transformOrigin: "center",
              animation: `v2-orb-${state === "listening" ? "breathe-fast" : "breathe"} ${state === "listening" ? "1.4s" : "1.9s"} ease-in-out infinite`,
            }}
          />
        )}

        {/* awaiting-approval — amber ring, slow pulse */}
        {state === "awaiting-approval" && (
          <circle
            className="v2-orb-anim-approve"
            cx={0}
            cy={0}
            r={r + 6}
            fill="none"
            stroke="var(--warn)"
            strokeWidth={2}
            style={{
              transformOrigin: "center",
              animation: "v2-orb-approve 2s ease-in-out infinite",
            }}
          />
        )}

        {/* main disc */}
        <circle
          cx={0}
          cy={0}
          r={r}
          fill={discFill}
          stroke={discStroke}
          strokeWidth={state === "muted" ? 1.5 : 0}
          strokeDasharray={discDash}
        />

        {/* thinking — three orbiting dots inside the dark disc.
            Uses native SVG animateTransform per-circle with explicit `0 0`
            rotation center — avoids CSS transform-box quirks on <g> where
            the group's fill-box offsets the effective pivot. */}
        {state === "thinking" && (
          <g>
            {[0, 1, 2].map((i) => (
              <circle key={i} cx={0} cy={-r / 2} r={3} fill={innerTone}>
                <animateTransform
                  attributeName="transform"
                  type="rotate"
                  from={`${i * 120} 0 0`}
                  to={`${i * 120 + 360} 0 0`}
                  dur="1.6s"
                  repeatCount="indefinite"
                />
              </circle>
            ))}
          </g>
        )}

        {/* speaking — five waveform bars */}
        {state === "speaking" && (
          <g>
            {[
              { x: -16, key: "a" },
              { x: -8,  key: "b" },
              { x: 0,   key: "c" },
              { x: 8,   key: "d" },
              { x: 16,  key: "e" },
            ].map(({ x, key }) => (
              <rect
                key={key}
                className={`v2-orb-anim-wave-${key}`}
                x={x - 1.4}
                y={-12}
                width={2.8}
                height={24}
                rx={1.2}
                fill={innerTone}
                style={{
                  transformOrigin: "center",
                  transformBox: "fill-box",
                  animation: `v2-orb-wave-${key} 0.6s ease-in-out infinite`,
                  animationDelay: `${({ a: 0, b: 0.1, c: 0.2, d: 0.3, e: 0.4 } as Record<string, number>)[key]}s`,
                }}
              />
            ))}
          </g>
        )}

        {/* listening — horizontal pulse line */}
        {state === "listening" && (
          <rect
            className="v2-orb-anim-line"
            x={-r / 2}
            y={-1}
            width={r}
            height={2}
            rx={1}
            fill={innerTone}
            style={{ animation: "v2-orb-line 1.4s ease-in-out infinite" }}
          />
        )}

        {/* muted — slash */}
        {state === "muted" && (
          <line
            x1={-r / 1.6}
            y1={-r / 1.6}
            x2={r / 1.6}
            y2={r / 1.6}
            stroke="var(--ink-3)"
            strokeWidth={2}
            strokeLinecap="round"
          />
        )}
      </svg>
    </button>
  );
}
