import {afterEach,beforeEach,expect,test} from "bun:test";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {randomUUID} from "node:crypto";
import {readIntercomConnection,intercomStatus} from "./intercom-connection";
import {JarvisIntercomConnectionSource} from "../workflows/credentials/intercom-source";
import {managedConnectionMisuse} from "../workflows/credentials/adapter";
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
