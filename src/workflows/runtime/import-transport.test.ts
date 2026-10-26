import {expect,test} from 'bun:test';
import {EventEmitter} from 'node:events';
import {importTransport} from './import-transport';
import {importFixtureSetup as setup} from './import-fixtures';

function harness(address='8.8.8.8',status=200,payload='{"items":[],"next_cursor":null}'){
 const calls:Array<{url:string;options:any;body?:string}>=[];
 const transport={lookup:async()=>[{address,family:4}],request:(url:URL,options:any,onResponse:(r:any)=>void)=>{
  const req=new EventEmitter() as any;const call={url:url.toString(),options,body:undefined as string|undefined};calls.push(call);
  req.destroy=()=>req.emit('error',Error('closed'));
  req.end=(body?:string)=>{call.body=body;queueMicrotask(()=>{const response=new EventEmitter() as any;response.statusCode=status;response.headers={'retry-after':'60',location:'https://other.example'};onResponse(response);response.emit('data',Buffer.from(payload));response.emit('end');});};return req;
 }};
 let checks=0;return {calls,request:importTransport(setup,{hubspot:'fake-hubspot',source:'fake-source'},()=>{checks++;},transport as any),get checks(){return checks;}};
}

test('transport pins public DNS, scopes bearer tokens and exposes status, headers and body',async()=>{
 const h=harness('8.8.8.8',429);const response=await h.request('source',setup.sourceUrl+'?cursor=page2','GET');
 expect(response).toEqual({status:429,retryAfter:'60',body:{items:[],next_cursor:null}});expect(h.calls[0]!.options.headers.Authorization).toBe('Bearer fake-source');expect(h.checks).toBe(2);
 const address=await new Promise(resolve=>h.calls[0]!.options.lookup('import.example',{all:true},(_e:any,value:any)=>resolve(value)));expect(address).toEqual([{address:'8.8.8.8',family:4}]);
 await h.request('hubspot','https://api.hubapi.com/crm/v3/objects/contacts','POST',{properties:{email:'a@example.com'}});expect(h.calls[1]!.options.headers.Authorization).toBe('Bearer fake-hubspot');expect(h.calls[1]!.body).toContain('a@example.com');
});

test('transport refuses private destinations, source mutations and non-contact HubSpot actions before dispatch',async()=>{
 const local=harness('127.0.0.1');await expect(local.request('source',setup.sourceUrl,'GET')).rejects.toThrow('public');expect(local.calls).toHaveLength(0);
 const h=harness();
 await expect(h.request('source','https://other.example/contacts','GET')).rejects.toThrow('changed');
 await expect(h.request('source',setup.sourceUrl,'POST')).rejects.toThrow('changed');
 await expect(h.request('hubspot','https://api.hubapi.com/email/public/v1/singleEmail/send','POST')).rejects.toThrow('Unsupported');expect(h.calls).toHaveLength(0);
});

test('transport neither follows redirects nor silently truncates oversized pages',async()=>{
 const redirect=harness('8.8.8.8',302);expect((await redirect.request('source',setup.sourceUrl,'GET')).status).toBe(302);expect(redirect.calls).toHaveLength(1);
 const large=harness('8.8.8.8',200,'x'.repeat(2*1024*1024+1));await expect(large.request('source',setup.sourceUrl,'GET')).rejects.toThrow();expect(large.calls).toHaveLength(1);
});
