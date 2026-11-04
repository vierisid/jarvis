import {ImportTransportError,type ImportRequest,type ImportSetup} from './contact-import';
export const importFixtureSetup:ImportSetup={importId:'fixture-import',sourceUrl:'https://import.example/contacts',sourceAuth:'none',sourceConnection:'',hubspotConnection:'fixture-hubspot',hubspotPortalId:'42',itemsPath:'items',nextCursorPath:'next_cursor',cursorParameter:'cursor',idPath:'id',emailPath:'email',propertyMapping:{firstname:'name'}};
export function importFixtureProvider(){
  const contacts=new Map<string,{id:string;properties:Record<string,string>}>(),calls:Array<{provider:string;url:string;method:string}>=[];
  let creates=0,failures=0;
  const options={loseWrite:false,crashWrite:false,throttle:false,sourceUnavailable:false,cursorCycle:false,changedIdentity:false,missingCursor:false};
  const request:ImportRequest=async(provider,url,method,body:any)=>{
    calls.push({provider,url,method});const u=new URL(url);
    if(u.pathname==='/account-info/v3/details')return {status:200,body:{portalId:42}};
    if(provider==='source'){
      if(options.sourceUnavailable)return {status:503,body:null};
      if(options.throttle&&failures++===0)return {status:429,retryAfter:'60',body:null};
      const page=u.searchParams.get('cursor');
      return {status:200,body:{items:page?[{id:'1',email:' ALICE@EXAMPLE.COM ',name:options.changedIdentity?'Changed':'Alice'},{id:'2',email:'bob@example.com',name:'Bob'}]:[{id:'1',email:'alice@example.com',name:'Alice'}],...(!options.missingCursor?{next_cursor:page?(options.cursorCycle?'page2':null):'page2'}:{})}};
    }
    const email=method==='POST'?body.properties.email:decodeURIComponent(u.pathname.split('/').at(-1)!);
    if(method==='GET')return contacts.has(email)?{status:200,body:contacts.get(email)}:{status:404,body:{}};
    if(method==='POST'&&contacts.has(email))return {status:409,body:{}};
    const old=contacts.get(email);if(method==='PATCH'&&!old)return {status:404,body:{}};
    const contact={id:old?.id??String(++creates),properties:{...old?.properties,...body.properties,email}};contacts.set(email,contact);
    if(options.crashWrite){options.crashWrite=false;throw Error('Fixture process died after provider commit');}
    if(options.loseWrite){options.loseWrite=false;throw new ImportTransportError();}
    return {status:200,body:contact};
  };
  return {request,options,contacts,calls,get creates(){return creates;}};
}
