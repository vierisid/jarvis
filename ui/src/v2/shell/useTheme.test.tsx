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
import { useTheme } from "./useTheme";
let React: typeof import("react"),
  createRoot: typeof import("react-dom/client").createRoot;
let root: Root,
  host: HTMLDivElement,
  setters: Array<(next?: "light" | "dark") => void>;
function Selector({ index }: { index: number }) {
  const [theme, setTheme] = useTheme();
  setters[index] = setTheme;
  return (
    <button data-theme-value={theme} onClick={() => setTheme()}>
      {theme}
    </button>
  );
}
function App() {
  return (
    <main>
      <input defaultValue="Keep my chat draft" />
      <aside data-sidebar="rail" />
      <Selector index={0} />
      <Selector index={1} />
      <menu>
        <Selector index={2} />
      </menu>
    </main>
  );
}
beforeAll(async () => {
  GlobalRegistrator.register();
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
});
beforeEach(async () => {
  document.documentElement.setAttribute("data-theme", "light");
  localStorage.clear();
  setters = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await React.act(async () => root.render(<App />));
});
afterEach(async () => {
  await React.act(async () => root.unmount());
  host.remove();
});
afterAll(() => GlobalRegistrator.unregister());
function expectTheme(theme: string) {
  expect(document.documentElement.getAttribute("data-theme")).toBe(theme);
  expect(
    [...host.querySelectorAll("button")].map((n) => n.dataset.themeValue),
  ).toEqual([theme, theme, theme]);
}
test("independent controls and menus update together without replacing focused content", async () => {
  const input = host.querySelector("input")!;
  input.focus();
  input.setSelectionRange(5, 9);
  await React.act(async () => setters[1]!("dark"));
  expectTheme("dark");
  expect(localStorage.getItem("jarvis-theme")).toBe("dark");
  expect(host.querySelector("input")).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("Keep my chat draft");
  expect(input.selectionStart).toBe(5);
  expect(host.querySelector("aside")!.dataset.sidebar).toBe("rail");
  await React.act(async () => setters[2]!("light"));
  expectTheme("light");
});
test("rapid independent toggles read the current root rather than a stale render", async () => {
  await React.act(async () => {
    setters[0]!();
    setters[1]!();
  });
  expectTheme("light");
});
test("cross-tab storage updates all subscribers without echoing a storage write", async () => {
  localStorage.setItem("jarvis-theme", "light");
  await React.act(async () =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "jarvis-theme",
        newValue: "dark",
        storageArea: localStorage,
      }),
    ),
  );
  expectTheme("dark");
  expect(localStorage.getItem("jarvis-theme")).toBe("light");
  await React.act(async () =>
    window.dispatchEvent(
      new StorageEvent("storage", { key: "unrelated", newValue: "light" }),
    ),
  );
  expectTheme("dark");
  await React.act(async () =>
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "jarvis-theme",
        newValue: "light",
        storageArea: sessionStorage,
      }),
    ),
  );
  expectTheme("dark");
});
test("storage clear/removal uses the bootstrap OS fallback", async () => {
  const original = window.matchMedia;
  window.matchMedia = ((query) => ({
    ...original.call(window, query),
    matches: true,
  })) as typeof window.matchMedia;
  try {
    for (const key of ["jarvis-theme", null]) {
      await React.act(async () =>
        window.dispatchEvent(
          new StorageEvent("storage", { key, newValue: null }),
        ),
      );
      expectTheme("dark");
      await React.act(async () => setters[0]!("light"));
    }
  } finally {
    window.matchMedia = original;
  }
});
test("existing direct root writers remain observable", async () => {
  await React.act(async () => {
    document.documentElement.setAttribute("data-theme", "dark");
    await new Promise((r) => setTimeout(r, 10));
  });
  expectTheme("dark");
});
test("storage denial still changes in-memory appearance", async () => {
  const original = localStorage.setItem;
  localStorage.setItem = () => {
    throw Error("Denied");
  };
  try {
    await React.act(async () => setters[0]!("dark"));
    expectTheme("dark");
  } finally {
    localStorage.setItem = original;
  }
});
