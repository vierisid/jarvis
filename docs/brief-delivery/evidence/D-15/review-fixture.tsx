/** Explicit review fixture. No provider, socket, request or account mutation. */
import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "../../../../ui/src/styles/globals.css";
import "../../../../ui/src/brief/styles/index.css";
import { ConversationMessages } from "../../../../ui/src/brief/chat/message/ConversationMessages";
import type { MessageBinding, ReadingPosition } from "../../../../ui/src/brief/chat/message/model";

const params = new URLSearchParams(location.search);
const lists = "## A clear sequence\n\n3. Confirm scope.\n4. Agree a date.\n   - Calendar checked\n     - Timezone confirmed\n   - Owner confirmed\n5. Send the follow-up.\n\n- A regular bullet\n- [x] Scope agreed\n- [ ] Date pending\n- Another regular bullet\n\n**Illustrative reply.**";
const long = Array.from({length:30}, (_,i) => `## Step ${i+1}\n\nKeep the saved reading position while history arrives. This is an illustrative response, not a live conversation.`).join("\n\n");
function Fixture() {
  const [phase, setPhase] = useState<"idle"|"loading"|"error"|"ready">(params.get("case")==="lists"?"ready":"idle");
  const [other, setOther] = useState(false);
  const writes = useRef<ReadingPosition[]>([]);
  const id = other ? "other" : "restored";
  const binding: MessageBinding = {source:"fixture",scopeId:"review",conversationId:id,mode:"scoped",connected:true,progressEnabled:true,
    chat:{messages:phase==="ready"&&!other&&params.get("case")!=="empty"?[{id:"answer",conversation_id:id,role:"assistant",created_at:1,content:params.get("case")==="lists"?lists:long}]:[],
      turns:{},activity:{},history:{state:other?"ready":phase,cursor:null},scroll:{top:other?0:480,atBottom:other||params.get("case")==="bottom"}},
    saveScroll:p=>{writes.current.push({...p});document.getElementById("writes")!.textContent=JSON.stringify(writes.current);}};
  return <main className="brief-root" data-brief-theme={params.get("theme")||"light"} style={{padding:24,background:"var(--brief-canvas)",color:"var(--brief-ink)",minHeight:"100vh"}}>
    <nav style={{display:"flex",gap:12,marginBottom:16}}>
      <button onClick={()=>setPhase("loading")}>Loading</button><button onClick={()=>setPhase("error")}>Fail history</button>
      <button onClick={()=>setPhase("ready")}>Load history</button><button onClick={()=>setOther(!other)}>Switch chat</button>
    </nav>
    <div style={{display:"flex",flexDirection:"column",width:Number(params.get("width")||448),maxWidth:"100%",height:650,background:"var(--brief-card)",padding:16,border:"1px solid var(--brief-card-edge)"}}>
      <ConversationMessages mode="preview" binding={binding} panelId="review-thread" reducedMotion/>
      <div style={{height:56,flexShrink:0}}>Illustrative composer stays here.</div>
    </div>
    <output id="writes" style={{display:"block",marginTop:16}}>[]</output>
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture/>);
