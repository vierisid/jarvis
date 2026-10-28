/** Read the hosting-owned grant on every use so reconnect/disconnect needs no restart. */
import {join} from "node:path";
import type {JarvisConfig} from "../config/types";
import {readManagedConnectionFile} from "./managed-connection-file";
export const INTERCOM_PIECE = "@activepieces/piece-intercom";
export const INTERCOM_CONNECTION = "jarvis:intercom";
export const INTERCOM_HOSTS = {us:"api.intercom.io", eu:"api.eu.intercom.io", au:"api.au.intercom.io"} as const;
export interface IntercomConnection {
  version:1; provider:"intercom"; status:"connected"; generation:string; access_token:string;
  account:{id:string;label:string}; workspaces:Array<{id:string;name:string}>; connected_at:string;
  settings:{region:keyof typeof INTERCOM_HOSTS;api_host:string;admin_id:string};
}
const text = (v:unknown,max=512):v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f-\x9f]/.test(v);
export function readIntercomConnection(dataDir:string):IntercomConnection|null {
  try {
    const v=JSON.parse(readManagedConnectionFile(join(dataDir,"connections","intercom.json")));
    if(v.version!==1 || v.provider!=="intercom" || v.status!=="connected" || !text(v.generation) || !/^[a-f0-9-]{36}$/.test(v.generation) ||
      !text(v.access_token,16384) || v.refresh_token!==undefined || v.expires_at!==undefined || !text(v.account?.id) || !text(v.account?.label) ||
      !Array.isArray(v.workspaces) || v.workspaces.length!==1 || !text(v.workspaces[0]?.id,256) || !text(v.workspaces[0]?.name) ||
      !text(v.connected_at) || !Number.isFinite(Date.parse(v.connected_at)) || !v.settings || !Object.hasOwn(INTERCOM_HOSTS,v.settings.region) ||
      v.settings.api_host!==INTERCOM_HOSTS[v.settings.region as keyof typeof INTERCOM_HOSTS] || !text(v.settings.admin_id,256) ||
      v.account.id!==v.workspaces[0].id+":"+v.settings.admin_id) return null;
    return v;
  }catch{return null;}
}
export function intercomConnectUrl(config:JarvisConfig):string|null {
  try {const url=new URL(config.usejarvis_integrations?.page_url ?? "");
    if(url.protocol!=="https:" || url.username || url.password)return null;
    url.searchParams.set("integration","intercom");return url.toString();
  }catch{return null;}
}
export function intercomStatus(config:JarvisConfig) {
  const c=readIntercomConnection(config.daemon.data_dir),url=intercomConnectUrl(config);
  return {configured:!!url,connect_url:url,connected:!!c,external_id:INTERCOM_CONNECTION,
    account:c?.account ?? null,workspaces:c?.workspaces ?? [],generation:c?.generation ?? null,connected_at:c?.connected_at ?? null};
}
