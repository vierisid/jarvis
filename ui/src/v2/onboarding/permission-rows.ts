/**
 * What the Permissions screen shows, derived from what the machine actually
 * reports.
 *
 * The screen this replaces was static: four hardcoded macOS rows whose buttons
 * called window.open("x-apple.systempreferences:...") and whose state was never
 * read. Neither half worked. The sidecar's panel host allowlists http(s) for
 * window.open (isExternallyOpenable in sidecar/panels_extnav.go), so the scheme
 * was dropped and no pane ever opened; and with no status to read, granted and
 * denied looked identical. The rows now come from GET /api/system/permissions,
 * which asks the desktop app on the machine the page is being looked at on.
 *
 * Kept separate from the component because the interesting decisions - which
 * rows exist at all, which of them the user can act on, which are load-bearing
 * enough to warn about - are rules, and this repo has no DOM test
 * infrastructure. Pure functions, tested directly.
 */

/**
 * The wire contract, imported rather than restated. The daemon owns these
 * shapes (src/daemon/system-permissions.ts) and the dashboard already reaches
 * into src/ for shared logic (TasksRoom's parseRelativeDate). Two hand-kept
 * copies of a response type drift the moment either side gains a field, and
 * the drift shows up as a row that silently stops rendering.
 */
export type {
  PermissionGrantMode as PermGrant,
  PermissionRow as PermRow,
  PermissionStatus as PermStatus,
  PermissionsHostInfo as PermHost,
  PermissionsResult as PermReport,
  PermissionsUnavailable as PermUnavailable,
  PermissionRequestResult as PermRequestResult,
} from "../../../../src/daemon/system-permissions";

import type {
  PermissionGrantMode as PermGrant,
  PermissionRow as PermRow,
  PermissionStatus as PermStatus,
  PermissionsResult as PermReport,
  PermissionsUnavailable as PermUnavailable,
  PermissionRequestResult as PermRequestResult,
} from "../../../../src/daemon/system-permissions";

export interface PermCopy {
  label: string;
  body: string;
  /** Key into the wizard's inline SVG map. */
  glyph: string;
  /**
   * A permission whose absence breaks a feature SILENTLY, with no prompt to
   * rescue the user later. That is the whole reason this screen exists, and
   * it is a much smaller set than the old screen implied.
   */
  required: boolean;
}

/**
 * Row copy, by the name the sidecar reports.
 *
 * WHAT IS NOT HERE, deliberately: Automation and "Files & Folders", both of
 * which the old screen listed. Neither can be pre-granted at all - their TCC
 * panes are EMPTY until the app has already tried the thing they gate, so the
 * link showed the user a list Jarvis was not in and could not be added to.
 * macOS prompts for both in the moment, which is the only time they can be
 * answered. (The old "Files & Folders" row also pointed at Privacy_AllFiles,
 * which is Full Disk Access: a far broader grant than the row described.)
 *
 * REQUIRED means silent failure, not importance. Accessibility and Screen
 * Recording have no dialog on macOS: the app registers itself in a list and
 * the user must go and switch it on, and until they do, global hotkeys and
 * screen awareness simply never work, with nothing anywhere saying why. The
 * microphone and notifications both raise a real dialog at the point of use,
 * so a user who skips them here still gets asked later.
 */
export const PERM_COPY: Record<string, PermCopy> = {
  accessibility: {
    label: "Accessibility",
    glyph: "access",
    required: true,
    body: "Global hotkeys like Ctrl+Space, and letting Jarvis operate your apps. macOS won't grant this from a dialog, so until you switch it on the shortcuts quietly do nothing.",
  },
  screen: {
    label: "Screen Recording",
    glyph: "screen",
    required: true,
    body: "Seeing your screen for Awareness: reading what's on it, and noticing when you're stuck.",
  },
  microphone: {
    label: "Microphone",
    glyph: "mic",
    required: false,
    body: "Voice commands and the wake word. Jarvis will ask again the first time you talk to it.",
  },
  notifications: {
    label: "Notifications",
    glyph: "bell",
    required: false,
    body: "Letting Jarvis reach you when something needs a decision.",
  },
};

/** Windows has no per-app permission model, so its one row carries a link and
 *  no state. Worth carrying anyway: with that global switch off, capture just
 *  fails and no prompt arrives to explain it. */
const WINDOWS_MIC_BODY =
  "Windows keeps one switch for every desktop app, and it can't be read from here. If the mic stays silent, check it is on.";

export interface DisplayRow extends PermCopy {
  name: string;
  status: PermStatus;
  /**
   * How this row is obtained, which the button has to say out loud. "Allow"
   * on a row that actually sends you to System Settings is a small lie that
   * costs the user the trip: they click expecting a dialog, a window they did
   * not ask for appears, and nothing explains what to do in it.
   */
  grant: PermGrant;
  /** Can the user do anything about this row from the screen? */
  actionable: boolean;
  /**
   * Does this row have a state worth drawing a dot for? False on Windows,
   * where the mic row is a link to a switch whose position we cannot see -
   * and a dot that never changes colour is worse than no dot.
   */
  hasState: boolean;
}

/**
 * The rows to render, in the order they should appear.
 *
 * Ordered by what the user should deal with first: the two that fail silently,
 * then the two that will ask again on their own. That is deliberately NOT the
 * order the sidecar reports them in - the report's order is a wire contract,
 * this one is an editorial judgement about attention.
 */
const DISPLAY_ORDER = ["accessibility", "screen", "microphone", "notifications"];

export function displayRows(report: PermReport): DisplayRow[] {
  if (!report.available) return [];
  const byName = new Map(report.permissions.map((p) => [p.name, p]));
  const windows = report.platform === "windows";

  const rows: DisplayRow[] = [];
  for (const name of DISPLAY_ORDER) {
    const row = byName.get(name);
    const copy = PERM_COPY[name];
    // An unknown name from a newer sidecar has no copy to render it with;
    // skipping beats inventing a label for a permission this build has never
    // heard of.
    if (!row || !copy) continue;

    const actionable = row.grant !== "none";
    const hasState = row.status !== "na";
    // Nothing to show and nothing to do. This is every row on Linux, and three
    // of the four on Windows.
    if (!actionable && !hasState) continue;

    rows.push({
      ...copy,
      name,
      status: row.status,
      grant: row.grant,
      actionable,
      hasState,
      // A row with no readable state cannot be "required": the screen would be
      // asserting something is missing when it cannot tell.
      required: copy.required && hasState,
      body: windows && name === "microphone" ? WINDOWS_MIC_BODY : copy.body,
    });
  }
  return rows;
}

/**
 * What a request attempt should say, if anything.
 *
 * Extracted as a pure function because this is where the screen's whole point
 * lives: the route answers HTTP 200 for every `available: false` outcome, so
 * a wedged sidecar, a machine that just disconnected, and a refusal all arrive
 * as a successful fetch. Reading only `r.ok` leaves the button resetting to
 * its label with nothing said - which is precisely the silent click this
 * change exists to delete. Pure, so a test can fail on it; the hook itself has
 * no DOM harness to be tested in.
 */
export function requestFeedback(result: PermRequestResult | null, label: string): string | null {
  if (!result) return "Jarvis sent an answer this page couldn't read.";

  if (!result.available) {
    const copy = unavailableCopy(result.reason);
    return result.detail ? `${copy.title} ${result.detail}` : copy.title;
  }

  // A pane that did not open is the original bug wearing a new hat: the user
  // is told to flip a switch in a window that never appeared. Name the pane so
  // the trip is still makeable by hand.
  if (result.grant === "pane" && !result.paneOpened) {
    const where = `System Settings \u203A Privacy & Security \u203A ${label}`;
    return result.paneError
      ? `Jarvis couldn't open ${where} (${result.paneError}). Open it yourself.`
      : `Jarvis couldn't open ${where}. Open it yourself.`;
  }
  return null;
}

/** The required rows still not granted. Drives the summary line, not a block:
 *  a machine under MDM may never be able to grant these, and onboarding that
 *  cannot be finished is worse than a feature that is off. */
export function outstandingRequired(rows: DisplayRow[]): DisplayRow[] {
  return rows.filter((r) => r.required && r.status !== "granted");
}

/** True once nothing on screen is left to do. */
export function allSettled(rows: DisplayRow[]): boolean {
  return rows.every((r) => !r.hasState || r.status === "granted");
}

/**
 * Screen Recording is the one grant that does not take effect where it is
 * made: macOS hands a running process its old answer until the app restarts,
 * so the row stays amber after the user has switched it on and looks broken.
 * Say so, but only once they have actually been sent to that pane.
 */
export function needsRestartNote(rows: DisplayRow[], visitedScreenPane: boolean): boolean {
  return visitedScreenPane && rows.some((r) => r.name === "screen" && r.status !== "granted");
}

/** What to say when there is no machine to ask. Each reason sends the user
 *  somewhere different, which is the only reason they are distinguished. */
export function unavailableCopy(reason: PermUnavailable): { title: string; body: string } {
  switch (reason) {
    case "offline":
      return {
        title: "Jarvis isn't running on this machine right now.",
        body: "The desktop app has to be open for permissions to be read or granted. Start it and this page will catch up on its own.",
      };
    case "refused":
      return {
        title: "That can't be granted from here.",
        body: "The desktop app declined the request. Its message is below; System Settings can still do it by hand.",
      };
    case "unsupported":
      return {
        title: "Your desktop app is older than this screen.",
        body: "Update Jarvis on this machine to grant permissions from here. Until then, the desktop app asks for what it needs as it goes.",
      };
    case "ambiguous":
      return {
        title: "More than one machine is connected.",
        body: "Permissions belong to one computer, and this page can't tell which one you're at. Open Jarvis on that machine and run through setup there.",
      };
    case "unreachable":
      return {
        title: "The desktop app didn't answer.",
        body: "It may have just quit or gone to sleep. You can carry on — Jarvis asks for what it needs as it goes — or reopen it and come back.",
      };
    case "no_sidecar":
    default:
      return {
        title: "Nothing to set up from here.",
        body: "This page isn't talking to a Jarvis desktop app, so there's nothing on this computer to grant. Install or open Jarvis on the machine you want it to act on.",
      };
  }
}
