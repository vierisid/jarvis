import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { focusRun, useRunFocus } = await import("./run-focus");

let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; });
afterAll(() => GlobalRegistrator.unregister());

function Probe({ seen }: { seen: Array<{ flowId: string; runId: string }> }) {
  useRunFocus((target) => { seen.push(target); });
  return null;
}
async function mount(seen: Array<{ flowId: string; runId: string }>) {
  const host = document.createElement("div");
  root = createRoot(host);
  await act(async () => { root!.render(<Probe seen={seen} />); });
}

// Q-19, review C7: Today's "Open" lands on the failed run itself.
test("a run asked for before the room opens is taken once it mounts, and only once", async () => {
  focusRun("flow-1", "run-1");
  const seen: Array<{ flowId: string; runId: string }> = [];
  await mount(seen);
  expect(seen).toEqual([{ flowId: "flow-1", runId: "run-1" }]);
  await act(async () => root!.unmount());
  root = undefined;
  const again: Array<{ flowId: string; runId: string }> = [];
  await mount(again);
  expect(again).toEqual([]);
});

test("a run asked for while the room is open is taken at once", async () => {
  const seen: Array<{ flowId: string; runId: string }> = [];
  await mount(seen);
  await act(async () => { focusRun("flow-2", "run-2"); });
  expect(seen).toEqual([{ flowId: "flow-2", runId: "run-2" }]);
});
