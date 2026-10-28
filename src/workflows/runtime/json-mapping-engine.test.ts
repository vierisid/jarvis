/** Production worker/engine/authorization pipeline against a local Sheets fixture, never Google. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import {createRequire} from 'node:module';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { initWorkflowDb, closeWorkflowDb, getWorkflowDb, DEFAULT_IDS } from '../db';
import { setEncryptionKey } from '../db/encryption';
import { createFlow, setPublishedVersion, updateFlowStatus } from '../db/repos/flow';
import { createDraftVersion, lockVersion } from '../db/repos/flow-version';
import { getFlowRun, listRuns } from '../db/repos/flow-run';
import { upsertConnection } from '../db/repos/app-connection';
import { configureWorkflowReadiness } from '../db/repos/flow-readiness';
import { listWorkflowEffects } from '../db/repos/workflow-effect';
import { AuthorityEngine } from '../../authority/engine';
import { AuditTrail } from '../../authority/audit';
import { EmergencyController } from '../../authority/emergency';
import { CredentialResolver } from '../credentials/adapter';
import { SandboxApi } from '../sandbox-api/server';
import { workflowLogsBase } from '../sandbox-api/config';
import { EngineRuntime } from '../runner/engine-runtime/engine-runtime';
import { EngineFlowExecutor } from '../runner/engine-runtime/engine-flow-executor';
import { buildEngineBundle } from '../runner/engine-runtime/build';
import { buildPiece } from '../runner/engine-runtime/build-pieces';
import { Worker } from '../queue/worker';
import { createRunFlowHandler, RUN_FLOW } from '../runner/handler';
import { TriggerManager } from '../runner/triggers/manager';
import { buildSandboxServiceBackends } from './service-backends';
import { WorkflowEventBuffer } from './event-buffer';
import { WorkflowEventBus } from './event-bus';
import { PieceCatalog, metadataToCatalogEntry } from './piece-catalog';

const PIECE = '@activepieces/piece-google-sheets';
let dir: string, api: SandboxApi, runtime: EngineRuntime, manager: TriggerManager, worker: Worker;
let provider: ReturnType<typeof Bun.serve>;
let loseReply = false, rejectWrite = false;
let catalog: PieceCatalog;
const rows: unknown[] = [], runIds: string[] = [];
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-product-engine-'));
  initWorkflowDb(join(dir, 'fixture.db')); setEncryptionKey(Buffer.alloc(32, 35));
  const bundle = await buildEngineBundle();
  provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const body = await req.json();
    if(rejectWrite)return new Response('Fixture rejected append',{status:400});
    rows.push(...body.values);
    return loseReply ? new Response('Fixture lost reply after append', { status: 500 })
      : Response.json({ updatedRows: body.values.length, updatedRange: 'Submissions!A2:C2' });
  } });
  const pieceDir = join(dir, 'fixture-sheets'); mkdirSync(join(pieceDir, 'src'), { recursive: true });
  writeFileSync(join(pieceDir, 'package.json'), JSON.stringify({ name: PIECE, version: '0.18.2' }));
  writeFileSync(join(pieceDir, 'src/index.ts'), `
    import { createAction, createPiece, PieceAuth, Property } from '@activepieces/pieces-framework';
    const auth = PieceAuth.OAuth2({ description: 'Fixture', required: true, scope: [], authUrl: 'http://localhost/unused', tokenUrl: 'http://localhost/unused' });
    const append = createAction({ name: 'sheets_append_values', displayName: 'Append fixture', description: 'Mirrors inspected Sheets inputs', auth,
      props: { spreadsheet_id: Property.ShortText({ displayName: 'ID', required: true }),
        worksheet_title: Property.ShortText({ displayName: 'Tab', required: true }), range: Property.ShortText({ displayName: 'Range', required: true }),
        values: Property.Json({ displayName: 'Rows', required: true }), value_input_option: Property.ShortText({ displayName: 'Input mode', required: true }) },
      async run(context) {
        const response = await fetch('http://127.0.0.1:${provider.port}/append', { method: 'POST', body: JSON.stringify(context.propsValue) });
        if (!response.ok) throw new Error('Fixture reply lost after append');
        return response.json();
      }
    });
    export const sheets = createPiece({ displayName: 'Fixture Sheets', description: 'Tests only', auth,
      minimumSupportedRelease: '0.82.0', logoUrl: '', authors: [], actions: [append], triggers: [] });
  `);
  await buildPiece(pieceDir);
  const installed = join(dir, 'node_modules', PIECE); mkdirSync(dirname(installed), { recursive: true });
  symlinkSync(join(pieceDir, 'dist'), installed, 'dir');
  upsertConnection({ externalId: 'fixture-sheets', displayName: 'Fixture', type: 'OAUTH2', pieceName: PIECE,
    pieceVersion: '0.18.2', value: { access_token: 'synthetic-only' } });
  const jsonInstalled=join(dir,'node_modules/@activepieces/piece-json');
  symlinkSync(dirname(dirname(createRequire(import.meta.url).resolve('@activepieces/piece-json'))),jsonInstalled,'dir');
  const subflow=await buildPiece(join(import.meta.dir,'../activepieces/packages/pieces/jarvis/subflow'));
  const subInstalled=join(dir,'node_modules',subflow.packageName);mkdirSync(dirname(subInstalled),{recursive:true});symlinkSync(dirname(subflow.packageJsonPath),subInstalled,'dir');
  const services = buildSandboxServiceBackends({ credentialResolver: new CredentialResolver(),
    authorityEngine: new AuthorityEngine({ default_level: 10, governed_categories: [], overrides: [], context_rules: [],
      learning: { enabled: false, suggest_threshold: 10 }, emergency_state: 'normal' }),
    emergencyController: new EmergencyController(), auditTrail: new AuditTrail(), eventBuffer: new WorkflowEventBuffer(),
    llmManager: {} as any, channelService: {} as any, wsService: {} as any });
  api = new SandboxApi({ services }); await api.start({ port: 0 });
  runtime = new EngineRuntime({ api, pool:true, bundlePath: bundle.bundlePath, expectedDigest: bundle.digest, cwd: dir, customPiecesPaths: [dir], devPieces: [], baseCodeDir: join(dir, 'code') });
  const handle = await runtime.acquire({ runId: 'form-fixture-metadata', projectId: DEFAULT_IDS.project });
  try {
    catalog=new PieceCatalog(await Promise.all([[PIECE,'0.18.2'],['@activepieces/piece-json','0.1.14'],[subflow.packageName,subflow.pieceVersion]].map(async([pieceName,pieceVersion])=>metadataToCatalogEntry(await handle.extractPieceMetadata({pieceName:pieceName!,pieceVersion:pieceVersion!})))));
    configureWorkflowReadiness({pieces:catalog});
  }
  finally { await handle.release(); }
  manager = new TriggerManager({ eventBus: new WorkflowEventBus(), log: () => {} }); await manager.start();
  worker = new Worker({ log: () => {}, handlers: { [RUN_FLOW]: createRunFlowHandler({ executor: new EngineFlowExecutor(runtime) }) } });
}, 120_000);
afterAll(async () => {
  await manager?.stop(); await runtime?.shutdown(); await api?.stop(); provider?.stop(true);
  closeWorkflowDb(); setEncryptionKey(null);
  for (const id of runIds) rmSync(join(workflowLogsBase(), id + '.bin'), { force: true });
  if (dir) rmSync(dir, { recursive: true, force: true });
});


import {productSetup,repairedProductGraph,repairedProductCases} from './product-fixture-data';
import {repairedProductRetestGraph,productRetestSetup,productRetestCases} from './product-retest-data';
import {createManageWorkflowTool} from '../../actions/tools/manage-workflow';
import {getLatestDraft} from '../db/repos/flow-version';
import {getFlow} from '../db/repos/flow';
import {UNTRUSTED_OPEN} from '../../roles/untrusted';
const unwrap=(raw:any)=>{const lines=String(raw).split('\n');return JSON.parse(lines[1]?.startsWith(UNTRUSTED_OPEN)?lines.slice(2,-1).join('\n'):String(raw));};
for (const scenario of [
  {name:'original product',graph:repairedProductGraph,setup:productSetup,cases:repairedProductCases},
  {name:'retested batch product',graph:repairedProductRetestGraph,setup:productRetestSetup,cases:productRetestCases},
]) test(scenario.name+' saved graph passes public tool and real worker with mocked Sheets',async()=>{
  const source=scenario.graph(),setup=scenario.setup(),cases=scenario.cases();
  const flow=createFlow();const draft=createDraftVersion({flowId:flow.id,displayName:'Captured product graph',trigger:source});
  const tool=createManageWorkflowTool({pieceRegistry:catalog});
  const args={action:'validate_fixtures',flow:flow.id,fixture_input:{setup,cases}};
  let page=unwrap(await tool.execute(args)),content='';
  for(;;){content+=page.content;if(!page.nextCursor)break;page=unwrap(await tool.execute({...args,cursor:page.nextCursor}));}
  const report=JSON.parse(content);expect(report.cases).toHaveLength(cases.length);expect(report.flowId).toBe(flow.id);expect(report.versionId).toBe(draft.id);expect(report.externalActions).toBe(0);
  expect(getLatestDraft(flow.id)?.trigger).toEqual(source);expect(getFlow(flow.id)?.status).toBe('DISABLED');expect(getFlow(flow.id)?.published_version_id).toBeNull();expect(listRuns({flowId:flow.id})).toHaveLength(0);
  const graph=scenario.graph();Object.assign(graph.nextAction.settings.input,setup.step_1);Object.assign(graph.nextAction.nextAction.nextAction.children[0].settings.input,{...setup.step_3,auth:'{{connections.fixture-sheets}}'});
  const version=createDraftVersion({flowId:flow.id,displayName:'Isolated configured fixture',trigger:graph});
  lockVersion(version.id);setPublishedVersion(flow.id,version.id);updateFlowStatus(flow.id,'ENABLED');await manager.refresh(flow.id);
  for(const c of cases){
    rejectWrite=c.sheetsOutcome==='failure';loseReply=c.sheetsOutcome==='uncertain';const before=rows.length;
    const response=await manager.webhookManager().handleRequest(flow.id,new Request('http://localhost/products',{method:'POST',body:JSON.stringify(c.payload)}));
    const accepted=await response.json();expect(accepted.outcome).toBe('started');runIds.push(accepted.runId);
    await worker.drain();const run=getFlowRun(accepted.runId)!;
    expect(run.status,c.name+': '+JSON.stringify(run)).toBe(['FAILED','UNCERTAIN'].includes(c.expectedStatus)?'FAILED':'SUCCEEDED');
    expect(rows.slice(before),c.name).toEqual(c.expectedRows);
    if(c.expectedStates){const result=getWorkflowDb().query('SELECT value FROM workflow_subflow_result WHERE run_id=?').get(accepted.runId) as {value:string};expect(JSON.parse(result.value).states,c.name).toEqual(c.expectedStates);}
    if(c.assertions?.length){
      const stored=getWorkflowDb().query('SELECT value FROM workflow_subflow_result WHERE run_id=?').get(accepted.runId) as {value:string};
      const result=JSON.parse(stored.value),validation=result.validation??result;
      for(const assertion of c.assertions){
        expect(assertion.step).toBe('step_2');
        const value=assertion.path.reduce((v:any,key:string|number)=>v[key],validation);
        expect(value,c.name+': '+assertion.path.join('.')).toEqual(assertion.equals);
      }
    }
    if(c.expectedRequests===0)expect(listWorkflowEffects(accepted.runId).filter(e=>e.stepName==='step_3')).toHaveLength(0);
  }
},120_000);
