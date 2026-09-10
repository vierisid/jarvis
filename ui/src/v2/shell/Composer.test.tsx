import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let act: typeof import("react").act;
let createRoot: typeof import("react-dom/client").createRoot;
let Composer: typeof import("./Composer").Composer;
let host: HTMLDivElement;
let field: HTMLInputElement;
let root: ReturnType<typeof createRoot>;

beforeAll(async () => {
  ({ act } = await import("react"));
  ({ createRoot } = await import("react-dom/client"));
  ({ Composer } = await import("./Composer"));
});
beforeEach(() => {
  host = document.createElement("div");
  field = document.createElement("input");
  document.body.append(host, field);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  field.remove();
});
afterAll(() => GlobalRegistrator.unregister());

const render = (node: React.ReactNode) => act(async () => root.render(node));
const input = () => host.querySelector<HTMLTextAreaElement>(".v2-composer__input")!;

describe("Composer autoFocus", () => {
  test("focuses when opened ready, and a later reconnect does not take focus back", async () => {
    await render(<Composer autoFocus />);
    expect(document.activeElement === input()).toBe(true);
    field.focus();
    await render(<Composer autoFocus disabled />);
    await render(<Composer autoFocus />);
    expect(document.activeElement === field).toBe(true);
  });

  test("opened while disconnected, focuses once the connection is ready", async () => {
    await render(<Composer autoFocus disabled />);
    expect(document.activeElement === input()).toBe(false);
    await render(<Composer autoFocus />);
    expect(document.activeElement === input()).toBe(true);
  });

  test("opened while disconnected, leaves a field the user moved to in the meantime", async () => {
    await render(<Composer autoFocus disabled />);
    field.focus();
    await render(<Composer autoFocus />);
    expect(document.activeElement === field).toBe(true);
  });

  test("a reconnect gives focus back when the disconnect took it from the composer", async () => {
    await render(<Composer autoFocus />);
    expect(document.activeElement === input()).toBe(true);
    // Browsers drop focus to <body> when a focused textarea becomes disabled.
    // happy-dom does not, and ignores blur() once disabled, so blur first.
    input().blur();
    await render(<Composer autoFocus disabled />);
    expect(document.activeElement === input()).toBe(false);
    await render(<Composer autoFocus />);
    expect(document.activeElement === input()).toBe(true);
  });

  test("without autoFocus never moves focus", async () => {
    await render(<Composer />);
    expect(document.activeElement === input()).toBe(false);
  });
});
