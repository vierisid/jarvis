import { describe, expect, test } from 'bun:test';
import { matchWindowControl } from './window-control.ts';

describe('matchWindowControl — close action', () => {
  test('bare imperatives match with most_recent target', () => {
    expect(matchWindowControl('close')).toEqual({ action: 'close', target: 'most_recent' });
    expect(matchWindowControl('shut')).toEqual({ action: 'close', target: 'most_recent' });
    expect(matchWindowControl('dismiss')).toEqual({ action: 'close', target: 'most_recent' });
    expect(matchWindowControl('hide')).toEqual({ action: 'close', target: 'most_recent' });
  });

  test('targets a specific room when named', () => {
    expect(matchWindowControl('close the tools room')).toEqual({ action: 'close', target: 'tools' });
    expect(matchWindowControl('shut the workflows')).toEqual({ action: 'close', target: 'workflows' });
    expect(matchWindowControl('hide the memory window')).toEqual({ action: 'close', target: 'memory' });
  });

  test('respects polite leading phrases', () => {
    expect(matchWindowControl('please close it')).toEqual({ action: 'close', target: 'most_recent' });
    expect(matchWindowControl('can you close')).toEqual({ action: 'close', target: 'most_recent' });
    expect(matchWindowControl('could you shut the goals')).toEqual({ action: 'close', target: 'goals' });
  });
});

describe('matchWindowControl — minimize action', () => {
  test('matches "minimize" / "minimise" / "shrink" / "collapse"', () => {
    expect(matchWindowControl('minimize')?.action).toBe('minimize');
    expect(matchWindowControl('minimise')?.action).toBe('minimize');
    expect(matchWindowControl('shrink')?.action).toBe('minimize');
    expect(matchWindowControl('collapse')?.action).toBe('minimize');
  });

  test('with target', () => {
    expect(matchWindowControl('minimize the workflows')).toEqual({ action: 'minimize', target: 'workflows' });
    expect(matchWindowControl('shrink tools')).toEqual({ action: 'minimize', target: 'tools' });
  });
});

describe('matchWindowControl — expand action', () => {
  test('matches "expand" / "maximize" / "fullscreen"', () => {
    expect(matchWindowControl('expand')?.action).toBe('expand');
    expect(matchWindowControl('maximize')?.action).toBe('expand');
    expect(matchWindowControl('maximise')?.action).toBe('expand');
    expect(matchWindowControl('fullscreen')?.action).toBe('expand');
    expect(matchWindowControl('full screen')?.action).toBe('expand');
    expect(matchWindowControl('full-screen')?.action).toBe('expand');
  });

  test('with target', () => {
    expect(matchWindowControl('maximize tools please')).toEqual({ action: 'expand', target: 'tools' });
    expect(matchWindowControl('expand the calendar')).toEqual({ action: 'expand', target: 'calendar' });
  });
});

describe('matchWindowControl — restore action', () => {
  test('matches "restore" / "unminimize" / "reopen" / "bring back"', () => {
    expect(matchWindowControl('restore')?.action).toBe('restore');
    expect(matchWindowControl('unminimize')?.action).toBe('restore');
    expect(matchWindowControl('reopen')?.action).toBe('restore');
    expect(matchWindowControl('bring back')?.action).toBe('restore');
  });

  test('with target', () => {
    expect(matchWindowControl('restore the memory window')).toEqual({ action: 'restore', target: 'memory' });
  });
});

describe('matchWindowControl — reorder action (global; target ignored)', () => {
  test('matches "reorder" / "tidy [up]" / "reset layout"', () => {
    expect(matchWindowControl('reorder')?.action).toBe('reorder');
    expect(matchWindowControl('tidy up')?.action).toBe('reorder');
    expect(matchWindowControl('tidy')?.action).toBe('reorder');
    expect(matchWindowControl('reset layout')?.action).toBe('reorder');
    expect(matchWindowControl('reset the layout')?.action).toBe('reorder');
  });

  test('matches "inline all" / "bring everything back"', () => {
    expect(matchWindowControl('inline all')?.action).toBe('reorder');
    expect(matchWindowControl('inline everything')?.action).toBe('reorder');
    expect(matchWindowControl('bring all back')?.action).toBe('reorder');
    expect(matchWindowControl('bring everything back')?.action).toBe('reorder');
  });

  test('reorder always returns most_recent target (it is global)', () => {
    expect(matchWindowControl('reorder')?.target).toBe('most_recent');
    // Even if a room is named, reorder ignores it. (Phase 6.1.6 behavior.)
  });
});

describe('matchWindowControl — fall-through cases (must return null so classifier handles them)', () => {
  test('utterances that open rooms are NOT window controls', () => {
    expect(matchWindowControl('open the tools room')).toBeNull();
    expect(matchWindowControl('show me workflows')).toBeNull();
    expect(matchWindowControl('go to settings')).toBeNull();
  });

  test('"back to thread" navigation is not a window control', () => {
    expect(matchWindowControl('back to the thread')).toBeNull();
    expect(matchWindowControl('home view')).toBeNull();
  });

  test('long sentences fall through (over 8 words)', () => {
    expect(matchWindowControl('I want to close the email and reply quickly')).toBeNull();
    expect(matchWindowControl('please close the tools room when you have a chance')).toBeNull();
  });

  test('verb-buried-in-the-middle does not match (verbs must be near the start)', () => {
    expect(matchWindowControl('the workflows room close')).toBeNull();
  });

  test('empty / whitespace-only input', () => {
    expect(matchWindowControl('')).toBeNull();
    expect(matchWindowControl('   ')).toBeNull();
    expect(matchWindowControl('.,!?')).toBeNull();
  });

  test('non-matching verbs', () => {
    expect(matchWindowControl('jump on the tools')).toBeNull();
    expect(matchWindowControl('explain workflows')).toBeNull();
  });
});

describe('matchWindowControl — room aliases', () => {
  test('singular and plural both map to the canonical RoomKey', () => {
    expect(matchWindowControl('close tool')?.target).toBe('tools');
    expect(matchWindowControl('close tools')?.target).toBe('tools');
    expect(matchWindowControl('close goal')?.target).toBe('goals');
    expect(matchWindowControl('close goals')?.target).toBe('goals');
    expect(matchWindowControl('close project')?.target).toBe('workspaces');
    expect(matchWindowControl('close projects')?.target).toBe('workspaces');
    expect(matchWindowControl('close setting')?.target).toBe('settings');
    expect(matchWindowControl('close settings')?.target).toBe('settings');
  });

  test('alias matching respects word boundaries (no substring match)', () => {
    // "logbook" should NOT trigger the "log" alias.
    const result = matchWindowControl('close logbook');
    // The action matches but no room alias hits "logbook" → most_recent.
    expect(result?.action).toBe('close');
    expect(result?.target).toBe('most_recent');
  });

  test('case-insensitive normalization', () => {
    expect(matchWindowControl('CLOSE')?.action).toBe('close');
    expect(matchWindowControl('Close The Tools')?.target).toBe('tools');
  });

  test('punctuation is collapsed to whitespace before matching', () => {
    expect(matchWindowControl('close, please.')).toEqual({ action: 'close', target: 'most_recent' });
    expect(matchWindowControl('close!')).toEqual({ action: 'close', target: 'most_recent' });
  });
});
