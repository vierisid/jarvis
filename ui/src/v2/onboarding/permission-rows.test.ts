import { describe, expect, test } from "bun:test";
import {
  allSettled,
  displayRows,
  needsRestartNote,
  outstandingRequired,
  PERM_COPY,
  requestFeedback,
  unavailableCopy,
  type PermReport,
  type PermRow,
  type PermUnavailable,
  type PermRequestResult,
} from "./permission-rows";

/** Pure-function tests, the LLMTab.models.test.ts / OnboardingWizard.steps.test.ts
 *  precedent -- this repo has no DOM test infrastructure. The rules ARE the
 *  feature here: the screen this replaces showed four macOS rows unconditionally,
 *  two of which could never be granted from a screen at all. */

const HOST = { id: "sc1", name: "Desk Mac", hostname: "desk.local", source: "panel" as const };

function report(platform: string, rows: PermRow[], bundled = true): PermReport {
  return { available: true, host: HOST, platform, bundled, permissions: rows };
}

const MAC_ROWS: PermRow[] = [
  { name: "notifications", status: "undetermined", grant: "prompt" },
  { name: "microphone", status: "granted", grant: "prompt" },
  { name: "screen", status: "denied", grant: "pane" },
  { name: "accessibility", status: "denied", grant: "pane" },
];

describe("displayRows", () => {
  test("macOS shows all four, ordered by what fails silently first", () => {
    // Not the sidecar's order. Accessibility and Screen Recording have no
    // dialog: skip them and the feature is simply dead, with nothing to say
    // so later. The other two ask again on their own.
    const rows = displayRows(report("darwin", MAC_ROWS));
    expect(rows.map((r) => r.name)).toEqual(["accessibility", "screen", "microphone", "notifications"]);
    expect(rows.map((r) => r.status)).toEqual(["denied", "denied", "granted", "undetermined"]);
  });

  test("Linux shows nothing at all", () => {
    // Every row comes back na/none. Rendering them would give a Linux user
    // four rows that can never go green.
    const rows = displayRows(report("linux", MAC_ROWS.map((r) => ({ ...r, status: "na" as const, grant: "none" as const }))));
    expect(rows).toEqual([]);
  });

  test("Windows shows only the microphone link, with no state and its own copy", () => {
    const rows = displayRows(report("windows", [
      { name: "notifications", status: "na", grant: "none" },
      { name: "microphone", status: "na", grant: "pane" },
      { name: "screen", status: "na", grant: "none" },
      { name: "accessibility", status: "na", grant: "none" },
    ]));
    expect(rows.map((r) => r.name)).toEqual(["microphone"]);
    expect(rows[0]!.actionable).toBe(true);
    expect(rows[0]!.hasState).toBe(false);
    // The macOS sentence promises a prompt that Windows never sends.
    expect(rows[0]!.body).not.toBe(PERM_COPY.microphone!.body);
    expect(rows[0]!.body).toContain("one switch");
  });

  test("a row with no readable state is never marked required", () => {
    // "required" is an assertion that something is missing. A row whose state
    // cannot be read has no business making it.
    const rows = displayRows(report("windows", [
      { name: "accessibility", status: "na", grant: "pane" },
    ]));
    expect(rows[0]!.hasState).toBe(false);
    expect(rows[0]!.required).toBe(false);
  });

  test("a permission name this build has never heard of is skipped", () => {
    // A newer sidecar can report rows this UI has no copy for. Inventing a
    // label for it would be worse than omitting it.
    const rows = displayRows(report("darwin", [
      ...MAC_ROWS,
      { name: "telepathy", status: "denied", grant: "pane" },
    ]));
    expect(rows.map((r) => r.name)).not.toContain("telepathy");
    expect(rows).toHaveLength(4);
  });

  test("each row carries how it is obtained, so the button can say so", () => {
    // "Allow" on a row that actually opens System Settings costs the user the
    // trip: they click expecting a dialog and get a window with no explanation.
    const rows = displayRows(report("darwin", MAC_ROWS));
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.grant]));
    expect(byName).toEqual({
      accessibility: "pane", screen: "pane", microphone: "prompt", notifications: "prompt",
    });
  });

  test("an unavailable report yields no rows", () => {
    expect(displayRows({ available: false, reason: "no_sidecar" })).toEqual([]);
  });

  test("the screen offers exactly four permissions, and required is exactly two", () => {
    // Automation and Files & Folders were on the old screen and could not
    // work: their TCC panes are empty until the app has already asked, so the
    // link showed a list Jarvis was not in. "required" is narrower still --
    // it means the OS never asks and never will, so skipping it kills a
    // feature silently. Widening either set is a product decision, not a
    // refactor, and should have to come through this test.
    expect(Object.keys(PERM_COPY).sort()).toEqual([
      "accessibility", "microphone", "notifications", "screen",
    ]);
    expect(
      Object.entries(PERM_COPY).filter(([, c]) => c.required).map(([k]) => k).sort(),
    ).toEqual(["accessibility", "screen"]);
  });
});

describe("outstandingRequired", () => {
  test("names only the rows that fail silently and are not granted", () => {
    const rows = displayRows(report("darwin", MAC_ROWS));
    expect(outstandingRequired(rows).map((r) => r.name)).toEqual(["accessibility", "screen"]);
  });

  test("the microphone is never outstanding -- macOS asks for it in the moment", () => {
    const rows = displayRows(report("darwin", MAC_ROWS.map(
      (r) => (r.name === "microphone" ? { ...r, status: "denied" as const } : r),
    )));
    expect(outstandingRequired(rows).map((r) => r.name)).not.toContain("microphone");
  });

  test("nothing is outstanding once the two are granted", () => {
    const rows = displayRows(report("darwin", MAC_ROWS.map(
      (r) => (r.grant === "pane" ? { ...r, status: "granted" as const } : r),
    )));
    expect(outstandingRequired(rows)).toEqual([]);
  });
});

describe("allSettled", () => {
  test("false while any readable row is ungranted", () => {
    expect(allSettled(displayRows(report("darwin", MAC_ROWS)))).toBe(false);
  });

  test("true when every readable row is granted", () => {
    const rows = displayRows(report("darwin", MAC_ROWS.map((r) => ({ ...r, status: "granted" as const }))));
    expect(allSettled(rows)).toBe(true);
  });

  test("a stateless row does not hold it open forever", () => {
    // The Windows mic row can never report "granted". Waiting on it would
    // mean the screen never settles on Windows.
    const rows = displayRows(report("windows", [{ name: "microphone", status: "na", grant: "pane" }]));
    expect(allSettled(rows)).toBe(true);
  });
});

describe("needsRestartNote", () => {
  const ungranted = displayRows(report("darwin", MAC_ROWS));
  const granted = displayRows(report("darwin", MAC_ROWS.map(
    (r) => (r.name === "screen" ? { ...r, status: "granted" as const } : r),
  )));

  test("silent until the user has actually been sent to that pane", () => {
    expect(needsRestartNote(ungranted, false)).toBe(false);
  });

  test("shown when they have been and the row is still not granted", () => {
    // macOS keeps handing a running process its old Screen Recording answer,
    // so the row stays amber after the toggle is flipped and reads as broken.
    expect(needsRestartNote(ungranted, true)).toBe(true);
  });

  test("gone once the row is granted", () => {
    expect(needsRestartNote(granted, true)).toBe(false);
  });
});

describe("unavailableCopy", () => {
  test("every reason has its own sentence", () => {
    const reasons: PermUnavailable[] = ["no_sidecar", "offline", "ambiguous", "unsupported", "refused", "unreachable"];
    const titles = reasons.map((r) => unavailableCopy(r).title);
    expect(new Set(titles).size).toBe(reasons.length);
    for (const r of reasons) {
      expect(unavailableCopy(r).title.length).toBeGreaterThan(0);
      expect(unavailableCopy(r).body.length).toBeGreaterThan(0);
    }
  });

  test("offline and no_sidecar do not say the same thing", () => {
    // "your app is not running" and "there is no app here" send the user to
    // completely different places; collapsing them is what the fallback bug
    // in the daemon resolver would have done.
    expect(unavailableCopy("offline").body).not.toBe(unavailableCopy("no_sidecar").body);
  });
});

describe("requestFeedback", () => {
  const rows: PermRow[] = [];
  const host = HOST;

  test("a granted-by-dialog request says nothing", () => {
    const ok: PermRequestResult = {
      available: true, host, name: "microphone", grant: "prompt", paneOpened: false, permissions: rows,
    };
    expect(requestFeedback(ok, "Microphone")).toBeNull();
  });

  test("a pane that opened says nothing", () => {
    const ok: PermRequestResult = {
      available: true, host, name: "screen", grant: "pane", paneOpened: true, permissions: rows,
    };
    expect(requestFeedback(ok, "Screen Recording")).toBeNull();
  });

  test("an available:false answer is never silent", () => {
    // THE bug this guards. The route answers HTTP 200 for every one of these,
    // so a hook that checks only response.ok resets the button to its label
    // and says nothing -- the exact silent click this screen exists to fix.
    const reasons: PermUnavailable[] = ["no_sidecar", "offline", "ambiguous", "unsupported", "refused", "unreachable"];
    for (const reason of reasons) {
      const msg = requestFeedback({ available: false, reason }, "Screen Recording");
      expect(msg).toBeTruthy();
      expect(msg).toBe(unavailableCopy(reason).title);
    }
  });

  test("a refusal carries the reason the desktop app gave", () => {
    const msg = requestFeedback(
      { available: false, reason: "refused", detail: "not running as an app bundle" },
      "Screen Recording",
    );
    expect(msg).toContain("not running as an app bundle");
  });

  test("a pane that did not open names where to go by hand", () => {
    const msg = requestFeedback(
      { available: true, host, name: "screen", grant: "pane", paneOpened: false, permissions: rows },
      "Screen Recording",
    );
    expect(msg).toContain("Privacy & Security");
    expect(msg).toContain("Screen Recording");
  });

  test("a launcher error is passed through, not swallowed", () => {
    const msg = requestFeedback(
      {
        available: true, host, name: "screen", grant: "pane", paneOpened: false,
        paneError: 'exec: "open": not found', permissions: rows,
      },
      "Screen Recording",
    );
    expect(msg).toContain('exec: "open": not found');
  });

  test("an unreadable body is reported rather than treated as success", () => {
    expect(requestFeedback(null, "Screen Recording")).toBeTruthy();
  });
});
