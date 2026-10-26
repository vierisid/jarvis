import {lookup} from 'node:dns/promises';
import {request as httpsRequest} from 'node:https';
import {isIP} from 'node:net';
import {ImportTransportError,type ImportRequest,type ImportSetup,type ImportResponse} from './contact-import';
/** Public HTTPS only. Resolve once and pin that address in the TLS request so
 * a DNS rebinding cannot redirect the daemon into a private service. */
export function publicImportAddress(address:string):boolean {
  if(isIP(address)===4){const [a,b]=address.split('.').map(Number);return !!a&&a!==10&&a!==127&&a<224&&!(a===169&&b===254)&&!(a===172&&b!>=16&&b!<=31)&&!(a===192&&(b===168||b===0))&&!(a===100&&b!>=64&&b!<=127)&&!(a===198&&(b===18||b===19));}
  return isIP(address)===6&&/^[23]/i.test(address)&&!/^2001:db8:/i.test(address);
}
export function importTransport(setup:ImportSetup,tokens:{source?:string;hubspot:string},checkpoint:()=>void,
  transport:{lookup:typeof lookup;request:typeof httpsRequest}={lookup,request:httpsRequest}):ImportRequest {
  return async(provider,url,method,body)=>{
    const u=new URL(url),source=new URL(setup.sourceUrl);
    if(u.protocol!=='https:'||u.username||u.password||u.hash||u.port&&u.port!=='443')throw Error('Import endpoint is not qualified HTTPS');
    if(provider==='source'){
      const clean=new URL(u);clean.searchParams.delete(setup.cursorParameter);const original=new URL(source);original.searchParams.delete(setup.cursorParameter);
      if(method!=='GET'||clean.toString()!==original.toString())throw Error('Import source operation changed');
    }else if(u.hostname!=='api.hubapi.com'||!(method==='GET'&&(u.pathname==='/account-info/v3/details'||u.pathname.startsWith('/crm/v3/objects/contacts/'))||method==='POST'&&u.pathname==='/crm/v3/objects/contacts'||method==='PATCH'&&u.pathname.startsWith('/crm/v3/objects/contacts/')))throw Error('Unsupported import operation');
    checkpoint();let addresses;
    let lookupDeadline:ReturnType<typeof setTimeout>|undefined;
    try{addresses=await Promise.race([transport.lookup(u.hostname,{all:true}),new Promise<never>((_,reject)=>{lookupDeadline=setTimeout(()=>reject(new ImportTransportError()),5000);})]);}
    catch{throw new ImportTransportError();}finally{clearTimeout(lookupDeadline);}
    if(!addresses.length||addresses.some(a=>!publicImportAddress(a.address)))throw Error('Import source must resolve to a public HTTPS address');
    const selected=addresses.find(a=>a.family===4)??addresses[0]!;checkpoint();
    const token=provider==='hubspot'?tokens.hubspot:tokens.source;
    return new Promise<ImportResponse>((resolve,reject)=>{
      const req=transport.request(u,{method,agent:false,headers:{Accept:'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(body?{'Content-Type':'application/json'}:{})},
        lookup:((_hostname:any,options:any,callback:any)=>options.all?callback(null,[selected]):callback(null,selected.address,selected.family)) as any},res=>{
          const chunks:Buffer[]=[];let size=0;
          res.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>2*1024*1024){req.destroy();reject(Error('Import provider response exceeds 2 MiB'));}else chunks.push(chunk);});
          res.on('error',()=>reject(new ImportTransportError()));
          res.on('end',()=>{clearTimeout(deadline);let data:unknown;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{data=null;}
            resolve({status:res.statusCode??0,retryAfter:String(res.headers['retry-after']??'')||null,body:data});});
        });
      const deadline=setTimeout(()=>{req.destroy();reject(new ImportTransportError());},15_000);
      req.on('error',()=>{clearTimeout(deadline);reject(new ImportTransportError());});
      req.end(body?JSON.stringify(body):undefined);
    });
  };
}
