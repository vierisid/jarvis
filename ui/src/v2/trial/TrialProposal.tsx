import React, { useEffect, useState } from "react";
import type {
  AuthorityProposal,
  BeatProposal,
  CalendarProposal,
  GoalProposal,
  ProposalLanded,
  TaskProposal,
  WorkflowProposal,
} from "./conductorSession";

/* ═══════════ What the founder is being asked to say yes to ═══════════

   Storyboard frames 05 to 09, all five of them the same card: a header that
   says where it came from, the thing itself, and a footer that says it is
   waiting on them. One component rather than five, because they are one idea:
   Jarvis proposes, the founder says yes, and the real thing lands in the room
   underneath (D18, D22).

   It floats in the conductor's layer rather than living inside each room. The
   layer is `pointer-events: none` and this card keeps it that way: there is
   nothing to click, deliberately. The approval is spoken (D19), and a button
   here would quietly make the conversation optional. The one affordance is the
   line telling them they can just say yes.

   The card sits on the RIGHT of the room surface so the left of the room, where
   the tree, the board and the flow list actually render, stays visible. When
   they say yes the card resolves and dissolves, and their eye moves left to the
   thing that just became real. */

const LANDED_MS = 2200;

export function TrialProposal({
  proposal,
  landed,
}: {
  proposal: BeatProposal | null;
  landed: ProposalLanded | null;
}) {
  // Hold the last card on screen through its resolved frame, so "yes" reads as
  // a thing landing rather than a panel vanishing.
  const [resolved, setResolved] = useState<ProposalLanded | null>(null);
  useEffect(() => {
    if (!landed) return;
    setResolved(landed);
    const t = window.setTimeout(() => setResolved(null), LANDED_MS);
    return () => window.clearTimeout(t);
  }, [landed]);

  if (!proposal && !resolved) return null;

  if (!proposal && resolved) {
    return (
      <div className="tc-prop tc-prop--landed">
        <div className="tc-prop-head">
          <span className="tc-prop-dot is-ok" />
          {LANDED_LABEL[resolved.beat]}
        </div>
        <div className="tc-prop-landed">{resolved.summary}</div>
      </div>
    );
  }

  const p = proposal!;
  const building = p.beat === "workflows" && p.building === true;
  return (
    <div className="tc-prop">
      <div className="tc-prop-head">
        <span className={`tc-prop-dot${building ? " is-run" : ""}`} />
        <span className="tc-prop-from">
          {building ? "building it now" : "proposed · from what you told me"}
        </span>
        {!building && <span className="tc-prop-wait">waiting on you</span>}
      </div>
      <div className="tc-prop-body">
        {p.beat === "goals" && <GoalsCard p={p} />}
        {p.beat === "tasks" && <TasksCard p={p} />}
        {p.beat === "calendar" && <CalendarCard p={p} />}
        {p.beat === "workflows" && <WorkflowCard p={p} />}
        {p.beat === "authority" && <AuthorityCard p={p} />}
      </div>
      <div className="tc-prop-foot">
        {building ? "give it a few seconds" : 'or just say "yes"'}
      </div>
    </div>
  );
}

const LANDED_LABEL: Record<ProposalLanded["beat"], string> = {
  goals: "created just now",
  tasks: "on the board just now",
  calendar: "set just now",
  workflows: "published just now",
  authority: "granted just now",
  agents: "running now",
};

/* ── frame 05 · the OKR tree ── */

function GoalsCard({ p }: { p: GoalProposal }) {
  return (
    <>
      <div className="tc-goal">
        <span className="tc-goal-name">{p.objective}</span>
        <span className="tc-tag">objective</span>
      </div>
      {p.measure && <div className="tc-sub">{p.measure}</div>}
      <ul className="tc-rows">
        {p.keyResults.map((kr, i) => (
          <li key={i}>
            <span className="tc-bullet" />
            <span className="tc-row-name">{kr.title}</span>
            <span className="tc-tag">{kr.measure || "key result"}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/* ── frame 06 · the tasks, including the late one ── */

function TasksCard({ p }: { p: TaskProposal }) {
  return (
    <ul className="tc-rows">
      {p.tasks.map((t, i) => (
        <li key={i} className={t.late ? "is-late" : ""}>
          <span className="tc-bullet" />
          <span className="tc-row-name">{t.what}</span>
          {t.late && <span className="tc-tag is-late">late</span>}
          <span className="tc-tag">{dueLabel(t)}</span>
        </li>
      ))}
    </ul>
  );
}

function dueLabel(t: TaskProposal["tasks"][number]): string {
  if (t.due === null) return t.dueLabel || "no date";
  const d = new Date(t.due);
  const today = new Date();
  const days = Math.round((d.setHours(12, 0, 0, 0) - today.setHours(12, 0, 0, 0)) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "was yesterday";
  const weekday = new Date(t.due).toLocaleDateString(undefined, { weekday: "short" }).toLowerCase();
  return days < 0 ? `was ${weekday}` : weekday;
}

/* ── frame 07 · the hour the brief lands ── */

function CalendarCard({ p }: { p: CalendarProposal }) {
  return (
    <div className="tc-brief">
      <div className="tc-brief-time">
        {String(p.hour).padStart(2, "0")}:{String(p.minute).padStart(2, "0")}
      </div>
      <div className="tc-brief-what">
        morning brief
        <span>every day</span>
      </div>
      {p.because && <div className="tc-sub">{p.because}</div>}
    </div>
  );
}

/* ── frame 08 · the flow, with its steps visible ── */

function WorkflowCard({ p }: { p: WorkflowProposal }) {
  return (
    <>
      <div className="tc-goal">
        <span className="tc-goal-name">{p.name}</span>
        <span className="tc-tag">{p.runsWhen}</span>
      </div>
      <ul className="tc-rows tc-rows--steps">
        {p.steps.map((s, i) => (
          <li key={i}>
            <span className="tc-tag">step {i + 1}</span>
            <span className="tc-row-name">{s}</span>
          </li>
        ))}
      </ul>
      {p.never && <div className="tc-never">never: {p.never}</div>}
    </>
  );
}

/* ── frame 09 · the ladder, and what the number buys ──
   The rungs mirror `AUTHORITY_REQUIREMENTS` in src/roles/authority.ts. Levels
   7 and up are drawn as out of reach rather than merely ungranted, because
   during a trial they are: the daemon clamps to 6 whatever is said out loud
   (D32), and a ladder that looked climbable would be a lie about that. */

const RUNGS: { upTo: number; buys: string }[] = [
  { upTo: 2, buys: "read your things" },
  { upTo: 4, buys: "write and change them, send you a message" },
  { upTo: 6, buys: "run a command, open a browser, drive an app" },
  { upTo: 8, buys: "send email as you, install software" },
  { upTo: 10, buys: "pay for things, delete things" },
];

const TRIAL_CEILING = 6;

function AuthorityCard({ p }: { p: AuthorityProposal }) {
  const buys = RUNGS.filter((r) => r.upTo <= ceilTo(p.level)).map((r) => r.buys);
  const notYet = RUNGS.filter((r) => r.upTo > ceilTo(p.level)).map((r) => r.buys);
  return (
    <>
      <div className="tc-ladder">
        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
          <span
            key={n}
            className={
              n === p.level ? "tc-rung is-here"
                : n < p.level ? "tc-rung is-granted"
                  : n > TRIAL_CEILING ? "tc-rung is-shut"
                    : "tc-rung"
            }
          >
            {n}
          </span>
        ))}
      </div>
      <div className="tc-buys">
        <div>
          <span className="tc-buys-k">without asking</span>
          <span>{buys.join(". ")}.</span>
        </div>
        <div className="is-no">
          <span className="tc-buys-k">still needs your yes</span>
          <span>{notYet.join(". ")}.</span>
        </div>
      </div>
      <div className="tc-never">seven and up is not offered during a trial</div>
    </>
  );
}

/** The rung a level sits on, so level 5 shows everything 6 buys. */
function ceilTo(level: number): number {
  return RUNGS.find((r) => level <= r.upTo)?.upTo ?? 10;
}
