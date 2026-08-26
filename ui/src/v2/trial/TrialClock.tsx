import { useEffect, useState } from "react";
import { formatTimeRemaining, type TrialStatus } from "./trialGate";
import "./TrialConductor.css";

/**
 * The 48 hours, and the only thing the trial keeps on screen after the
 * conductor has stood down.
 *
 * D3 and D9 make "48 hours, starting at your first spoken word" something the
 * founder is told plainly, and the microphone gate says it before they speak.
 * When the conducted hour ends the clock is the one part of the trial's own
 * surface that must not go with it: the entitlement is still running, and the
 * founder who has just been handed the shell is exactly the person who needs
 * to know how long they have it for.
 *
 * Recorded honestly, because the last worker flagged it and this brief did not
 * overturn it: D37 says the twelve-hour warning is Jarvis SAYING it out loud,
 * "not a countdown banner", and this is a countdown banner. It is a different
 * claim from the coverage counter that was removed on 26 August (expiry, not
 * position), and the brief for this work says the countdown stays where it
 * lives, so it stays. It is still a decision worth taking deliberately.
 *
 * It re-derives from `expires_at` on a local tick rather than waiting for the
 * daemon to tell it anything: after the stand-down there is no conductor
 * socket pushing `trial_status`, and a clock that froze at the moment of the
 * handover and then read "47h 12m left" for two days would be worse than none.
 */

/** How often the number redraws. A minute is the smallest unit it shows. */
const TICK_MS = 30_000;

/** How often to ask the daemon again, in case the plane changed the grant. */
const REFETCH_MS = 10 * 60_000;

export function TrialClock({
  trial,
  children,
  slot,
}: {
  /** The snapshot the gate already fetched, so the first paint has no gap. */
  trial: TrialStatus | null;
  children?: React.ReactNode;
  /** Anything the trial still wants on screen beside the clock. Today that is
   *  the hotkey card, for the twenty seconds after a handover. */
  slot?: React.ReactNode;
}) {
  const [status, setStatus] = useState<TrialStatus | null>(trial);
  const [, tick] = useState(0);

  useEffect(() => setStatus(trial), [trial]);

  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), TICK_MS);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    let stopped = false;
    const refetch = async () => {
      try {
        const r = await fetch("/api/trial/status");
        if (!stopped && r.ok) setStatus((await r.json()) as TrialStatus);
      } catch {
        // Keep the last good snapshot: the clock is derived from `expires_at`,
        // so a daemon that cannot answer does not stop it being right.
      }
    };
    const id = window.setInterval(() => void refetch(), REFETCH_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, []);

  const remaining = status?.expires_at != null
    ? formatTimeRemaining(Math.max(0, status.expires_at - Date.now()))
    : formatTimeRemaining(status?.ms_remaining ?? null);

  return (
    <>
      {children}
      <div className="tc-layer tc-layer--clock" aria-live="off">
        {slot}
        <div className="tc-foot">
          <span className="tc-foot-clock">
            {status?.started_at ? `48 hours · ${remaining} left` : "48 hours · not started"}
          </span>
        </div>
      </div>
    </>
  );
}
