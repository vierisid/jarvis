/** Actual F-06 transport/store with synthetic tools and streamed text. No live model/effects. */
import { strict as assert } from "node:assert";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { bindConversationMessages, threadItems } from "../../../../ui/src/brief/chat/message/model";
import { ConversationMessages } from "../../../../ui/src/brief/chat/message/ConversationMessages";
const other=process.env.F06_WORKTREE;
if(!other) throw Error("Set F06_WORKTREE to the reviewed F-06 checkout.");
const {initDatabase,getDb,closeDb}=await import(`${other}/src/vault/schema.ts`);
const {ToolRegistry}=await import(`${other}/src/actions/tools/registry.ts`);
const {BriefConversationProvider}=await import(`${other}/src/brief/conversations.ts`);
const {BriefChatTransport}=await import(`${other}/src/brief/chat-transport.ts`);
const {BriefCapabilities}=await import(`${other}/src/brief/capabilities.ts`);
const {registerConversations}=await import(`${other}/src/brief/registrations/conversations.ts`);
const {registerChatTransport}=await import(`${other}/src/brief/registrations/chat-transport.ts`);
const {registerChatProgress}=await import(`${other}/src/brief/registrations/chat-progress.ts`);
const {ConversationStore}=await import(`${other}/ui/src/brief/chat/store.ts`);
initDatabase(":memory:",{quiet:true});
const conversations=new BriefConversationProvider(),store=new ConversationStore(),registry=new ToolRegistry();
const releases=new Map<string,()=>void>();
registry.register({name:"read_file",description:"Fixture only",category:"files",parameters:{},execute:(args:any)=>new Promise((resolve,reject)=>{
 releases.set(args.name,()=>args.name==="B"?reject(Error("PRIVATE error")):resolve("PRIVATE result"));
})});
const frames:any[]=[];
const transport=new BriefChatTransport({db:getDb(),concurrency:2,send:(_socket:any,frame:any)=>{frames.push(frame);if(frame.type==="brief_chat_event")store.applyEvent(frame.payload,frame.timestamp);},runner:{ready:()=>true,stream:(input:any)=>({stream:(async function*(){
 try{await registry.execute("read_file",{name:input.text,secret:"PRIVATE tool arguments"});}catch{}
 yield {type:"text",text:`## ${input.text} response\n\nUseful partial answer.`};
 for(let i=0;i<510;i++)yield {type:"text",text:" More."};
 yield {type:"done",response:{content:"Answer",tool_calls:[],usage:{input_tokens:0,output_tokens:0},model:"fixture",finish_reason:"stop"}};
})(),onComplete:async()=>{}})}});
const caps=new BriefCapabilities([...registerConversations(conversations),...registerChatTransport(transport),...registerChatProgress(transport)],["conversations","chatTransport","chatProgress"]);
const input=(name:string)=>({conversationId:conversations.repository.create({title:name}).conversationId,turnId:`turn-${name}`,requestId:`request-${name}`,text:name});
const a=input("A"),b=input("B");store.restoreTabs(conversations.repository.tabs());
const binding=(selected:string,s=store)=>{s.select(selected);return bindConversationMessages({status:{mode:"scoped",connected:true,progressEnabled:true},state:s.getSnapshot(),client:{store:s}},"live");};
const html=(selected:string,s=store)=>renderToStaticMarkup(React.createElement(ConversationMessages,{mode:"live",binding:binding(selected,s),panelId:"thread"}));
try{
 await transport.handle({type:"brief_chat_send",payload:a,timestamp:0},{},caps);
 await transport.handle({type:"brief_chat_send",payload:b,timestamp:0},{},caps);
 const end=Date.now()+3000;while(releases.size<2){if(Date.now()>end)throw Error("Fixture timeout");await Bun.sleep(1);}
 assert.match(html(a.conversationId),/data-current="true"/);assert.match(html(b.conversationId),/data-current="true"/);
 await transport.handle({type:"brief_chat_cancel",payload:{conversationId:a.conversationId,turnId:a.turnId,requestId:a.requestId},timestamp:0},{},caps);
 releases.get("A")!();releases.get("B")!();await transport.idle();
 const aHtml=html(a.conversationId),bHtml=html(b.conversationId);
 assert.match(aHtml,/Response stopped/);assert.doesNotMatch(aHtml,/B response|data-current="true"/);
 assert.match(bHtml,/B response/);assert.match(bHtml,/1 failed/);assert.doesNotMatch(bHtml,/A response|PRIVATE|data-current="true"/);
 assert.doesNotMatch(JSON.stringify(frames),/PRIVATE/);
 const replay=new ConversationStore();replay.restoreTabs(conversations.repository.tabs());let pages=0;
 for(const id of [a.conversationId,b.conversationId]){let after=0;while(true){const snapshot=transport.repository.snapshot(id,after);replay.applySnapshot({...snapshot,subscribed:true});pages++;if(!snapshot.hasMore)break;after=snapshot.nextSequence;}}
 assert.ok(pages>=3);assert.equal(html(a.conversationId,replay),aHtml);assert.equal(html(b.conversationId,replay),bHtml);
 const identity=(s:any)=>threadItems(binding(b.conversationId,s)).map(item=>({key:item.key,time:item.time,content:item.message?.content,activities:item.kind==="reply"?item.activities.map(a=>[a.activityId,a.firstSequence,a.phase,a.summary]):[]}));
 assert.deepEqual(identity(replay),identity(store));
 const retained=binding(a.conversationId);store.select(b.conversationId);retained.saveScroll({top:230,atBottom:false});assert.equal(store.getSnapshot().conversations[a.conversationId].scroll.top,230);assert.equal(store.getSnapshot().conversations[b.conversationId].scroll.top,0);
 console.log(`PASS actual F-06 transport/projector/store: interleaved A/B tools, cancel A, fail B tool with usable answer, secret canaries excluded, ${pages} snapshot pages restore identical still markup, exact original-chat scroll binding. No real model, file read or external effect.`);
}finally{for(const release of releases.values())release();transport.stop();await transport.idle();closeDb();}
