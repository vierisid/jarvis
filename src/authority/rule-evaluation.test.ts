/**
 * How Authority reads its rules: a window that crosses midnight applies, a
 * deny beats an allow whatever the order, and the policy API refuses values
 * the engine would only clamp.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { closeDb, initDatabase } from '../vault/schema.ts';
import { AuthorityEngine, timeRangeMatches, type AuthorityConfig, type ContextRule } from './engine.ts';
import { authorityConfigPatchError, authorityConfigWarnings, backgroundPatchError, contextRuleParamsError, quickOverrideError } from './config-validation.ts';
import { getCronTimezone, ownerWallClockHour, setCronTimezone } from '../lib/cron-scheduler.ts';
import { createApiRoutes, type ApiContext } from '../daemon/api-routes.ts';

beforeEach(() => initDatabase(':memory:', { quiet: true }));
afterEach(() => closeDb());

function config(overrides: Partial<AuthorityConfig> = {}): AuthorityConfig {
  return { default_level: 10, governed_categories: [], overrides: [], context_rules: [],
    learning: { enabled: false, suggest_threshold: 5 }, emergency_state: 'normal', ...overrides };
}
const rule = (id: string, effect: ContextRule['effect'], extra: Partial<ContextRule> = {}): ContextRule =>
  ({ id, action: 'send_email', condition: 'always', params: {}, effect, description: id, ...extra });
const check = (engine: AuthorityEngine, roleId = 'r') => engine.checkAuthority({ agentId: 'a', agentAuthorityLevel: 10, agentRoleId: roleId,
  toolName: 'send_email', toolCategory: 'email', actionCategory: 'send_email', temporaryGrants: new Map() });

describe('a time window that crosses midnight', () => {
  test('start 15 end 14 covers every hour but 14, start 15 end 0 covers 15 to 23, start 22 end 6 covers the night', () => {
    const hours = (start: number, end: number) => [...Array(24).keys()].filter(h => timeRangeMatches(h, { start_hour: start, end_hour: end }));
    expect(hours(15, 14)).toEqual([...Array(24).keys()].filter(h => h !== 14));
    expect(hours(15, 0)).toEqual([15, 16, 17, 18, 19, 20, 21, 22, 23]);
    expect(hours(22, 6)).toEqual([0, 1, 2, 3, 4, 5, 22, 23]);
    expect(hours(9, 17)).toEqual([9, 10, 11, 12, 13, 14, 15, 16]);
    expect(hours(5, 5)).toEqual([]);
    expect(hours(0, 24)).toHaveLength(24);
  });

  test('a saved hour the API now refuses is read exactly as before windows could wrap, so an upgrade never widens it', () => {
    // The old test was `hour >= (start ?? 0) && hour < (end ?? 24)` on the raw values.
    const old = (h: number, p: Record<string, unknown>) => h >= ((p.start_hour ?? 0) as number) && h < ((p.end_hour ?? 24) as number);
    for (const params of [
      { start_hour: 'soon' }, { start_hour: 'soon', end_hour: null }, { end_hour: {} },
      { start_hour: '9', end_hour: '17' }, { start_hour: 22.5 }, { end_hour: 6.5 }, { start_hour: 9.2, end_hour: 16.1 },
      { start_hour: -4, end_hour: 99 }, { start_hour: 30 }, { start_hour: 30, end_hour: 6 }, { start_hour: 23.5, end_hour: 2 },
      { start_hour: 5, end_hour: -3 }, { start_hour: null, end_hour: null }, { start_hour: '' },
    ]) {
      for (let h = 0; h < 24; h++) expect([JSON.stringify(params), h, timeRangeMatches(h, params)]).toEqual([JSON.stringify(params), h, old(h, params)]);
    }
  });

  test('a deny rule whose window wraps past the current hour blocks the action, at every hour of the day', () => {
    for (let hour = 0; hour < 24; hour++) {
      // Starts this hour and ends the hour before: wraps (except at 0), and includes the current hour.
      const engine = new AuthorityEngine(config({ context_rules: [rule('night', 'deny', { condition: 'time_range', params: { start_hour: hour, end_hour: (hour + 23) % 24 } })] }), { currentHour: () => hour });
      expect(check(engine)).toMatchObject({ allowed: false, contextRule: 'night' });
    }
  });

  test('boundaries: the start hour is in the window, the end hour is not', () => {
    const night = rule('night', 'deny', { condition: 'time_range', params: { start_hour: 22, end_hour: 6 } });
    const at = (hour: number) => check(new AuthorityEngine(config({ context_rules: [night] }), { currentHour: () => hour })).allowed;
    expect([21, 22, 23, 0, 5, 6].map(at)).toEqual([true, false, false, false, false, true]);
  });
});

describe('the hour is read on the owner\'s clock', () => {
  test('a configured zone decides the hour, not the machine', () => {
    const instant = new Date('2026-07-01T02:30:00Z');
    expect(ownerWallClockHour(instant, 'UTC')).toBe(2);
    expect(ownerWallClockHour(instant, 'America/New_York')).toBe(22);
    expect(ownerWallClockHour(instant, 'Asia/Kolkata')).toBe(8);
  });

  test('the engine reads the configured zone by default', () => {
    const saved = getCronTimezone();
    // A zone 14 hours from UTC, so it differs from this machine's for most hours of most machines.
    setCronTimezone('Pacific/Kiritimati');
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const hour = ownerWallClockHour(new Date());
        const only = rule('only', 'deny', { condition: 'time_range', params: { start_hour: hour, end_hour: hour + 1 } });
        const decision = check(new AuthorityEngine(config({ context_rules: [only] })));
        if (ownerWallClockHour(new Date()) !== hour) continue; // the hour turned mid-check
        expect(decision).toMatchObject({ allowed: false, contextRule: 'only' });
        return;
      }
      throw new Error('hour kept turning');
    } finally {
      setCronTimezone(saved);
    }
  });

  test('spring forward: the skipped hour never shows, the window resumes on the next real hour', () => {
    // 2026-03-08 in New York: 01:59 EST is followed by 03:00 EDT.
    const before = new Date('2026-03-08T06:59:00Z'), after = new Date('2026-03-08T07:00:00Z');
    expect([ownerWallClockHour(before, 'America/New_York'), ownerWallClockHour(after, 'America/New_York')]).toEqual([1, 3]);
    // A deny window 1 to 3 covers 01:00 to 01:59, then ends at the jump.
    expect(timeRangeMatches(ownerWallClockHour(before, 'America/New_York'), { start_hour: 1, end_hour: 3 })).toBe(true);
    expect(timeRangeMatches(ownerWallClockHour(after, 'America/New_York'), { start_hour: 1, end_hour: 3 })).toBe(false);
  });

  test('fall back: the repeated hour is in the window both times', () => {
    // 2026-11-01 in New York: 01:00 to 01:59 runs twice, EDT then EST.
    const first = new Date('2026-11-01T05:30:00Z'), second = new Date('2026-11-01T06:30:00Z');
    expect([ownerWallClockHour(first, 'America/New_York'), ownerWallClockHour(second, 'America/New_York')]).toEqual([1, 1]);
    expect(timeRangeMatches(1, { start_hour: 23, end_hour: 2 })).toBe(true);
  });
});

describe('the rest of the window rules', () => {
});

describe('a deny wins over an allow, whatever the order', () => {
  test('two always rules: allow then deny and deny then allow are both denied', () => {
    expect(check(new AuthorityEngine(config({ context_rules: [rule('yes', 'allow'), rule('no', 'deny')] })))).toMatchObject({ allowed: false, contextRule: 'no' });
    expect(check(new AuthorityEngine(config({ context_rules: [rule('no', 'deny'), rule('yes', 'allow')] })))).toMatchObject({ allowed: false, contextRule: 'no' });
  });

  test('a rule that asks beats a rule that allows, either way round', () => {
    for (const rules of [[rule('yes', 'allow'), rule('ask', 'require_approval')], [rule('ask', 'require_approval'), rule('yes', 'allow')]]) {
      expect(check(new AuthorityEngine(config({ context_rules: rules })))).toMatchObject({ allowed: true, requiresApproval: true, contextRule: 'ask' });
    }
  });

  test('an always-allow override, global or for the role, does not beat a matching deny rule', () => {
    const deny = rule('no', 'deny');
    expect(check(new AuthorityEngine(config({ overrides: [{ action: 'send_email', allowed: true }], context_rules: [deny] })))).toMatchObject({ allowed: false, contextRule: 'no' });
    expect(check(new AuthorityEngine(config({ overrides: [{ action: 'send_email', allowed: true, role_id: 'r' }], context_rules: [deny] })))).toMatchObject({ allowed: false, contextRule: 'no' });
  });

  test('a deny override still beats an allow rule, and an allow override still skips the governed switch', () => {
    expect(check(new AuthorityEngine(config({ overrides: [{ action: 'send_email', allowed: false }], context_rules: [rule('yes', 'allow')] })))).toMatchObject({ allowed: false });
    expect(check(new AuthorityEngine(config({ governed_categories: ['send_email'], overrides: [{ action: 'send_email', allowed: true }] })))).toMatchObject({ allowed: true, requiresApproval: false });
  });

  test('a rule for another action or a window that is not open changes nothing', () => {
    const closed = rule('later', 'deny', { condition: 'time_range', params: { start_hour: 14, end_hour: 15 } });
    expect(check(new AuthorityEngine(config({ context_rules: [closed, rule('other', 'deny', { action: 'write_data' })] }), { currentHour: () => 13 }))).toMatchObject({ allowed: true });
  });

  test('a deny rule over the open window beats an allow rule over the whole day, and a role override, either order', () => {
    const day = rule('day', 'allow', { condition: 'time_range', params: { start_hour: 0, end_hour: 24 } });
    const night = rule('night', 'deny', { condition: 'time_range', params: { start_hour: 22, end_hour: 6 } });
    for (const rules of [[day, night], [night, day]]) {
      const engine = (hour: number) => new AuthorityEngine(config({ overrides: [{ action: 'send_email', allowed: true, role_id: 'r' }], context_rules: rules }), { currentHour: () => hour });
      expect(check(engine(23))).toMatchObject({ allowed: false, contextRule: 'night' });
      expect(check(engine(12))).toMatchObject({ allowed: true, requiresApproval: false });
    }
  });
});

describe('the policy API refuses what the engine would only clamp', () => {
  test('context rule hours must be whole hours', () => {
    expect(contextRuleParamsError({ condition: 'time_range', params: { start_hour: 15, end_hour: 0 } })).toBeNull();
    expect(contextRuleParamsError({ condition: 'time_range', params: { start_hour: 24 } })).toContain('start_hour');
    expect(contextRuleParamsError({ condition: 'time_range', params: { start_hour: 1.5 } })).toContain('start_hour');
    expect(contextRuleParamsError({ condition: 'time_range', params: { end_hour: -1 } })).toContain('end_hour');
    expect(contextRuleParamsError({ condition: 'time_range', params: { end_hour: '9' } })).toContain('end_hour');
    expect(contextRuleParamsError({ condition: 'tool_name', params: { tool_name: 5 } })).toContain('tool_name');
    expect(contextRuleParamsError({ condition: 'tool_name', params: {} })).toContain('tool_name');
    expect(contextRuleParamsError({ condition: 'tool_name', params: { tool_name: '  ' } })).toContain('tool_name');
    expect(contextRuleParamsError({ condition: 'time_range', params: { start_hour: 5, end_hour: 5 } })).toContain('covers no hour');
    expect(contextRuleParamsError({ condition: 'time_range', params: { end_hour: 0 } })).toContain('covers no hour');
    expect(contextRuleParamsError({ condition: 'time_range', params: { start_hour: 0, end_hour: 24 } })).toBeNull();
    expect(contextRuleParamsError({ condition: 'time_range', params: {} })).toBeNull();
  });

  test('a saved allow rule that crosses midnight, dormant before this change, is reported', () => {
    const wrapped = (effect: ContextRule['effect']) => rule(`w-${effect}`, effect, { condition: 'time_range', params: { start_hour: 22, end_hour: 6 } });
    const warnings = authorityConfigWarnings({ context_rules: [wrapped('allow'), wrapped('require_approval'), wrapped('deny'), rule('flat', 'allow', { condition: 'time_range', params: { start_hour: 9, end_hour: 17 } })] });
    expect(warnings).toEqual([expect.stringContaining('"w-allow" (allow) crosses midnight'), expect.stringContaining('"w-require_approval" (require_approval) crosses midnight')]);
  });

  test('an override saved unchanged is not refused again either', () => {
    const old = { action: 'send_email', allowed: true, role_id: 5 };
    expect(authorityConfigPatchError({ overrides: [old] })).toContain('override');
    expect(authorityConfigPatchError({ overrides: [old] }, { overrides: [old] })).toBeNull();
    expect(authorityConfigPatchError({ overrides: [{ ...old, role_id: 6 }] }, { overrides: [old] })).toContain('override');
  });

  test('a rule saved unchanged is not refused again, so an old bad rule never blocks other edits', () => {
    const old = { id: 'old', action: 'send_email', condition: 'time_range', effect: 'deny', description: 'old', params: { start_hour: 30 } };
    expect(authorityConfigPatchError({ context_rules: [old] })).toContain('start_hour');
    expect(authorityConfigPatchError({ context_rules: [old] }, { context_rules: [old] })).toBeNull();
    expect(authorityConfigWarnings({ context_rules: [old] })).toEqual([expect.stringContaining('Context rule "old"')]);
  });

  test('background categories and level cap are checked, quick override role ids are role names', () => {
    expect(backgroundPatchError({ governed_categories: ['nonsense'] })).toContain('governed_categories');
    expect(backgroundPatchError({ level_cap: 99 })).toContain('level_cap');
    expect(backgroundPatchError({ level_cap: -5 })).toContain('level_cap');
    expect(backgroundPatchError({ level_cap: 4, governed_categories: ['send_email'] })).toBeNull();
    expect(quickOverrideError({ role_id: 5 })).toContain('role_id');
    expect(quickOverrideError({ role_id: { a: 1 } })).toContain('role_id');
    expect(quickOverrideError({ role_id: 'workflow-default' })).toBeNull();
    expect(quickOverrideError({})).toBeNull();
  });

  test('the routes answer 400 with a plain message and change nothing', async () => {
    const authority = new AuthorityEngine(config({ default_level: 3 }));
    const appConfig = { authority: { default_level: 3 } } as Record<string, any>;
    const routes = createApiRoutes({ config: appConfig, agentService: {}, authorityEngine: authority } as unknown as ApiContext) as Record<string, Record<string, (req: Request) => Promise<Response>>>;
    const post = (path: string, body: unknown) => routes[path]!.POST!(new Request(`http://localhost${path}`, {
      method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }));
    for (const body of [
      { context_rules: [{ id: 'x', action: 'send_email', condition: 'time_range', effect: 'deny', description: 'd', params: { start_hour: 99 } }] },
      { background: { governed_categories: ['nonsense'] } },
      { background: { level_cap: 99 } },
      { background: { level_cap: -5 } },
    ]) {
      const response = await post('/api/authority/config', body);
      expect(response.status).toBe(400);
      expect(String((await response.json() as { error: string }).error)).not.toContain('Invalid request body');
    }
    expect(authority.getConfig().context_rules).toEqual([]);
    expect(appConfig.authority.background).toBeUndefined();
    const quick = await post('/api/authority/config/quick-override', { action: 'send_email', allow: true, role_id: 5 });
    expect(quick.status).toBe(400);
    expect(authority.getConfig().overrides).toEqual([]);
    expect((await post('/api/authority/config/quick-override', { action: 'send_email', allow: true, role_id: 'workflow-default' })).status).toBe(200);
    expect((await post('/api/authority/config', { context_rules: [{ id: 'night', action: 'send_email', condition: 'time_range', effect: 'deny', description: 'd', params: { start_hour: 15, end_hour: 0 } }] })).status).toBe(200);
  });
});
