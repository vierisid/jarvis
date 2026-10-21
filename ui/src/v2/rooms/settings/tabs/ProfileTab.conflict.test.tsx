/**
 * #1101: Settings > Profile sends the revision it read (F-23 #945), so a save made
 * elsewhere while the form is open answers 409. The form used to keep the stale
 * revision, so every retry answered 409 again and the only way out was Cancel,
 * which threw the draft away. It now reloads the newer profile, keeps the edits on
 * top of it and lets an explicit second Save through, still conflict-checked.
 */
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SettingsHook } from "../useSettingsData";

const NativeResponse = globalThis.Response, NativeRequest = globalThis.Request, originalFetch = globalThis.fetch;
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let ProfileTab: typeof import("./ProfileTab").ProfileTab;
let rebaseDraft: typeof import("./ProfileTab").rebaseDraft;
let clashingAnswers: typeof import("./ProfileTab").clashingAnswers;
let useSettingsData: typeof import("../useSettingsData").useSettingsData;
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement | undefined;

beforeAll(async () => {
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ ProfileTab, rebaseDraft, clashingAnswers } = await import("./ProfileTab"));
  ({ useSettingsData } = await import("../useSettingsData"));
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  globalThis.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());

const setValue = (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

// Waits on an observable condition, not on how many turns the save chain takes.
async function until(done: () => boolean) {
  for (let i = 0; i < 500 && !done(); i++) await act(async () => { await new Promise((r) => setTimeout(r, 2)); });
  expect(done()).toBe(true);
}

async function scenario(run: (h: {
  posts: number[]; toasts: string[];
  click: (label: string) => Promise<void>; button: (label: string) => HTMLButtonElement | undefined;
  field: (value: string) => Promise<HTMLInputElement>; setValue: typeof setValue;
  hold: (on: boolean) => void; release: () => void;
  elsewhere: (answers: Record<string, string>) => void; saved: () => Record<string, string> | undefined;
}) => Promise<void>) {
  const { initDatabase, closeDb } = await import("../../../../../../src/vault/schema");
  const { saveUserProfile, getUserProfile } = await import("../../../../../../src/vault/user-profile");
  const { patchUserProfile, readEditableProfile } = await import("../../../../../../src/vault/profile-edit");
  const { createApiRoutes } = await import("../../../../../../src/daemon/api-routes");
  const { DEFAULT_CONFIG } = await import("../../../../../../src/config/types");
  // The classic form is conflict-checked with the F-23 flag off too (F-23 #945).
  const oldFlag = process.env.JARVIS_BRIEF_PROFILE_SETTINGS;
  delete process.env.JARVIS_BRIEF_PROFILE_SETTINGS;
  initDatabase(":memory:", { quiet: true });
  try {
    saveUserProfile({ preferred_name: "Sam", company: "Before" });
    const table = createApiRoutes({ config: structuredClone(DEFAULT_CONFIG) } as never) as Record<string, Record<string, (r: Request) => Promise<Response>>>;
    const posts: number[] = [], toasts: string[] = [];
    let holding = false, release = () => {};
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (url === "/api/user-profile") {
        if (init?.method === "POST" && holding) await new Promise<void>((r) => { release = r; });
        const response = await table[url]![init?.method ?? "GET"]!(new NativeRequest("http://localhost" + url, init));
        if (init?.method === "POST") posts.push(response.status);
        return response;
      }
      return NativeResponse.json(null);
    }) as typeof fetch;
    function Harness() {
      const data: SettingsHook = useSettingsData();
      return <ProfileTab data={data} onToast={(text) => toasts.push(text)} />;
    }
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<Harness />));
    await until(() => !!button("Edit profile"));
    function button(label: string) {
      return Array.from(host!.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
    }
    const click = async (label: string) => {
      const b = button(label);
      expect(b).toBeDefined();
      await act(async () => b!.click());
    };
    // Pages back to the first step, then forward until an input holds `value`.
    const field = async (value: string) => {
      while (button("Previous") && !button("Previous")!.disabled) await click("Previous");
      let found: HTMLInputElement | undefined;
      for (let i = 0; i < 20 && !found; i++) {
        found = Array.from(host!.querySelectorAll("input")).find((el) => el.value === value);
        if (!found) await click("Next");
      }
      expect(found).toBeDefined();
      return found!;
    };
    await run({
      posts, toasts, click, button, field, setValue,
      hold: (on) => { holding = on; }, release: () => release(),
      elsewhere: (answers) => { patchUserProfile(readEditableProfile().revision, answers); },
      saved: () => getUserProfile()?.answers,
    });
  } finally {
    closeDb();
    if (oldFlag === undefined) delete process.env.JARVIS_BRIEF_PROFILE_SETTINGS;
    else process.env.JARVIS_BRIEF_PROFILE_SETTINGS = oldFlag;
  }
}

async function toSave(h: { button: (l: string) => HTMLButtonElement | undefined; click: (l: string) => Promise<void> }) {
  while (h.button("Next")) await h.click("Next");
}

test("a 409 keeps the draft, rebases it on the newer profile and lets an explicit second save through", async () => {
  await scenario(async (h) => {
    await h.click("Edit profile");
    const company = await h.field("Before");
    await act(async () => h.setValue(company, "Mine"));
    // Another tab (or the assistant) saves a different answer meanwhile.
    h.elsewhere({ preferred_name: "Samantha" });
    await toSave(h);
    await h.click("Save profile");
    await until(() => h.posts.length === 1 && h.toasts.length === 1);
    expect(h.posts).toEqual([409]);
    expect(h.saved()).toMatchObject({ preferred_name: "Samantha", company: "Before" });
    expect(h.toasts.at(-1)).toMatch(/changed somewhere else/i);
    // Still editing, draft intact.
    expect(h.button("Save profile")).toBeDefined();
    await h.click("Save profile");
    await until(() => h.posts.length === 2 && h.toasts.length === 2);
    expect(h.posts).toEqual([409, 200]);
    // The edited answer wins; the untouched answer keeps the newer value instead of being overwritten.
    expect(h.saved()).toMatchObject({ preferred_name: "Samantha", company: "Mine" });
    expect(h.toasts.at(-1)).toBe("User profile saved.");
  });
});

test("an answer changed on both sides is named with its newer value and its step is shown before any overwrite", async () => {
  await scenario(async (h) => {
    await h.click("Edit profile");
    const company = await h.field("Before");
    await act(async () => h.setValue(company, "Mine"));
    h.elsewhere({ company: "Theirs" });
    await toSave(h);
    await h.click("Save profile");
    await until(() => h.toasts.length === 1);
    expect(h.posts).toEqual([409]);
    expect(h.toasts[0]).toContain('Company (now "Theirs")');
    // The form jumped to the step holding Company and still shows the user's value.
    expect(Array.from(host!.querySelectorAll("input")).some((el) => el.value === "Mine")).toBe(true);
    expect(h.saved()).toMatchObject({ company: "Theirs" });
  });
});

test("Cancel and Clear are unavailable while a save is in flight, so a late conflict cannot revive a cancelled draft", async () => {
  await scenario(async (h) => {
    await h.click("Edit profile");
    const company = await h.field("Before");
    await act(async () => h.setValue(company, "Mine"));
    h.elsewhere({ preferred_name: "Samantha" });
    h.hold(true);
    await toSave(h);
    let disabled: boolean | undefined;
    try {
      await h.click("Save profile");
      disabled = h.button("Cancel")?.disabled && h.button("Clear")?.disabled;
    } finally { h.release(); } // never leave the held request pending on a failure
    expect(disabled).toBe(true);
    await until(() => h.toasts.length === 1);
    expect(h.button("Cancel")?.disabled).toBe(false);
  });
});

test("rebase keeps edited and cleared answers and takes the newer value for the rest", () => {
  const base = { a: "1", b: "2", c: "3", d: "4" };
  const draft = { a: "1", b: "mine", c: "", d: "4" };
  const latest = { a: "new", b: "theirs", c: "3", e: "added" };
  expect(rebaseDraft(base, draft, latest)).toEqual({ a: "new", b: "mine", c: "", e: "added" });
  expect(clashingAnswers(base, draft, latest)).toEqual(["b"]);
  // Same value on both sides, or a draft typed and reverted, is no clash.
  expect(clashingAnswers({ a: "1" }, { a: "x" }, { a: "x" })).toEqual([]);
  expect(clashingAnswers({ a: "1" }, { a: "1" }, { a: "2" })).toEqual([]);
});
