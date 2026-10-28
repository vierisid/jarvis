/** Fixed endpoints, bounded responses and one dispatch attempt. Safe to import into the engine. */
export const MANAGED_INTERCOM_ACTIONS = ["get_contact","get_conversation_by_id","add_note_to_contact","add_note_to_conversation_by_id","list-all-tags","add-or-remove-tag-on-contact"] as const;
export function managedIntercomInput(input:unknown):Record<string,unknown>|null {
  return (input as {auth?:{jarvis_managed?:unknown}}|null)?.auth?.jarvis_managed==="intercom"?input as Record<string,unknown>:null;
}
const record=(v:unknown):v is Record<string,any> => !!v && typeof v==="object" && !Array.isArray(v);
function text(v:unknown,label:string,max=65536):string {
  if(typeof v!=="string" || !v.trim() || v.length>max)throw new Error("Enter a valid "+label+".");return v.trim();
}
function id(v:unknown):string {
  const s=text(v,"Intercom ID",256);
  if(!/^[a-zA-Z0-9_-]+$/.test(s))throw new Error("Enter a valid Intercom ID.");return s;
}
function resource(v:unknown):v is Record<string,any>{return record(v) && typeof v.id==="string" && /^[a-zA-Z0-9_-]{1,256}$/.test(v.id);}
function flag(v:unknown,defaultValue:boolean):boolean {
  if(v===undefined || v===null)return defaultValue;
  if(typeof v!=="boolean")throw new Error("Choose Yes or No for the Intercom option.");return v;
}
async function requestJson(host:string,token:string,path:string,method:string,body:unknown,request:typeof fetch):Promise<Record<string,any>> {
  let response:Response;
  try {response=await request("https://"+host+path,{method,redirect:"error",signal:AbortSignal.timeout(15000),
    headers:{Authorization:"Bearer "+token,Accept:"application/json","Intercom-Version":"2.11",...(body===undefined?{}:{"Content-Type":"application/json"})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});}
  catch{throw new Error("Intercom did not confirm the request. Check the record before trying again.");}
  if(!response.ok){await response.body?.cancel().catch(()=>{});
    throw new Error(response.status===401?"Intercom refused access. Reconnect Intercom.":response.status===429?"Intercom is rate limiting requests. Wait and check the record before trying again.":"Intercom could not complete the request. Check the record and account permissions before trying again.");}
  const reader=response.body?.getReader();
  if(!reader)throw new Error("Intercom returned an empty response. Check the record before trying again.");
  try{const chunks:Uint8Array[]=[];let size=0;
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1048576)throw new Error();chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
    const value=JSON.parse(new TextDecoder().decode(bytes));if(!record(value))throw new Error();return value;
  }catch{throw new Error("Intercom returned an invalid response. Check the record before trying again.");}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function runManagedIntercomAction(action:string,input:Record<string,unknown>,request:typeof fetch=fetch):Promise<unknown> {
  if(!(MANAGED_INTERCOM_ACTIONS as readonly string[]).includes(action))throw new Error("This Intercom action has not been enabled for the managed connection.");
  const auth=input.auth;
  if(!record(auth) || typeof auth.access_token!=="string" || !auth.access_token || !["api.intercom.io","api.eu.intercom.io","api.au.intercom.io"].includes(auth.api_host))throw new Error("Reconnect Intercom.");
  const call=(path:string,method="GET",body?:unknown)=>requestJson(auth.api_host,auth.access_token,path,method,body,request);
  let result:Record<string,any>;
  if(action==="get_contact"){
    const lookup=input.lookupBy ?? "id";
    if(lookup==="id")result=await call("/contacts/"+id(input.value));
    else {
      if(lookup!=="email" && lookup!=="external_id")throw new Error("Choose contact ID, email or external ID.");
      const page=await call("/contacts/search","POST",{query:{field:lookup,operator:"=",value:text(input.value,"contact lookup",512)},pagination:{per_page:2}});
      if(!Array.isArray(page.data) || page.data.some((c:unknown)=>!resource(c)))throw new Error("Intercom returned an invalid contact page.");
      if(page.data.length!==1 || (typeof page.total_count==="number" && page.total_count>1) || page.pages?.next)throw new Error("The lookup must match exactly one contact. Use a contact ID.");
      result=page.data[0];
    }
  }else if(action==="get_conversation_by_id"){
    result=await call("/conversations/"+id(input.conversationId)+(flag(input.plainText,true)?"?display_as=plaintext":""));
    if(!resource(result))throw new Error("Intercom returned an invalid conversation.");
    const {conversation_parts,...conversation}=result;
    if(conversation_parts!=null && (!record(conversation_parts) || !Array.isArray(conversation_parts.conversation_parts)))throw new Error("Intercom returned invalid conversation parts.");
    return {...conversation,parts:(conversation_parts?.conversation_parts ?? []).map((p:unknown)=>{const v=record(p)?p:{},a=record(v.author)?v.author:{};
      return {id:String(v.id??""),part_type:typeof v.part_type==="string"?v.part_type:null,author_type:typeof a.type==="string"?a.type:null,
        author_id:a.id==null?null:String(a.id),author_name:typeof a.name==="string"?a.name:null,body:typeof v.body==="string"?v.body:null,created_at:typeof v.created_at==="number"?v.created_at:null};})};
  }else if(action==="list-all-tags"){
    result=await call("/tags");
    if(!Array.isArray(result.data) || result.data.some((t:unknown)=>!resource(t)))throw new Error("Intercom returned an invalid tag list.");return result;
  }else if(action==="add-or-remove-tag-on-contact"){
    const contact=id(input.contactId),tag=id(input.tagId),remove=flag(input.untag,false);
    result=await call("/contacts/"+contact+"/tags"+(remove?"/"+tag:""),remove?"DELETE":"POST",remove?undefined:{id:tag});
  }else{
    const conversation=action==="add_note_to_conversation_by_id",recordId=id(conversation?input.conversationId:input.contactId);
    const body=text(input.body,"internal note"),adminId=id(input.adminId===undefined || input.adminId===null || input.adminId===""?auth.admin_id:input.adminId);
    result=await call((conversation?"/conversations/":"/contacts/")+recordId+(conversation?"/reply":"/notes"),"POST",
      {body,admin_id:adminId,...(conversation?{message_type:"note",type:"admin"}:{})});
  }
  if(!resource(result))throw new Error("Intercom returned an invalid record. Check the record before trying again.");return result;
}
