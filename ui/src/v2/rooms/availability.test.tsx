import { afterAll, afterEach, beforeAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const NativeResponse = globalThis.Response;
const originalFetch = globalThis.fetch;
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let useGoalsData: typeof import("./goals/useGoalsData").useGoalsData;
let useAuthorityData: typeof import("./authority/useAuthorityData").useAuthorityData;
let useRemoteData: typeof import("../hooks/useRemoteData").useRemoteData;
let readArray: typeof import("../hooks/useRemoteData").readArray;
let GoalsRoomBody: typeof import("./goals/GoalsRoom").GoalsRoomBody;
let AuthorityRoomBody: typeof import("./authority/AuthorityRoom").AuthorityRoomBody;
let NowRoom: typeof import("../shell/NowRoom").NowRoom;
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
beforeAll(async () => {
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ useGoalsData } = await import("./goals/useGoalsData"));
  ({ useAuthorityData } = await import("./authority/useAuthorityData"));
  ({ useRemoteData, readArray } = await import("../hooks/useRemoteData"));
  ({ GoalsRoomBody } = await import("./goals/GoalsRoom"));
  ({ AuthorityRoomBody } = await import("./authority/AuthorityRoom"));
  ({ NowRoom } = await import("../shell/NowRoom"));
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  host?.remove();
  globalThis.fetch = originalFetch;
  localStorage.clear();
});
afterAll(() => GlobalRegistrator.unregister());
async function mount(element: React.ReactNode) {
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => { root!.render(element); });
}

for (const name of ["Goals", "Authority"] as const) {
  for (const status of [401, 403, 429, 500, 502, 503, 504]) {
    test(`${name}: HTTP ${status} is an error, never a successful empty load`, async () => {
      globalThis.fetch = (async () => NativeResponse.json({ error: "Unavailable" }, { status })) as unknown as typeof fetch;
      let result: { loading: boolean; error: string | null; sections: Record<string, { availability: string; updatedAt: number | null }> };
      function Probe() { result = name === "Goals" ? useGoalsData() : useAuthorityData(); return null; }
      await mount(<Probe />);
      expect(result!.loading).toBe(false);
      expect(result!.error).not.toBeNull();
      expect(Object.values(result!.sections).every(s => s.availability === "unavailable" && s.updatedAt === null)).toBe(true);
    });
  }
}

const metrics = { total: 1, active: 1, completed: 0, failed: 0, killed: 0, avg_score: 0.5, on_track: 1, at_risk: 0, behind: 0, critical: 0, overdue: 0 };
const config = { default_level: 5, governed_categories: [], overrides: [], context_rules: [], learning: { enabled: true, suggest_threshold: 5 }, emergency_state: "normal" };
const goal = { id: "goal-1", title: "Ship the report", description: "", tags: [], parent_id: null, sort_order: 0, level: "objective", status: "active", health: "on_track", score: 0.5 };
const approval = { id: "approval-1", agent_name: "Jarvis", tool_name: "send_email", reason: "Send checked report", status: "pending", action_category: "send_email", created_at: Date.now() };
function good(url: string): unknown {
  if (url === "/api/goals?limit=200" || url === "/api/goals") return [goal];
  if (url === "/api/goals/metrics") return metrics;
  if (url === "/api/authority/status") return { emergency_state: "normal", pending_approvals: 0 };
  if (url === "/api/authority/config") return config;
  if (url === "/api/authority/audit/stats") return { total: 0, allowed: 0, denied: 0, approvalRequired: 0, byCategory: {} };
  return [];
}
function mock(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = ((url: string, init?: RequestInit) => Promise.resolve(handler(String(url), init))) as unknown as typeof fetch;
}
function button(name: string): HTMLButtonElement {
  const el = [...host.querySelectorAll("button")].find(b => b.getAttribute("aria-label") === name || b.textContent?.trim() === name);
  if (!el) throw new Error(`Missing button ${name}: ${host.textContent}`);
  return el;
}

test("independent goal snapshots survive partial failure and recover on the next refresh", async () => {
  let failed = false;
  mock(url => failed && url === "/api/goals?limit=200" ? new NativeResponse("", { status: 503 }) : NativeResponse.json(url === "/api/goals/metrics" && failed ? { ...metrics, active: 2 } : good(url)));
  let result!: ReturnType<typeof useGoalsData>;
  function Probe() { result = useGoalsData(); return null; }
  await mount(<Probe />);
  const timestamp = result.sections.goals.updatedAt;
  failed = true;
  await act(async () => result.refresh());
  expect(result.sections.goals.availability).toBe("stale");
  expect(result.sections.goals.updatedAt).toBe(timestamp);
  expect(result.goals[0]?.title).toBe(goal.title);
  expect(result.sections.metrics.availability).toBe("ready");
  expect(result.metrics?.active).toBe(2);
  failed = false;
  await act(async () => result.refresh());
  expect(result.sections.goals.availability).toBe("ready");
  expect(result.error).toBeNull();
});

test("offline, invalid JSON and wrong-shaped payloads cannot become ready or erase a snapshot", async () => {
  let kind = "offline";
  mock(() => {
    if (kind === "offline") throw new TypeError("Failed to fetch");
    if (kind === "json") return new NativeResponse("not JSON");
    return NativeResponse.json(kind === "wrong" ? { error: "no data" } : [goal]);
  });
  let result!: ReturnType<typeof useGoalsData>;
  function Probe() { result = useGoalsData(); return null; }
  await mount(<Probe />);
  expect(result.sections.goals.availability).toBe("unavailable");
  kind = "good"; await act(async () => result.refresh());
  expect(result.sections.goals.availability).toBe("ready");
  for (kind of ["offline", "json", "wrong"]) {
    await act(async () => result.refresh());
    expect(result.sections.goals.availability).toBe("stale");
    expect(result.goals[0]?.id).toBe(goal.id);
  }
});

test("a slow authority source does not delay successful sources or their next refresh", async () => {
  let release!: (response: Response) => void;
  const slow = new Promise<Response>(resolve => { release = resolve; });
  let reads = 0;
  mock(url => {
    if (url === "/api/authority/config") return slow;
    if (url.includes("status=pending")) { reads++; return NativeResponse.json([approval]); }
    return NativeResponse.json(good(url));
  });
  let result!: ReturnType<typeof useAuthorityData>;
  function Probe() { result = useAuthorityData(); return null; }
  await mount(<Probe />);
  expect(result.sections.config.availability).toBe("loading");
  expect(result.sections.pending.availability).toBe("ready");
  await act(async () => { void result.refresh(); });
  expect(reads).toBe(2);
  await act(async () => release(NativeResponse.json({}, { status: 403 })));
  expect(result.sections.config.availability).toBe("unavailable");
  expect(result.pendingApprovals[0]?.id).toBe(approval.id);
});

test("timeout clears the in-flight slot so retry can recover", async () => {
  mock((_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))));
  let result!: ReturnType<typeof useRemoteData<object[]>>;
  function Probe() { result = useRemoteData("/slow", readArray<object>, 60000, 15); return null; }
  await mount(<Probe />);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 35)); });
  expect(result.availability).toBe("unavailable");
  expect(result.error).toContain("timed out");
  mock(() => NativeResponse.json([]));
  await act(async () => result.refresh());
  expect(result.availability).toBe("ready");
});

test("changing resource URL discards old data and ignores late responses", async () => {
  let resolveOld!: (value: Response) => void;
  mock(url => url === "/old" ? new Promise(resolve => { resolveOld = resolve; }) : NativeResponse.json([{ id: "new" }]));
  let result!: ReturnType<typeof useRemoteData<object[]>>;
  function Probe({ url }: { url: string }) { result = useRemoteData(url, readArray<object>, 60000); return null; }
  await mount(<Probe url="/old" />);
  await act(async () => root!.render(<Probe url="/new" />));
  await act(async () => resolveOld(NativeResponse.json([{ id: "old" }])));
  expect(result.data).toEqual([{ id: "new" }]);
});

for (const status of [401, 403, 429, 503]) {
  test(`rooms render HTTP ${status} as unavailable without zero counts or normal emergency status`, async () => {
    mock(() => NativeResponse.json({}, { status }));
    await mount(<><GoalsRoomBody mode="inline" /><AuthorityRoomBody mode="inline" /></>);
    const text = host.textContent!;
    expect(text).toContain("Goals: Unavailable");
    expect(text).toContain("Pending approvals: Unavailable");
    expect(text).not.toContain("No goals match");
    expect(text).not.toContain("No pending approvals");
    expect(text).not.toContain("No recent decisions");
    expect(text).not.toContain("all systems normal");
    expect(button("Pause").disabled).toBe(false);
    expect(button("Kill").disabled).toBe(false);
    const values = [...host.querySelectorAll('.v2-goals__stat-value, .v2-auth__stat-value')].map(el => el.textContent);
    expect(values.length).toBe(8);
    expect(values.every(value => value === "—")).toBe(true);
  });
}

test("a formerly empty approval inbox is labelled stale, and Retry alone restores a confirmed empty state", async () => {
  let failed = false;
  mock(url => failed && url.includes("status=pending") ? NativeResponse.json({}, { status: 503 }) : NativeResponse.json(good(url)));
  await mount(<AuthorityRoomBody mode="inline" />);
  expect(host.textContent).toContain("No pending approvals.");
  failed = true; await retryAllInline();
  expect(host.textContent).toContain("Pending approvals: Stale");
  expect(host.textContent).toContain("not current");
  expect(host.textContent).not.toContain("No pending approvals.");
  expect(host.querySelector("time")?.getAttribute("datetime")).toBeTruthy();
  failed = false;
  await act(async () => button("Retry Pending approvals").click());
  expect(host.textContent).toContain("No pending approvals.");
  expect(host.textContent).not.toContain("Pending approvals: Stale");
});
async function retryAllInline() { await act(async () => window.dispatchEvent(new Event("online"))); }

test("unresolved failure does not hide a successful pending list or imply a complete zero", async () => {
  mock(url => url.includes("status=unresolved") ? NativeResponse.json({}, { status: 503 }) : NativeResponse.json(url.includes("status=pending") ? [approval] : good(url)));
  await mount(<AuthorityRoomBody mode="expanded" />);
  expect(host.textContent).toContain(approval.reason);
  expect(host.textContent).toContain("Unfinished approvals: Unavailable");
  expect(host.querySelector(".v2-auth__stat-value")?.textContent).toBe("—");
});

test("audit and learning sections expose their own failures while keeping successful siblings", async () => {
  mock(url => url === "/api/authority/audit?limit=100" || url === "/api/authority/config" ? NativeResponse.json({}, { status: 503 }) : NativeResponse.json(good(url)));
  await mount(<AuthorityRoomBody mode="expanded" />);
  await act(async () => button("Audit").click());
  expect(host.textContent).toContain("Audit entries: Unavailable");
  expect(host.querySelector(".v2-auth__filter-meta")?.textContent).toBe("—");
  expect(host.textContent).toContain("all decisions");
  expect(host.textContent).not.toContain("No audit entries match");
  await act(async () => button("Learning").click());
  expect(host.textContent).toContain("Learning configuration: Unavailable");
  expect(host.textContent).toContain("No suggestions yet");
});

for (const filterBeforeFailure of [true, false]) {
  test(`stale audit filters remain usable when filtering ${filterBeforeFailure ? "before" : "after"} a failed refresh`, async () => {
    let failed = false;
    const entry = { id: "audit-1", agent_name: "Report assistant", tool_name: "send_email", action_category: "send_email", authority_decision: "allowed", created_at: Date.now() };
    mock(url => url === "/api/authority/audit?limit=100"
      ? failed ? NativeResponse.json({}, { status: 503 }) : NativeResponse.json([entry])
      : NativeResponse.json(good(url)));
    await mount(<AuthorityRoomBody mode="expanded" />);
    await act(async () => button("Audit").click());
    if (filterBeforeFailure) await act(async () => button("Denied").click());
    failed = true;
    await retryAllInline();
    if (!filterBeforeFailure) await act(async () => button("Denied").click());
    expect(host.textContent).toContain("Audit entries: Stale");
    expect(host.textContent).not.toContain("No audit entries match");
    expect(host.querySelector(".v2-auth__filter-meta")?.textContent).toBe("Last known: 0 of 1");
    await act(async () => button("All").click());
    expect(host.textContent).toContain(entry.agent_name);
    expect(host.querySelector(".v2-auth__filter-meta")?.textContent).toBe("Last known: 1 of 1");
  });
}

test("calendar advances its window and keeps a qualified snapshot when the next window fails", async () => {
  const start = Date.UTC(2026, 8, 21, 10);
  const day = 86400000;
  let now = start;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    localStorage.setItem("jarvis-now-layout-v2", JSON.stringify([{ id: "calendar", size: 1 }]));
    const events = [
      { title: "Morning call", timestamp: start + 60000 },
      { title: "Planning session", timestamp: start + 3 * day },
      { title: "Next week's review", timestamp: start + 8 * day },
    ];
    let failed = false;
    const requests: URL[] = [];
    mock(url => {
      if (!url.startsWith("/api/calendar?")) return NativeResponse.json(good(url));
      const request = new URL(url, "http://localhost");
      requests.push(request);
      if (failed) return NativeResponse.json({}, { status: 503 });
      const from = Number(request.searchParams.get("range_start"));
      const to = Number(request.searchParams.get("range_end"));
      return NativeResponse.json(events.filter(e => e.timestamp >= from && e.timestamp <= to));
    });
    const page = () => <NowRoom connection="live" arranging={false} onApprove={() => {}} onCancel={() => {}} />;
    await mount(page());
    expect(host.textContent).toContain("Morning call");
    expect(requests.length).toBe(1);

    now += 120000;
    await act(async () => root!.render(page()));
    expect(host.textContent).not.toContain("Morning call");
    expect(host.textContent).toContain("Planning session");
    expect(requests.length).toBe(1); // A render must not restart the request effect.
    failed = true;
    await retryAllInline();
    expect(requests.at(-1)!.searchParams.get("range_start")).toBe(String(now));
    expect(host.textContent).toContain("Calendar: Stale");
    expect(host.textContent).toContain("Planning session");
    expect(host.querySelector("time")?.getAttribute("datetime")).toBe(new Date(start).toISOString());

    failed = false;
    now = start + 4 * day;
    await retryAllInline();
    expect(requests.at(-1)!.searchParams.get("range_end")).toBe(String(now + 7 * day));
    expect(host.textContent).toContain("Next week's review");
    expect(host.textContent).not.toContain("Planning session");
    expect(host.textContent).not.toContain("Calendar: Stale");

    failed = true;
    now = start + 9 * day;
    await retryAllInline();
    expect(host.textContent).toContain("Calendar: Stale");
    expect(host.textContent).not.toContain("Next week's review");
    expect(host.textContent).not.toContain("No commitments this week");
    failed = false;
    await retryAllInline();
    expect(host.textContent).toContain("No commitments this week");
    expect(requests.length).toBe(5);
  } finally {
    clock.mockRestore();
  }
});

test("Now keeps HTTP failures and a disconnected live stream distinct from nothing waiting", async () => {
  localStorage.setItem("jarvis-now-layout-v2", JSON.stringify(["goals", "waiting", "vitals", "authority-audit"].map(id => ({ id, size: 1 }))));
  let failed = true;
  mock(url => failed ? NativeResponse.json({}, { status: 503 }) : NativeResponse.json(url === "/api/goals" ? [] : good(url)));
  const page = (connection: "live" | "offline") => <NowRoom connection={connection} arranging={false} onApprove={() => {}} onCancel={() => {}} />;
  await mount(page("live"));
  expect(host.textContent).toContain("Goals: Unavailable");
  expect(host.textContent).toContain("Authority audit: Unavailable");
  expect(host.textContent).not.toContain("No goals set yet");
  expect(host.textContent).not.toContain("Nothing waits right now");
  expect(host.textContent).toContain("waiting on you · —");
  failed = false;
  await retryAllInline();
  expect(host.textContent).toContain("Nothing waits right now");
  expect(host.textContent).toContain("No goals set yet");
  failed = true;
  await retryAllInline();
  expect(host.textContent).toContain("Goals: Stale");
  expect(host.textContent).not.toContain("No goals set yet");
  expect(host.textContent).not.toContain("Nothing waits right now");
  failed = false;
  await retryAllInline();
  await act(async () => root!.render(page("offline")));
  expect(host.textContent).toContain("Live requests unavailable");
  expect(host.textContent).not.toContain("Nothing waits right now");
});

test("an object-shaped widget suppresses its empty line when stale but keeps a last known value", async () => {
  localStorage.setItem("jarvis-now-layout-v2", JSON.stringify([{ id: "usage-week", size: 1 }, { id: "settings", size: 1 }]));
  let failed = false;
  mock(url => failed && url.startsWith("/api/usage") ? NativeResponse.json({}, { status: 503 })
    : NativeResponse.json(url.startsWith("/api/usage") ? { totalTokens: 0 } : { status: "connected" }));
  await mount(<NowRoom connection="live" arranging={false} onApprove={() => {}} onCancel={() => {}} />);
  expect(host.textContent).toContain("Weekly token spend by model appears here");
  failed = true;
  await retryAllInline();
  expect(host.textContent).toContain("Usage: Stale");
  expect(host.textContent).not.toContain("Weekly token spend by model appears here");
  expect(host.textContent).toContain("Connected");
});

test("polling refreshes data and unmount aborts the outstanding request", async () => {
  let requests = 0;
  let signal: AbortSignal | null | undefined;
  mock((_url, init) => {
    requests++;
    if (requests === 1) return NativeResponse.json([]);
    signal = init?.signal;
    return new Promise((_resolve, reject) => signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
  });
  let result!: ReturnType<typeof useRemoteData<object[]>>;
  function Probe() { result = useRemoteData("/poll", readArray<object>, 20); return null; }
  await mount(<Probe />);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 45)); });
  expect(result.availability).toBe("ready");
  expect(requests).toBe(2);
  await act(async () => root!.unmount()); root = undefined;
  expect(signal?.aborted).toBe(true);
});

test("stale nonempty goal rows remain visible while healthy metrics continue updating", async () => {
  let failed = false;
  mock(url => failed && url === "/api/goals?limit=200" ? NativeResponse.json({}, { status: 503 }) : NativeResponse.json(good(url)));
  await mount(<GoalsRoomBody mode="inline" />);
  expect(host.textContent).toContain(goal.title);
  failed = true;
  await retryAllInline();
  expect(host.textContent).toContain("Goals: Stale");
  expect(host.textContent).toContain(goal.title);
  expect(host.querySelector(".v2-goals__stat-value")?.textContent).toBe("1");
});
