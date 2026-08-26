import React, { useEffect, useState } from "react";
import type {
  AgentProposal,
  AuthorityProposal,
  BeatProposal,
  CalendarProposal,
  EditProposal,
  FilesProposal,
  GoalProposal,
  HandoverProposal,
  ProposalLanded,
  TaskProposal,
  WorkflowProposal,
  WorkspaceProposal,
} from "./conductorSession";

/* ═══════════ What the founder is being asked to say yes to ═══════════

   Storyboard frames 05 to 10, all of them the same card: a header that says
   where it came from, the thing itself, and a footer that says it is waiting
   on them. One component rather than nine, because they are one idea: Jarvis
   proposes, the founder says yes, and the real thing lands in the room
   underneath (D18, D22).

   It floats in the conductor's layer rather than living inside each room. The
   layer is `pointer-events: none` and this card keeps it that way: there is
   nothing to click, deliberately. The approval is spoken (D19), and a button
   here would quietly make the conversation optional. The one affordance is the
   line telling them they can just say yes.

   The card sits on the RIGHT of the room surface so the left of the room, where
   the tree, the board and the flow list actually render, stays visible. When
   they say yes the card resolves and dissolves, and their eye moves left to the
   thing that just became real.

   ── Why it was rebuilt on 26 August ──

   Vieri, after the second full run: *"when there is a lot of writing in it, it
   becomes very confusing and you can't really read."* Three things were wrong
   and all three were structural rather than a matter of length:

   1. EVERY ROW PUT CONTENT AND METADATA ON ONE LINE, and the metadata was
      `flex-shrink: 0; white-space: nowrap`. So a key result whose number was
      "4 a month → 12 a month", or a task pointing at a key result called
      "booked demos with studios over twenty seats", took the whole width and
      squeezed the actual sentence into one word per line. That is not a
      density problem, it is a layout that gets WORSE the more real the content
      is. Rows are now two lines: the sentence owns the full width, its
      machine-truth sits underneath in mono, and nothing can squeeze anything.

   2. NOTHING WAS RANKED. The objective, the key results, the first move and
      the safety line were all within 2px of each other in size, and the two
      most load-bearing sentences on the whole surface, "never send anything
      without you reading it" and "nothing is moved or deleted", were the
      SMALLEST and palest things on the card. There are now three registers,
      taken off the brand book's type scale: the decision, the detail, and the
      machine truth. A founder scanning the card reads what they are agreeing
      to before they read anything else.

   3. IT WAS NOT THERE AT ALL BELOW 900px (`display: none`). Below that it is
      now a sheet at the top of the screen, because a founder approving a write
      into their own company has to be able to read it.

   The answer to "too much writing" is NOT to show less of their own work. They
   are approving what is about to go into their company, so they have to be
   able to read all of it: the card is a flex column with a pinned head and
   foot and a scrolling middle, so "waiting on you" never scrolls away from a
   long tree. */

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
          <span className="tc-prop-from">{LANDED_LABEL[resolved.beat]}</span>
        </div>
        <div className="tc-prop-body">
          <div className="tc-prop-landed">{resolved.summary}</div>
        </div>
      </div>
    );
  }

  const p = proposal!;
  const building = p.beat === "workflows" && p.building === true;
  // Three cards are not waiting on anything once they have started: the founder
  // already said yes and the thing is working. They keep the same shape so the
  // surface does not change under them, and count up instead of asking.
  const reading = p.beat === "files" && p.reading === true;
  const running = p.beat === "agents" && p.running === true;
  // The handover asks for nothing. It is the one card in the trial that is not
  // waiting on a spoken yes: what it wants is a keystroke, and once that has
  // happened it is a reference rather than a question (D28).
  const handover = p.beat === "handover";
  const working = building || reading || running || handover;
  // Once the conductor has stood down the card is a reference rather than a
  // question, and it moves out of the way of the Talk panel their keystroke
  // just opened. See `.tc-prop--kept`.
  const kept = p.beat === "handover" && p.handedOver === true;
  const fromFiles =
    (p.beat === "goals" || p.beat === "tasks" || p.beat === "calendar" || p.beat === "workflows") &&
    p.fromFiles === true;
  return (
    <div className={`tc-prop${working ? " tc-prop--working" : ""}${kept ? " tc-prop--kept" : ""}`}>
      <div className="tc-prop-head">
        <span className={`tc-prop-dot${working ? " is-run" : ""}`} />
        <span className="tc-prop-from">
          {building ? "building it now"
            : reading ? "reading your files now"
              : running ? "working now, and after you close this"
                : handover ? (p.handedOver ? "yours from here" : p.pressed ? "that is the one" : "how you get me back")
                  : p.beat === "files" ? "nothing read yet"
                    : p.beat === "workspace" ? "from what it read"
                      // D44 put the file beats first, so from here on most of
                      // what is on this card came out of their own documents
                      // rather than out of the conversation. Saying "from what
                      // you told me" over a quarter built from their own plan
                      // would undersell the one thing the reorder bought.
                      : fromFiles ? "from your own files, and what you told me"
                        : "from what you told me"}
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
        {p.beat === "agents" && <AgentCard p={p} />}
        {p.beat === "handover" && <HandoverCard p={p} />}
      </div>
      <div className="tc-prop-foot">
        {building ? "give it a few seconds"
          : reading ? "it keeps going while you talk"
            : running ? "it does not stop when you do"
              : handover
                ? (p.handedOver
                    ? "the 48 hours keep running, and so do I"
                    : p.pressed ? "one second" : "press it and I will get out of your way")
                : 'or just say "yes"'}
      </div>
    </div>
  );
}

const LANDED_LABEL: Record<ProposalLanded["beat"], string> = {
  handover: "yours now",
  goals: "created just now",
  tasks: "on the board just now",
  calendar: "set just now",
  workflows: "published just now",
  authority: "granted just now",
  files: "reading now",
  workspace: "written just now",
  agents: "running now",
};

/* ═════════════════ the three registers every card is built from ═════════════════

   Taken off the brand book's type scale rather than invented here, so the card
   sits in the same system as the rooms behind it:

     Decision   what they are being asked to say yes to. Heading weight, one
                per card, always first, always separated from what follows.
     Item       one thing, on its own line, with its machine truth UNDER it
                rather than beside it. Nothing competes for width.
     Note       the sentence that changes whether a reasonable person agrees:
                the line a flow must never cross, what is not touched, what
                cannot be taken back. Given the amber of the held breath, and
                never the smallest thing on the card. */

function Decision({ title, sub, mono }: { title: string; sub?: string | null; mono?: boolean }) {
  return (
    <div className="tc-decision">
      <div className={`tc-decision-t${mono ? " tc-path" : ""}`}>{title}</div>
      {sub ? <div className="tc-decision-s">{sub}</div> : null}
    </div>
  );
}

function Group({ label, count, children }: { label: string; count?: string; children: React.ReactNode }) {
  return (
    <div className="tc-group">
      <div className="tc-group-h">
        <span>{label}</span>
        {count ? <span className="tc-group-n">{count}</span> : null}
      </div>
      {children}
    </div>
  );
}

/**
 * One thing, two lines.
 *
 * `meta` goes UNDERNEATH and not beside, which is the whole fix: the old row
 * gave a nowrap, non-shrinking tag the width it asked for and let the sentence
 * take whatever was left, so the longer and more real the content was, the
 * more unreadable the card became.
 */
function Item({
  main,
  meta,
  flag,
  tone,
  mono,
}: {
  main: string;
  meta?: React.ReactNode;
  flag?: string | null;
  tone?: "late" | "first" | null;
  mono?: boolean;
}) {
  return (
    <div className={`tc-item${tone ? ` is-${tone}` : ""}`}>
      <div className="tc-item-main">
        {flag ? <span className={`tc-flag${tone ? ` is-${tone}` : ""}`}>{flag}</span> : null}
        <span className={mono ? "tc-path" : undefined}>{main}</span>
      </div>
      {meta ? <div className="tc-item-meta">{meta}</div> : null}
    </div>
  );
}

function Note({
  label,
  tone = "hold",
  children,
}: {
  label: string;
  /** `hold` is the amber of the held breath, waiting on their yes, and is the
   *  default because that is what most of these cards are. `run` is the
   *  speaking blue, for the two notes that describe something already working
   *  and are therefore not asking for anything. */
  tone?: "hold" | "run";
  children: React.ReactNode;
}) {
  return (
    <div className={`tc-note is-${tone}`}>
      <div className="tc-note-k">{label}</div>
      <div className="tc-note-b">{children}</div>
    </div>
  );
}

/* ── frame 05 · the OKR tree ── */

function GoalsCard({ p }: { p: GoalProposal }) {
  const withNumbers = p.keyResults.filter((kr) => kr.today).length;
  return (
    <>
      <Decision title={p.objective} sub={[p.deadlineLabel, p.measure].filter(Boolean).join(" · ") || null} />
      <Group
        label="key results"
        count={withNumbers < p.keyResults.length ? `${withNumbers} of ${p.keyResults.length} have today's number` : undefined}
      >
        {p.keyResults.map((kr, i) => (
          <Item
            key={i}
            main={kr.title}
            // Today against target is the whole point of this beat, so it is
            // set as machine truth rather than as a caption: a founder looking
            // at "9% → under 4%" is looking at a gap they have to close.
            meta={
              kr.today
                ? <><b>{kr.today}</b>{kr.target ? <> <span className="tc-arrow">→</span> <b>{kr.target}</b></> : null}</>
                : <span className="tc-missing">{kr.target ? `→ ${kr.target}, and today is still open` : "needs today's number"}</span>
            }
          />
        ))}
      </Group>
      {p.firstMove && (
        <Note label="first move">
          {p.firstMove.what}
          {p.firstMove.dueLabel ? <span className="tc-note-when">{p.firstMove.dueLabel}</span> : null}
        </Note>
      )}
    </>
  );
}

/* ── frame 06 · the tasks, including the late one ── */

function TasksCard({ p }: { p: TaskProposal }) {
  const toward = p.tasks.filter((t) => t.toward).length;
  const first = p.tasks.find((t) => t.first);
  const rest = [...p.tasks].filter((t) => t !== first).sort((a, b) => Number(b.late) - Number(a.late));
  return (
    <>
      {first
        ? <Decision title={first.what} sub={`first thing · ${first.toward ? `toward ${first.toward}` : dueLabel(first)}`} />
        : <Decision title="Nothing is marked as the one you do first" sub="which one is it?" />}
      <Group label="and the rest of the week" count={`${p.tasks.length} in total`}>
        {rest.map((t, i) => (
          <Item
            key={i}
            main={t.what}
            tone={t.late ? "late" : null}
            flag={t.late ? "late" : null}
            meta={<>{dueLabel(t)}{t.toward ? <> <span className="tc-arrow">→</span> {t.toward}</> : null}</>}
          />
        ))}
      </Group>
      <Note label="against the quarter">
        {toward === 0
          ? "None of these move the thing you said matters this quarter."
          : `${toward} of ${p.tasks.length} move the thing you said matters this quarter.`}
      </Note>
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

/* ── frame 07 · both ends of the day ── */

function CalendarCard({ p }: { p: CalendarProposal }) {
  return (
    <>
      <div className="tc-clocks">
        <div className="tc-clock">
          <div className="tc-clock-t">
            {String(p.hour).padStart(2, "0")}:{String(p.minute).padStart(2, "0")}
          </div>
          <div className="tc-clock-k">morning brief</div>
          <div className="tc-clock-s">waiting for you</div>
        </div>
        <div className="tc-clock">
          <div className={`tc-clock-t${p.eveningHour === null ? " is-blank" : ""}`}>
            {p.eveningHour === null ? "--:--" : `${String(p.eveningHour).padStart(2, "0")}:00`}
          </div>
          <div className="tc-clock-k">evening review</div>
          <div className="tc-clock-s">{p.eveningHour === null ? "when do you stop?" : "the day gets closed off"}</div>
        </div>
      </div>
      {p.because && <div className="tc-because">{p.because}</div>}
    </>
  );
}

/* ── frame 08 · the flow, with its steps visible ── */

function WorkflowCard({ p }: { p: WorkflowProposal }) {
  return (
    <>
      <Decision title={p.name} sub={p.runsWhen} />
      <Group label="what it does" count={`${p.steps.length} steps`}>
        {p.steps.map((s, i) => (
          <Item key={i} main={s} flag={String(i + 1)} />
        ))}
      </Group>
      {/* The sentence that decides whether a reasonable person lets something
          run unattended. It used to be the smallest thing on this card. */}
      {p.never && <Note label="it will never">{p.never}</Note>}
    </>
  );
}

/* ── frame 09 · the ladder, and what the number buys ──
   The rungs mirror `AUTHORITY_REQUIREMENTS` in src/roles/authority.ts. Levels
   7 and up are drawn as out of reach rather than merely ungranted, because
   during a trial they are: the daemon clamps to 6 whatever is said out loud
   (D32), and a ladder that looked climbable would be a lie about that. */

/**
 * One clause per action category rather than one per rung.
 *
 * It used to be per rung, which was fine while the only thing on this card was
 * a number. It is not fine now that the founder carves categories out: a card
 * that said "without asking: send you a message" directly above "still needs
 * your yes: messages sent as you" would be contradicting itself in the one
 * beat that is entirely about what Jarvis is and is not allowed to do.
 *
 * `needs` mirrors AUTHORITY_REQUIREMENTS in src/roles/authority.ts, and the
 * ids mirror CARVE_OUT_CATEGORIES in src/daemon/trial/beats.ts.
 */
const CLAUSES: { id: string; needs: number; buys: string; kept: string }[] = [
  { id: "read_data", needs: 1, buys: "read your things", kept: "reading your things" },
  { id: "write_data", needs: 3, buys: "write and change them", kept: "changes to your files" },
  { id: "send_message", needs: 3, buys: "send you a message", kept: "messages sent as you" },
  { id: "execute_command", needs: 5, buys: "run a command", kept: "commands on your machine" },
  { id: "access_browser", needs: 5, buys: "open a browser", kept: "a browser in your accounts" },
  { id: "control_app", needs: 5, buys: "drive an app", kept: "apps being controlled" },
  { id: "send_email", needs: 7, buys: "send email as you", kept: "send email as you" },
  { id: "install_software", needs: 7, buys: "install software", kept: "install software" },
  { id: "make_payment", needs: 9, buys: "pay for things", kept: "pay for things" },
  { id: "delete_data", needs: 9, buys: "delete things", kept: "delete things" },
];

const TRIAL_CEILING = 6;

function AuthorityCard({ p }: { p: AuthorityProposal }) {
  const carved = new Set(p.alwaysAsk ?? []);
  // A category they carved out is NOT something it can do without asking,
  // whatever the number says, so it moves across rather than appearing twice.
  const buys = CLAUSES.filter((c) => c.needs <= p.level && !carved.has(c.id)).map((c) => c.buys);
  const kept = CLAUSES.filter((c) => carved.has(c.id)).map((c) => c.kept);
  const notYet = CLAUSES.filter((c) => c.needs > p.level && !carved.has(c.id)).map((c) => c.kept);
  return (
    <>
      <div className="tc-level">
        <div className="tc-level-n">{p.level}</div>
        <div className="tc-level-k">
          authority
          <span>out of 10</span>
        </div>
      </div>
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
      <Group label="without asking you">
        <div className="tc-clause">{buys.join(". ")}.</div>
      </Group>
      <Group label="still needs your yes">
        {/* Their carve-out first, because it is the half they chose. */}
        <div className="tc-clause is-no">{[...kept, ...notYet].join(". ")}.</div>
      </Group>
      <Note label={kept.length === 0 ? "still to decide" : "during a trial"}>
        {kept.length === 0
          ? "What do you want to keep your hand on anyway?"
          : "Seven and up is not offered during a trial: no email as you, no spending, no deleting."}
      </Note>
    </>
  );
}

/* ── D42 · exactly what is about to be read, before they answer ── */

function FilesCard({ p }: { p: FilesProposal }) {
  return (
    <>
      {/* `says` is their own spelling of the path. Under WSL the daemon opens
          /mnt/c/Users/... and the founder has only ever seen C:\Users\...;
          showing them the first would be showing them somebody else's machine. */}
      <Decision title={p.says || p.folder} sub={p.what} mono />
      <Group
        label={p.reading ? "reading these" : "it would open"}
        count={`${p.willRead} of ${p.total}`}
      >
        {p.sample.map((f, i) => (
          <Item key={i} main={f} mono />
        ))}
        {p.willRead > p.sample.length && (
          <div className="tc-more">and {p.willRead - p.sample.length} more</div>
        )}
      </Group>
      {/* "or sent anywhere" used to be in this sentence and is now gone. The
          reader is a language model: it reads their documents the same way the
          realtime session hears their voice, so that clause was a promise the
          design never made and the code cannot keep. Under D44 the card is on
          screen at minute three instead of minute forty, on a tenth of the
          credit, which makes an overclaim here the most expensive sentence in
          the trial rather than a loose one. The three claims that are left are
          all true by construction: founder-files.ts imports mkdir, copyFile
          and writeFile and nothing else, so there is no rename and no unlink
          in the module to reach for. */}
      <Note label={p.reading ? "so far" : "read only"} tone={p.reading ? "run" : "hold"}>
        {p.reading
          ? `${p.found ?? 0} things about your company, and nothing has been changed.`
          : "Nothing of yours is moved, changed or deleted. It reads, and it stops when you say."}
      </Note>
    </>
  );
}

/* ── D43 · the organised copy, and the one real piece of work ── */

function WorkspaceCard({ p }: { p: WorkspaceProposal }) {
  const total = p.sections.reduce((n, s) => n + s.files.length, 0);
  return (
    <>
      <Decision title={p.saysDestination || p.destination} sub={`${p.sections.length} sections · ${total} files`} mono />
      <Group label="what goes where">
        {p.sections.map((s, i) => (
          <Item key={i} main={s.name} meta={<>{s.about} <span className="tc-arrow">·</span> {s.files.length} files</>} />
        ))}
      </Group>
      {/* The line on this card that matters most, and the reason it is a line
          on the card and not only a sentence Jarvis says out loud. */}
      <Note label="copies only">
        Nothing in {p.saysSource || p.source} is moved, renamed or deleted. Every original stays exactly where it is.
      </Note>
    </>
  );
}

function EditCard({ p }: { p: EditProposal }) {
  return (
    <>
      <Decision title={p.file} sub="one file, rewritten" mono />
      <div className="tc-because">{p.change}</div>
      <Note label="beside yours">
        Written as <span className="tc-path">{p.as}</span>. Your file is not touched, and you can throw this one away.
      </Note>
    </>
  );
}

/* ── D23, D24, D28 · the three keys, and the one they press ──

   This is the last thing the trial's own surface ever draws, and it is doing
   two jobs at once. It is D28's hotkey card, the reference the founder keeps.
   And it is D24's lesson: one of the three is marked, they are asked to press
   it, and it ticks the instant they do, because the acknowledgement is what
   turns a keystroke into a small win.

   ⌘ or Ctrl is decided here rather than by the daemon, which does not know
   what is under the founder's hands. `ctrl+space` is written out as itself on
   every platform because that is what the summon hotkey actually is
   (`src/daemon/index.ts`, `summon_hotkey: 'ctrl+space'`). */

const MOD = typeof navigator !== "undefined" && /mac|iphone|ipad/i.test(navigator.platform || navigator.userAgent)
  ? "⌘"
  : "Ctrl";

function chordLabel(chord: string): string {
  return chord
    .split("+")
    .map((part) => (part === "mod" ? MOD : part === "ctrl" ? "Ctrl" : part === "space" ? "Space" : part.toUpperCase()))
    .join(" ");
}

function HandoverCard({ p }: { p: HandoverProposal }) {
  const press = p.keys.find((k) => k.press);
  return (
    <>
      <Decision
        title={p.handedOver ? "This is yours now" : "Everything here is yours"}
        sub={p.handedOver
          ? "the 48 hours carry on, and so does everything you built"
          : `press ${press ? chordLabel(press.chord) : "Ctrl J"} and I will step aside`}
      />
      <Group label="how you get me">
        {p.keys.map((k) => (
          <div className={`tc-keyrow${k.press ? " is-press" : ""}${k.press && p.pressed ? " is-done" : ""}`} key={k.chord}>
            <kbd className="tc-kbd">{chordLabel(k.chord)}</kbd>
            <div className="tc-keyrow-t">
              <span className="tc-keyrow-what">{k.what}</span>
              <span className="tc-keyrow-where">{k.where}</span>
            </div>
            {k.press && <span className="tc-keyrow-tick">{p.pressed ? "✓" : "press this"}</span>}
          </div>
        ))}
      </Group>
      <Note label={p.handedOver ? "still running" : "nothing ends here"} tone="run">
        {p.handedOver
          ? "Your quarter, your week, your flows and the agent are all where you left them, and I am still on for the rest of the 48 hours."
          : "The trial does not stop. Only the setting-up does."}
      </Note>
    </>
  );
}

/* ── D15 · the finale, and the only card that stays ── */

function AgentCard({ p }: { p: AgentProposal }) {
  return (
    <>
      <Decision title={p.question} sub={p.running ? `${p.agentName ?? "an agent"} is on it` : "nobody has ever had time to answer this"} />
      <Group label="what a useful answer looks like">
        <div className="tc-clause">{p.brief}</div>
      </Group>
      <Note label={p.running ? "running" : "about to run"} tone={p.running ? "run" : "hold"}>
        {p.running
          ? "It keeps working after this conversation ends, and it comes back to you with what it found."
          : "It works in the background and comes back to you with what it found. You do not have to go and look."}
      </Note>
    </>
  );
}
