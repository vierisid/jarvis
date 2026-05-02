import React, { useEffect, useRef, useState } from "react";

export type PebbleState =
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "working";

// "thinking" is intentionally NOT locked — it should follow the cursor like
// idle, since thinking is a transient state where the user has no input
// affordance to interact with. Listening + speaking lock so bubble buttons
// stay clickable.
const LOCKED: ReadonlySet<PebbleState> = new Set(["listening", "speaking"]);

const FOLLOW_FACTOR = 0.10;
const SETTLE_FACTOR = 0.18;

// Cursor never sits on the pebble. Small offset down-right of the pointer.
const CURSOR_OFFSET_X = 18;
const CURSOR_OFFSET_Y = 22;

// In native mode the sidecar moves the entire window to follow the cursor,
// so the pebble div itself stays put. Pinned a few px from the window's
// top-left so the visible disc sits right next to the OS cursor tip
// (which lives just outside the window's TL corner).
const NATIVE_PEBBLE_X = 4;
const NATIVE_PEBBLE_Y = 4;

const WAVE_BARS = 4;
const THINK_DOTS = 3;

// True when the daemon spawned this page with ?native=1, meaning the
// sidecar is doing native cursor-follow at the window level. The page
// should NOT do its own cursor-follow physics in this mode.
const IS_NATIVE = typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("native") === "1";

export function Pebble() {
  const [state, setState] = useState<PebbleState>("idle");
  const stateRef = useRef<PebbleState>("idle");

  const pebbleRef = useRef<HTMLDivElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);

  const x = useRef(window.innerWidth / 2);
  const y = useRef(window.innerHeight / 2);
  const tx = useRef(window.innerWidth / 2);
  const ty = useRef(window.innerHeight / 2);
  const lockedX = useRef(window.innerWidth / 2);
  const lockedY = useRef(window.innerHeight / 2);

  useEffect(() => {
    stateRef.current = state;
    if (LOCKED.has(state)) {
      lockedX.current = x.current;
      lockedY.current = y.current;
    }
  }, [state]);

  useEffect(() => {
    function onMouseMove(e: MouseEvent) {
      tx.current = e.clientX;
      ty.current = e.clientY;
      if (!LOCKED.has(stateRef.current)) {
        lockedX.current = e.clientX + CURSOR_OFFSET_X;
        lockedY.current = e.clientY + CURSOR_OFFSET_Y;
      }
    }

    // Summon chord: Ctrl + left click anywhere (Cmd on macOS).
    function onMouseDown(e: MouseEvent) {
      if (e.button !== 0) return;
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();
      setState((s) => (s === "idle" ? "listening" : "idle"));
    }

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape" && stateRef.current !== "idle") {
        setState("idle");
      }
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    // Native mode: the sidecar moves the entire window every frame, so the
    // pebble + bubble are pinned to fixed screen-relative positions inside
    // the window. The bubble drops *below* the pebble (rather than above as
    // in browser mode) because the window's top edge is closest to the
    // cursor — the pebble sits there and the bubble extends downward into
    // the window.
    if (IS_NATIVE) {
      if (pebbleRef.current) {
        pebbleRef.current.style.left = `${NATIVE_PEBBLE_X}px`;
        pebbleRef.current.style.top = `${NATIVE_PEBBLE_Y}px`;
        // Override the centering transform — pinning to top-left.
        pebbleRef.current.style.transform = "none";
      }
      if (bubbleRef.current) {
        bubbleRef.current.style.left = `${NATIVE_PEBBLE_X - 8}px`;
        bubbleRef.current.style.top = `${NATIVE_PEBBLE_Y + 32}px`;
        bubbleRef.current.style.transform = "none";
      }
      return;
    }

    let raf = 0;
    function tick() {
      const locked = LOCKED.has(stateRef.current);
      const targetX = locked
        ? lockedX.current
        : tx.current + CURSOR_OFFSET_X;
      const targetY = locked
        ? lockedY.current
        : ty.current + CURSOR_OFFSET_Y;
      const factor = locked ? SETTLE_FACTOR : FOLLOW_FACTOR;

      x.current += (targetX - x.current) * factor;
      y.current += (targetY - y.current) * factor;

      if (pebbleRef.current) {
        pebbleRef.current.style.left = `${x.current}px`;
        pebbleRef.current.style.top = `${y.current}px`;
      }
      if (bubbleRef.current) {
        bubbleRef.current.style.left = `${x.current}px`;
        bubbleRef.current.style.top = `${y.current - 30}px`;
      }
      raf = requestAnimationFrame(tick);
    }
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  const showBubble = state === "listening" || state === "speaking";
  const cls =
    "pebble pebble--" + state + (LOCKED.has(state) ? " pebble--locked" : "");

  return (
    <>
      <div ref={pebbleRef} className={cls} aria-hidden>
        <span className="pebble-glyph">
          {state === "idle" && <span className="idle-dot" />}

          {(state === "listening" || state === "speaking") && (
            <span className="wave">
              {Array.from({ length: WAVE_BARS }).map((_, i) => (
                <span key={i} className="wave-bar" style={{ animationDelay: `${i * 0.09}s` }} />
              ))}
            </span>
          )}

          {state === "thinking" && (
            <span className="think">
              {Array.from({ length: THINK_DOTS }).map((_, i) => (
                <span key={i} className="think-dot" style={{ animationDelay: `${i * 0.15}s` }} />
              ))}
            </span>
          )}

          {state === "working" && (
            <span className="working-dot" />
          )}
        </span>

        {state !== "idle" && state !== "thinking" && (
          <span className="pebble-label">
            {state === "listening" && "listening"}
            {state === "speaking" && "speaking"}
            {state === "working" && "working"}
          </span>
        )}
      </div>

      {showBubble && (
        <div ref={bubbleRef} className="pebble-thread">
          <div className="thread-header">
            <span>Thread</span>
            <button
              type="button"
              className="thread-dismiss"
              onClick={() => setState("idle")}
            >
              esc
            </button>
          </div>
          <div className="thread-body">
            <span className="thread-from">jarvis</span>
            {state === "listening" ? "listening — go ahead." : "ready when you are."}
          </div>
          <div className="thread-actions">
            <button
              type="button"
              className="thread-btn thread-btn--primary"
              onClick={() => setState("speaking")}
            >
              Speak it
            </button>
            <button
              type="button"
              className="thread-btn"
              onClick={() => setState("thinking")}
            >
              Think
            </button>
            <button
              type="button"
              className="thread-btn"
              onClick={() => setState("idle")}
            >
              Dismiss
            </button>
          </div>
          <div className="thread-hint">
            <kbd>⌃</kbd>+click anywhere to summon · <kbd>esc</kbd> to dismiss
          </div>
        </div>
      )}
    </>
  );
}
