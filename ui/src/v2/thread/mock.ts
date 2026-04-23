import type { ThreadItem } from "./types";

/**
 * Realistic morning-brief conversation covering every ThreadItem kind.
 * Used in Phase 3A to drive the UI; replaced by real WS subscription in Phase 3B.
 */
export const MOCK_THREAD: ThreadItem[] = [
  {
    kind: "jarvis-speech",
    id: "s-001",
    text:
      "Good morning, Martin. Quiet overnight — no critical alerts. Your 10am with Anya is confirmed, and I've held two hours of deep work this afternoon.",
    t: "07:32",
    status: "done",
  },
  {
    kind: "user-voice",
    id: "u-001",
    text: "What did the researcher finish overnight?",
    t: "07:34",
  },
  {
    kind: "jarvis-thought",
    id: "th-001",
    text: "Pulling the researcher's run log and the authority-patterns brief.",
    t: "07:34",
  },
  {
    kind: "jarvis-speech",
    id: "s-002",
    text:
      "The Researcher finished the authority-patterns brief — 4 pages, 23 sources. Headline: soft-gate approval with auto-learn is now the dominant production pattern; hard RBAC is out.",
    t: "07:35",
    status: "done",
  },
  {
    kind: "card",
    id: "c-001",
    objectType: "memory",
    ref: "mem_auth_patterns_2026",
    title: "Authority patterns 2026 — brief",
    summary:
      "4 pages · Researcher · sources span Anthropic, Linear, Ramp, and 20 others. Key finding: soft-gate + auto-learn supersedes RBAC in agentic systems.",
    meta: "4 pages · 23 sources · 18m",
    t: "07:35",
  },
  {
    kind: "user-text",
    id: "u-002",
    text: "Schedule a follow-up with Anya for Thu 2pm to review it.",
    t: "07:36",
  },
  {
    kind: "jarvis-thought",
    id: "th-002",
    text: "Checking Anya's availability and our authority scope for calendar writes.",
    t: "07:36",
  },
  {
    kind: "approval",
    id: "a-001",
    intent: "Approve Scheduler · book Thu 2pm with Anya — requires confirmation?",
    category: "authority.approve",
    impact: "write",
    highlights: ["Scheduler", "book Thu 2pm"],
    t: "07:36",
  },
  {
    kind: "jarvis-speech",
    id: "s-003",
    text: "Thursday at 2pm looks clear for both of you. Shall I send the invite?",
    t: "07:36",
    status: "done",
  },
  {
    kind: "card",
    id: "c-002",
    objectType: "workflow",
    ref: "wf_morning_triage",
    title: "Morning triage",
    summary: "Classify urgent mail, draft replies for low-stakes threads.",
    meta: "v7 · 1,241 runs · avg 1.1s",
    status: { label: "Running", tone: "ok" },
    t: "07:37",
  },
  {
    kind: "result",
    id: "r-001",
    summary: "Morning triage complete: 14 threads classified, 3 drafts queued.",
    detail:
      "3 drafts awaiting your review in the outbox. 2 threads flagged urgent (Anya · OKR draft).",
    t: "07:38",
  },
  {
    kind: "card",
    id: "c-003",
    objectType: "agent",
    ref: "ag_researcher",
    title: "Researcher",
    summary: "Currently deep-diving “agentic authority patterns 2026”.",
    meta: "18m · 23 sources read",
    status: { label: "Active", tone: "ok" },
    t: "07:40",
  },
  {
    kind: "jarvis-speech",
    id: "s-004",
    text: "Drafting the Thursday invite now — you'll see an approval card when it's ready to send.",
    t: "07:41",
    status: "speaking",
  },
];
