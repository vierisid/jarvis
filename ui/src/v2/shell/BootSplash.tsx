import React, { useEffect, useRef, useState } from "react";
import "./BootSplash.css";

/* ═══════════════════ Cold-start splash ═══════════════════
   The runtime waking up, shown over the booting app until it's ready. Five
   temperaments (design: usejarvis-loading-screens), one picked per launch by
   a weighted rotation (the Summon is the signature, so it's heaviest). Real
   hairline progress that only completes on the boot-ready signal; a floor so
   it can't flash, an 8s ceiling that turns honest, reduced-motion aware. */

type VariantId = "summon" | "pulse" | "boot" | "pillars" | "stars";

const VARIANTS: Record<VariantId, { name: string; status: string[]; weight: number }> = {
  summon: { name: "The Summon", status: ["starting the brain…", "mounting the vault…", "waking your agents…", "pebble live · :3142"], weight: 4 },
  pulse: { name: "The Heartbeat", status: ["waking the runtime"], weight: 1 },
  boot: { name: "The Boot Log", status: [], weight: 1 },
  pillars: { name: "The Pillars", status: ["bringing the pillars online", "memory · awareness", "action · orchestration", "all systems · live"], weight: 1 },
  stars: { name: "The Constellation", status: ["connecting what it knows", "1,840 facts linked", "context restored"], weight: 1 },
};

const STAR_POS: Array<[number, number, number]> = [
  [8, 18, 0], [24, 72, 0.5], [40, 8, 1.1], [62, 62, 0.4], [80, 22, 1.6], [92, 55, 0.9],
  [16, 48, 2.1], [50, 90, 1.3], [72, 12, 2.4], [88, 82, 0.7], [34, 38, 1.9], [58, 30, 2.7],
];

const MIN_SHOW = 1300;
const CEILING = 8000;
const SAFETY = 12000;

function pickVariant(): VariantId | null {
  let setting = "rotate";
  try { setting = localStorage.getItem("jarvis-startup-anim") || "rotate"; } catch { /* ignore */ }
  if (setting === "none") return null;
  if (setting !== "rotate" && setting in VARIANTS) return setting as VariantId;
  let last = "";
  try { last = localStorage.getItem("jarvis-boot-last") || ""; } catch { /* ignore */ }
  const ids = Object.keys(VARIANTS) as VariantId[];
  const pool = ids.filter((id) => id !== last) ;
  const use = pool.length ? pool : ids;
  const total = use.reduce((s, id) => s + VARIANTS[id].weight, 0);
  let r = Math.random() * total;
  let chosen: VariantId = use[0]!;
  for (const id of use) { r -= VARIANTS[id].weight; if (r <= 0) { chosen = id; break; } }
  try { localStorage.setItem("jarvis-boot-last", chosen); } catch { /* ignore */ }
  return chosen;
}

const Drop = ({ ring }: { ring?: boolean }) => (
  <div className="ldrop"><span className="in" />{ring && <span className="ring" />}</div>
);
const Word = () => <div className="lword"><span className="u">use</span>jarvis</div>;

export function BootSplash() {
  // Lazy state init, not useMemo: pickVariant is impure (Math.random +
  // localStorage write), and StrictMode double-invokes render-phase memos.
  const [variant] = useState(pickVariant);
  const [done, setDone] = useState(variant === null);
  const [out, setOut] = useState(false);
  const [progress, setProgress] = useState(6);
  const [statusIdx, setStatusIdx] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const readyRef = useRef(false);
  const mountRef = useRef(Date.now());

  useEffect(() => {
    // `done` in the deps: after hand-off the component renders null forever —
    // rerun the effect so its cleanup stops the progress/status intervals.
    if (variant === null || done) return;
    const st = VARIANTS[variant].status;
    // real-ish progress, eased toward 90% and never past it until ready
    const prog = window.setInterval(() => setProgress((p) => (p < 90 ? p + (90 - p) * 0.09 + 0.5 : p)), 130);
    const statTimer = st.length > 1 ? window.setInterval(() => setStatusIdx((k) => (k + 1) % st.length), 1400) : 0;
    const ceil = window.setTimeout(() => setBlocked(true), CEILING);

    const pending: number[] = [];
    const handOff = () => {
      if (readyRef.current) return;
      readyRef.current = true;
      const wait = Math.max(0, MIN_SHOW - (Date.now() - mountRef.current));
      pending.push(window.setTimeout(() => {
        setProgress(100);
        pending.push(window.setTimeout(() => {
          setOut(true);
          pending.push(window.setTimeout(() => setDone(true), 260));
        }, 200));
      }, wait));
    };
    window.addEventListener("jarvis:boot-ready", handOff);
    // safety: never let the splash stick if the ready signal is missed
    const safety = window.setTimeout(handOff, SAFETY);

    return () => {
      clearInterval(prog);
      if (statTimer) clearInterval(statTimer);
      clearTimeout(ceil);
      clearTimeout(safety);
      for (const t of pending) clearTimeout(t);
      window.removeEventListener("jarvis:boot-ready", handOff);
    };
  }, [variant, done]);

  if (done || variant === null) return null;

  const st = VARIANTS[variant].status;
  const statusText = blocked ? "still mounting the vault…" : st.length ? st[Math.min(statusIdx, st.length - 1)] : "";

  return (
    <div className={`jboot ${out ? "out" : ""}`} role="status" aria-label="Starting Jarvis" aria-live="polite">
      {variant === "summon" && (
        <div className="lstage st-summon">
          <div className="dropwrap"><div className="lbloom" /><Drop /></div>
          <Word />
          <div className="lstat">{statusText}</div>
          <div className="lbar"><i style={{ width: `${progress}%` }} /></div>
        </div>
      )}

      {variant === "pulse" && (
        <div className="lstage st-pulse">
          <div className="dropwrap"><span className="sonar" /><span className="sonar d2" /><span className="sonar d3" /><Drop /></div>
          <Word />
          <div className="lstat">{statusText}</div>
        </div>
      )}

      {variant === "boot" && (
        <div className="lstage st-boot">
          <div className="blhead"><Drop /><Word /></div>
          <div className="bootlog">
            <div className="bl" style={{ ["--i" as string]: 0 }}><span className="mut">$</span> jarvis start</div>
            <div className="bl" style={{ ["--i" as string]: 1 }}>brain · awake</div>
            <div className="bl" style={{ ["--i" as string]: 2 }}>vault · 1,840 facts mounted</div>
            <div className="bl" style={{ ["--i" as string]: 3 }}>sidecars · 2/2 online</div>
            <div className="bl ok" style={{ ["--i" as string]: 4 }}>✓ pebble live · localhost:3142</div>
          </div>
        </div>
      )}

      {variant === "pillars" && (
        <div className="lstage st-pillars">
          <div className="dropwrap">
            <span className="pmark m-mem">Mem</span><span className="pmark m-awr">Awr</span>
            <span className="pmark m-act">Act</span><span className="pmark m-orc">Orc</span>
            <div className="lbloom" /><Drop ring />
          </div>
          <Word />
          <div className="lstat">{statusText}</div>
        </div>
      )}

      {variant === "stars" && (
        <div className="lstage st-stars">
          <div className="dropwrap">
            {STAR_POS.map(([l, t, d], i) => (
              <span key={i} className="star" style={{ left: `${l}%`, top: `${t}%`, animationDelay: `${d}s` }} />
            ))}
            <div className="lbloom" /><Drop />
          </div>
          <Word />
          <div className="lstat">{statusText}</div>
        </div>
      )}
    </div>
  );
}
