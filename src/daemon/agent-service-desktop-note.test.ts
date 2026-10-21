/**
 * #905: the cached tool guide documents the desktop tools whatever the
 * setting, so with desktop.enabled off the per-turn (dynamic) half of every
 * system prompt says they are not available. The static half -- the provider
 * cache prefix -- must not change either way.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { initDatabase, closeDb } from '../vault/schema';
import { AgentService } from './agent-service';
import { setDesktopEnabledSource } from '../actions/tools/desktop-guard';
import type { JarvisConfig } from '../config/types';
import type { RoleDefinition } from '../roles/types';

const role = { id: 'fixture', name: 'Fixture', description: 'Test only', responsibilities: [], autonomous_actions: [], approval_required: [],
  authority_level: 5, tools: [], sub_roles: [], kpis: [] } as unknown as RoleDefinition;

let desktopOn = true;
beforeEach(() => { desktopOn = true; setDesktopEnabledSource(() => desktopOn); initDatabase(':memory:', { quiet: true }); });
afterEach(() => { setDesktopEnabledSource(null); closeDb(); });

test('the dynamic prompt says desktop control is off only while it is, and the static half never moves', () => {
  const service = new AgentService({} as JarvisConfig);
  Object.assign(service, { role });
  const on = service.buildFullSystemPromptParts('websocket', 'hello');
  expect(on.dynamic).not.toContain('Desktop control is off');
  desktopOn = false;
  const off = service.buildFullSystemPromptParts('websocket', 'hello');
  expect(off.dynamic).toContain('# Desktop control is off');
  expect(off.static).toBe(on.static);
});
