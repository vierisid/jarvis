import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolRegistry } from './tools/registry';
import { readFileTool, runCommandTool } from './tools/builtin';
import { isNoLocalTools, setNoLocalTools } from './tools/local-tools-guard';
import { getSidecarManager, setSidecarManagerRef } from './tools/sidecar-route';
import type { SidecarManager } from '../sidecar/manager';
import { withExecutionProgress, type ExecutionActivity } from './progress-context';
import { SidecarRPCError } from '../sidecar/rpc';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

async function localTool(name: string, params: Record<string, unknown>) {
  const manager = getSidecarManager(), disabled = isNoLocalTools();
  const registry = new ToolRegistry(), events: ExecutionActivity[] = [];
  registry.register(readFileTool); registry.register(runCommandTool);
  setSidecarManagerRef(null as unknown as SidecarManager); setNoLocalTools(false);
  try {
    const result = await withExecutionProgress(event => events.push(event), () => registry.execute(name, params));
    return { result, events };
  } finally { setSidecarManagerRef(manager as SidecarManager); setNoLocalTools(disabled); }
}

test.each(['Error handling guide', '[ERROR] is a log level', '[NOT RUN] is a literal example'])('real file contents cannot select a failed activity: %s', async content => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-progress-file-')); directories.push(directory);
  const path = join(directory, 'guide.txt'); writeFileSync(path, content);
  const { result, events } = await localTool('read_file', { path });
  expect(result).toBe(content);
  expect(events.map(event => event.phase)).toEqual(['started', 'completed']);
  expect(JSON.stringify(events)).not.toContain(content);
});

test('real missing file remains a failed activity with the original legacy return', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-progress-missing-')); directories.push(directory);
  const path = join(directory, 'missing.txt');
  const { result, events } = await localTool('read_file', { path });
  expect(result).toBe(`Error: File not found: ${path}`);
  expect(events.map(event => event.phase)).toEqual(['started', 'failed']);
});

test.each([0, 1])('real shell exit status %i decides progress, independent of output', async exitCode => {
  const { result, events } = await localTool('run_command', { command: `printf 'Error handling guide'; exit ${exitCode}` });
  expect(result).toBe(`Error handling guide${exitCode ? '\n[exit code: 1]' : ''}`);
  expect(events.map(event => event.phase)).toEqual(['started', exitCode ? 'failed' : 'completed']);
});

test('a silent nonzero shell exit is reported as failed', async () => {
  const { result, events } = await localTool('run_command', { command: 'exit 1' });
  expect(result).toBe('\n[exit code: 1]');
  expect(events.at(-1)?.phase).toBe('failed');
});

test('routed tool outcomes use the RPC failure and command receipt, never file contents', async () => {
  const previous = getSidecarManager(), registry = new ToolRegistry();
  registry.register(readFileTool); registry.register(runCommandTool);
  let reply: unknown = 'Error handling guide', failure = false;
  setSidecarManagerRef({
    listSidecars: () => [{ id: 'remote', name: 'Remote', connected: true, capabilities: ['filesystem', 'terminal'] }],
    dispatchRPC: async () => { if (failure) throw new SidecarRPCError('NOT_FOUND', 'PRIVATE path missing'); return reply; },
  } as unknown as SidecarManager);
  const call = async (name: string) => {
    const events: ExecutionActivity[] = [];
    const result = await withExecutionProgress(event => events.push(event), () => registry.execute(name, { target: 'remote', ...(name === 'read_file' ? { path: '/tmp/guide' } : { command: 'fixture' }) }));
    expect(JSON.stringify(events)).not.toContain('PRIVATE');
    return { result, phase: events.at(-1)?.phase };
  };
  try {
    expect(await call('read_file')).toEqual({ result: reply, phase: 'completed' });
    reply = { stdout: '', stderr: '', exit_code: 1 };
    expect(await call('run_command')).toEqual({ result: JSON.stringify(reply, null, 2), phase: 'failed' });
    reply = { stdout: 'Error handling guide', stderr: '', exit_code: 0 };
    expect(await call('run_command')).toEqual({ result: JSON.stringify(reply, null, 2), phase: 'completed' });
    // A receipt-shaped data value from a different method is still only data.
    reply = { error: 'PRIVATE', success: false, exit_code: 1 };
    expect(await call('read_file')).toEqual({ result: JSON.stringify(reply, null, 2), phase: 'completed' });
    failure = true;
    expect(await call('read_file')).toMatchObject({ phase: 'failed' });
  } finally { setSidecarManagerRef(previous as SidecarManager); }
});
