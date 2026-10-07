import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
let React: typeof import("react"), createRoot: typeof import("react-dom/client").createRoot;
let Environment: typeof import("./WorkflowEditorEnvironment").WorkflowEditorEnvironment;
let useDraft: typeof import("./useSampleDraftText").useSampleDraftText;
let host: HTMLDivElement, root: Root, draft: ReturnType<typeof useDraft>, cache: Map<string, string>;
beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  ({ WorkflowEditorEnvironment: Environment } = await import("./WorkflowEditorEnvironment"));
  ({ useSampleDraftText: useDraft } = await import("./useSampleDraftText"));
});
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  cache = new Map();
});
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); });
afterAll(() => GlobalRegistrator.unregister());
function Harness({ name, incoming }: { name: string; incoming: string }) {
  draft = useDraft(name, incoming); return null;
}
const request = async () => Response.json({});
async function render(name: string, incoming: string) {
  await React.act(async () => root.render(
    <Environment.Provider value={{ request, workspace: true, portalHost: null, sampleDrafts: cache }}>
      <Harness key={name} name={name} incoming={incoming} />
    </Environment.Provider>,
  ));
}
for (const section of ["input", "output"]) {
  test(`${section}: compact saved JSON stays saved after changing nodes`, async () => {
    const key = `${section}:draft`, compact = '{"x":1}', saved = JSON.stringify({ x: 1 }, null, 2);
    await render(key, "");
    await React.act(async () => draft.setText(compact));
    expect(draft.hasUnsavedEdits).toBe(true);
    await React.act(async () => draft.markSaved(compact));
    await render(key, saved);
    expect(draft.hasUnsavedEdits).toBe(false);
    await render(`${section}:notes`, "");
    await render(key, saved);
    expect(draft.hasUnsavedEdits).toBe(false);
  });
}
test("a late save acknowledges only its submitted value after the editor remounts", async () => {
  const first = '{"x":1}', later = '{"x":2}';
  await render("output:draft", "");
  await React.act(async () => draft.setText(first));
  const acknowledge = draft.markSaved; // the in-flight request captured the previous mount
  await render("output:notes", "");
  await render("output:draft", "");
  await React.act(async () => draft.setText(later));
  await React.act(async () => acknowledge(first));
  await render("output:draft", JSON.stringify({ x: 1 }, null, 2));
  expect(draft.text).toBe(later);
  expect(draft.hasUnsavedEdits).toBe(true);
  // Restoring the acknowledged value does not need another save.
  await React.act(async () => draft.setText(first));
  expect(draft.hasUnsavedEdits).toBe(false);
});
test("invalid and distinct input/output drafts survive inspector remounts", async () => {
  await render("input:draft", "");
  await React.act(async () => draft.setText('{"unfinished":'));
  await render("output:draft", "");
  await React.act(async () => draft.setText('{"output":true}'));
  await render("input:draft", "");
  expect(draft.text).toBe('{"unfinished":');
  expect(draft.hasUnsavedEdits).toBe(true);
  await render("output:draft", "");
  expect(draft.text).toBe('{"output":true}');
  expect(draft.hasUnsavedEdits).toBe(true);
});
