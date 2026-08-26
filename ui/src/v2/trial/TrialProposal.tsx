import React, { useEffect, useState } from "react";
import type {
  AuthorityProposal,
  BeatProposal,
  CalendarProposal,
  EditProposal,
  FilesProposal,
  GoalProposal,
  ProposalLanded,
  TaskProposal,
  WorkflowProposal,
  WorkspaceProposal,
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
  // The reading card is the one card that is not waiting on anything once it
  // has started: the founder already said yes and it is working. It keeps the
  // same shape so the surface does not change under them, and counts up.
  const reading = p.beat === "files" && p.reading === true;
  const working = building || reading;
  return (
    <div className="tc-prop">
      <div className="tc-prop-head">
        <span className={`tc-prop-dot${working ? " is-run" : ""}`} />
        <span className="tc-prop-from">
          {building ? "building it now"
            : reading ? "reading your files now"
              : p.beat === "files" ? "it would read this · nothing has been read"
                : p.beat === "workspace" ? "proposed · from what it read"
                  : "proposed · from what you told me"}
        </span>
        {!working && <span className="tc-prop-wait">waiting on you</span>}
      </div>
      <div className="tc-prop-body">
        {p.beat === "goals" && <GoalsCard p={p} />}
        {p.beat === "tasks" && <TasksCard p={p} />}
        {p.beat === "calendar" && <CalendarCard p={p} />}
        {p.beat === "workflows" && <WorkflowCard p={p} />}
        {p.beat === "authority" && <AuthorityCard p={p} />}
        {p.beat === "files" && <FilesCard p={p} />}
        {p.beat === "workspace" && p.kind === "workspace" && <WorkspaceCard p={p} />}
        {p.beat === "workspace" && p.kind === "edit" && <EditCard p={p} />}
      </div>
      <div className="tc-prop-foot">
        {building ? "give it a few seconds"
          : reading ? "it keeps going while you talk"
            : 'or just say "yes"'}
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
  files: "reading now",
  workspace: "written just now",
  agents: "running now",
};

/* ── frame 05 · the OKR tree ── */

function GoalsCard({ p }: { p: GoalProposal }) {
  return (
    <>
      <div className="tc-goal">
        <span className="tc-goal-name">{p.objective}</span>
        <span className="tc-tag">{p.deadlineLabel || "objective"}</span>
      </div>
      {p.measure && <div className="tc-sub">{p.measure}</div>}
      <ul className="tc-rows">
        {p.keyResults.map((kr, i) => (
          <li key={i}>
            <span className="tc-bullet" />
            <span className="tc-row-name">{kr.title}</span>
            {/* Today against target is the whole point of this beat: a founder
                looking at "9 → 40" is looking at a gap, not an aspiration. */}
            <span className="tc-tag">
              {kr.today
                ? `${kr.today}${kr.target ? ` → ${kr.target}` : ""}`
                : kr.target || kr.measure || "needs today's number"}
            </span>
          </li>
        ))}
      </ul>
      {p.firstMove && (
        <div className="tc-never">
          first move: {p.firstMove.what}
          {p.firstMove.dueLabel ? ` · ${p.firstMove.dueLabel}` : ""}
        </div>
      )}
    </>
  );
}

/* ── frame 06 · the tasks, including the late one ── */

function TasksCard({ p }: { p: TaskProposal }) {
  const toward = p.tasks.filter((t) => t.toward).length;
  return (
    <>
      <ul className="tc-rows">
        {[...p.tasks].sort((a, b) => Number(b.first) - Number(a.first)).map((t, i) => (
          <li key={i} className={t.late ? "is-late" : ""}>
            <span className="tc-bullet" />
            <span className="tc-row-name">{t.what}</span>
            {t.first && <span className="tc-tag is-first">first</span>}
            {t.late && <span className="tc-tag is-late">late</span>}
            <span className="tc-tag">{t.toward ? `→ ${t.toward}` : dueLabel(t)}</span>
          </li>
        ))}
      </ul>
      <div className="tc-never">
        {toward} of {p.tasks.length} move the quarter
      </div>
    </>
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
    <>
      <div className="tc-brief">
        <div className="tc-brief-time">
          {String(p.hour).padStart(2, "0")}:{String(p.minute).padStart(2, "0")}
        </div>
        <div className="tc-brief-what">
          morning brief
          <span>every day</span>
        </div>
      </div>
      <div className="tc-brief">
        <div className={`tc-brief-time${p.eveningHour === null ? " is-blank" : ""}`}>
          {p.eveningHour === null ? "--:--" : `${String(p.eveningHour).padStart(2, "0")}:00`}
        </div>
        <div className="tc-brief-what">
          evening review
          <span>{p.eveningHour === null ? "when do you stop?" : "every day"}</span>
        </div>
      </div>
      {p.because && <div className="tc-sub">{p.because}</div>}
    </>
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

/** The carve-outs, in the founder's words rather than the category names.
 *  Mirrors CARVE_OUT_CATEGORIES in src/daemon/trial/beats.ts. */
const CARVE_OUT_SAYS: Record<string, string> = {
  send_message: "messages sent as you",
  execute_command: "commands on your machine",
  write_data: "changes to your files",
  access_browser: "a browser in your accounts",
  control_app: "apps being controlled",
};

function AuthorityCard({ p }: { p: AuthorityProposal }) {
  const buys = RUNGS.filter((r) => r.upTo <= ceilTo(p.level)).map((r) => r.buys);
  const notYet = RUNGS.filter((r) => r.upTo > ceilTo(p.level)).map((r) => r.buys);
  const kept = (p.alwaysAsk ?? []).map((id) => CARVE_OUT_SAYS[id] ?? id);
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
          {/* Their carve-out first, because it is the half they chose. */}
          <span>{[...kept, ...notYet].join(". ")}.</span>
        </div>
      </div>
      <div className="tc-never">
        {kept.length === 0
          ? "what do you want to keep your hand on?"
          : "seven and up is not offered during a trial"}
      </div>
    </>
  );
}

/** The rung a level sits on, so level 5 shows everything 6 buys. */
function ceilTo(level: number): number {
  return RUNGS.find((r) => level <= r.upTo)?.upTo ?? 10;
}

/* ── D42 · exactly what is about to be read, before they answer ── */

function FilesCard({ p }: { p: FilesProposal }) {
  return (
    <>
      <div className="tc-goal">
        <span className="tc-goal-name tc-path">{p.folder}</span>
        <span className="tc-tag">{p.reading ? "reading" : `${p.willRead} of ${p.total}`}</span>
      </div>
      <div className="tc-sub">{p.what}</div>
      <ul className="tc-rows tc-rows--steps">
        {p.sample.map((f, i) => (
          <li key={i}>
            <span className="tc-tag">file</span>
            <span className="tc-row-name tc-path">{f}</span>
          </li>
        ))}
        {p.willRead > p.sample.length && (
          <li>
            <span className="tc-tag">and</span>
            <span className="tc-row-name">{p.willRead - p.sample.length} more</span>
          </li>
        )}
      </ul>
      <div className="tc-never">
        {p.reading
          ? `${p.found ?? 0} things about your company so far · nothing is changed, only read`
          : "read only · nothing is moved, changed or sent anywhere"}
      </div>
    </>
  );
}

/* ── D43 · the organised copy, and the one real piece of work ── */

function WorkspaceCard({ p }: { p: WorkspaceProposal }) {
  const total = p.sections.reduce((n, s) => n + s.files.length, 0);
  return (
    <>
      <div className="tc-goal">
        <span className="tc-goal-name tc-path">{p.destination}</span>
        <span className="tc-tag">{total} files</span>
      </div>
      <ul className="tc-rows">
        {p.sections.map((s, i) => (
          <li key={i}>
            <span className="tc-bullet" />
            <span className="tc-row-name">{s.name}</span>
            <span className="tc-tag">{s.files.length}</span>
          </li>
        ))}
      </ul>
      {/* The one line on this card that matters most, and the reason it is a
          line on the card and not only a sentence Jarvis says. */}
      <div className="tc-never">
        copies only · nothing in {p.source} is moved, renamed or deleted
      </div>
    </>
  );
}

function EditCard({ p }: { p: EditProposal }) {
  return (
    <>
      <div className="tc-goal">
        <span className="tc-goal-name tc-path">{p.file}</span>
        <span className="tc-tag">rewrite</span>
      </div>
      <div className="tc-sub">{p.change}</div>
      <div className="tc-never">
        written as {p.as}, beside yours · your file is not touched
      </div>
    </>
  );
}
