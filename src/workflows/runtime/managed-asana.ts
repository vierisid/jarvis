/** Fixed endpoints and a single dispatch attempt. No SDK retries or transport objects. */
export const MANAGED_ASANA_ACTIONS = ["create_task", "get_task", "update_task", "list_project_tasks", "add_task_comment"] as const;
export const ASANA_TASK_FIELDS = "name,notes,completed,due_on,due_at,start_on,assignee.name,projects.name,workspace.name,permalink_url";
export const ASANA_STORY_FIELDS = "created_at,created_by.name,resource_subtype,type,text,html_text,is_pinned,target.name";
export function managedAsanaInput(input: unknown): Record<string, unknown> | null {
  return (input as {auth?:{jarvis_managed?:unknown}} | null)?.auth?.jarvis_managed === "asana" ? input as Record<string,unknown> : null;
}
export function asanaGid(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9]{1,64}$/.test(value)) throw new Error("Enter a valid Asana ID.");
  return value;
}
const present = (value: unknown) => value !== undefined && value !== null && value !== "";
function text(value: unknown, label: string, max = 65536): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("Enter a valid " + label + ".");
  return value;
}
function date(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) throw new Error("Enter an Asana date as YYYY-MM-DD.");
  return value;
}
function dateTime(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error("Enter an Asana date and time in UTC, ending in Z.");
  date(value.slice(0,10));
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Choose Yes or No for the Asana option.");
  return value;
}
function exclusive(input: Record<string,unknown>, first:string, second:string) {
  if (present(input[first]) && present(input[second])) throw new Error("Use either " + first + " or " + second + ", not both.");
}
/** Also used by the editor's read-only project picker. Caller supplies a fixed path. */
export async function asanaRequest(token:string, path:string, method="GET", data?:Record<string,unknown>, request:typeof fetch=fetch):Promise<Record<string,any>> {
  // This helper is deliberately not a general proxy or a workflow HTTP action.
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("..")) throw new Error("Invalid Asana path.");
  let response:Response;
  try {
    response = await request("https://app.asana.com/api/1.0" + path, {
      method, redirect:"error", signal:AbortSignal.timeout(15000),
      headers:{Authorization:"Bearer " + token, "Content-Type":"application/json"},
      ...(data ? {body:JSON.stringify({data})} : {}),
    });
  } catch { throw new Error("Asana did not confirm the request. Check the task before trying again."); }
  if (!response.ok) {
    await response.body?.cancel().catch(()=>{});
    throw new Error(response.status === 401 ? "Asana refused access. Reconnect Asana." : response.status === 429 ? "Asana is rate limiting requests. Wait and check the task before trying again." : "Asana could not complete the request. Check the task, permissions and fields before trying again.");
  }
  const reader=response.body?.getReader();
  if (!reader) throw new Error("Asana returned an empty response. Check the task before trying again.");
  try {
    const chunks:Uint8Array[]=[]; let size=0;
    for (;;) {const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>1048576)throw new Error();chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}
    const result=JSON.parse(new TextDecoder().decode(bytes));
    if(!result || typeof result!=="object" || Array.isArray(result))throw new Error();
    return result;
  } catch {throw new Error("Asana returned an invalid response. Check the task before trying again.");}
  finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function runManagedAsanaAction(action:string,input:Record<string,unknown>,request:typeof fetch=fetch):Promise<unknown> {
  if (!(MANAGED_ASANA_ACTIONS as readonly string[]).includes(action)) throw new Error("This Asana action has not been enabled for the managed connection.");
  const token=(input.auth as {access_token?:unknown})?.access_token;
  if(typeof token!=="string" || !token)throw new Error("Reconnect Asana.");
  let path:string, method="GET", data:Record<string,unknown>|undefined;
  const query=new URLSearchParams({opt_fields:ASANA_TASK_FIELDS});
  if(action==="create_task") {
    const tags=input.tags;
    if (tags !== undefined && tags !== null && !(Array.isArray(tags) && tags.length===0)) throw new Error("Tags are not supported by hosted Asana yet. Remove tags.");
    path="/tasks";method="POST";
    data={workspace:asanaGid(input.workspace),projects:[asanaGid(input.project)],name:text(input.name,"task name",1000),notes:text(input.notes,"task description")};
    if(present(input.assignee))data.assignee=input.assignee==="me" ? "me" : asanaGid(input.assignee);
    if(present(input.due_on))data.due_on=date(input.due_on);
  } else if(action==="list_project_tasks") {
    path="/projects/"+asanaGid(input.project)+"/tasks";
    const limit=input.limit ?? 100;
    if(typeof limit!=="number" || !Number.isInteger(limit) || limit<1 || limit>100)throw new Error("Choose an Asana result limit from 1 to 100.");
    query.set("limit",String(limit));
    if(present(input.offset))query.set("offset",text(input.offset,"pagination offset",4096));
    if(present(input.completed_since))query.set("completed_since",input.completed_since==="now" ? "now" : dateTime(input.completed_since));
  } else {
    path="/tasks/"+asanaGid(input.task);
    if(action==="update_task") {
      method="PUT";data={};
      exclusive(input,"notes","html_notes");exclusive(input,"due_on","due_at");
      for(const key of ["name","notes","html_notes"])if(present(input[key]))data[key]=text(input[key],key,key==="name"?1000:65536);
      if(present(input.assignee))data.assignee=input.assignee==="me"?"me":asanaGid(input.assignee);
      for(const key of ["due_on","start_on"])if(present(input[key]))data[key]=date(input[key]);
      if(present(input.due_at))data.due_at=dateTime(input.due_at);
      if(present(input.completed))data.completed=boolean(input.completed);
      if(!Object.keys(data).length)throw new Error("Choose at least one Asana task field to update.");
    } else if(action==="add_task_comment") {
      method="POST";path+="/stories";query.set("opt_fields",ASANA_STORY_FIELDS);data={};
      exclusive(input,"text","html_text");
      if(present(input.text))data.text=text(input.text,"comment");
      if(present(input.html_text))data.html_text=text(input.html_text,"HTML comment");
      if(!Object.keys(data).length)throw new Error("Enter the Asana comment text.");
      if(present(input.is_pinned))data.is_pinned=boolean(input.is_pinned);
    }
  }
  const result=await asanaRequest(token,path+"?"+query,method,data,request);
  if(action==="list_project_tasks") {
    if(!Array.isArray(result.data) || result.data.some((t:unknown)=>!validResource(t)) || (result.next_page != null && (typeof result.next_page.offset!=="string" || !result.next_page.offset || result.next_page.offset.length>4096))) throw new Error("Asana returned an invalid task page.");
    return {data:result.data,next_offset:result.next_page?.offset ?? null};
  }
  if(!validResource(result.data))throw new Error("Asana returned an invalid resource. Check the task before trying again.");
  return result.data;
}
function validResource(value:unknown):boolean {
  return !!value && typeof value==="object" && !Array.isArray(value) && typeof (value as any).gid==="string" && /^[0-9]{1,64}$/.test((value as any).gid);
}
