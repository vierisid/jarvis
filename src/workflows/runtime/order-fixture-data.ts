import captured from './fixtures/order-generated-test18.json';

export const orderGraph = () => structuredClone(captured) as any;
/** Repair the captured graph, preserving IDs, branches and unset destinations. */
export function repairedOrderGraph() {
  const graph = orderGraph(), transform = graph.nextAction;
  graph.nextAction = {name:'order_mapping',displayName:'Setup required: order payload paths and column mappings',type:'PIECE',settings:{
    pieceName:'@activepieces/piece-json',actionName:'run_jsonata_query',input:{json:null,query:'$'}},nextAction:transform};
  transform.settings.input.json.mapping = '{{order_mapping}}';
  const append=transform.nextAction.children[0];
  append.settings.input.values='{{step_1.orderRows}}';
  append.nextAction.settings.input.values='{{step_1.lineRows}}';
  transform.settings.input.query = `(
    $p := payload; $m := mapping;
    $pathOK := function($path){$type($path) = 'string' and $length($path) > 0};
    $get := function($o,$path){$reduce($split($path,'.'),function($v,$k){$type($v) = 'object' ? $lookup($v,$k) : $nothing},$o)};
    $columnsOK := function($columns,$itemAllowed){
      $type($columns) = 'array' and $count($columns) > 0 ?
      $count($columns[source = 'order_id']) > 0 and
      $count($filter($columns,function($c){$not($type($c) = 'object' and
        ($c.source = 'order_id' or ($c.source = 'order' or ($itemAllowed and $c.source = 'item')) and $pathOK($c.path)))})) = 0 : false
    };
    $configured := $type($m) = 'object' and $pathOK($m.idPath) and $pathOK($m.lineItemsPath)
      and $columnsOK($m.orderColumns,false) and $columnsOK($m.lineColumns,true);
    $id := $configured ? $get($p,$m.idPath) : null;
    $items := $configured ? $get($p,$m.lineItemsPath) : null;
    $validId := $type($id) = 'string' ? $length($trim($id)) > 0 and $length($trim($id)) <= 256
      : ($type($id) = 'number' ? $floor($id) = $id and $abs($id) <= 9007199254740991 : false);
    $validItems := $type($items) = 'array' ? $count($items) > 0 and $count($items[$type($) != 'object']) = 0 : false;
    $valid := $configured and $validId and $validItems;
    $orderId := $validId ? ($type($id) = 'string' ? $trim($id) : $string($id)) : '';
    $cell := function($column,$item){(
      $value := $column.source = 'order_id' ? $orderId : ($column.source = 'order' ? $get($p,$column.path) : $get($item,$column.path));
      $exists($value) and $value != null ? $value : ''
    )};
    $scalar := function($v){$type($v) in ['string','boolean'] or ($type($v) = 'number' and $abs($v) <= 1.7976931348623157e308)};
    $cellsOK := $valid ? $count($filter($m.orderColumns,function($c){$not($scalar($cell($c,null)))})) = 0 and
      $count($filter($items,function($item){$count($filter($m.lineColumns,function($c){$not($scalar($cell($c,$item)))})) > 0})) = 0 : false;
    $accepted := $valid and $cellsOK;
    $orderRows := $accepted ? [[$map($m.orderColumns,function($c){$cell($c,null)})]] : [];
    $lineRows := $accepted ? $reduce($items,function($rows,$item){$append($rows,[[$map($m.lineColumns,function($c){$cell($c,$item)})]])},[]) : [];
    {'valid':$accepted,'status':$not($configured) ? 'setup_required' : ($accepted ? 'ready' : 'rejected'),
      'orderId':$orderId,'orderRows':$accepted ? $orderRows : [],'lineRows':$accepted ? $lineRows : [],
      'issues':$not($configured) ? ['Configure ID/item paths and ordered column descriptors. Each tab must include source order_id. Use the same ID path as webhook admission.'] :
        ($accepted ? [] : ['Require a stable order ID, nonempty array of line-item objects and scalar mapped cells. No rows dispatched.'])}
  )`;
  return graph;
}
export const orderSetup = () => ({
  trigger:{request_id_field:'orderId'},
  order_mapping:{json:{idPath:'orderId',lineItemsPath:'items',
    orderColumns:[{source:'order_id'},{source:'order',path:'customer.name'},{source:'order',path:'shipping.address2'}],
    lineColumns:[{source:'order_id'},{source:'item',path:'sku'},{source:'item',path:'quantity'}]}},
  step_2:{spreadsheet_id:'fixture-sheet',worksheet_title:'Orders',range:'A:C'},
  step_3:{spreadsheet_id:'fixture-sheet',worksheet_title:'Lines',range:'A:C'},
});
export function orderCases() {
  const payload = {orderId:'order-1',customer:{name:'Fixture Customer'},shipping:{},items:[{sku:'A',quantity:0},{sku:'B',quantity:2}]};
  const order = [['order-1','Fixture Customer','']], lines = [['order-1','A',0],['order-1','B',2]];
  const c = (name:string,p:any,orders:any[],items:any[],extra:any={}) => ({name,payload:p,expectedStatus:'SUCCEEDED',
    expectedRows:[...orders,...items],expectedRowsByStep:{step_2:orders,step_3:items},expectedRequests:orders.length?2:0,...extra});
  const invalid = (name:string,p:any) => c(name,p,[],[],{assertions:[{step:'step_1',path:['valid'],equals:false}]});
  return [
    c('two line order',payload,order,lines),
    c('one line order',{...payload,items:payload.items.slice(0,1)},order,lines.slice(0,1)),
    c('optional address absent',{...payload,shipping:undefined},order,lines),
    c('optional address null',{...payload,shipping:{address2:null}},order,lines),
    c('optional address empty',{...payload,shipping:{address2:''}},order,lines),
    c('zero and false cells',{...payload,items:[{sku:false,quantity:0}]},order,[['order-1',false,0]]),
    c('normalized ID',{...payload,orderId:' order-1 '},order,lines),
    c('numeric zero ID',{...payload,orderId:0},[['0','Fixture Customer','']],[['0','A',0],['0','B',2]]),
    ...[undefined,null,'',false,1.5].map(id=>c('invalid ID '+String(id),{...payload,orderId:id},[],[],{expectedStatus:'REJECTED',expectedAdmissionRejections:1})),
    ...[undefined,null,[],{},'bad'].map(items=>invalid('invalid items '+String(items),{...payload,items})),
    invalid('non-object item',{...payload,items:[null]}),
    invalid('array cell cannot disappear',{...payload,items:[{sku:[],quantity:1}]}),
    invalid('non-scalar cell',{...payload,items:[{sku:{bad:true},quantity:1}]}),
    c('repeated concurrent delivery',payload,order,lines,{deliveries:8,expectedDuplicateDeliveries:7}),
    c('order append rejected',payload,[],[],{sheetsOutcomes:{step_2:'failure'},expectedStatus:'FAILED',expectedRequests:1,deliveries:3,expectedDuplicateDeliveries:2}),
    c('line append rejected after order',payload,order,[],{sheetsOutcomes:{step_3:'failure'},expectedStatus:'FAILED',expectedRequests:2,deliveries:3,expectedDuplicateDeliveries:2}),
    c('order append uncertain',payload,order,[],{sheetsOutcomes:{step_2:'uncertain'},expectedStatus:'UNCERTAIN',expectedRequests:1,deliveries:3,expectedDuplicateDeliveries:2}),
    c('line append uncertain after order',payload,order,lines,{sheetsOutcomes:{step_3:'uncertain'},expectedStatus:'UNCERTAIN',expectedRequests:2,deliveries:3,expectedDuplicateDeliveries:2}),
  ];
}
