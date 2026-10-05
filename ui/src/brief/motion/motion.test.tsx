import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { BRIEF_MOTION, createBriefMotion } from "./motion";

GlobalRegistrator.register({ url: "http://localhost:4384/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let React: typeof import("react");
let createRoot: typeof import("react-dom/client").createRoot;
let hooks: typeof import("./hooks");
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const actualComputed = globalThis.getComputedStyle;
const actualAnimate = HTMLElement.prototype.animate;
const actualMatchMedia = window.matchMedia;
let systemReduced = false;
const listeners = new Set<() => void>();
type FakeAnimation = { playState: string; pending: boolean; onfinish: (() => void) | null; cancel: () => void; frames: Keyframe[]; duration: number };
let animations: FakeAnimation[] = [];
let visual = new WeakMap<Element, Record<string, string>>();
beforeAll(async () => {
  React = await import("react");
  ({ createRoot } = await import("react-dom/client"));
  hooks = await import("./hooks");
});
beforeEach(() => {
  animations = []; visual = new WeakMap(); systemReduced = false;
  window.matchMedia = (() => ({ matches: systemReduced,
    addEventListener: (_type: string, callback: () => void) => listeners.add(callback),
    removeEventListener: (_type: string, callback: () => void) => listeners.delete(callback) })) as unknown as typeof window.matchMedia;
  globalThis.getComputedStyle = ((node: Element) => {
    const computed = actualComputed(node);
    return new Proxy(computed, { get(target, key) { return visual.get(node)?.[key as string] ?? Reflect.get(target, key); } });
  }) as typeof getComputedStyle;
  HTMLElement.prototype.animate = function(frames, options) {
    const element = this;
    const animation: FakeAnimation = { playState: "running", pending: false, onfinish: null,
      frames: frames as Keyframe[], duration: (options as KeyframeAnimationOptions).duration as number,
      cancel() { this.playState = "idle"; visual.delete(element); } };
    animations.push(animation); return Object.assign(animation, { finished: Promise.resolve(animation) }) as unknown as Animation;
  };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await React.act(async () => root.unmount()); host.remove();
  globalThis.getComputedStyle = actualComputed; HTMLElement.prototype.animate = actualAnimate; window.matchMedia = actualMatchMedia; listeners.clear(); });
afterAll(() => GlobalRegistrator.unregister());

test("durations retain the approved contact, local and spatial entry/exit rules", () => {
  expect(BRIEF_MOTION.press).toEqual({ enter: 100, exit: 80 });
  expect(BRIEF_MOTION.reveal).toEqual({ enter: 200, exit: 160 });
  expect(BRIEF_MOTION.selection).toEqual({ enter: 180, exit: 180 });
  expect(BRIEF_MOTION.reflow).toEqual({ enter: 320, exit: 280 });
  expect(BRIEF_MOTION.transfer).toEqual({ enter: 280, exit: 220 });
  expect(BRIEF_MOTION.settle).toEqual({ enter: 180, exit: 160 });
});
test("reversal samples the rendered position before cancellation, never the old endpoint", () => {
  const motion = createBriefMotion(host);
  motion.to({ transform: "translateX(120px)" }, { kind: "transfer", active: true });
  visual.set(host, { transform: "matrix(1, 0, 0, 1, 47.25, 0)" });
  motion.to({ transform: "translateX(0px)" }, { kind: "transfer", active: false });
  expect(animations[0]!.playState).toBe("idle");
  expect(animations[1]!.frames[0]!.transform).toBe("matrix(1, 0, 0, 1, 47.25, 0)");
  expect(animations[1]!.duration).toBe(220);
  expect(host.style.transform).toBe("translateX(0px)");
  expect(animations.filter(a => a.playState === "running")).toHaveLength(1);
  motion.dispose();
});
test("twenty reversals have one current animation; stale completion cannot cancel its replacement", () => {
  const motion = createBriefMotion(host);
  for (let i = 0; i < 40; i++) {
    const stale = animations.at(-1)?.onfinish;
    motion.to({ opacity: i % 2 === 0 ? 1 : 0 }, { kind: "reveal", active: i % 2 === 0 });
    stale?.();
    expect(animations.filter(a => a.playState === "running")).toHaveLength(1);
  }
  animations.at(-1)!.onfinish!();
  expect(animations.every(a => a.playState === "idle")).toBe(true);
  expect(host.style.opacity).toBe("0");
  motion.dispose();
});
test("reduced motion interrupts immediately to the same latest endpoint", () => {
  const motion = createBriefMotion(host);
  motion.to({ width: 400, opacity: 1 }, { kind: "reflow", active: true });
  motion.to({ width: 220, opacity: 0 }, { kind: "reflow", active: false, reduced: true });
  expect(animations).toHaveLength(1); expect(animations[0]!.playState).toBe("idle");
  expect(host.style.width).toBe("220px"); expect(host.style.opacity).toBe("0");
  motion.dispose();
});
test("unsupported WAAPI still commits the final usable style", () => {
  HTMLElement.prototype.animate = undefined as unknown as typeof actualAnimate;
  const motion = createBriefMotion(host);
  motion.to({ height: 80 }, { kind: "reflow", active: true });
  expect(host.style.height).toBe("80px"); expect(animations).toHaveLength(0);
  motion.dispose();
});
test("an unchanged endpoint never replays an animation, including after reduced motion", () => {
  const motion = createBriefMotion(host);
  motion.to({ opacity: 1 }, { kind: "reveal", active: true, reduced: true });
  motion.to({ opacity: 1 }, { kind: "reveal", active: true });
  expect(animations).toHaveLength(0);
  motion.dispose();
});
test("disposal restores owned inline properties and cancels work without touching unrelated styling", () => {
  host.style.transform = "translateX(2px)"; host.style.color = "red";
  const motion = createBriefMotion(host);
  motion.to({ transform: "translateX(80px)" }, { kind: "transfer", active: true });
  motion.dispose(); motion.to({ transform: "translateX(50px)" }, { kind: "transfer", active: true });
  expect(host.style.transform).toBe("translateX(2px)"); expect(host.style.color).toBe("red");
  expect(animations).toHaveLength(1); expect(animations[0]!.playState).toBe("idle");
});
function Example({ active, forceReduced = false }: { active: boolean; forceReduced?: boolean }) {
  const ref = hooks.useBriefMotion<HTMLDivElement>({ transform: `translateX(${active ? 100 : 0}px)` }, { kind: "reveal", active, reduced: forceReduced });
  return <div ref={ref}><input aria-label="Retained draft" defaultValue="Keep my content" /></div>;
}
test("mount is still; subsequent intents preserve focus and content while moving only the wrapper", async () => {
  await React.act(async () => root.render(<Example active={false} />));
  expect(animations).toHaveLength(0);
  const input = host.querySelector("input")!; input.focus(); input.value = "Edited draft";
  await React.act(async () => root.render(<Example active />));
  expect(animations).toHaveLength(1); expect(document.activeElement).toBe(input); expect(input.value).toBe("Edited draft");
});
test("live OS preference changes finish a running transition without remounting or losing state", async () => {
  await React.act(async () => root.render(<Example active={false} />));
  await React.act(async () => root.render(<Example active />));
  const input = host.querySelector("input")!; input.focus();
  await React.act(async () => { systemReduced = true; for (const callback of listeners) callback(); });
  expect(animations).toHaveLength(1); expect(animations[0]!.playState).toBe("idle");
  expect(host.firstElementChild?.getAttribute("style")).toContain("translateX(100px)");
  expect(document.activeElement).toBe(input);
  await React.act(async () => root.render(<Example active={false} forceReduced={false} />));
  expect(animations).toHaveLength(1); // A local flag must never defeat OS reduction.
});
test("local reduced examples match selection without bypassing the OS or animating", async () => {
  await React.act(async () => root.render(<Example active={false} forceReduced />));
  await React.act(async () => root.render(<Example active forceReduced />));
  expect(animations).toHaveLength(0);
  expect(host.firstElementChild?.getAttribute("style")).toContain("translateX(100px)");
});
test("StrictMode mount and unmount leave no animation or media listeners behind", async () => {
  await React.act(async () => root.render(<React.StrictMode><Example active={false} /></React.StrictMode>));
  expect(animations).toHaveLength(0); expect(listeners.size).toBe(1);
  await React.act(async () => root.render(<React.StrictMode><Example active /></React.StrictMode>));
  await React.act(async () => root.render(null));
  expect(animations.every(a => a.playState === "idle")).toBe(true); expect(listeners.size).toBe(0);
});
