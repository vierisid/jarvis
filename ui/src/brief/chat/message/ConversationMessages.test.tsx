import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Root } from "react-dom/client";
import { bindConversationMessages, threadItems, type Activity, type MessageBinding, type MessageChat, type ReplyTurn } from "./model";
import { captureReading, restoreReading } from "./reading";
import { safeReplyUrl } from "./ReplyMarkdown";
let React: typeof import("react"), createRoot: typeof import("react-dom/client").createRoot;
let ConversationMessages: typeof import("./ConversationMessages").ConversationMessages;
let root: Root, host: HTMLDivElement, binding: MessageBinding;
const activity = (id: string, phase: Activity["phase"] = "completed", patch: Partial<Activity> = {}): Activity => ({ activityId:id, conversationId:"a", turnId:"t", requestId:"r", firstSequence:1, sequence:2, live:false, kind:"tool", phase, summary:phase === "completed" ? "Context lookup finished." : "Looking up saved context.", refs:[{kind:"fact",id:"pilot"}], ...patch });
const chat = (): MessageChat => ({ messages:[{id:"user",conversation_id:"a",role:"user",content:"Prepare my call",created_at:1},{id:"answer",conversation_id:"a",role:"assistant",content:"## A clear next step\n\nAgree the scope.",created_at:2}], turns:{t:{conversationId:"a",turnId:"t",requestId:"r",state:"completed",createdAt:1,assistantMessageId:"answer"}}, activity:{one:activity("one")}, scroll:{top:0,atBottom:true}, history:{state:"ready",cursor:null} });
beforeAll(async()=>{ GlobalRegistrator.register(); (globalThis as {IS_REACT_ACT_ENVIRONMENT?:boolean}).IS_REACT_ACT_ENVIRONMENT=true; React=await import("react"); ({createRoot}=await import("react-dom/client")); ({ConversationMessages}=await import("./ConversationMessages")); });
beforeEach(()=>{ host=document.createElement("div"); document.body.append(host); root=createRoot(host); binding={source:"fixture",scopeId:"w",conversationId:"a",mode:"scoped",connected:true,progressEnabled:true,chat:chat(),saveScroll:()=>{}}; });
afterEach(async()=>{await React.act(async()=>root.unmount());host.remove();});
afterAll(()=>GlobalRegistrator.unregister());
async function render(mode:"preview"|"live"="preview") { await React.act(async()=>root.render(<div className="brief-root"><ConversationMessages mode={mode} binding={binding} panelId="thread" reducedMotion/></div>)); }
const toggle=()=>host.querySelector<HTMLButtonElement>(".brief-activity-toggle")!;
function setTurn(patch: Partial<ReplyTurn> & { error?: { message: string } }) { binding.chat!.turns = { ...binding.chat!.turns, t: { ...binding.chat!.turns.t!, ...patch } }; }
async function click(node:HTMLElement){await React.act(async()=>node.click());}

test("quiet user and unboxed answer share one scoped thread; activity starts collapsed",async()=>{
 await render();expect(host.querySelector(".brief-user-message")?.textContent).toBe("Prepare my call");expect(host.querySelector(".brief-reply-prose h2")?.textContent).toBe("A clear next step");expect(toggle().getAttribute("aria-expanded")).toBe("false");expect(host.querySelectorAll(".brief-assistant-reply").length).toBe(1);
});
test("twenty open/close cycles retain the same reply and local preference across tabs",async()=>{
 await render();const answer=host.querySelector(".brief-reply-prose");
 for(let i=0;i<20;i++){await click(toggle());expect(toggle().getAttribute("aria-expanded")).toBe("true");await click(toggle());expect(toggle().getAttribute("aria-expanded")).toBe("false");expect(host.querySelector(".brief-reply-prose")).toBe(answer);}
 await click(toggle());const a=binding;binding={...binding,conversationId:"b",chat:{...chat(),messages:[],turns:{},activity:{}}};await render();expect(host.textContent).not.toContain("Prepare my call");binding=a;await render();expect(toggle().getAttribute("aria-expanded")).toBe("true");
});
test("workspace change drops view preferences even if chat IDs are reused",async()=>{
 await render();await click(toggle());binding={...binding,scopeId:"other"};await render();expect(toggle().getAttribute("aria-expanded")).toBe("false");
});
test("only current live activity moves; completed and replayed activities never move",async()=>{
 setTurn({state:"running"});binding.chat!.activity={one:activity("one"),two:activity("two","started",{live:true,firstSequence:2}),three:activity("three","started",{live:true,firstSequence:3})};await render();
 expect(host.querySelectorAll('[data-current="true"]').length).toBe(1);expect(host.querySelector('[data-activity-id="three"] [data-current="true"]')).not.toBeNull();
 binding.chat!.activity=Object.fromEntries(Object.entries(binding.chat!.activity!).map(([id,a])=>[id,{...a,live:false}]));await render();expect(host.querySelectorAll('[data-current="true"]').length).toBe(0);
});
test("disconnect stops the current marker without losing partial content",async()=>{
 setTurn({state:"running"});binding.chat!.activity={one:activity("one","started",{live:true})};await render();binding={...binding,connected:false};await render();expect(host.querySelector('[data-current="true"]')).toBeNull();expect(host.textContent).toContain("Paused");expect(host.textContent).toContain("Agree the scope.");
});
test("terminal failure keeps the partial answer and does not expose the raw error",async()=>{
 setTurn({state:"failed",error:{message:"PRIVATE_KEY"}});
 await render();expect(host.textContent).toContain("partial answer is kept above");expect(host.textContent).toContain("Agree the scope.");expect(host.textContent).not.toContain("PRIVATE_KEY");
});
test("cancellation is not completion; unfinished activity does not claim success",async()=>{
 setTurn({state:"cancelled"});binding.chat!.activity={one:activity("one","started")};await render();expect(host.textContent).toContain("Response stopped.");expect(toggle().textContent).toContain("recorded");await click(toggle());expect(host.textContent).toContain("Unfinished");
});
test("completion shows output immediately and condenses untouched working details",async()=>{
 setTurn({state:"running"});await render();expect(toggle().getAttribute("aria-expanded")).toBe("true");setTurn({state:"completed"});await render();expect(toggle().getAttribute("aria-expanded")).toBe("false");expect(host.querySelector(".brief-reply-prose h2")).not.toBeNull();
});
test("missing progress produces a generic working state, not invented activity",async()=>{
 setTurn({state:"running"});binding.chat!.activity={};await render();expect(host.querySelector(".brief-activity-toggle")).toBeNull();expect(host.textContent).toContain("Preparing your response");
});
test("foreign conversations, requests, raw tool/system messages and unsafe labels stay out",async()=>{
 binding.chat!.messages=[...binding.chat!.messages,{id:"foreign",role:"assistant",conversation_id:"b",content:"FOREIGN",created_at:3},{id:"tool",role:"tool",conversation_id:"a",content:"SECRET_TOOL",created_at:4},{id:"system",role:"system",conversation_id:"a",content:"HIDDEN_REASONING",created_at:5}];
 binding.chat!.activity={one:activity("one","completed",{summary:"RAW_ARGS"}),foreign:activity("foreign","completed",{conversationId:"b",summary:"FOREIGN"}),wrong:activity("wrong","completed",{requestId:"different"})};
 await render();await click(toggle());for(const secret of ["FOREIGN","SECRET_TOOL","HIDDEN_REASONING","RAW_ARGS"])expect(host.textContent).not.toContain(secret);expect(host.querySelectorAll(".brief-activity-list li").length).toBe(1);expect(host.textContent).toContain("Activity finished.");
});
test("markdown supports tables/code and safe links without HTML or remote image effects",async()=>{
 binding.chat!.messages=[{id:"m",conversation_id:"a",role:"assistant",created_at:1,content:'<script>bad()</script>\n\n[unsafe](javascript:alert%281%29) [safe](https://example.com)\n\n![pixel](https://example.com/track.png)\n\n```js\nconst x = 1;\n```\n\n| Name | Value |\n| --- | --- |\n| Pilot | 6 |'}];binding.chat!.turns={};binding.chat!.activity={};await render();expect(host.querySelector("script,img,iframe")).toBeNull();expect(host.querySelectorAll("a").length).toBe(1);expect(host.querySelector("a")?.rel).toBe("noopener noreferrer");expect(host.querySelector("pre")?.tabIndex).toBe(0);expect(host.querySelector("table")).not.toBeNull();
});
test("URLs reject executable, relative, credentials and malformed destinations",()=>{
 for(const url of ["javascript:alert(1)","data:text/html,test","/admin", "//example.com", "https://user:secret@example.com"] )expect(safeReplyUrl(url)).toBe("");expect(safeReplyUrl("https://example.com")).toBe("https://example.com/");
});
test("gates never substitute fixture history in live mode",async()=>{await render("live");expect(host.textContent).not.toContain("Prepare my call");binding={...binding,source:"live",mode:"unavailable"};await render("live");expect(host.querySelector(".brief-messages")).toBeNull();});
test("owner binding captures the exact conversation for scroll and history",()=>{
 const calls:string[]=[];const owner={status:{mode:"scoped" as const,connected:true,progressEnabled:true},state:{workspaceId:"w",activeId:"a",order:["a","b"],conversations:{a:chat(),b:chat()}},client:{store:{setScroll:(id:string)=>{calls.push(id);}},loadOlder:async(id:string)=>{calls.push(id);}}};
 const port=bindConversationMessages(owner,"live");owner.state.activeId="b";port.saveScroll({top:40,atBottom:false});void port.loadOlder!();expect(calls).toEqual(["a","a"]);owner.state.order=[];expect(bindConversationMessages(owner,"live").conversationId).toBeNull();
});
test("stable activity order and turn identity survive interleaved response arrival",()=>{
 binding.chat!.activity={two:activity("two","completed",{firstSequence:4}),one:activity("one","failed",{firstSequence:2})};const items=threadItems(binding);const reply=items[1]!;expect(reply.kind).toBe("reply");if(reply.kind==="reply")expect(reply.activities.map(a=>a.activityId)).toEqual(["one","two"]);expect(reply.key).toBe("turn:t");
});
test("history retry uses one existing owner without hiding retained messages",async()=>{
 let calls=0;binding.chat!.history={state:"error",cursor:"older"};binding.loadOlder=async()=>{calls++;throw Error("PRIVATE");};await render();await click(host.querySelector(".brief-history-button")!);expect(calls).toBe(1);expect(host.textContent).toContain("Earlier messages could not be loaded");expect(host.textContent).not.toContain("PRIVATE");expect(host.textContent).toContain("Agree the scope.");
});
test("semantic scroll anchor survives growth above it and only bottom readers follow",()=>{
 const el=document.createElement("div");el.innerHTML='<article data-thread-item="turn:t"><div class="brief-reply-prose"><p>First</p><p>Second</p></div></article>';
 Object.defineProperties(el,{clientHeight:{value:200},scrollHeight:{value:1000,configurable:true}});el.scrollTop=300;
 el.getBoundingClientRect=()=>({top:100} as DOMRect);const ps=el.querySelectorAll("p");let shift=0;
 ps[0]!.getBoundingClientRect=()=>({top:-200+shift,bottom:0+shift} as DOMRect);ps[1]!.getBoundingClientRect=()=>({top:120+shift,bottom:320+shift} as DOMRect);
 const saved=captureReading(el);expect(saved.anchor).toBe("turn:t/block:1");expect(saved.atBottom).toBe(false);shift=160;restoreReading(el,saved);expect(el.scrollTop).toBe(460);
 restoreReading(el,{top:300,atBottom:true});expect(el.scrollTop).toBe(800);
});
test("a condensed activity falls back to its own summary rather than another response",()=>{
 const el=document.createElement("div");el.innerHTML='<article data-thread-item="turn:t"><button data-reading-anchor="activity-toggle">Finished</button></article>';
 Object.defineProperties(el,{clientHeight:{value:200},scrollHeight:{value:1000}});el.scrollTop=300;
 el.getBoundingClientRect=()=>({top:100} as DOMRect);el.querySelector("button")!.getBoundingClientRect=()=>({top:80,bottom:116} as DOMRect);
 restoreReading(el,{top:300,atBottom:false,anchor:"turn:t/activity:one",offset:10});expect(el.scrollTop).toBe(270);
});

test("delayed initial history preserves the saved reading position through empty loading and error states",async()=>{
 const calls:{top:number;atBottom:boolean}[]=[];
 const height=Object.getOwnPropertyDescriptor(HTMLElement.prototype,"clientHeight");
 const scrollHeight=Object.getOwnPropertyDescriptor(HTMLElement.prototype,"scrollHeight");
 Object.defineProperty(HTMLElement.prototype,"clientHeight",{configurable:true,get(){return this.classList.contains("brief-message-scroll")?300:0;}});
 Object.defineProperty(HTMLElement.prototype,"scrollHeight",{configurable:true,get(){return this.querySelector(".brief-reply-prose")?2000:100;}});
 try {
  binding.chat={...chat(),messages:[],turns:{},activity:{},history:{state:"idle",cursor:null},scroll:{top:480,atBottom:false}};
  binding.saveScroll=position=>calls.push({...position});
  await render();
  const viewport=host.querySelector<HTMLElement>(".brief-message-scroll")!;
  for(const state of ["loading","error","loading"] as const){
   binding.chat.history={state,cursor:null};await render();
   await React.act(async()=>viewport.dispatchEvent(new Event("scroll")));
  }
  expect(calls).toEqual([]);
  binding.chat={...chat(),scroll:{top:480,atBottom:false}};await render();
  expect(viewport.scrollTop).toBe(480);
  expect(host.querySelector(".brief-reply-latest")).not.toBeNull();
  const a=binding;binding={...a,conversationId:"b",chat:{...chat(),messages:[],turns:{},activity:{},scroll:{top:0,atBottom:true}}};await render();binding=a;await render();
  expect(host.querySelector<HTMLElement>(".brief-message-scroll")!.scrollTop).toBe(480);
 } finally {
  if(height)Object.defineProperty(HTMLElement.prototype,"clientHeight",height);else delete (HTMLElement.prototype as any).clientHeight;
  if(scrollHeight)Object.defineProperty(HTMLElement.prototype,"scrollHeight",scrollHeight);else delete (HTMLElement.prototype as any).scrollHeight;
 }
});
