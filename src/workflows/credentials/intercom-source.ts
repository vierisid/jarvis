import type {JarvisConfig} from "../../config/types";
import {INTERCOM_CONNECTION, INTERCOM_PIECE, INTERCOM_HOSTS, readIntercomConnection} from "../../integrations/intercom-connection";
import {MANAGED_INTERCOM_ACTIONS} from "../runtime/managed-intercom";
import {credentialFingerprint, type JarvisConnectionSource, type ResolvedConnection} from "./adapter";
export class JarvisIntercomConnectionSource implements JarvisConnectionSource {
  readonly id="intercom";
  readonly pieceNames=[INTERCOM_PIECE];
  readonly pieceDetails = {[INTERCOM_PIECE]:{displayName:"Intercom",apiHosts:Object.values(INTERCOM_HOSTS),actions:MANAGED_INTERCOM_ACTIONS}};
  constructor(private readonly config:JarvisConfig){}
  canResolve(id:string){return id===INTERCOM_CONNECTION;}
  identity(id:string){const c=this.canResolve(id)?readIntercomConnection(this.config.daemon.data_dir):null;
    return c?credentialFingerprint(JSON.stringify([c.generation,c.account.id,c.settings.region,c.settings.api_host,c.settings.admin_id,c.access_token])):null;}
  async resolve(id:string):Promise<ResolvedConnection|null>{
    const c=this.canResolve(id)?readIntercomConnection(this.config.daemon.data_dir):null;
    return c?{type:"OAUTH2",pieceName:INTERCOM_PIECE,status:"ACTIVE",value:{access_token:c.access_token,refresh_token:"",token_type:"Bearer",
      region:c.settings.region==="us"?"intercom":c.settings.region+".intercom",props:{region:c.settings.region==="us"?"intercom":c.settings.region+".intercom"},jarvis_managed:"intercom",api_host:c.settings.api_host,admin_id:c.settings.admin_id}}:null;
  }
}
