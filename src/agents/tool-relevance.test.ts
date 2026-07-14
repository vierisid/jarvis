import { describe, expect, it } from 'bun:test';
import { selectRelevantTools } from './tool-relevance.ts';
import type { LLMTool } from '../llm/provider.ts';

const T = (name: string): LLMTool => ({ name, description: name, parameters: { type: 'object', properties: {}, required: [] } });

const ALL: LLMTool[] = [
  // always
  'run_command', 'read_file', 'write_file', 'list_directory', 'get_clipboard',
  'set_clipboard', 'get_system_info', 'list_sidecars', 'ask_for_clarification', 'request_approval',
  // control
  'desktop_launch_app', 'desktop_snapshot', 'desktop_click', 'desktop_type',
  'browser_navigate', 'browser_ax_snapshot', 'ui_snapshot', 'ui_act', 'capture_screen',
  // other groups
  'manage_workflow', 'manage_goals', 'commitments', 'research_queue', 'create_document',
  'content_pipeline', 'delegate_task', 'manage_agents',
].map(T);

const names = (tools: LLMTool[]) => tools.map((t) => t.name);

describe('selectRelevantTools', () => {
  it('keeps only control + always tools for a desktop task', () => {
    const got = names(selectRelevantTools(ALL, 'open notepad and type hello'));
    expect(got).toContain('desktop_launch_app');
    expect(got).toContain('ui_act');
    expect(got).toContain('run_command'); // always
    expect(got).not.toContain('manage_workflow');
    expect(got).not.toContain('manage_goals');
    expect(got).not.toContain('delegate_task');
  });

  it('never ships a partial control surface — desktop task keeps browser+ui too', () => {
    const got = names(selectRelevantTools(ALL, 'click the Save button in the app'));
    // control group spans desktop/browser/ui so refs across them never dangle
    expect(got).toContain('browser_ax_snapshot');
    expect(got).toContain('ui_snapshot');
  });

  it('selects the workflow group for automation asks', () => {
    const got = names(selectRelevantTools(ALL, 'make a workflow that emails me every morning'));
    expect(got).toContain('manage_workflow');
    expect(got).not.toContain('desktop_click');
  });

  it('fails open on an ambiguous message (returns everything)', () => {
    const got = selectRelevantTools(ALL, 'what do you think about that?');
    expect(got.length).toBe(ALL.length);
  });

  it('fails open on an empty message', () => {
    expect(selectRelevantTools(ALL, '').length).toBe(ALL.length);
  });

  it('never drops always-tools or unknown/ungrouped tools', () => {
    const withUnknown = [...ALL, T('some_new_tool')];
    const got = names(selectRelevantTools(withUnknown, 'launch chrome'));
    expect(got).toContain('some_new_tool'); // ungrouped → kept
    expect(got).toContain('request_approval'); // always → kept
  });

  it('respects enabled:false (returns everything unchanged)', () => {
    const got = selectRelevantTools(ALL, 'open notepad', { enabled: false });
    expect(got.length).toBe(ALL.length);
  });

  it('combines multiple matched groups', () => {
    const got = names(selectRelevantTools(ALL, 'open the app and set a goal for it'));
    expect(got).toContain('desktop_launch_app');
    expect(got).toContain('manage_goals');
  });
});
