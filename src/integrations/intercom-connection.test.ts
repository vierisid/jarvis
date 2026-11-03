import {afterEach,beforeEach,expect,test} from "bun:test";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID} from "node:crypto";
import {readIntercomConnection,intercomStatus} from "./intercom-connection";
import {JarvisIntercomConnectionSource} from "../workflows/credentials/intercom-source";
import {managedConnectionMisuse} from "../workflows/credentials/adapter";
import {MANAGED_PIECE_ADAPTERS,resolveGovernedPieceAction,tracksPieceCompletion} from "../workflows/runtime/piece-effects";
import {MANAGED_INTERCOM_ACTIONS} from "../workflows/runtime/managed-intercom";
let dir:string,config:any;
const doc=()=>({version:1,provider:"intercom",status:"connected",generation:randomUUID(),access_token:"PRIVATE_INTERCOM",
 account:{id:"workspace:admin",label:"owner@example.test"},workspaces:[{id:"workspace",name:"Sandbox"}],connected_at:new Date().toISOString(),settings:{region:"eu",api_host:"api.eu.intercom.io",admin_id:"admin"}});
const write=(v:unknown)=>writeFileSync(join(dir,"connections/intercom.json"),JSON.stringify(v));
beforeEach(()=>{dir=mkdtempSync(join(tmpdir(),"intercom-unit-"));mkdirSync(join(dir,"connections"));config={daemon:{data_dir:dir},usejarvis_integrations:{page_url:"https://app.usejarvis.dev/account"}};});
afterEach(()=>rmSync(dir,{recursive:true,force:true}));
test("status is secret-free; only qualified actions and auth position can use the grant",async()=>{
 write(doc());const source=new JarvisIntercomConnectionSource(config);
 expect(intercomStatus(config)).toMatchObject({connected:true,connect_url:"https://app.usejarvis.dev/account?integration=intercom"});
 expect(JSON.stringify(intercomStatus(config))).not.toContain("PRIVATE_INTERCOM");
 expect((await source.resolve("jarvis:intercom"))?.value).toMatchObject({access_token:"PRIVATE_INTERCOM",props:{region:"eu.intercom"},api_host:"api.eu.intercom.io"});
 for(const actionName of ["custom_api_call","send_message","new_conversation","reply_to_conversation_by_id"])
  expect(managedConnectionMisuse(source,source.pieceNames[0]!,"settings.input.auth",{actionName})).not.toBeNull();
 expect(managedConnectionMisuse(source,source.pieceNames[0]!,"settings.input.auth",{actionName:"get_contact"})).toBeNull();
 expect(managedConnectionMisuse(source,source.pieceNames[0]!,"settings.input.auth",{actionName:"get_contact",triggerName:"new_conversation"})).not.toBeNull();
 expect(managedConnectionMisuse(source,"@activepieces/piece-http","settings.input.auth",{actionName:"get_contact"})).not.toBeNull();
 expect(managedConnectionMisuse(source,source.pieceNames[0]!,"settings.input.body",{actionName:"get_contact"})).not.toBeNull();
});
test("identity binds workspace, admin, region and generation; disconnect invalidates without restart",async()=>{
 const c=doc();write(c);const source=new JarvisIntercomConnectionSource(config),identity=source.identity("jarvis:intercom");expect(identity).toBeTruthy();
 for(const next of [{...c,generation:randomUUID()},{...c,access_token:"NEW"},{...c,settings:{...c.settings,region:"us",api_host:"api.intercom.io"}},{...c,account:{...c.account,id:"other:admin"},workspaces:[{id:"other",name:"Other"}]}]){write(next);expect(source.identity("jarvis:intercom")).not.toBe(identity);}
 write({...c,status:"disconnected"});expect(source.identity("jarvis:intercom")).toBeNull();expect(await source.resolve("jarvis:intercom")).toBeNull();
});
test("invalid, oversized and mismatched region documents fail closed",()=>{
 const c=doc();for(const bad of [{...c,settings:null},{...c,settings:{...c.settings,region:"toString"}},{...c,settings:{...c.settings,api_host:"evil.test"}},{...c,account:{...c.account,id:"other"}},{...c,refresh_token:"unsupported"},{...c,expires_at:"later"},{...c,workspaces:[]},{...c,provider:"other"},{...c,access_token:"bad\nheader"}]){write(bad);expect(readIntercomConnection(dir)).toBeNull();}
 writeFileSync(join(dir,"connections/intercom.json"),"x".repeat(65537));expect(readIntercomConnection(dir)).toBeNull();
 for(const url of ["http://app.usejarvis.dev/account","https://user:pass@app.usejarvis.dev/account","invalid"]){config.usejarvis_integrations.page_url=url;expect(intercomStatus(config).connect_url).toBeNull();}
});

const INTERCOM = "@activepieces/piece-intercom";
/** Every action of the pinned @activepieces/piece-intercom 0.9.2 bundle, keyed by
 * the `classification` upstream gives it (custom_api_call is added by the
 * framework and stays unmapped). The engine test checks the installed package
 * against the adapter too. */
const INTERCOM_092_BY_UPSTREAM: Record<string, string[]> = {
  READ: ["find-company", "find-lead", "find-user", "get-conversation", "get_conversation_by_id", "get_contact", "get_ticket", "get_company"],
  SEARCH: ["find-conversation", "list-all-tags", "search_contacts", "list_contact_notes", "search_conversations", "search_tickets",
    "list_ticket_types", "list_admins", "list_teams", "list_data_attributes", "list_companies", "search_articles", "list_segments"],
  WRITE: ["add-note-to-user", "addNoteToConversation", "add-or-remove-tag-on-contact", "add-or-remove-tag-on-company",
    "add-or-remove-tag-on-conversation", "assignConversationAction", "create-article", "create-conversation", "create-data-event",
    "create-ticket", "create-user", "create-or-update-company", "create-or-update-lead", "create-or-update-user", "replyToConversation",
    "send_message", "update-ticket", "find-or-create-company", "find-or-create-lead", "reply_to_conversation_by_id",
    "add_note_to_conversation_by_id", "assign_conversation_by_id", "tag_or_untag_record", "send_message_to_contact",
    "create_ticket_by_type_id", "update_ticket_by_id", "update_contact", "attach_contact_to_company", "set_conversation_state",
    "convert_conversation_to_ticket", "reply_to_ticket", "create_tag", "add_note_to_contact", "create_conversation_from_contact",
    "create_help_center_article"],
};
/** Upstream WRITE actions that put content in front of other people (worst case). */
const INTERCOM_SENDS = ["add-note-to-user", "addNoteToConversation", "add_note_to_contact", "add_note_to_conversation_by_id",
  "replyToConversation", "reply_to_conversation_by_id", "reply_to_ticket", "create-conversation", "create_conversation_from_contact",
  "assignConversationAction", "set_conversation_state", "create-article", "create_help_center_article", "update_ticket_by_id"];
const INTERCOM_EMAILS = ["send_message", "send_message_to_contact"];
test("the Intercom adapter names every action of the pinned bundle, each in the category it should have", () => {
  const all = Object.values(INTERCOM_092_BY_UPSTREAM).flat();
  expect(all).toHaveLength(56);
  const adapter = MANAGED_PIECE_ADAPTERS.find((a) => a.pieceName === INTERCOM)!;
  expect((Object.values(adapter.categories).flat() as string[]).sort()).toEqual([...all].sort());
  const table = Object.fromEntries(Object.entries(INTERCOM_092_BY_UPSTREAM).flatMap(([upstream, names]) => names.map((name) =>
    [name, INTERCOM_EMAILS.includes(name) ? "send_email" : INTERCOM_SENDS.includes(name) ? "send_message" : upstream === "WRITE" ? "write_data" : "read_data"])));
  expect(Object.fromEntries(all.map((name) => [name, resolveGovernedPieceAction(INTERCOM, name)!.category as string]))).toEqual(table);
  expect(all.filter((name) => !resolveGovernedPieceAction(INTERCOM, name)!.known)).toEqual([]);
  for (const name of ["custom_api_call", "added_upstream_later"])
    expect(resolveGovernedPieceAction(INTERCOM, name)).toMatchObject({ category: "modify_settings", known: false });
  // A completion receipt for every change, never for a read.
  for (const name of all)
    expect(`${name}: ${tracksPieceCompletion(INTERCOM, name)}`).toBe(`${name}: ${table[name] !== "read_data"}`);
  // The managed connection runs a subset of the governed table.
  for (const name of MANAGED_INTERCOM_ACTIONS) expect(all).toContain(name);
});
test("Intercom actions take one category whatever their input", () => {
  const adapter = MANAGED_PIECE_ADAPTERS.find((a) => a.pieceName === INTERCOM)!;
  expect(adapter.categoryFromInput).toBeUndefined();
  const category = (action: string, input?: Record<string, unknown>) => resolveGovernedPieceAction(INTERCOM, action, input)!.category;
  expect(category("send_message", { message_type: "inapp" })).toBe("send_email");
  expect(category("send_message_to_contact", { messageType: "in_app" })).toBe("send_email");
  expect(category("set_conversation_state", { state: "close" })).toBe("send_message");
  expect(category("create_help_center_article", { state: "draft" })).toBe("send_message");
});
