import React, { useCallback, useEffect, useRef, useState } from "react";
import { openRoom, useV2Route } from "../router";
import { flightToRow, labelAt, type Rect } from "./dayOneGesture";
import "./TrialDayOne.css";

/**
 * The rest of day one, on screen. Beats 14, 16 and 17, after the conductor has
 * gone.
 *
 * Mounted by TrialClock, which is the trial's only remaining surface once the
 * conducted hour has been handed back, and therefore the only thing still on
 * screen for the other forty-seven hours.
 *
 * It opens its OWN socket rather than threading a message type through the
 * shell's voice hook. That is deliberate and it is the same pattern the
 * panel-mode bridge in AppShellV2 already uses: day one is trial-only, it must
 * not be able to change what a non-trial founder's shell does, and a component
 * nobody mounts is a component that cannot regress anybody.
 */

type Offer = {
  id: string;
  kind: string;
  direction: "inward" | "outward";
  label: string;
  where: string;
  target?: { id?: string; title: string };
};

type AgentBack = {
  kind: "agent_back";
  says: string;
  question: string;
  finding: string | null;
  answered: boolean;
  failure: { kind: string; says: string } | null;
  offers: Offer[];
  agent: { taskId: string | null; agentName: string };
  gesture: { room: string; anchor: string; label: string; holdMs: number } | null;
  permanentHome: string;
};

type DayClose = {
  kind: "day_close";
  says: string;
  summary: string[];
  thin: boolean;
  offers: Offer[];
};

type OfferDone = { kind: "offer_done"; id: string; ok: boolean; says: string };

type Card =
  | { sort: "agent"; data: AgentBack }
  | { sort: "close"; data: DayClose };

/** How long to keep looking for the row before giving the gesture up. The
 *  strip polls the daemon once a second, so a row that has only just settled
 *  can be a second or two behind the message that announced it. */
const ANCHOR_WAIT_MS = 8_000;

export function TrialDayOne() {
  const [card, setCard] = useState<Card | null>(null);
  const [outcome, setOutcome] = useState<OfferDone | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [label, setLabel] = useState<{ left: number; top: number; align: "left" | "right"; text: string } | null>(null);
  const route = useV2Route();
  const routeRef = useRef(route);
  routeRef.current = route;

  /* ── the socket ── */
  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/ws`;
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const connect = () => {
      ws = new WebSocket(url);
      ws.addEventListener("message", (e) => {
        let msg: unknown;
        try { msg = JSON.parse(typeof e.data === "string" ? e.data : ""); } catch { return; }
        const m = msg as { type?: string; payload?: { kind?: string } };
        if (m?.type !== "trial_day_one" || !m.payload) return;
        const p = m.payload as AgentBack | DayClose | OfferDone;
        if (p.kind === "agent_back") {
          setOutcome(null);
          setCard({ sort: "agent", data: p });
        } else if (p.kind === "day_close") {
          setOutcome(null);
          setCard({ sort: "close", data: p });
        } else if (p.kind === "offer_done") {
          setOutcome(p);
          setBusy(null);
        }
      });
      ws.addEventListener("close", () => {
        if (closed) return;
        retry = setTimeout(connect, 2_000);
      });
      ws.addEventListener("error", () => { /* close handles the retry */ });
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      ws?.close();
    };
  }, []);

  /* ── D26, the gesture ──
     The pebble leaves its corner, goes and stands beside the row, holds a
     label there, and drifts back. It is not an instruction and there is no
     sentence anywhere telling the founder to click anything: the whole point
     is that a thing they can see moved to the place they should look. */
  const gesture = card?.sort === "agent" ? card.data.gesture : null;
  useEffect(() => {
    if (!gesture) return;
    let cancelled = false;
    let restore: (() => void) | null = null;

    const run = async () => {
      // The strip first, because the pebble moves BEFORE the thing it is
      // pointing at is on screen only when the thing is already there.
      if (routeRef.current.kind !== "room" || routeRef.current.key !== gesture.room) {
        openRoom(gesture.room as never);
      }
      const row = await waitFor(() =>
        document.querySelector<HTMLElement>(`[data-trial-anchor="${cssEscape(gesture.anchor)}"]`),
      );
      if (cancelled || !row) return;
      const peb = document.querySelector<HTMLElement>(".rs-peb");
      if (!peb) return;

      const from = rectOf(peb);
      const to = rectOf(row);
      const flight = flightToRow(from, to);
      const prevTransform = peb.style.transform;
      const prevTransition = peb.style.transition;
      const prevZ = peb.style.zIndex;
      peb.style.transition = "transform 0.62s cubic-bezier(0.32, 0.72, 0.24, 1)";
      peb.style.zIndex = "260";
      peb.style.transform = `translate(${flight.dx}px, ${flight.dy}px)`;
      const spot = labelAt(from, flight);
      setLabel({ ...spot, text: gesture.label });

      restore = () => {
        peb.style.transform = prevTransform;
        // The transition stays for the drift home and is cleared after it, so
        // the pebble returns the way it went rather than snapping back.
        window.setTimeout(() => {
          peb.style.transition = prevTransition;
          peb.style.zIndex = prevZ;
        }, 700);
        setLabel(null);
      };
      window.setTimeout(() => { if (!cancelled) restore?.(); }, gesture.holdMs || 4_000);
    };

    void run();
    return () => {
      cancelled = true;
      restore?.();
    };
  }, [gesture]);

  const take = useCallback(async (id: string) => {
    setBusy(id);
    try {
      const res = await fetch("/api/trial/day-one/offer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const body = (await res.json()) as { ok?: boolean; says?: string };
      setOutcome({ kind: "offer_done", id, ok: Boolean(body.ok), says: body.says ?? "" });
    } catch {
      setOutcome({ kind: "offer_done", id, ok: false, says: "I could not reach the daemon. Nothing changed." });
    } finally {
      setBusy(null);
    }
  }, []);

  if (!card) return label ? <GestureLabel {...label} /> : null;

  const offers = card.sort === "agent" ? card.data.offers : card.data.offers;

  return (
    <>
      {label && <GestureLabel {...label} />}
      <div className="td1" role="dialog" aria-label="Jarvis">
        <button className="td1-x" aria-label="Dismiss" onClick={() => setCard(null)}>esc</button>

        {card.sort === "agent" ? (
          <>
            <div className="td1-eyebrow">
              {card.data.answered ? "your question came back" : `no answer · ${card.data.failure?.kind ?? "stopped"}`}
            </div>
            <div className="td1-q">{card.data.question}</div>
            <p className="td1-says">{card.data.says}</p>
            {card.data.finding && <div className="td1-finding">{card.data.finding}</div>}
            {/* D26's closing half, said once, where it is useful rather than
                as an instruction: this is where these live from now on. */}
            <div className="td1-home">Everything an agent finds stays in your agents room.</div>
          </>
        ) : (
          <>
            <div className="td1-eyebrow">{card.data.thin ? "the end of day one" : "where your day went"}</div>
            <ul className="td1-day">
              {card.data.summary.map((line, i) => <li key={i}>{line}</li>)}
            </ul>
            <p className="td1-says">Let me take one of them off you.</p>
          </>
        )}

        <div className="td1-offers">
          {offers.map((o) => (
            <button
              key={o.id}
              className={`td1-offer td1-offer--${o.direction}`}
              disabled={busy !== null || outcome?.id === o.id}
              onClick={() => void take(o.id)}
            >
              <span className="td1-offer-label">{busy === o.id ? "doing it…" : o.label}</span>
              <span className="td1-offer-where">{o.where}</span>
            </button>
          ))}
        </div>

        {outcome && (
          <div className={`td1-outcome${outcome.ok ? "" : " td1-outcome--no"}`}>{outcome.says}</div>
        )}
      </div>
    </>
  );
}

function GestureLabel({ left, top, align, text }: { left: number; top: number; align: "left" | "right"; text: string }) {
  return (
    <div
      className={`td1-label td1-label--${align}`}
      style={{ left, top }}
      aria-hidden="true"
    >
      {text}
    </div>
  );
}

function rectOf(el: HTMLElement): Rect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
}

/** Poll for something to appear. Resolves null rather than throwing: a gesture
 *  that cannot find its subject simply does not happen, and the card carries
 *  the whole of the beat's substance on its own. */
async function waitFor<T>(get: () => T | null, timeoutMs = ANCHOR_WAIT_MS): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = get();
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 150));
  }
}

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/"/g, '\\"');
}
