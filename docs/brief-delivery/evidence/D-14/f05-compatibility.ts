/** Optional actual F-05 owner check. In-memory DB, synthetic files and fake capture API only. */
import { strict as assert } from "node:assert";
import { bindAttachmentFan, type AttachmentPickers } from "../../../../ui/src/brief/chat/attachment-fan/model";
const other = process.env.F05_WORKTREE;
if (!other) throw Error("Set F05_WORKTREE to the reviewed F-05 checkout.");
const { initDatabase, getDb, closeDb } = await import(`${other}/src/vault/schema.ts`);
const { ConversationRepository } = await import(`${other}/src/vault/conversation-lifecycle.ts`);
const { BriefConversationClient } = await import(`${other}/ui/src/brief/chat/client.ts`);
const { BriefCapabilities } = await import(`${other}/src/brief/capabilities.ts`);
initDatabase(":memory:", { quiet: true });
const repository = new ConversationRepository(getDb());
const enabled = ["conversations", "chatTransport", "chatState", "chatAttachments"];
const capabilities = new BriefCapabilities(enabled.map(id=>({id,provider:{readiness:()=>"ready"}})),enabled).snapshot();
const uploads:unknown[] = [], captures:unknown[] = [];
const ref=(c:string,id:string,kind:string,name:string,mediaType:string,size:number)=>({conversationId:c,attachmentId:id,kind,name,mediaType,size,sha256:"fixture",expiresAt:Date.now()+60_000,state:"ready",turnId:null});
const client=new BriefConversationClient({
 capabilities:async()=>capabilities,tabs:async()=>repository.tabs(),create:async()=>repository.create(),select:async(id:string|null)=>repository.activate(id),
 tab:async(id:string,open:boolean)=>repository.setOpen(id,open),history:async(id:string,cursor?:string)=>repository.messages(id,{cursor,limit:50}),
},undefined,{
 get:async()=>{throw Error("No restored fixture");},remove:async(c:string,id:string)=>({...ref(c,id,"document","note.txt","text/plain",4),state:"removed"}),
 upload:async(c:string,id:string,kind:string,file:File)=>{uploads.push({c,id,kind,name:file.name});return ref(c,id,kind,file.name,file.type,file.size);},
 capture:async(c:string,id:string,deviceId:string)=>{captures.push({c,id,deviceId});return ref(c,id,"screenshot","Screenshot.png","image/png",4);},
});
const file=new File(["synthetic notes"],"note.txt",{type:"text/plain"});
const pickers:AttachmentPickers={file:async()=>file,screenshot:async()=>({deviceId:"fixture-desktop",confirmed:true}),screenshotAvailability:{available:true}};
const signal=()=>new AbortController().signal;
try {
 await client.start();const a=await client.add(),b=await client.add();await client.select(a);
 client.adapter.onOpen({readyState:1,send:()=>{}});for(let i=0;!client.getSnapshot().connected&&i<1000;i++)await Bun.sleep(1);assert.equal(client.getSnapshot().connected,true);
 client.store.setDraft(a,"Keep A");client.store.setDraft(b,"Keep B");
 let release!:(file:File|null)=>void;pickers.file=()=>new Promise(resolve=>release=resolve);
 const bound=bindAttachmentFan(client,pickers,"live"),selection=bound.choose("document",signal());await client.select(b);release(file);assert.equal(await selection,"attached");
 assert.equal(client.store.getSnapshot().conversations[a].attachments[0].name,"note.txt");assert.equal(client.store.getSnapshot().conversations[b].attachments.length,0);
 assert.equal((uploads[0] as {c:string}).c,a);assert.equal(client.store.getSnapshot().conversations[a].draft,"Keep A");assert.equal(client.store.getSnapshot().conversations[b].draft,"Keep B");
 pickers.file=async()=>new File(["fixture pixels"],"image.png",{type:"image/png"});await bindAttachmentFan(client,pickers,"live").choose("image",signal());assert.equal(client.store.getSnapshot().conversations[b].attachments[0].kind,"image");
 pickers.screenshotAvailability.available=false;await assert.rejects(()=>bindAttachmentFan(client,pickers,"live").choose("screenshot",signal()));assert.equal(captures.length,0);
 pickers.screenshotAvailability.available=true;pickers.screenshot=async()=>null;assert.equal(await bindAttachmentFan(client,pickers,"live").choose("screenshot",signal()),"cancelled");assert.equal(captures.length,0);
 pickers.screenshot=async()=>({deviceId:"fixture-desktop",confirmed:true});await bindAttachmentFan(client,pickers,"live").choose("screenshot",signal());assert.equal(captures.length,1);assert.equal((captures[0] as {c:string}).c,b);
 assert.equal(client.store.getSnapshot().conversations[b].attachments[1].kind,"screenshot");
 // A selected file must not be admitted after its chat closes during the picker.
 await client.select(a);pickers.file=()=>new Promise(resolve=>release=resolve);const closed=bindAttachmentFan(client,pickers,"live").choose("document",signal());await client.close(a);release(file);await assert.rejects(()=>closed);assert.equal(uploads.length,2);
 console.log("PASS actual F-05 client/store/DraftAttachments: captured conversation survives picker delay and selection change; exact Document/Image delegation; unavailable and cancelled Screenshot dispatch nothing; confirmed device delegated once; closed chat refuses delayed file; both drafts retained. In-memory repositories and synthetic attachment API, no real upload/capture/model.");
} finally {client.stop();closeDb();}
