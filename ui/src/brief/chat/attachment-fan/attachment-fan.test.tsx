import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import { bindAttachmentFan, type AttachmentFanBinding, type AttachmentOwner, type AttachmentPickers } from "./model";
let React: typeof import("react"), createRoot: typeof import("react-dom/client").createRoot;
let AttachmentFan: typeof import("./AttachmentFan").AttachmentFan;
let root: Root, host: HTMLDivElement, binding: AttachmentFanBinding, calls: string[], feedback: string[];
beforeAll(async () => { GlobalRegistrator.register(); (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; React = await import("react"); ({ createRoot } = await import("react-dom/client")); ({ AttachmentFan } = await import("./AttachmentFan")); });
beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host); calls = []; feedback = [];
  binding = { source:"fixture", scopeId:"w", conversationId:"a", enabled:true, screenshot:{available:true},
    choose:async kind => { calls.push(kind); return "attached"; } };
});
afterEach(async () => { await React.act(async () => root.unmount()); host.remove(); });
afterAll(() => GlobalRegistrator.unregister());
async function render(mode:"preview"|"live"="preview",theme="light",report=(message:string)=>feedback.push(message)) {
  await React.act(async () => root.render(<div className="brief-root" data-brief-theme={theme}>
    <AttachmentFan mode={mode} binding={binding} reducedMotion onFeedback={report} />
    <input aria-label="Next field" defaultValue="Keep draft" />
  </div>));
}
const toggle = () => host.querySelector<HTMLButtonElement>("button")!;
const row = (kind:string) => document.querySelector<HTMLButtonElement>(`[data-choice="${kind}"]`)!;
const menu = () => document.querySelector<HTMLElement>('[role="menu"]')!;
async function click(button:HTMLButtonElement) { await React.act(async () => button.click()); }
async function key(element:HTMLElement,key:string) { const event=new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true}); await React.act(async()=>element.dispatchEvent(event)); return event; }

test("three choices stay mounted across twenty reversals and retain composer value",async()=>{
  await render(); const nodes = [row("document"),row("image"),row("screenshot")];
  for(let i=0;i<20;i++){await click(toggle()); expect(menu().getAttribute("aria-hidden")).toBe("false"); await click(toggle()); expect(menu().getAttribute("aria-hidden")).toBe("true"); expect(row("document")).toBe(nodes[0]!);}
  expect(calls).toEqual([]); expect(host.querySelector("input")!.value).toBe("Keep draft");
});
test("keyboard reaches each choice; Escape closes only the fan and restores plus",async()=>{
  await render(); let escaped=0; const listener=()=>escaped++; document.addEventListener("keydown",listener);
  try { await key(toggle(),"ArrowUp"); expect(document.activeElement).toBe(row("document"));
    await key(row("document"),"ArrowUp"); expect(document.activeElement).toBe(row("image"));
    await key(row("image"),"ArrowUp"); expect(document.activeElement).toBe(row("screenshot"));
    const before=escaped; await key(row("screenshot"),"Escape"); expect(escaped).toBe(before); expect(document.activeElement).toBe(toggle()); expect(menu().getAttribute("aria-hidden")).toBe("true");
  } finally { document.removeEventListener("keydown",listener); }
});
test("unavailable Screenshot stays focusable with a reason but cannot capture",async()=>{
  binding.screenshot={available:false,reason:"No desktop connected."}; await render(); await click(toggle());
  await key(row("document"),"End"); expect(document.activeElement).toBe(row("screenshot")); expect(row("screenshot").getAttribute("aria-disabled")).toBe("true");
  expect(document.getElementById(row("screenshot").getAttribute("aria-describedby")!)!.textContent).toBe("No desktop connected.");
  await click(row("screenshot")); expect(calls).toEqual([]); expect(menu().getAttribute("aria-hidden")).toBe("false");
});
test("selection acknowledges once and returns focus to the origin",async()=>{
  await render(); await click(toggle()); await click(row("image")); expect(calls).toEqual(["image"]);
  expect(feedback).toEqual(["Adding image…","Image attached."]); expect(document.activeElement).toBe(toggle()); expect(menu().getAttribute("aria-hidden")).toBe("true");
});
test("cancelled picker has no attachment receipt",async()=>{
  binding.choose=async()=>"cancelled"; await render(); await click(toggle()); await click(row("document")); expect(feedback.at(-1)).toBe("");
});
test("pending entry is deduplicated and a failed request can be retried",async()=>{
  let reject!:(error:Error)=>void; binding.choose=()=>{calls.push("choose"); return new Promise((_,no)=>reject=no);};
  await render(); await click(toggle()); await click(row("document")); await click(toggle()); await click(row("image")); expect(calls).toEqual(["choose"]);
  await React.act(async()=>reject(Error("private backend details"))); expect(feedback.at(-1)).toBe("Could not add document. Try again.");
  binding={...binding,choose:async()=>"attached"}; await render(); await click(toggle()); await click(row("image")); expect(feedback.at(-1)).toBe("Image attached.");
});
test("late picker result cannot report into another conversation",async()=>{
  let resolve!:(value:"attached")=>void, signal!:AbortSignal;
  binding.choose=async(_,s)=>{signal=s;return new Promise(yes=>resolve=yes);};
  await render(); await click(toggle()); await click(row("document"));
  binding={...binding,conversationId:"b"}; await render(); expect(signal.aborted).toBe(true);
  expect(feedback).toEqual(["Adding document…", ""]); const count=feedback.length;
  await React.act(async()=>resolve("attached")); expect(feedback.length).toBe(count); expect(menu().getAttribute("aria-hidden")).toBe("true");
});
test("source mismatch, missing identity and offline states never dispatch",async()=>{
  await render("live"); await click(toggle()); expect(toggle().getAttribute("aria-expanded")).toBe("false");
  for(const patch of [{enabled:false},{scopeId:null},{conversationId:null}]) {const original=binding;binding={...binding,...patch};await render();await click(toggle());expect(toggle().getAttribute("aria-expanded")).toBe("false");binding=original;}
  expect(calls).toEqual([]);
});
test("theme changes preserve menu, selected focus and choice elements",async()=>{
  await render();await click(toggle());await key(row("document"),"ArrowUp");const same=row("image");await render("preview","dark");
  expect(row("image")).toBe(same);expect(document.activeElement).toBe(same);expect(menu().closest<HTMLElement>(".brief-root")!.dataset.briefTheme).toBe("dark");
});
test("outside focus closes the fan without stealing the new focus",async()=>{
  await render();await click(toggle());const field=host.querySelector("input")!;await React.act(async()=>field.focus());expect(menu().getAttribute("aria-hidden")).toBe("true");expect(document.activeElement).toBe(field);
});
test("unmount removes portal and cancels an outstanding selection",async()=>{
  let signal!:AbortSignal;binding.choose=async(_,s)=>{signal=s;return new Promise(()=>{});};await render();await click(toggle());await click(row("image"));await React.act(async()=>root.render(null));expect(signal.aborted).toBe(true);expect(document.querySelector('[role="menu"]')).toBeNull();
});
function adapter() {
  const state={workspaceId:"w",activeId:"a",order:["a","b"]};const status={mode:"scoped",connected:true,attachmentsEnabled:true,pending:0};const operations:unknown[]=[];
  const owner:AttachmentOwner={getSnapshot:()=>status,store:{getSnapshot:()=>state},attachments:{upload:async(...args)=>{operations.push(args);return {state:"ready",conversationId:args[0]};},capture:async(...args)=>{operations.push(args);return {state:"ready",conversationId:args[0]};}}};
  const file=new File(["notes"],"notes.txt",{type:"text/plain"});
  const pickers:AttachmentPickers={file:async()=>file,screenshot:async()=>({deviceId:"desktop-a",confirmed:true}),screenshotAvailability:{available:true}};
  return {state,status,operations,owner,pickers,file};
}
test("F-05 binding captures original chat through picker delay and delegates exact file",async()=>{
  const a=adapter();const bound=bindAttachmentFan(a.owner,a.pickers,"live");a.state.activeId="b";
  expect(await bound.choose("document",new AbortController().signal)).toBe("attached");expect(a.operations).toEqual([["a","document",a.file]]);
});
test("F-05 capture requires explicit device confirmation",async()=>{
  const a=adapter();await bindAttachmentFan(a.owner,a.pickers,"live").choose("screenshot",new AbortController().signal);expect(a.operations).toEqual([["a","desktop-a",true]]);
  a.pickers.screenshot=async()=>({deviceId:"desktop-a",confirmed:false as true});await expect(bindAttachmentFan(a.owner,a.pickers,"live").choose("screenshot",new AbortController().signal)).rejects.toThrow();expect(a.operations.length).toBe(1);
});
test("F-05 does not upload after scope change, tab closure, disconnect or abort during picker",async()=>{
  for(const change of ["workspace","closed","disconnected","abort"]){const a=adapter(),controller=new AbortController();a.pickers.file=async()=>{if(change==="workspace")a.state.workspaceId="other";if(change==="closed")a.state.order=["b"];if(change==="disconnected")a.status.connected=false;if(change==="abort")controller.abort();return a.file;};
    const result=bindAttachmentFan(a.owner,a.pickers,"live").choose("document",controller.signal);if(change==="abort")expect(await result).toBe("cancelled");else await expect(result).rejects.toThrow();expect(a.operations).toEqual([]);
  }
});
test("F-05 unsupported Screenshot and cancelled file picker have no external effect",async()=>{
  const a=adapter();a.pickers.screenshotAvailability.available=false;await expect(bindAttachmentFan(a.owner,a.pickers,"live").choose("screenshot",new AbortController().signal)).rejects.toThrow();
  a.pickers.file=async()=>null;expect(await bindAttachmentFan(a.owner,a.pickers,"live").choose("image",new AbortController().signal)).toBe("cancelled");expect(a.operations).toEqual([]);
});

test("F-05 superseded upload cannot report attached merely because its promise finished",async()=>{
  const a=adapter();a.owner.attachments.upload=async()=>undefined;
  await expect(bindAttachmentFan(a.owner,a.pickers,"live").choose("document",new AbortController().signal)).rejects.toThrow("not retained");
});

test("keyboard can enter a fan already opened with the pointer",async()=>{
 await render();await React.act(async()=>toggle().dispatchEvent(new MouseEvent("click",{bubbles:true,detail:1})));
 await key(toggle(),"ArrowUp");expect(document.activeElement).toBe(row("document"));
 await key(row("document"),"ArrowRight");expect(document.activeElement).toBe(row("image"));
});

test("closing Pebble during selection clears pending feedback without a success receipt",async()=>{
  let resolve!:(value:"attached")=>void, signal!:AbortSignal;
  binding.choose=async(_,s)=>{signal=s;return new Promise(yes=>resolve=yes);};
  await render();await click(toggle());await click(row("document"));
  expect(feedback.at(-1)).toBe("Adding document…");
  await React.act(async()=>{
    host.firstElementChild!.setAttribute("inert","");
    await new Promise(yes=>setTimeout(yes,0));
  });
  expect(signal.aborted).toBe(true);
  expect(feedback.at(-1)).toBe("");
  await React.act(async()=>resolve("attached"));
  expect(feedback.at(-1)).toBe("");
  expect(feedback).not.toContain("Document attached.");
});

test("A to B to A clears only the cancelled request and keeps completed feedback",async()=>{
  const status:Record<string,string>={b:"Existing B feedback"};
  const report=(id:string)=>(message:string)=>{status[id]=message;return 0;};
  let resolve!:(value:"attached")=>void;
  binding.choose=()=>new Promise(yes=>resolve=yes);
  await render("preview","light",report("a"));await click(toggle());await click(row("document"));
  expect(status.a).toBe("Adding document…");
  binding={...binding,conversationId:"b",choose:async()=>"attached"};
  await render("preview","light",report("b"));
  expect(status).toEqual({a:"",b:"Existing B feedback"});
  await click(toggle());await click(row("image"));
  binding={...binding,conversationId:"a"};await render("preview","light",report("a"));
  expect(status).toEqual({a:"",b:"Image attached."});
  await click(toggle());await click(row("screenshot"));
  await React.act(async()=>resolve("attached"));
  expect(status).toEqual({a:"Screenshot attached.",b:"Image attached."});
});
