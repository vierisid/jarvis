import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register({ url: "http://localhost:4383/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let C: typeof import("../controls");
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeAll(async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  C = await import("../controls");
});
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); });
afterAll(() => GlobalRegistrator.unregister());
async function mount(child: React.ReactNode, theme = "light") {
  await React.act(async () => root.render(<div className="brief-root" data-brief-theme={theme}>{child}</div>));
}
async function click(node: HTMLElement) { await React.act(async () => node.click()); }
async function key(node: Element, key: string) {
  await React.act(async () => node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
}

test("pending actions retain focus, suppress repeat activation and prevent submit", async () => {
  let clicks = 0, submissions = 0;
  const form = (state: "idle" | "pending") => <form onSubmit={e => { e.preventDefault(); submissions++; }}>
    <C.BriefButton type="submit" state={state} stateLabels={{ pending: "Saving", success: "Saved" }} onClick={() => clicks++}>Save</C.BriefButton>
  </form>;
  await mount(form("idle"));
  const button = host.querySelector("button")!;
  await React.act(async () => button.focus());
  await click(button);
  expect(clicks).toBe(1); expect(submissions).toBe(1);
  await mount(form("pending"));
  await click(button); await click(button);
  expect(clicks).toBe(1); expect(submissions).toBe(1);
  expect(document.activeElement).toBe(button);
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.disabled).toBe(false);
});

test("native disabled and aria-disabled buttons cannot activate", async () => {
  let actions = 0;
  await mount(<><C.BriefButton disabled onClick={() => actions++}>Disabled</C.BriefButton>
    <C.BriefButton aria-disabled="true" onClick={() => actions++}>Unavailable</C.BriefButton></>);
  for (const button of host.querySelectorAll("button")) await click(button);
  expect(actions).toBe(0);
});

test("alternate action labels reserve space but remain hidden from assistive technology", async () => {
  await mount(<C.BriefButton state="success" stateLabels={{ pending: "Saving", success: "Changes saved", error: "Try again" }}>Save changes</C.BriefButton>);
  expect(host.querySelector(".brief-button__label")?.textContent).toBe("Changes saved");
  expect([...host.querySelectorAll(".brief-button__reserve")].every(n => n.getAttribute("aria-hidden") === "true")).toBe(true);
});

test("fields retain the input node and value through validation and success", async () => {
  const field = (error?: string, saved?: string) => <C.BriefInput label="Name" defaultValue="Long retained value" hint="Public name"
    reserveMessage="Enter a valid name" error={error} saved={saved} aria-describedby="outside-help" />;
  await mount(field());
  const input = host.querySelector("input")!;
  await React.act(async () => input.focus());
  await mount(field("Enter a valid name"));
  expect(host.querySelector("input")).toBe(input);
  expect(document.activeElement).toBe(input);
  expect(input.value).toBe("Long retained value");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  const description = input.getAttribute("aria-describedby")!.split(" ");
  expect(description[0]).toBe("outside-help");
  expect(document.getElementById(description[1]!)?.textContent).toBe("Enter a valid name");
  expect(host.querySelector("label")?.htmlFor).toBe(input.id);
  expect(input.hasAttribute("reserveMessage")).toBe(false);
  await mount(field(undefined, "Saved"));
  expect(input.getAttribute("aria-invalid")).toBeNull();
  expect(document.getElementById(description[1]!)?.textContent).toBe("Saved");
});

test("native select and textarea remain labeled and retain supplied semantics", async () => {
  await mount(<><C.BriefSelect label="Frequency" defaultValue="weekly"><option value="daily">Daily</option><option value="weekly">Weekly</option></C.BriefSelect>
    <C.BriefTextarea label="Notes" required defaultValue={"First line\nSecond line"} /></>);
  expect(host.querySelector("select")?.value).toBe("weekly");
  expect(host.querySelector("textarea")?.value).toBe("First line\nSecond line");
  expect(host.querySelector("textarea")?.required).toBe(true);
  for (const label of host.querySelectorAll("label")) expect(document.getElementById(label.htmlFor)).not.toBeNull();
});

test("switch reports the opposite value once; disabled position and meaning stay intact", async () => {
  let values: boolean[] = [];
  await mount(<C.BriefSwitch label="Workflow" checked onCheckedChange={value => values.push(value)} onLabel="Enabled" offLabel="Paused" />);
  await click(host.querySelector("button")!);
  expect(values).toEqual([false]);
  await mount(<C.BriefSwitch label="Workflow" checked={false} disabled onCheckedChange={value => values.push(value)} onLabel="Enabled" offLabel="Paused" />);
  const button = host.querySelector("button")!;
  await click(button);
  expect(values).toEqual([false]);
  expect(button.getAttribute("aria-checked")).toBe("false");
  expect(button.disabled).toBe(true);
  expect(host.querySelector(".brief-switch__value > span:last-child")?.textContent).toBe("Paused");
});

test("segment groups use independent native radio names and controlled selection", async () => {
  let choice = "";
  const options = [{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }];
  await mount(<><C.BriefSegments label="Appearance" options={options} value="light" onValueChange={value => choice = value} />
    <C.BriefSegments label="Other appearance" options={options} value="dark" onValueChange={() => {}} /></>);
  const radios = [...host.querySelectorAll("input")];
  expect(radios[0]!.name).toBe(radios[1]!.name);
  expect(radios[0]!.name).not.toBe(radios[2]!.name);
  await click(radios[1]!);
  expect(choice).toBe("dark");
  expect(radios[3]!.checked).toBe(true);
});

test("tab arrows skip disabled entries without activating; switching preserves panel state", async () => {
  let selected = "first";
  const items = [
    { value: "first", label: "First", content: <input aria-label="Draft" defaultValue="Retain me" /> },
    { value: "disabled", label: "Disabled", disabled: true, content: null },
    { value: "last", label: "Last", content: <p>Last panel</p> },
  ];
  const tabs = (value: string) => <C.BriefTabs label="Work" items={items} value={value} onValueChange={value => selected = value} />;
  await mount(tabs("first"));
  const buttons = host.querySelectorAll("button");
  const draft = host.querySelector("input")!; draft.value = "Edited draft";
  await key(buttons[0]!, "ArrowRight");
  expect(document.activeElement).toBe(buttons[2]!); expect(selected).toBe("first");
  await key(buttons[2]!, "Home"); expect(document.activeElement).toBe(buttons[0]!);
  await key(buttons[0]!, "End"); expect(document.activeElement).toBe(buttons[2]!);
  await click(buttons[2]!); expect(selected).toBe("last");
  await mount(tabs("last")); await mount(tabs("first"));
  expect(host.querySelector("input")).toBe(draft); expect(draft.value).toBe("Edited draft");
  expect(buttons[0]!.getAttribute("aria-selected")).toBe("true");
  const panelId = buttons[0]!.getAttribute("aria-controls")!;
  expect(document.getElementById(panelId)?.getAttribute("hidden")).toBeNull();
});

const menuItems = (select: (id: string) => void) => [
  { id: "profile", label: "Profile", onSelect: () => select("profile") },
  { id: "unavailable", label: "Unavailable", disabled: true, onSelect: () => select("bad") },
  { id: "settings", label: "Settings", onSelect: () => select("settings") },
];

test("menu uses a portal with inherited theme; keyboard skips disabled and restores trigger", async () => {
  let selected = "";
  await mount(<C.BriefMenu label="Account" items={menuItems(id => selected = id)} />, "dark");
  const trigger = host.querySelector("button")!;
  await key(trigger, "ArrowDown");
  const menu = document.querySelector('[role="menu"]')!;
  expect(menu).not.toBeNull(); expect(host.contains(menu)).toBe(false);
  expect(menu.closest("[data-brief-theme]")?.getAttribute("data-brief-theme")).toBe("dark");
  expect(document.activeElement?.textContent).toBe("Profile");
  await key(document.activeElement!, "ArrowDown"); expect(document.activeElement?.textContent).toBe("Settings");
  await key(document.activeElement!, "Home"); expect(document.activeElement?.textContent).toBe("Profile");
  await key(document.activeElement!, "End"); expect(document.activeElement?.textContent).toBe("Settings");
  await key(document.activeElement!, "p"); expect(document.activeElement?.textContent).toBe("Profile");
  await click(document.activeElement as HTMLElement);
  expect(selected).toBe("profile"); expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(trigger); expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

test("menu opens at last item with ArrowUp; Escape dismisses without action", async () => {
  let actions = 0;
  await mount(<C.BriefMenu label="Account" items={menuItems(() => actions++)} />);
  const trigger = host.querySelector("button")!;
  await key(trigger, "ArrowUp"); expect(document.activeElement?.textContent).toBe("Settings");
  await key(document.activeElement!, "Escape");
  expect(document.querySelector('[role="menu"]')).toBeNull(); expect(actions).toBe(0); expect(document.activeElement).toBe(trigger);
});

test("menu dismisses on outside pointer and focus without stealing focus", async () => {
  await mount(<><C.BriefMenu label="Account" items={menuItems(() => {})} /><button>Outside</button></>);
  const [trigger, outside] = [...host.querySelectorAll("button")];
  await click(trigger!);
  await React.act(async () => outside!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await click(trigger!); await React.act(async () => outside!.focus());
  expect(document.querySelector('[role="menu"]')).toBeNull(); expect(document.activeElement).toBe(outside!);
});

test("an open menu follows a local appearance change", async () => {
  const menu = <C.BriefMenu label="Account" items={menuItems(() => {})} />;
  await mount(menu, "light"); await click(host.querySelector("button")!);
  await mount(menu, "dark");
  expect(document.querySelector('[role="menu"]')?.closest("[data-brief-theme]")?.getAttribute("data-brief-theme")).toBe("dark");
});

test("tooltip is immediate on focus, has a description, and Escape retains focus", async () => {
  await mount(<C.BriefIconButton label="Close panel" icon={<span>X</span>} />);
  const button = host.querySelector("button")!;
  await React.act(async () => button.focus());
  const tip = document.querySelector('[role="tooltip"]')!;
  expect(tip.textContent).toBe("Close panel"); expect(button.getAttribute("aria-describedby")).toBe(tip.id);
  await key(button, "Escape");
  expect(document.querySelector('[role="tooltip"]')).toBeNull(); expect(document.activeElement).toBe(button);
});

test("unmount removes a menu and its portaled content", async () => {
  await mount(<C.BriefMenu label="Account" items={menuItems(() => {})} />);
  await click(host.querySelector("button")!);
  await mount(<p>Another room</p>);
  expect(document.querySelector('[role="menu"]')).toBeNull(); expect(document.querySelector(".brief-control-layer")).toBeNull();
});

test("pointer departure does not dismiss a keyboard-focused tooltip", async () => {
  await mount(<><C.BriefIconButton label="Close panel" icon={<span>X</span>} /><button>Outside</button></>);
  const button = host.querySelector("button")!;
  await React.act(async () => button.focus());
  await React.act(async () => {
    button.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
    await new Promise(resolve => setTimeout(resolve, 100));
  });
  expect(document.querySelector('[role="tooltip"]')?.textContent).toBe("Close panel");
  await React.act(async () => host.querySelectorAll("button")[1]!.focus());
  expect(document.querySelector('[role="tooltip"]')).toBeNull();
});
