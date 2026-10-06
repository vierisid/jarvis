/**
 * Parameter enums: advertised, emitted, and enforced.
 *
 * A JSON-Schema `enum` that only reaches the model is a hint. These tests
 * pin all three halves of the contract so they cannot drift apart:
 *
 *   1. `toolDefToLLMTool` emits the enum into the model-facing schema.
 *   2. `ToolRegistry.execute` REJECTS a value outside it, naming the allowed
 *      values, so an invented action is corrected instead of reaching the
 *      sidecar as an opaque failure.
 *   3. Each advertised value is one the tool's own implementation accepts.
 *
 * (3) is the one that matters most. `ui_act.verify` is advertised in the
 * schema and separately interpreted by `parsePostcondition`; nothing but a
 * test keeps those two lists equal, and an enum that advertises a value the
 * runtime rejects is worse than no enum at all.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ToolRegistry, type ToolDefinition } from './registry.ts';
import { toolDefToLLMTool } from './builtin.ts';
import { uiActTool, uiSnapshotTool, parsePostcondition } from './ui.ts';
import { desktopClickTool } from './desktop.ts';
import type { SemanticNode } from '../../structural/types.ts';
import type { LLMTool } from '../../llm/provider.ts';

/** The model-facing property map, typed for assertions. */
function propsOf(schema: LLMTool): Record<string, Record<string, unknown> | undefined> {
  return schema.parameters.properties as Record<string, Record<string, unknown> | undefined>;
}

function toolWith(params: ToolDefinition['parameters']): ToolDefinition {
  return {
    name: 'probe',
    description: 'probe tool',
    category: 'test',
    parameters: params,
    execute: async () => 'ok',
  };
}

const ENUM_PARAM = {
  mode: { type: 'string', description: 'the mode', required: false, enum: ['fast', 'slow'] },
} satisfies ToolDefinition['parameters'];

describe('enum emission into the model-facing schema', () => {
  test('toolDefToLLMTool copies enum onto the property', () => {
    const schema = toolDefToLLMTool(toolWith(ENUM_PARAM));
    const mode = propsOf(schema).mode!;
    // Fails if the emission in toolDefToLLMTool is removed.
    expect(mode.enum).toEqual(['fast', 'slow']);
    expect(mode.type).toBe('string');
    expect(mode.description).toBe('the mode');
  });

  test('a param with no enum gets no enum key at all', () => {
    const schema = toolDefToLLMTool(
      toolWith({ text: { type: 'string', description: 'free text', required: true } }),
    );
    expect('enum' in propsOf(schema).text!).toBe(false);
  });

  test('the real UI and desktop tools carry their enums through to the schema', () => {
    for (const [tool, param, expected] of [
      [uiSnapshotTool, 'kind', ['desktop', 'browser']],
      [uiActTool, 'action', uiActTool.parameters.action!.enum],
      [uiActTool, 'verify', uiActTool.parameters.verify!.enum],
      [desktopClickTool, 'action', desktopClickTool.parameters.action!.enum],
    ] as const) {
      const props = propsOf(toolDefToLLMTool(tool as ToolDefinition));
      expect(props[param]!.enum).toEqual(expected as string[]);
    }
  });
});

describe('enum enforcement at the execution boundary', () => {
  test('an in-enum value executes', async () => {
    const reg = new ToolRegistry();
    reg.register(toolWith(ENUM_PARAM));
    expect(await reg.execute('probe', { mode: 'fast' })).toBe('ok');
  });

  test('an out-of-enum value is rejected and the error names the allowed values', async () => {
    const reg = new ToolRegistry();
    reg.register(toolWith(ENUM_PARAM));
    // The orchestrator turns this throw into the tool result the model reads.
    await expect(reg.execute('probe', { mode: 'sideways' })).rejects.toThrow(
      /must be one of: fast, slow \(got "sideways"\)/,
    );
  });

  test('an omitted optional enum param is still fine', async () => {
    const reg = new ToolRegistry();
    reg.register(toolWith(ENUM_PARAM));
    expect(await reg.execute('probe', {})).toBe('ok');
  });

  test('matching is case-insensitive, so callers that already worked keep working', async () => {
    const reg = new ToolRegistry();
    reg.register(toolWith(ENUM_PARAM));
    expect(await reg.execute('probe', { mode: 'FAST' })).toBe('ok');
  });

  test('the value reaches the tool unchanged - validation narrows, it does not normalise', async () => {
    const reg = new ToolRegistry();
    let seen: unknown;
    reg.register({
      ...toolWith(ENUM_PARAM),
      execute: async (params) => {
        seen = params.mode;
        return 'ok';
      },
    });
    await reg.execute('probe', { mode: 'FAST' });
    expect(seen).toBe('FAST');
  });

  test('desktop_click rejects an invented action', async () => {
    const reg = new ToolRegistry();
    reg.register(desktopClickTool);
    // element_id is required; the point is that the enum check fires on a
    // call that is otherwise well-formed, before anything is dispatched.
    await expect(reg.execute('desktop_click', { element_id: 1, action: 'press_and_pray' })).rejects.toThrow(
      /must be one of: click, double_click/,
    );
  });
});

describe('enum declarations are checked at registration', () => {
  test('an enum on a non-string param is a definition error, not a silent no-op', () => {
    const reg = new ToolRegistry();
    expect(() =>
      reg.register(
        toolWith({ n: { type: 'number', description: 'count', required: false, enum: ['1', '2'] } }),
      ),
    ).toThrow(/declares an enum but is type 'number'/);
  });

  test('an empty enum is a definition error', () => {
    const reg = new ToolRegistry();
    expect(() =>
      reg.register(toolWith({ m: { type: 'string', description: 'm', required: false, enum: [] } })),
    ).toThrow(/empty enum/);
  });
});

describe('advertised values match what the implementation accepts', () => {
  const node = {
    ref: { role: 'button', name: 'Save', path: [] },
    role: 'button',
    name: 'Save',
  } as unknown as SemanticNode;

  test('every ui_act verify value is one parsePostcondition understands', () => {
    const advertised = uiActTool.parameters.verify!.enum!;
    expect(advertised.length).toBeGreaterThan(0);
    for (const v of advertised) {
      // A string return is parsePostcondition's error channel; a rejected
      // value here would mean the schema advertises something the runtime
      // refuses. value_equals needs its companion value parameter.
      const pc = parsePostcondition(v, node, 'before title', 'expected text');
      expect(typeof pc).not.toBe('string');
      expect(pc).not.toBeNull();
      expect((pc as { kind: string }).kind).toBe(v);
    }
  });

  test('parsePostcondition rejects a value outside the advertised set', () => {
    const advertised = new Set(uiActTool.parameters.verify!.enum!);
    expect(advertised.has('element_settled')).toBe(false);
    expect(typeof parsePostcondition('element_settled', node, undefined, undefined)).toBe('string');
  });

  test('ui_act does not advertise get_text, which the sidecar rejects', () => {
    // Removed when the structural runtime landed; a stale re-application of
    // the enum work would quietly put it back.
    expect(uiActTool.parameters.action!.enum).not.toContain('get_text');
  });

  test('the browser-supported ui_act actions are a subset of the advertised ones', () => {
    const advertised = new Set(uiActTool.parameters.action!.enum!);
    // Mirrors BROWSER_ACTIONS / READ_ONLY_ACTIONS in ui.ts, which gate the
    // same parameter further down.
    for (const a of ['click', 'set_value', 'get_value']) {
      expect(advertised.has(a)).toBe(true);
    }
  });

  /**
   * desktop_click's enum against the sidecar's three dispatchers (#657).
   *
   * The enum is a gate (ToolRegistry enforces it), and the accepted set lives in
   * Go with no shared definition, so the two drifted in BOTH directions with
   * nothing to notice: the enum advertised `get_text`, which no platform's
   * switch has a case for, so every call was a guaranteed error. Parsed out of
   * the Go rather than copied, the way linux.test.ts reads the key tables, so a
   * case added or removed on either side fails here.
   *
   * Each platform's `default:` arm also prints a "supported:" list for the
   * model, and that list is pinned to the same switch -- Windows' omitted
   * `get_text` too, which is how the drift was visible in the first place.
   */
  test('every desktop_click action is one some sidecar dispatches, and every dispatched one is advertised', () => {
    // Linux and macOS share one clickElement since #712.
    const dispatchers = [
      ['uia_actions_windows.go', 'uiaPerformAction'],
      ['desktop_element_action.go', 'clickElement'],
    ] as const;
    const accepted = new Set<string>();
    for (const [file, fn] of dispatchers) {
      const source = readFileSync(new URL(`../../../sidecar/${file}`, import.meta.url), 'utf-8');
      const start = source.indexOf(`func ${fn}(`);
      expect(start).toBeGreaterThanOrEqual(0);
      const body = source.slice(start, source.indexOf('\n}\n', start));
      const switchAt = body.indexOf('switch action {');
      expect(switchAt).toBeGreaterThanOrEqual(0);
      const arms = body.slice(switchAt);
      const cases = [...arms.matchAll(/^\s*case ((?:"[a-z_]+",?\s*)+):\s*$/gm)]
        .flatMap(m => [...m[1]!.matchAll(/"([a-z_]+)"/g)].map(c => c[1]!));
      expect(cases.length).toBeGreaterThan(0);
      for (const c of cases) accepted.add(c);
      const supported = /supported: ([a-z_, ]+)\)/.exec(arms);
      expect(supported).not.toBeNull();
      expect(supported![1]!.split(', ').sort()).toEqual([...cases].sort());
    }
    expect([...desktopClickTool.parameters.action!.enum!].sort()).toEqual([...accepted].sort());
    expect(desktopClickTool.parameters.action!.enum).not.toContain('get_text');
    expect(desktopClickTool.parameters.action!.description).not.toContain('get_text');
  });

  test('ui_snapshot kind matches the capture kinds the surface layer takes', () => {
    expect(uiSnapshotTool.parameters.kind!.enum).toEqual(['desktop', 'browser']);
  });
});
