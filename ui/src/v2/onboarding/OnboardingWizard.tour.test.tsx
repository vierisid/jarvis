/**
 * The tour's spotlight card, rendered for real.
 *
 * This is the repo's first DOM test, and it exists because the bug that
 * prompted it was invisible to a pure-function one. On macOS the 4th slide
 * showed the 3rd slide's copy and counter while sitting at the 4th slide's
 * position. React was never wrong: the committed DOM carried slide 4's text,
 * counter and `top` together, which is the first thing asserted below. The
 * card is a stacking context wrapping an infinitely animated dot, so the
 * compositor gives it its own layer, and the 3->4 and 4->5 transitions change
 * ONLY `top` - WebKit moved the cached layer without re-rasterising it.
 *
 * The paint itself cannot be asserted from here; no headless DOM rasterises.
 * What CAN be pinned is the fix - each slide is a BRAND-NEW element rather
 * than a mutated one - and the regression that fix introduced: remounting
 * dropped keyboard focus to <body>, so anyone advancing with Enter had to Tab
 * back into the card on every slide. Both are covered, because the second is
 * the more likely of the two to be "tidied" away by someone who sees a `key`
 * on a non-list element and assumes it is noise.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Registered before the component (and React DOM) are imported, so nothing
// reads a global that does not exist yet, and unregistered afterwards so the
// DOM does not leak into the suites that run after this file in the same
// process - several of them branch on `typeof window`.
GlobalRegistrator.register();
// Without this React warns on every act() call and does not promise that
// effects have flushed when one returns - which is exactly what the focus
// assertions below depend on.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let createRoot: typeof import("react-dom/client").createRoot;
let act: typeof import("react").act;
let OnboardingWizard: typeof import("./OnboardingWizard").OnboardingWizard;
type OnboardingStatus = import("./useOnboardingStatus").OnboardingStatus;

const realFetch = globalThis.fetch;

beforeAll(async () => {
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ OnboardingWizard } = await import("./OnboardingWizard"));
});

afterAll(() => {
  // Both globals are restored, not just the DOM: a stubbed `fetch` left behind
  // would follow this file into every suite that runs after it.
  globalThis.fetch = realFetch;
  GlobalRegistrator.unregister();
});

/** Reached the tour: setup and profile done, tutorial neither seen nor skipped.
 *  Spelled out in full against the real type so that a new REQUIRED field on
 *  OnboardingStatus breaks here rather than silently changing which screen the
 *  wizard resolves to. */
const AT_TOUR: OnboardingStatus = {
  setup_completed: true,
  setup_completed_at: 1,
  setup_skipped_profile: false,
  profile_completed: true,
  tutorial_completed: false,
  tutorial_completed_at: null,
  tutorial_dismissed: false,
  tutorial_progress_step: null,
  last_reset_at: null,
};

const posted: string[] = [];
let host: HTMLElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

async function mountTour() {
  posted.length = 0;
  globalThis.fetch = (async (url: string, init?: { method?: string }) => {
    if (init?.method === "POST") posted.push(String(url));
    // The hosted probe blocks the setup screens until it answers; the tour
    // does not gate on it, but an unresolved probe leaves a retry timer
    // running under every assertion here.
    return new Response(JSON.stringify({ hosted_llm: false }), {
      headers: { "content-type": "application/json" },
    });
  }) as never;

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<OnboardingWizard status={AT_TOUR} onComplete={() => {}} />);
  });
  return host;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

const spot = () => host!.querySelector(".obw-spot") as HTMLElement;
const counter = () => spot().querySelector(".sc")!.textContent;
/* Direct child: `.sm` is also the small-button modifier, so a plain `.sm`
   lookup finds the Next button instead of the message. */
const message = () => spot().querySelector(":scope > .sm")!.textContent;
const advance = () =>
  Array.from(spot().querySelectorAll("button")).find((b) => /Next|Finish/.test(b.textContent || ""))!;

/* Never assert on a DOM node directly: bun prints the whole object graph, and
   a one-line focus regression arrives as several thousand lines of getters.
   These reduce the thing under test to something a failure can actually say. */
const focusLabel = () => {
  const el = document.activeElement as HTMLElement | null;
  if (!el || el === document.body) return "<body>";
  return `${el.tagName.toLowerCase()}:${(el.textContent || "").trim().slice(0, 20)}`;
};

/** The five slides, in the order the tour walks them. */
const SLIDES = [
  { counter: "1 of 5", pos: /top: 58px/, copy: /programmatic steps/ },
  { counter: "2 of 5", pos: /bottom: 50px/, copy: /Describe a routine in Talk/ },
  { counter: "3 of 5", pos: /top: 104px/, copy: /Awareness.*Memory and goals/ },
  { counter: "4 of 5", pos: /bottom: 50px/, copy: /paired computer awake, connected and permitted/ },
  { counter: "5 of 5", pos: /top: 150px/, copy: /Authority/ },
];

describe("tour slides", () => {
  test("labels the static dashboard as a preview", async () => {
    await mountTour();
    expect(host!.querySelector(".obw-preview-label")?.textContent).toBe("Dashboard preview");
    expect(host!.querySelector(".obw-miniapp")?.getAttribute("aria-hidden")).toBe("true");
    expect(host!.textContent).not.toContain("Click the Pebble to try");
  });
  test("copy, counter and position always describe the SAME slide", async () => {
    await mountTour();
    for (const [i, want] of SLIDES.entries()) {
      expect(counter()).toBe(want.counter);
      expect(message()).toMatch(want.copy);
      expect(spot().getAttribute("style")).toMatch(want.pos);
      if (i < SLIDES.length - 1) await act(async () => advance().click());
    }
  });

  test("the counter's total matches the slides that actually exist", async () => {
    await mountTour();
    // Walked, not hardcoded: click through to the slide offering "Finish" and
    // count what was seen. Asserting against SLIDES.length instead would agree
    // with a stale literal, since both say five today - this fails the moment
    // a slide is added or dropped and the label is left behind.
    let walked = 1;
    while (advance().textContent !== "Finish") {
      await act(async () => advance().click());
      walked++;
      if (walked > 20) throw new Error("tour never reached its last slide");
    }
    expect(counter()).toBe(`${walked} of ${walked}`);
  });

  test("each slide is a NEW element, never a mutated one", async () => {
    await mountTour();
    // Identity, not contents: the whole point of the `key` is that the
    // compositor is handed a node it has never rasterised before.
    const seen = new WeakSet<HTMLElement>([spot()]);
    for (let i = 2; i <= SLIDES.length; i++) {
      await act(async () => advance().click());
      const now = spot();
      expect({ slide: i, remounted: !seen.has(now) }).toEqual({ slide: i, remounted: true });
      seen.add(now);
    }
  });

  test("the last slide finishes instead of advancing", async () => {
    await mountTour();
    for (let i = 1; i < SLIDES.length; i++) await act(async () => advance().click());
    expect(advance().textContent).toBe("Finish");
    await act(async () => advance().click());
    expect(posted).toContain("/api/onboarding/tutorial/complete");
    expect(host!.textContent).not.toContain("profile saved to your Vault");
    expect(host!.querySelector(".obw-activation")).not.toBeNull();
  });

  test("Skip tour dismisses rather than completing", async () => {
    await mountTour();
    const skip = Array.from(spot().querySelectorAll("button")).find((b) => b.textContent === "Skip tour")!;
    await act(async () => skip.click());
    expect(posted).toContain("/api/onboarding/tutorial/dismiss");
  });
});

describe("tour keyboard focus", () => {
  test("advancing keeps focus on the button that was activated", async () => {
    await mountTour();
    for (let i = 2; i <= SLIDES.length; i++) {
      const btn = advance();
      btn.focus();
      await act(async () => btn.click());
      // Remounting the card destroys `btn`; focus must land on its
      // REPLACEMENT, not on <body> and not on the detached original, or
      // Enter-to-advance dies after one slide.
      expect({ slide: i, focus: focusLabel(), onLiveButton: document.activeElement === advance() })
        .toEqual({ slide: i, focus: i === SLIDES.length ? "button:Finish" : "button:Next", onLiveButton: true });
    }
  });

  test("the first slide does not grab focus on its own", async () => {
    await mountTour();
    // Nothing has been activated yet, so pulling focus into the card here
    // would be a bug of its own - it would yank a screen reader mid-sentence.
    expect(focusLabel()).toBe("<body>");
  });
});
