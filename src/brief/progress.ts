import type { ExecutionActivity } from '../actions/progress-context.ts';
import type { BriefActivity, BriefEvidenceRef } from './contracts.ts';

export const MAX_TURN_ACTIVITIES = 128;
type Labels = readonly [started: string, completed: string, failed: string];
const tools: Record<string, Labels> = {
  read_file: ['Reading a file.', 'File read finished.', 'File could not be read.'],
  list_directory: ['Listing files.', 'File listing finished.', 'Files could not be listed.'],
  web_search: ['Searching the web.', 'Web search finished.', 'Web search could not finish.'],
  browser_navigate: ['Opening a web page.', 'Page navigation finished.', 'Page could not be opened.'],
  browser_snapshot: ['Reading the web page.', 'Page read finished.', 'Page could not be read.'],
  run_command: ['Running a command.', 'Command returned.', 'Command could not finish.'],
  recall: ['Looking up saved context.', 'Context lookup finished.', 'Context lookup could not finish.'],
  query_memory: ['Looking up saved context.', 'Context lookup finished.', 'Context lookup could not finish.'],
};
const generic: Record<ExecutionActivity['kind'], Labels> = {
  tool: ['Running a tool.', 'Tool returned.', 'Tool could not finish.'],
  agent: ['Agent work started.', 'Agent work finished.', 'Agent work could not finish.'],
  task: ['Task started.', 'Task finished.', 'Task could not finish.'],
};
type Entry = { activity: BriefActivity; labels: Labels };

/** Per-turn projection. Labels never interpolate source text, including tool names. */
export class BriefProgressProjector {
  private entries = new Map<string, Entry>();
  constructor(private readonly resolveRef?: (ref: { kind: 'goal' | 'fact' | 'run'; id: string }) => BriefEvidenceRef | null) {}
  project(event: ExecutionActivity): BriefActivity | null {
    if (!event || !Object.hasOwn(generic, event.kind) || !['started', 'completed', 'failed'].includes(event.phase)
      || typeof event.executionId !== 'string' || !event.executionId.length || event.executionId.length > 256) return null;
    const key = `${event.kind}:${event.executionId}`;
    let entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= MAX_TURN_ACTIVITIES) return null;
      const labels = event.kind === 'tool' && typeof event.toolName === 'string' && Object.hasOwn(tools, event.toolName) ? tools[event.toolName]! : generic[event.kind];
      const refs: BriefEvidenceRef[] = [];
      for (const candidate of Array.isArray(event.refs) ? event.refs.slice(0, 4) : []) {
        if (!candidate || !['goal', 'fact', 'run'].includes(candidate.kind) || typeof candidate.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(candidate.id)) continue;
        try {
          const found = this.resolveRef?.(candidate);
          if (found?.kind === candidate.kind && found.id === candidate.id && !refs.some(ref => ref.kind === found.kind && ref.id === found.id)) refs.push({ kind: found.kind, id: found.id, revision: null });
        } catch { /* A missing reference never invents a link or leaks its lookup error. */ }
      }
      entry = { activity: { activityId: crypto.randomUUID(), kind: event.kind, order: this.entries.size + 1, phase: event.phase, summary: '', refs }, labels };
      this.entries.set(key, entry);
    } else if (entry.activity.phase !== 'started' || event.phase === 'started') return null;
    entry.activity = { ...entry.activity, phase: event.phase, summary: entry.labels[event.phase === 'started' ? 0 : event.phase === 'completed' ? 1 : 2] };
    return structuredClone(entry.activity);
  }
}
