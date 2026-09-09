/**
 * Execution-environment awareness -- which machines a step can actually land
 * on, and which OS each of them runs.
 *
 * Everything that "does something to a computer" (run_command, the desktop_*
 * tools, read/write_file) either routes to a sidecar or falls back to the
 * brain's own host. Those machines are frequently NOT the same OS: the brain
 * commonly runs on a Linux server or in a container while the user's hands and
 * eyes are a macOS or Windows laptop running the sidecar.
 *
 * Nothing used to tell the LLM that. Composing "open notepad" against a fleet
 * of one MacBook produced `notepad.exe`, which is only discovered when the run
 * fails. This module is the single source for (a) the environment block both
 * the workflow composer's prompts and the agent tool guide render, and (b) the
 * compose-time check that rejects an OS-specific command when no reachable
 * machine runs that OS.
 *
 * This module is pure: it holds no registry handle and reads no global state,
 * so both the composer (which is handed an inventory) and the tool guide can
 * use it, and every rule here is testable without a running daemon. The live
 * inventory itself is assembled by `collectExecutionTargets` in
 * sidecar-route.ts, which owns the sidecar registry handle.
 *
 * Detection is deliberately biased towards precision: a marker only fires on
 * syntax that is unambiguously tied to an OS family, and any target whose OS
 * is unknown (enrolled but never connected) disables the check rather than
 * guessing. A false rejection costs the user a workflow they asked for; a
 * missed one costs a run that fails the way it does today.
 */

/** The three OS families every target maps onto. */
export type OsFamily = "windows" | "macos" | "linux";

/**
 * One machine a step can execute on: a sidecar, or the brain's own host.
 *
 * `arch` is the sidecar's GOARCH (arm64 / amd64). Note the wire/DB field for
 * it is called `platform` (see SidecarInfo) -- it is renamed here because
 * "platform" reads like an OS and the confusion is exactly what this module
 * exists to prevent.
 */
export interface ExecutionTarget {
  /** Sidecar id; empty for the brain host. */
  id: string;
  /** Display name used for the `target` param and in prompt lines. */
  name: string;
  /** GOOS-style value as reported at register: darwin | windows | linux. Null when never connected. */
  os: string | null;
  /** GOARCH-style value: arm64 | amd64 | ... */
  arch?: string | null;
  /** Live connection state. Absent = unknown; the host is always reachable. */
  connected?: boolean;
  /** Capabilities the sidecar advertises (terminal, filesystem, desktop, ...). */
  capabilities?: string[];
  /** True for the brain's own machine -- the fallback when nothing is targeted. */
  isHost?: boolean;
}

/**
 * Map a reported OS string to its family. Accepts GOOS values (the wire
 * format), Node's `process.platform`, and the friendly spellings a human or an
 * older sidecar might have stored.
 */
export function osFamily(os: string | null | undefined): OsFamily | null {
  if (!os) return null;
  const v = os.trim().toLowerCase();
  if (!v) return null;
  if (v.startsWith("win")) return "windows";
  if (v.startsWith("darwin") || v.startsWith("mac") || v === "osx") return "macos";
  if (v.startsWith("linux")) return "linux";
  return null;
}

/** Human label for a family, for prompt and error text. */
export function familyLabel(f: OsFamily): string {
  return f === "windows" ? "Windows" : f === "macos" ? "macOS" : "Linux";
}

/** The brain's own machine as a target, from the running process. */
export function hostTarget(name = "Jarvis host (this brain)"): ExecutionTarget {
  return {
    id: "",
    name,
    os: process.platform,
    arch: process.arch,
    connected: true,
    isHost: true,
  };
}

/**
 * The families a step may end up on when it names no `target`.
 *
 * Sidecars win: `autoTargetForCapability` routes an untargeted call to the
 * first connected sidecar advertising the capability, and the brain host only
 * runs the call when no sidecar can. So the host counts only when there are no
 * sidecars at all -- otherwise a Linux brain would quietly excuse `xdg-open`
 * on a fleet whose only real machine is a Mac.
 *
 * Returns null when any candidate's OS is unknown: an enrolled-but-never-
 * connected sidecar could be running anything, and refusing a flow over a
 * guess is worse than letting it through.
 */
export function reachableFamilies(targets: ExecutionTarget[]): Set<OsFamily> | null {
  const sidecars = targets.filter((t) => !t.isHost);
  const candidates = sidecars.length > 0 ? sidecars : targets.filter((t) => t.isHost);
  if (candidates.length === 0) return null;
  const families = new Set<OsFamily>();
  for (const t of candidates) {
    const f = osFamily(t.os);
    if (!f) return null;
    families.add(f);
  }
  return families;
}

/**
 * Resolve a step's `target` value to a known machine. Mirrors the runtime's
 * own resolution order (`findSidecar` in sidecar-route.ts) -- exact id, then
 * exact name, then substring -- so compose-time validation judges the same
 * machine the run will dispatch to.
 */
export function resolveTarget(
  targets: ExecutionTarget[],
  query: string,
): ExecutionTarget | null {
  const q = query.trim();
  if (!q) return null;
  const byId = targets.find((t) => t.id && t.id === q);
  if (byId) return byId;
  const lower = q.toLowerCase();
  const byName = targets.find((t) => t.name.toLowerCase() === lower);
  if (byName) return byName;
  return targets.find((t) => t.name.toLowerCase().includes(lower)) ?? null;
}

/* --------------------------------------------------------- OS-bound syntax */

interface OsMarker {
  /** How the offending fragment is described back to the model. */
  label: string;
  /** Families this syntax CAN run on. Empty overlap with what's reachable = wrong OS. */
  families: OsFamily[];
  /** Group 1, when the pattern has one, is the fragment quoted back. */
  re: RegExp;
}

/**
 * Shell positions where a word is the thing being RUN rather than an argument
 * to something else: start of the string, after a separator or pipe, inside a
 * substitution, or after a wrapper that takes a command.
 *
 * Program names have to be anchored to one of these. Scanning for them
 * anywhere in the string is what made the first cut of this file reject
 * `rm ~/Downloads/installer.exe` and `echo notepad > names.txt` on a Mac --
 * both perfectly good commands, and a false rejection costs the user the
 * workflow they asked for.
 */
const CMD_POS = String.raw`(?:^|[;&|]\s*|\$\(\s*|\bsudo\s+|\bnohup\s+|\bexec\s+|\bstart\s+)`;

/** A marker for a program name: only counts where a command can start. */
function invocation(label: string, families: OsFamily[], core: string): OsMarker {
  return { label, families, re: new RegExp(`${CMD_POS}(${core})`, "i") };
}

/** A marker for syntax that is OS-bound wherever it appears (paths, env vars). */
function anywhere(label: string, families: OsFamily[], re: RegExp): OsMarker {
  return { label, families, re };
}

/**
 * Syntax that pins a command / path / executable to an OS family.
 *
 * Each entry lists every family it runs on, not just the obvious one, so a
 * cross-platform tool (`brew` on macOS and Linux) is never flagged on a fleet
 * that can run it. Anything a shim might provide on the "wrong" OS (bash
 * builtins under Git Bash, PowerShell aliases) is deliberately absent, and
 * program names are anchored to command position -- see CMD_POS.
 */
const OS_MARKERS: OsMarker[] = [
  // --- Windows ---
  invocation("a Windows executable or script", ["windows"], String.raw`[\w.\\/-]*[\w-]\.(?:exe|bat|cmd|ps1)\b`),
  invocation("PowerShell", ["windows"], String.raw`powershell\b`),
  invocation("the Windows command shell", ["windows"], String.raw`cmd\s+\/[a-z]\b`),
  invocation("a Windows-only app name", ["windows"], String.raw`(?:notepad|mspaint|wordpad|explorer)\b`),
  invocation("a Windows-only utility", ["windows"], String.raw`(?:winget|tasklist|taskkill|wmic|schtasks|regedit|msiexec)\b|reg\s+(?:add|query|delete)\b`),
  anywhere("a Windows drive path", ["windows"], /\b([a-z]:\\)/i),
  anywhere("a Windows environment variable", ["windows"], /(%(?:userprofile|appdata|localappdata|programfiles(?:\(x86\))?|systemroot|windir|temp)%)/i),

  // --- macOS ---
  invocation("an AppleScript invocation", ["macos"], String.raw`osascript\b`),
  invocation("the macOS `open -a` launcher", ["macos"], String.raw`open\s+-a\b`),
  invocation("a macOS-only utility", ["macos"], String.raw`(?:pbcopy|pbpaste|launchctl|sw_vers|diskutil)\b`),
  invocation("the macOS `defaults` command", ["macos"], String.raw`defaults\s+(?:write|read|delete)\b`),
  anywhere("a macOS application bundle path", ["macos"], /(\/Applications\/)/i),
  anywhere("a macOS Library path", ["macos"], /((?:~|\$HOME)\/Library\/)/i),

  // --- Linux ---
  invocation("the Linux `xdg-open` launcher", ["linux"], String.raw`xdg-open\b`),
  invocation("a Linux package manager", ["linux"], String.raw`(?:apt-get|apt|dnf|yum|pacman)\s+(?:install|update|upgrade|remove)\b`),
  invocation("systemd", ["linux"], String.raw`systemctl\b`),
  invocation("a Linux clipboard utility", ["linux"], String.raw`(?:xclip|xsel|wl-copy|wl-paste)\b`),
  anywhere("a Linux home path", ["linux"], /(\/home\/[\w.-]+)/),

  // --- Unix (macOS + Linux) ---
  invocation("Homebrew", ["macos", "linux"], String.raw`brew\s+(?:install|list|update|upgrade)\b`),
  invocation("a Unix privilege escalation", ["macos", "linux"], String.raw`sudo\b`),
  anywhere("a Unix system path", ["macos", "linux"], /(?:^|\s|=|")(\/(?:usr|etc|opt|var)\/)/i),
  anywhere("a Unix shebang", ["macos", "linux"], /(#!\s*\/(?:usr\/)?bin\/)/),
];

/** One piece of OS-bound syntax found in a value, and where it can run. */
export interface OsConflict {
  /** The matched fragment, verbatim, so the model can see what to change. */
  fragment: string;
  label: string;
  families: OsFamily[];
}

/**
 * Every OS-bound fragment in `value`, whatever OS it belongs to. An empty
 * result means the value is portable -- it says nothing about any particular
 * machine.
 */
export function findOsMarkers(value: string): OsConflict[] {
  const out: OsConflict[] = [];
  for (const marker of OS_MARKERS) {
    const m = marker.re.exec(value);
    if (!m) continue;
    // Group 1 is the fragment itself; group 0 would drag in the separator
    // or wrapper the pattern anchored to ("&& notepad.exe").
    out.push({ fragment: (m[1] ?? m[0]!).trim(), label: marker.label, families: marker.families });
  }
  return out;
}

/**
 * Fragments in `value` that cannot run on any of `reachable`. An empty result
 * means the value is either OS-neutral or fine where it will run.
 */
export function findOsConflicts(value: string, reachable: Set<OsFamily>): OsConflict[] {
  return findOsMarkers(value).filter((m) => !m.families.some((f) => reachable.has(f)));
}

/**
 * Cross-OS equivalents for the handful of apps users ask for by name. Small on
 * purpose: it exists to turn "notepad is wrong" into "use TextEdit", which is
 * the difference between a retry that converges and one that guesses again.
 */
const APP_EQUIVALENTS: Array<{ re: RegExp; by: Record<OsFamily, string> }> = [
  { re: /\bnotepad\b|\bgedit\b|\btextedit\b/i, by: { windows: "Notepad", macos: "TextEdit", linux: "gedit" } },
  { re: /\bcalc\b|\bcalculator\b|\bgnome-calculator\b/i, by: { windows: "calc", macos: "Calculator", linux: "gnome-calculator" } },
  { re: /\bexplorer\b|\bfinder\b|\bnautilus\b/i, by: { windows: "File Explorer", macos: "Finder", linux: "Nautilus" } },
  { re: /\bmspaint\b|\bpaint\b/i, by: { windows: "mspaint", macos: "Preview", linux: "gimp" } },
  { re: /\bcmd\b|\bterminal\b|\bgnome-terminal\b/i, by: { windows: "cmd", macos: "Terminal", linux: "gnome-terminal" } },
];

/**
 * "on macOS use TextEdit" hints for a value naming an app that exists under a
 * different name on the reachable machines. Empty when nothing matches.
 */
export function appEquivalentHints(value: string, reachable: Set<OsFamily>): string[] {
  const hints: string[] = [];
  for (const entry of APP_EQUIVALENTS) {
    if (!entry.re.test(value)) continue;
    for (const f of reachable) hints.push(`on ${familyLabel(f)} use ${entry.by[f]}`);
  }
  return hints;
}

/* ------------------------------------------------------- per-step OS check */

/**
 * Tool params that carry OS-bound syntax, per tool. Only the string params
 * whose CONTENT is interpreted by the target OS -- a command line, an
 * executable name, a filesystem path.
 *
 * Keyed by tool NAME, which makes the check silently dead if a tool is ever
 * renamed. A test asserts every key still exists in the builtin registry with
 * the params named here.
 */
export const OS_SENSITIVE_TOOL_PARAMS: Record<string, string[]> = {
  run_command: ["command", "cwd"],
  desktop_launch_app: ["executable", "args"],
  read_file: ["path"],
  write_file: ["path"],
  list_directory: ["path"],
};

/**
 * OS-fit context: the machines a step can land on plus the families they
 * cover. Built by `osCheckContextFor`, which returns null whenever a verdict
 * would be a guess.
 */
export interface OsCheckContext {
  targets: ExecutionTarget[];
  reachable: Set<OsFamily>;
}

/**
 * Build the OS-fit context, or null when the check can't be trusted -- no
 * inventory, or a machine whose OS was never reported. Rejecting a workflow on
 * a guess is worse than letting the run report the failure.
 */
export function osCheckContextFor(targets: ExecutionTarget[]): OsCheckContext | null {
  if (targets.length === 0) return null;
  const reachable = reachableFamilies(targets);
  if (!reachable || reachable.size === 0) return null;
  return { targets, reachable };
}

/**
 * Blank out `{{...}}` templates before scanning a value: they resolve at run
 * time to something we cannot see, so their contents must not be judged --
 * but the literal text around them (`notepad.exe {{trigger.payload.file}}`)
 * still must be.
 */
function withoutTemplates(value: string): string {
  return value.replace(/\{\{[^}]*\}\}/g, " ");
}

/** Canonical and short spellings of the generic tool-invocation piece. */
function isToolPiece(pieceName: string): boolean {
  return pieceName === "jarvis-tool" || pieceName.endsWith("/piece-jarvis-tool");
}

/**
 * Problems with one `jarvis-tool:invoke` step's OS fit, as messages meant to
 * be read by the model (they name the fix, not just the fault).
 *
 * Two distinct faults:
 *   1. The value cannot run on any machine it could land on -- the
 *      `notepad.exe` on a Mac-only fleet case.
 *   2. The value is OS-specific, the fleet spans more than one OS, and the
 *      step names no `target`. That one is not wrong today but is not
 *      DETERMINISTIC either: an untargeted call goes to whichever connected
 *      sidecar answers for the capability, and falls back to the brain host
 *      when none does. A macOS command is a coin flip on a mixed fleet, so
 *      the step has to say where it means to run.
 *
 * Anything unresolvable -- a templated target, a name matching no machine, a
 * machine whose OS was never reported -- yields nothing rather than a guess.
 */
export function stepOsIssues(
  stepName: string,
  input: Record<string, unknown>,
  ctx: OsCheckContext,
): string[] {
  const toolName = typeof input.toolName === "string" ? input.toolName.trim() : "";
  const paramNames = OS_SENSITIVE_TOOL_PARAMS[toolName];
  if (!paramNames) return [];
  const params =
    input.params && typeof input.params === "object" && !Array.isArray(input.params)
      ? (input.params as Record<string, unknown>)
      : {};

  let reachable = ctx.reachable;
  let pinned = false;
  let where: string;
  const target = typeof params.target === "string" ? params.target.trim() : "";
  if (target) {
    if (target.includes("{{")) return []; // resolved at run time; nothing to judge
    const resolved = resolveTarget(ctx.targets, target);
    if (!resolved) return []; // the runtime reports an unknown target with its own error
    const fam = osFamily(resolved.os);
    if (!fam) return []; // enrolled but never connected -- OS genuinely unknown
    reachable = new Set([fam]);
    pinned = true;
    where = `"${resolved.name}" runs ${familyLabel(fam)}`;
  } else {
    // Name the machines behind the verdict; their family is only worth
    // repeating per machine when more than one family is in play.
    const machines = ctx.targets
      .filter((t) => {
        const f = osFamily(t.os);
        return f !== null && reachable.has(f);
      })
      .map((t) => (reachable.size > 1 ? `"${t.name}" (${familyLabel(osFamily(t.os)!)})` : `"${t.name}"`))
      .join(", ");
    where =
      "this step names no `target`, so it runs on " +
      `${[...reachable].map(familyLabel).join(" / ")}: ${machines}`;
  }

  const issues: string[] = [];
  for (const paramName of paramNames) {
    const raw = params[paramName];
    if (typeof raw !== "string") continue;
    const value = withoutTemplates(raw).trim();
    if (!value) continue;
    const markers = findOsMarkers(value);
    if (markers.length === 0) continue;

    const conflicts = markers.filter((m) => !m.families.some((f) => reachable.has(f)));
    if (conflicts.length > 0) {
      const first = conflicts[0]!;
      const needs = first.families.map(familyLabel).join(" or ");
      const hints = appEquivalentHints(value, reachable);
      issues.push(
        `step "${stepName}" invokes ${toolName} with ${paramName}="${raw}", which needs ` +
          `${needs} (${first.label}: "${first.fragment}"), but ${where}. Rewrite it for that OS` +
          (hints.length > 0 ? ` (equivalent app: ${hints.join(", ")})` : "") +
          `, or set params.target to a machine that runs ${needs}.`,
      );
      continue;
    }

    if (!pinned && reachable.size > 1) {
      const fits = markers[0]!.families.map(familyLabel).join(" or ");
      issues.push(
        `step "${stepName}" invokes ${toolName} with ${paramName}="${raw}", which only runs on ` +
          `${fits} ("${markers[0]!.fragment}"), and ${where}. An untargeted step goes to whichever ` +
          `machine answers first, so set params.target to the one you mean.`,
      );
    }
  }
  return issues;
}

/**
 * The same check over a whole persisted flow tree, for flows this composer
 * never wrote -- ones built or edited by hand in the visual editor. Walks the
 * chain, loop bodies and router branches, and returns one message per problem.
 *
 * Warnings, not errors: a hand-built flow may deliberately target a machine
 * that is not enrolled yet, and refusing to save someone's edit over a
 * heuristic would be worse than the mismatch it prevents.
 */
export function flowOsWarnings(trigger: unknown, ctx: OsCheckContext): string[] {
  const out: string[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown): void => {
    if (typeof node !== "object" || node === null || seen.has(node)) return;
    seen.add(node);
    const step = node as Record<string, unknown>;
    const settings = step.settings as Record<string, unknown> | undefined;
    const pieceName = typeof settings?.pieceName === "string" ? settings.pieceName : "";
    const actionName = typeof settings?.actionName === "string" ? settings.actionName : "";
    if (isToolPiece(pieceName) && actionName === "invoke") {
      const input = settings?.input;
      if (input && typeof input === "object" && !Array.isArray(input)) {
        const name = typeof step.name === "string" ? step.name : "?";
        out.push(...stepOsIssues(name, input as Record<string, unknown>, ctx));
      }
    }
    walk(step.nextAction);
    walk(step.firstLoopAction);
    if (Array.isArray(step.children)) for (const child of step.children) walk(child);
  };
  walk(trigger);
  return out;
}

/* -------------------------------------------------------- prompt rendering */

/** One target as a prompt line: name, OS, arch, reachability, capabilities. */
function targetLine(t: ExecutionTarget): string {
  const fam = osFamily(t.os);
  const os = fam ? familyLabel(fam) : t.os ? t.os : "OS unknown (never connected)";
  const arch = t.arch ? `, ${t.arch}` : "";
  const bits: string[] = [];
  if (t.isHost) {
    bits.push("the brain itself; runs a step only when no sidecar is targeted or connected");
  } else {
    bits.push(t.connected === false ? "OFFLINE" : "connected");
    if (t.capabilities?.length) bits.push(`can: ${t.capabilities.join(", ")}`);
  }
  return `  - "${t.name}" -- ${os}${arch} (${bits.join("; ")})`;
}

/**
 * App-name equivalences as prose, generated from the same table the validator
 * quotes back. One source: a prompt that recommends TextEdit while the checker
 * suggests something else is how a model gets talked in circles.
 */
function appEquivalenceProse(): string {
  return APP_EQUIVALENTS.map((e) =>
    `${e.by.windows} (Windows) / ${e.by.macos} (macOS) / ${e.by.linux} (Linux)`,
  ).join("; ");
}

/**
 * The OS discipline every surface has to state: the composer's prompts and the
 * primary agent's tool guide. Shared so the two cannot drift into
 * contradicting each other -- the tool-guide header calls out exactly that
 * hazard for the piece-install advice, which is repeated in three places by
 * hand.
 *
 * Returned as bare sentences; each caller adds its own bullet or indent.
 */
export function osDisciplineLines(): string[] {
  return [
    "Commands, executable names, and file paths MUST match the OS of the machine they run on.",
    "Do NOT send Windows syntax (`notepad.exe`, `powershell`, `C:\\Users\\...`) to a macOS or Linux " +
      "machine, macOS syntax (`open -a`, `osascript`, `/Applications/...`) to Windows or Linux, or " +
      "Linux syntax (`xdg-open`, `apt-get`, `systemctl`) to Windows or macOS.",
    `App names differ per OS: ${appEquivalenceProse()}.`,
    "Keyboard shortcuts differ too: macOS uses Cmd where Windows and Linux use Ctrl, so a " +
      "`desktop_press_keys` combo must be spelled for the machine it lands on.",
  ];
}

/**
 * The environment block for the composer's prompts: the inventory, then the
 * shared OS discipline, then the routing rules that only apply to a composed
 * step. Returns [] when there is nothing worth saying, so callers can spread
 * it unconditionally.
 */
export function renderExecutionEnvironment(targets: ExecutionTarget[]): string[] {
  if (targets.length === 0) return [];
  const reachable = reachableFamilies(targets);
  const sidecars = targets.filter((t) => !t.isHost);
  const lines = [
    "## Execution environment (machines this workflow runs on)",
    "Any step that runs a command, launches an app, or touches the filesystem lands on one of these:",
    ...targets.map(targetLine),
    "Rules:",
    ...osDisciplineLines().map((l) => `  - ${l}`),
    "  - A step that names no `target` runs on a connected sidecar advertising the capability it needs,",
    "    and only falls back to the brain host when no sidecar can serve it.",
  ];
  if (sidecars.length > 1) {
    lines.push(
      '  - More than one machine is listed: set the tool\'s `target` param to the machine name (e.g. `target: "' +
        (sidecars[0]?.name ?? "") +
        '"`) so the step runs where the user meant. An OS-specific step on a mixed fleet MUST name one.',
    );
  }
  if (reachable && reachable.size > 0) {
    lines.push(
      `  - The machines above run ${[...reachable].map(familyLabel).join(" / ")}. If the request only ` +
        `makes sense on another OS, say what is missing instead of composing it anyway -- a step ` +
        `written for an OS nothing here runs fails on every single run.`,
    );
  }
  return lines;
}
