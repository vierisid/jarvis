import {
  beforeAll,
  beforeEach,
  afterEach,
  afterAll,
  test,
  expect,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import { makeCanvasFixture } from "./fixtures";
import { versionBoundRequest } from "./request";
import type { WorkflowCanvasBinding } from "./WorkflowCanvasRoom";
import type { BriefShellPort } from "../../contracts";
let React: typeof import("react"),
  createRoot: typeof import("react-dom/client").createRoot,
  Environment: typeof import("../../../v2/rooms/workflows/WorkflowEditorEnvironment").WorkflowEditorEnvironment,
  hook: typeof import("../../../v2/rooms/workflows/useWorkflowEditor").useWorkflowEditor,
  available: typeof import("./WorkflowCanvasRoom").canvasAvailable;
let host: HTMLDivElement,
  root: Root,
  editor: ReturnType<typeof hook>,
  fixture: ReturnType<typeof makeCanvasFixture>;
beforeAll(async () => {
  GlobalRegistrator.register();
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ WorkflowEditorEnvironment: Environment } =
    await import("../../../v2/rooms/workflows/WorkflowEditorEnvironment"));
  ({ useWorkflowEditor: hook } =
    await import("../../../v2/rooms/workflows/useWorkflowEditor"));
  ({ canvasAvailable: available } = await import("./WorkflowCanvasRoom"));
});
beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  fixture = makeCanvasFixture(true);
});
afterEach(async () => {
  await React.act(async () => root.unmount());
  host.remove();
});
afterAll(() => GlobalRegistrator.unregister());
function Harness() {
  editor = hook("meeting");
  return null;
}
async function mount(request = fixture.request) {
  await React.act(async () =>
    root.render(
      <Environment.Provider
        value={{ request, portalHost: null, workspace: true }}
      >
        <Harness />
      </Environment.Provider>,
    ),
  );
}
const caps = {
  contractVersion: 1,
  capabilities: {
    workflowContext: {
      supported: true,
      ready: true,
      enabled: true,
      state: "ready",
      reason: null,
    },
  },
};
test("mount boundary requires capability, exact selected identity and matching source", () => {
  const shell = {
    mode: "preview",
    route: {
      room: "workflow",
      selection: { flowId: "meeting", versionId: "advanced-v1" },
    },
  } as BriefShellPort;
  const binding: WorkflowCanvasBinding = {
    source: "fixture",
    scopeId: "account:vault",
    flowId: "meeting",
    versionId: "advanced-v1",
    capabilities: caps,
    request: fixture.request,
  };
  expect(available(shell, binding)).toBe(true);
  for (const patch of [
    { source: "live" },
    { scopeId: "" },
    { flowId: "other" },
    { versionId: "other" },
    { capabilities: null },
  ])
    expect(
      available(shell, { ...binding, ...patch } as WorkflowCanvasBinding),
    ).toBe(false);
  expect(available({ ...shell, mode: "live" }, binding)).toBe(false);
  expect(fixture.requests).toHaveLength(0);
});
test("version pin rejects another latest draft before the hook can edit it", async () => {
  await mount(versionBoundRequest(fixture.request, "meeting", "expired"));
  expect(editor.error).toContain("selected version changed");
  expect(editor.version).toBeNull();
  expect(editor.draftTrigger).toBeNull();
  expect(fixture.requests.every((r) => r.method === "GET")).toBe(true);
});
test("real graph edits serialize branch, loop, nested orphan settings and positions", async () => {
  await mount();
  expect(editor.allSteps.map((s) => s.step.type)).toContain("LOOP_ON_ITEMS");
  expect(editor.draftOrphans[0]?.node.nextAction?.name).toBe("orphan_child");
  await React.act(async () => {
    editor.updateStepInput("nested", "instructions", "Updated nested step");
    editor.updateStepInput(
      "orphan_child",
      "instructions",
      "Updated orphan child",
    );
    editor.setStepPosition("orphan_child", 480, 840);
    editor.setStepPosition("deleted", 1, 2);
  });
  expect(editor.dirty).toBe(true);
  await React.act(async () => {
    expect((await editor.save()).ok).toBe(true);
  });
  const { version, uiMeta } = fixture.snapshot();
  expect(JSON.stringify(version.trigger)).toContain("Updated nested step");
  expect(
    uiMeta.orphans[0]?.node.nextAction?.settings?.input?.instructions,
  ).toBe("Updated orphan child");
  expect(uiMeta.positions).toEqual({ orphan_child: { x: 480, y: 840 } });
  expect(editor.dirty).toBe(false);
});
test("delete and undo restore one subtree and preserve its settings", async () => {
  await mount();
  const before = JSON.stringify(editor.draftTrigger);
  await React.act(async () => {
    editor.deleteStep("router");
  });
  expect(editor.canUndo).toBe(true);
  expect(JSON.stringify(editor.draftTrigger)).not.toContain('"router"');
  await React.act(async () => {
    editor.undo();
  });
  expect(JSON.stringify(editor.draftTrigger)).toBe(before);
});
test("actual sample input/output paths remain separate from production configured input", async () => {
  await mount();
  const input = JSON.stringify(
    editor.allSteps.find((f) => f.step.name === "draft")?.step.settings?.input,
  );
  await React.act(async () => {
    expect(
      (await editor.setStepSampleInput("draft", { custom: "example" })).ok,
    ).toBe(true);
  });
  await React.act(async () => {
    expect(
      (await editor.setStepSampleData("draft", { content: "sample output" }))
        .ok,
    ).toBe(true);
  });
  expect(editor.version?.sampleInput?.draft).toEqual({ custom: "example" });
  expect(editor.version?.sampleData?.draft).toEqual({
    content: "sample output",
  });
  expect(
    JSON.stringify(
      editor.allSteps.find((f) => f.step.name === "draft")?.step.settings
        ?.input,
    ),
  ).toBe(input);
});
test("a published version creates a draft on save instead of patching a locked version", async () => {
  const calls: { path: string; method: string }[] = [];
  const request: WorkflowCanvasBinding["request"] = async (i, init) => {
    const path = String(i),
      method = init?.method ?? "GET";
    calls.push({ path, method });
    if (path === "/api/workflows/meeting" && method === "GET") {
      const detail = await (await fixture.request(i, init)).json();
      return Response.json({
        ...detail,
        latestDraft: null,
        published: { ...detail.latestDraft, state: "LOCKED" },
      });
    }
    if (method === "POST" && path.endsWith("/versions"))
      return Response.json({
        ...fixture.snapshot().version,
        ...JSON.parse(String(init?.body)),
        id: "new-draft",
        state: "DRAFT",
      });
    return fixture.request(i, init);
  };
  await mount(request);
  expect(editor.version?.state).toBe("LOCKED");
  await React.act(async () => {
    editor.updateStepInput("draft", "instructions", "Changed draft");
  });
  await React.act(async () => {
    expect((await editor.save()).ok).toBe(true);
  });
  expect(
    calls.some((c) => c.method === "POST" && c.path.endsWith("/versions")),
  ).toBe(true);
  expect(calls.some((c) => c.method === "PATCH")).toBe(false);
});
test("discard restores authored settings without losing a different scope", async () => {
  await mount();
  await React.act(async () =>
    editor.updateStepInput("draft", "instructions", "Unsaved"),
  );
  await React.act(async () => editor.reset());
  expect(editor.dirty).toBe(false);
  expect(
    editor.allSteps.find((f) => f.step.name === "draft")?.step.settings?.input
      ?.instructions,
  ).not.toBe("Unsaved");
  const second = makeCanvasFixture();
  await mount(second.request);
  expect(editor.version?.id).toBe("meeting-v3");
  expect(editor.draftOrphans).toHaveLength(0);
});
test("preview rejects execution and installation rather than falling through to network", async () => {
  expect(
    (await fixture.request("/api/workflows/meeting/run", { method: "POST" }))
      .status,
  ).toBe(403);
  expect(
    (
      await fixture.request("/api/workflows/pieces/library/real/install", {
        method: "POST",
      })
    ).status,
  ).toBe(403);
});

test("detached chains extend with global IDs and delete only the chosen step", async () => {
  await mount();
  let first: string | null = null,
    second: string | null = null;
  await React.act(async () => {
    first = editor.insertStepAfter("notes");
  });
  await React.act(async () => {
    second = editor.insertStepAfter("orphan_child");
  });
  expect(first).not.toBeNull();
  expect(second).not.toBeNull();
  expect(first).not.toBe(second);
  await React.act(async () => editor.deleteStep("orphan_child"));
  expect(editor.draftOrphans[0]?.node.name).toBe("orphan");
  expect(editor.draftOrphans[0]?.node.nextAction?.name).toBe(second!);
  await React.act(async () => editor.undo());
  expect(editor.draftOrphans[0]?.node.nextAction?.name).toBe("orphan_child");
});

test("discard restores the saved workflow name, not the edited version object", async () => {
  await mount();
  const original = editor.version!.displayName;
  await React.act(async () => editor.setVersionDisplayName("Unsaved name"));
  expect(editor.dirty).toBe(true);
  await React.act(async () => editor.reset());
  expect(editor.version!.displayName).toBe(original);
  expect(editor.dirty).toBe(false);
});

for (const kind of ["piece", "control-flow", "error-handler"] as const) {
  test(`detached descendant names are reserved when creating ${kind}`, async () => {
    await mount();
    let inserted: string | null = null, created: string | null = null;
    await React.act(async () => { inserted = editor.insertStepAfter("orphan_child"); });
    await React.act(async () => {
      created = kind === "piece"
        ? editor.createOrphanStep({ x: 800, y: 900 }, "fixture-tools", "prepare")
        : kind === "control-flow"
          ? editor.createOrphanControlFlowStep({ x: 800, y: 900 }, "LOOP_ON_ITEMS")
          : editor.addErrorHandling("notes");
    });
    expect(inserted).not.toBeNull();
    expect(created).not.toBeNull();
    expect(created).not.toBe(inserted);
    await React.act(async () => { expect((await editor.save()).ok).toBe(true); });
    await React.act(async () => editor.reload());
    const { flattenSteps } = await import("../../../v2/rooms/workflows/tree");
    const names = [editor.draftTrigger!, ...editor.draftOrphans.map(o => o.node)]
      .flatMap(root => flattenSteps(root).map(s => s.step.name));
    expect(names.filter(n => n === inserted)).toHaveLength(1);
    expect(names.filter(n => n === created)).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);
  });
}

test("a positioned detached child keeps its location on promotion, moves, saves and undoes", async () => {
  await mount();
  await React.act(async () => editor.setStepPosition("orphan_child", 640, 920));
  const before = JSON.stringify({ orphans: editor.draftOrphans, positions: editor.stepPositions });
  await React.act(async () => editor.deleteStep("orphan"));
  const effectivePosition = () => {
    const orphan = editor.draftOrphans.find(o => o.node.name === "orphan_child")!;
    return editor.stepPositions.orphan_child ?? { x: orphan.x, y: orphan.y };
  };
  expect(effectivePosition()).toEqual({ x: 640, y: 920 });
  await React.act(async () => editor.setOrphanPosition("orphan_child", 850, 1020));
  expect(effectivePosition()).toEqual({ x: 850, y: 1020 });
  await React.act(async () => editor.undo());
  expect(JSON.stringify({ orphans: editor.draftOrphans, positions: editor.stepPositions })).toBe(before);
  await React.act(async () => editor.deleteStep("orphan"));
  expect(effectivePosition()).toEqual({ x: 640, y: 920 });
  await React.act(async () => editor.setOrphanPosition("orphan_child", 850, 1020));
  await React.act(async () => { expect((await editor.save()).ok).toBe(true); });
  await React.act(async () => editor.reload());
  expect(effectivePosition()).toEqual({ x: 850, y: 1020 });
});

test("moving an orphan root retires a stale saved descendant override", async () => {
  await mount();
  await React.act(async () => editor.setStepPosition("orphan", 200, 300));
  await React.act(async () => editor.setOrphanPosition("orphan", 800, 900));
  expect(editor.stepPositions.orphan).toBeUndefined();
  expect(editor.draftOrphans[0]).toMatchObject({ x: 800, y: 900 });
});
test("the canvas room mounts the real editor over the fixture without a render error", async () => {
  const { WorkflowCanvasRoom } = await import("./WorkflowCanvasRoom");
  const shell = {
    mode: "preview",
    route: { room: "workflow", selection: { flowId: "meeting" } },
    navigate: () => {},
  } as unknown as BriefShellPort;
  const errors: unknown[] = [];
  const onError = (e: ErrorEvent) => errors.push(e.error ?? e.message);
  window.addEventListener("error", onError);
  try {
    await React.act(async () =>
      root.render(
        <div className="brief-root">
          <WorkflowCanvasRoom
            shell={shell}
            binding={{
              source: "fixture",
              scopeId: "canvas-test",
              flowId: "meeting",
              versionId: fixture.versionId,
              capabilities: caps,
              request: fixture.request,
            }}
          />
        </div>,
      ),
    );
    await React.act(async () => new Promise((r) => setTimeout(r, 50)));
  } finally {
    window.removeEventListener("error", onError);
  }
  expect(errors).toEqual([]);
  expect(host.querySelector(".wf-editor--workspace")).not.toBeNull();
  expect(host.textContent).toContain("Run workflow");
  expect(host.textContent).toContain("Saved draft");
  // The run-history poll reads the paged runs API shape ({ items, nextOffset }).
  expect(fixture.requests.some((r) => r.path.includes("/runs?"))).toBe(true);
  expect(fixture.requests.every((r) => r.method === "GET")).toBe(true);
});


test('setup notice opens mapped fields and partial saves remain editable without confirmation', async () => {
  const { WorkflowCanvasRoom } = await import('./WorkflowCanvasRoom');
  const { CANVAS_CATALOG } = await import('./fixtures');
  const saved = fixture.snapshot().version;
  saved.trigger = { name: 'trigger', displayName: 'Receive form submissions', type: 'PIECE_TRIGGER',
    settings: { pieceName: 'webhook', input: { submission_id_field: '', submission_email_field: '', secret: 'fixture-signature' } },
    nextAction: { name: 'append', displayName: 'Append to Sheets', type: 'PIECE',
      settings: { pieceName: 'fixture-tools', actionName: 'prepare', input: {} } },
  };
  await fixture.request(`/api/workflows/meeting/versions/${fixture.versionId}`, { method: 'PATCH', body: JSON.stringify({ ...saved, uiMeta: fixture.snapshot().uiMeta }) });
  fixture.requests.length = 0;
  const request: WorkflowCanvasBinding['request'] = async (input, init) => String(input) === '/api/workflows/pieces'
    ? Response.json(CANVAS_CATALOG.map(p => ({ ...p, auth: { type: 'OAUTH2' } }))) : fixture.request(input, init);
  const shell = { mode: 'preview', route: { room: 'workflow', selection: { flowId: 'meeting' } }, navigate() {} } as unknown as BriefShellPort;
  let runs = 0, publishes = 0;
  await React.act(async () => root.render(<div className="brief-root"><WorkflowCanvasRoom shell={shell} binding={{
    source: 'fixture', scopeId: 'setup-test', flowId: 'meeting', versionId: fixture.versionId, capabilities: caps, request,
    run: async () => { runs++; return { ok: true, message: '' }; }, publish: async () => { publishes++; },
  }} /></div>));
  const button = (name: string) => [...host.querySelectorAll('button')].find(b => b.querySelector('.brief-button__label')?.textContent === name)!;
  expect(host.querySelector('.brief-canvas-setup')?.textContent).toContain('Submission ID field, Email field');
  expect(host.querySelector('.brief-canvas-setup')?.textContent).toContain('Account, Instructions');
  expect(button('Run workflow').disabled).toBe(true);
  expect(button('Publish version').disabled).toBe(true);
  await React.act(async () => button('Receive form submissions').click());
  expect(host.querySelector('[aria-label="Step settings"]')?.getAttribute('data-open')).toBe('true');
  expect(host.querySelector('[aria-label="Step settings"]')?.hasAttribute('inert')).toBe(false);
  expect((host.querySelector('input[type="password"]') as HTMLInputElement)?.value).toBe('fixture-signature');
  expect(host.querySelector('[contenteditable]')?.textContent).not.toContain('fixture-signature');
  const field = [...host.querySelectorAll('label')].find(e => e.textContent?.startsWith('Submission ID field'))!.querySelector('[contenteditable]')!;
  await React.act(async () => {
    field.textContent = 'form.id';
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
  expect(button('Save changes').disabled).toBe(false);
  await React.act(async () => button('Save changes').click());
  expect(fixture.snapshot().version.trigger.settings?.input).toEqual({ submission_id_field: 'form.id', submission_email_field: '', secret: 'fixture-signature' });
  expect(host.querySelector('[role="alertdialog"]')).toBeNull();
  expect(host.querySelector('.brief-canvas-setup')?.textContent).toContain('Email field');
  expect(fixture.requests.filter(r => r.method !== 'GET').map(r => r.method)).toEqual(['PATCH']);
  expect(runs).toBe(0); expect(publishes).toBe(0);
});


test('request-ID-only setup is editable and does not ask for email',async()=>{
 const {WorkflowCanvasRoom}=await import('./WorkflowCanvasRoom');
 const saved=fixture.snapshot().version;
 saved.trigger={name:'trigger',displayName:'Receive request',type:'PIECE_TRIGGER',settings:{pieceName:'webhook',input:{request_id_field:''}}};
 await fixture.request(`/api/workflows/meeting/versions/${fixture.versionId}`,{method:'PATCH',body:JSON.stringify({...saved,uiMeta:fixture.snapshot().uiMeta})});
 const shell={mode:'preview',route:{room:'workflow',selection:{flowId:'meeting'}},navigate(){}} as unknown as BriefShellPort;
 await React.act(async()=>root.render(<div className="brief-root"><WorkflowCanvasRoom shell={shell} binding={{source:'fixture',scopeId:'request-setup',flowId:'meeting',versionId:fixture.versionId,capabilities:caps,request:fixture.request}}/></div>));
 expect(host.querySelector('.brief-canvas-setup')?.textContent).toContain('Request ID field');
 expect(host.querySelector('.brief-canvas-setup')?.textContent).not.toContain('Email field');
 const button=[...host.querySelectorAll('button')].find(b=>b.querySelector('.brief-button__label')?.textContent==='Receive request')!;
 await React.act(async()=>button.click());
 const field = [...host.querySelectorAll('label')].find(e=>e.textContent?.startsWith('Request ID field'))!.querySelector('[contenteditable]')!;
 await React.act(async()=>{ field.textContent='request.id'; field.dispatchEvent(new Event('input',{bubbles:true})); });
 const save=[...host.querySelectorAll('button')].find(b=>b.querySelector('.brief-button__label')?.textContent==='Save changes')!;
 await React.act(async()=>save.click());
 expect(fixture.snapshot().version.trigger.settings?.input).toEqual({request_id_field:'request.id'});
});
