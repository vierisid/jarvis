import {expect,test} from "bun:test";
import {runManagedIntercomAction} from "./managed-intercom";
import {executeAuthorizedPiece} from "./piece-effect-guard";
import {resolveGovernedPieceAction,tracksPieceCompletion} from "./piece-effects";
const auth={jarvis_managed:"intercom",access_token:"PRIVATE",api_host:"api.eu.intercom.io",admin_id:"admin1"};
const mock=(body:unknown,status=200)=>{const calls:any[]=[];return {calls,request:(async(url:string,init:RequestInit)=>{calls.push({url,...init});return Response.json(body,{status});}) as typeof fetch};};
test("lookup ambiguity is refused, region is fixed, conversation outputs match published flattened parts",async()=>{
 const m=mock({data:[{id:"c1"}],total_count:1});expect(await runManagedIntercomAction("get_contact",{auth,lookupBy:"email",value:"test@example.test"},m.request)).toEqual({id:"c1"});
 expect(m.calls[0].url).toBe("https://api.eu.intercom.io/contacts/search");expect(m.calls[0].redirect).toBe("error");expect(JSON.parse(m.calls[0].body)).toEqual({query:{field:"email",operator:"=",value:"test@example.test"},pagination:{per_page:2}});
 await expect(runManagedIntercomAction("get_contact",{auth,lookupBy:"email",value:"test@example.test"},mock({data:[{id:"a"},{id:"b"}]}).request)).rejects.toThrow("exactly one");
 const c=mock({id:"v1",conversation_parts:{conversation_parts:[{id:"p1",part_type:"note",body:"Hi",author:{id:12,type:"admin",name:"Owner"},created_at:1}]}});
 expect(await runManagedIntercomAction("get_conversation_by_id",{auth,conversationId:"v1"},c.request)).toEqual({id:"v1",parts:[{id:"p1",part_type:"note",body:"Hi",author_id:"12",author_type:"admin",author_name:"Owner",created_at:1}]});
});
test("writes send notes only, contact tags use explicit IDs and do not retry",async()=>{
 for(const action of ["add_note_to_contact","add_note_to_conversation_by_id"]){const m=mock({id:"n1"});await runManagedIntercomAction(action,{auth,contactId:"c1",conversationId:"v1",body:"Internal only"},m.request);const body=JSON.parse(m.calls[0].body);expect(body.admin_id).toBe("admin1");expect(body.body).toBe("Internal only");if(action.includes("conversation"))expect(body).toMatchObject({message_type:"note",type:"admin"});expect(m.calls.length).toBe(1);}
 for(const untag of [false,true]){const m=mock({id:"t1"});await runManagedIntercomAction("add-or-remove-tag-on-contact",{auth,contactId:"c1",tagId:"t1",untag},m.request);expect(m.calls[0].method).toBe(untag?"DELETE":"POST");expect(m.calls[0].url).toBe("https://api.eu.intercom.io/contacts/c1/tags"+(untag?"/t1":""));}
});
test("bad IDs, unqualified actions and arbitrary hosts make no requests",async()=>{
 const m=mock({id:"x"});for(const [action,input] of [["get_contact",{value:"../me"}],["get_contact",{value:"https://evil.test"}],["send_message",{}],["get_contact",{value:"c1",auth:{...auth,api_host:"evil.test"}}],["add-or-remove-tag-on-contact",{contactId:"c1",tagId:"t1",untag:"false"}] ] as const){await expect(runManagedIntercomAction(action,{auth,...input},m.request)).rejects.toThrow();}expect(m.calls).toEqual([]);
});
test("provider errors are sanitized, bodies bounded, no retry after uncertain writes",async()=>{
 for(const status of [401,403,429,500]){const m=mock({error:"PRIVATE"},status);const error=await runManagedIntercomAction("add_note_to_contact",{auth,contactId:"c1",body:"Note"},m.request).catch(e=>e);expect(String(error)).not.toContain("PRIVATE");expect(m.calls.length).toBe(1);}
 await expect(runManagedIntercomAction("get_contact",{auth,value:"c1"},mock({id:"c1",huge:"x".repeat(1048576)}).request)).rejects.toThrow("invalid response");
});
test("notes require send authority; tags require write authority; completed/held receipts never dispatch",async()=>{
 const piece="@activepieces/piece-intercom";
 expect(resolveGovernedPieceAction(piece,"add_note_to_contact")?.category).toBe("send_message");expect(resolveGovernedPieceAction(piece,"add-or-remove-tag-on-contact")?.category).toBe("write_data");expect(resolveGovernedPieceAction(piece,"get_contact")?.category).toBe("read_data");expect(tracksPieceCompletion(piece,"add_note_to_contact")).toBe(true);
 let dispatched=0;const params={piece,action:"add_note_to_contact",input:{auth,contactId:"c1",body:"Note"}} as any;
 expect(await executeAuthorizedPiece(params,{dispatch:"completed",result:{id:"saved"}} as any,async()=>{dispatched++;})).toEqual({id:"saved"});
 await expect(executeAuthorizedPiece(params,{dispatch:"held"} as any,async()=>{dispatched++;})).rejects.toThrow("authorization");expect(dispatched).toBe(0);
});
