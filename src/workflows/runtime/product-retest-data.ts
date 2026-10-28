import graph from './fixtures/product-retest-test17.json';
export const productRetestGraph = () => structuredClone(graph) as any;
// Preserve the captured generated graph as regression evidence. Only the row
// construction changes in the repaired draft; setup remains unset.
export function repairedProductRetestGraph() {
  const result=productRetestGraph();
  const input=result.nextAction.nextAction.settings.input;
  input.query=input.query.replace("[$map($results[valid = true],function($r){$r.row})]",
    "$reduce([$results[valid = true]],function($rows,$r){$append($rows,[[$r.row]])},[])");
  return result;
}
export const productRetestSetup = () => ({
  step_1: {json: {
    recordsPath: ['products'], mode: 'array',
    fields: ['price','stock','active'].map(name => ({name,path:[name],type:name==='active'?'boolean':'number',required:false,allowNull:true,allowEmpty:true})),
    columns: ['price','stock','active'].flatMap(field => [{field,kind:'value'},{field,kind:'state'}]),
  }},
  step_3: {spreadsheet_id:'fixture-sheet',worksheet_title:'Fixture',range:'A:F',values:'{{step_2.rows}}'},
});
const assertion=(path: Array<string|number>,equals:unknown)=>({step:'step_2',path,equals});
export function productRetestCases() {
  const valid={price:0,stock:0,active:false}, row=[0,'value',0,'value',false,'value'];
  const cases:any[]=[{name:'zero and false',payload:{products:[valid]},expectedRows:[row],expectedStatus:'SUCCEEDED',expectedRequests:1,
    assertions:[assertion(['validCount'],1),assertion(['invalidCount'],0)]}];
  for(const [i,field] of ['price','stock','active'].entries()) for(const [state,value] of [['missing',undefined],['null',null],['empty','']] as const){
    const product:any={...valid};if(value===undefined)delete product[field];else product[field]=value;
    const expected=[...row];expected[2*i]='';expected[2*i+1]=state;
    cases.push({name:field+' '+state,payload:{products:[product]},expectedRows:[expected],expectedStatus:'SUCCEEDED',expectedRequests:1,
      assertions:[assertion(['records',0,'fields',i,'state'],state)]});
  }
  for(const field of ['price','stock']) for(const value of ['0','NaN','Infinity','oops',true,[],{}])cases.push({
    name:field+' invalid '+JSON.stringify(value),payload:{products:[{...valid,[field]:value}]},expectedRows:[],expectedStatus:'SUCCEEDED',expectedRequests:0,
    assertions:[assertion(['validCount'],0),assertion(['invalidCount'],1)]});
  for(const value of ['false',0,[],{}])cases.push({name:'active invalid '+JSON.stringify(value),payload:{products:[{...valid,active:value}]},expectedRows:[],expectedStatus:'SUCCEEDED',expectedRequests:0,assertions:[assertion(['invalidCount'],1)]});
  for(const [field,value] of [['price',-2.5],['stock',-1],['stock',1.5]] as const){
    const expected=[...row];expected[field==='price'?0:2]=value;
    cases.push({name:field+' accepts numeric '+value+' without domain restrictions',payload:{products:[{...valid,[field]:value}]},expectedRows:[expected],expectedStatus:'SUCCEEDED',expectedRequests:1});
  }
  cases.push({name:'mixed batch',payload:{products:[valid,{...valid,price:'bad'},{price:12.5,stock:2,active:true}]},expectedRows:[row,[12.5,'value',2,'value',true,'value']],expectedStatus:'SUCCEEDED',expectedRequests:1,
    assertions:[assertion(['validCount'],2),assertion(['invalidCount'],1)]});
  cases.push({name:'all invalid',payload:{products:[{price:'bad'},false,null,[]]},expectedRows:[],expectedStatus:'SUCCEEDED',expectedRequests:0,assertions:[assertion(['invalidCount'],4)]});
  cases.push({name:'empty batch',payload:{products:[]},expectedRows:[],expectedStatus:'SUCCEEDED',expectedRequests:0,assertions:[assertion(['validCount'],0),assertion(['invalidCount'],0)]});
  for(const [label,payload] of [['missing',{}],['null',{products:null}],['wrong type',{products:'not an array'}]] as const)cases.push({name:'container '+label,payload,expectedRows:[],expectedStatus:'SUCCEEDED',expectedRequests:0,assertions:[assertion(['status'],'rejected_payload_shape')]});
  cases.push({name:'Sheets rejection',payload:{products:[valid]},sheetsOutcome:'failure',expectedRows:[],expectedStatus:'FAILED',expectedRequests:1});
  cases.push({name:'Sheets uncertain',payload:{products:[valid]},sheetsOutcome:'uncertain',expectedRows:[row],expectedStatus:'UNCERTAIN',expectedRequests:1});
  return cases;
}
