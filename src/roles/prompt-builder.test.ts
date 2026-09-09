import { describe, expect, it } from 'bun:test';
import { buildSystemPrompt, buildSystemPromptParts, type PromptContext } from './prompt-builder.ts';
import { buildToolGuide } from './tool-guide.ts';
import type { RoleDefinition } from './types.ts';

const role: RoleDefinition = {
  id: 'test-role',
  name: 'Test Assistant',
  description: 'A test role.',
  responsibilities: ['Answer questions', 'Run tasks'],
  tools: ['calendar', 'browser'],
  authority_level: 5,
};

function makeContext(overrides?: Partial<PromptContext>): PromptContext {
  return {
    userName: 'Alice',
    currentTime: new Date().toISOString(),
    recentObservations: ['User opened the dashboard'],
    activeGoals: 'Ship v1 (0.4)',
    knowledgeContext: 'Alice prefers dark mode.',
    ...overrides,
  };
}

describe('buildSystemPromptParts', () => {
  it('keeps the static part free of per-turn volatile content', () => {
    const parts = buildSystemPromptParts(role, makeContext());
    expect(parts.static).toContain('# Identity');
    expect(parts.static).toContain('Test Assistant');
    expect(parts.static).toContain('# Intent Gating');
    expect(parts.static).not.toContain('Time:');
    expect(parts.static).not.toContain('# Current Context');
    expect(parts.static).not.toContain('User opened the dashboard');
  });

  it('puts all volatile context in the dynamic part', () => {
    const context = makeContext();
    const parts = buildSystemPromptParts(role, context);
    expect(parts.dynamic).toContain('# Current Context');
    expect(parts.dynamic).toContain(`Time: ${context.currentTime}`);
    expect(parts.dynamic).toContain('User opened the dashboard');
    expect(parts.dynamic).toContain('Ship v1 (0.4)');
  });

  it('static part is byte-identical across calls with different volatile context', () => {
    const a = buildSystemPromptParts(role, makeContext({ currentTime: '2026-07-06T10:00:00Z' }));
    const b = buildSystemPromptParts(role, makeContext({
      currentTime: '2026-07-06T10:05:00Z',
      recentObservations: ['Something completely different happened'],
    }));
    expect(a.static).toBe(b.static);
    expect(a.dynamic).not.toBe(b.dynamic);
  });

  it('legacy buildSystemPrompt equals the joined parts', () => {
    const context = makeContext();
    const parts = buildSystemPromptParts(role, context);
    const legacy = buildSystemPrompt(role, context);
    expect(legacy).toBe(`${parts.static}\n${parts.dynamic}`);
  });

  it('legacy buildSystemPrompt without context has no dynamic tail', () => {
    const parts = buildSystemPromptParts(role, undefined);
    expect(parts.dynamic).toBe('');
    expect(buildSystemPrompt(role, undefined)).toBe(parts.static);
  });
});

describe("tool guide: install advice follows who owns the pieces catalog", () => {
  it("self-managed keeps the install remedy", () => {
    const g = buildToolGuide({ hasSidecars: false, piecesManaged: false });
    expect(g).toContain("suggestedInstalls");
    expect(g).toContain("Library page");
  });

  it("host-managed drops it, keeping the rest of the workflow guide", () => {
    // The THIRD surface carrying this advice, after the manage_workflow tool
    // description and the composer's prompts. It is the easiest to miss --
    // nothing about workflows imports it, it just gets concatenated into
    // every primary-agent system prompt -- and it is the most damaging to
    // get wrong, because it teaches the model the remedy up front rather
    // than only on a compose failure.
    const g = buildToolGuide({ hasSidecars: false, piecesManaged: true });
    expect(g).not.toContain("suggestedInstalls");
    expect(g).not.toContain("Library page");
    expect(g).toContain("### manage_workflow");
    expect(g).toContain("compose { name, description }");
  });

  it("the pieces flag does not disturb the sidecar sections", () => {
    for (const piecesManaged of [false, true]) {
      expect(buildToolGuide({ hasSidecars: true, piecesManaged })).toContain("Sidecar name or ID");
      expect(buildToolGuide({ hasSidecars: false, piecesManaged })).not.toContain(
        "Sidecar name or ID",
      );
    }
  });
});

describe("tool guide: machines and their OS", () => {
  const machines = [
    { name: "Lapo's MacBook", os: "macOS", arch: "arm64" },
    { name: "Jarvis host (this brain)", os: "Linux", arch: "x64", isHost: true },
  ];

  it("lists each machine with its OS so commands are written for the right one", () => {
    // Without this the model writes for whichever OS its priors favour -- the
    // reported bug was `notepad.exe` sent to a fleet of one MacBook.
    const g = buildToolGuide({ hasSidecars: true, piecesManaged: false, machines });
    expect(g).toContain("### Machines and their OS");
    expect(g).toContain("**Lapo's MacBook** — macOS, arm64");
    expect(g).toContain("**Jarvis host (this brain)** — Linux, x64");
    expect(g).toContain("MUST match the OS of the machine");
  });

  it("points at list_sidecars for live status, since this block is cached", () => {
    const g = buildToolGuide({ hasSidecars: true, piecesManaged: false, machines });
    expect(g).toContain("not live status");
  });

  it("is byte-identical across builds with the same inventory (prompt cache)", () => {
    const a = buildToolGuide({ hasSidecars: true, piecesManaged: false, machines });
    const b = buildToolGuide({ hasSidecars: true, piecesManaged: false, machines: [...machines] });
    expect(a).toBe(b);
  });

  it("says so when a machine never reported its OS", () => {
    const g = buildToolGuide({
      hasSidecars: true,
      piecesManaged: false,
      machines: [{ name: "New laptop", os: null }],
    });
    expect(g).toContain("OS unknown (never connected)");
  });

  it("omits the section entirely without an inventory", () => {
    expect(buildToolGuide({ hasSidecars: true, piecesManaged: false })).not.toContain(
      "### Machines and their OS",
    );
  });
});
