import { describe, expect, it } from 'bun:test';
import { resolveRef, pathSimilarity, fuzzyNameScore } from './resolver.ts';
import { semanticNodeFromUia, surfaceFromUia } from './types.ts';
import type { SemanticNode, SemanticRef, UiaSemanticElement } from './types.ts';

function node(partial: {
  role: string;
  name: string;
  stableId?: string;
  path?: Array<{ role: string; name?: string }>;
  ordinal?: number;
  sig?: string;
  sessionId?: number;
}): SemanticNode {
  return {
    ref: {
      role: partial.role,
      name: partial.name,
      stableId: partial.stableId,
      path: partial.path ?? [],
      ordinal: partial.ordinal ?? 0,
      sig: partial.sig ?? '',
    },
    role: partial.role,
    name: partial.name,
    value: null,
    state: { enabled: true },
    bounds: null,
    actions: ['click'],
    sessionId: partial.sessionId ?? 1,
  };
}

function ref(partial: Partial<SemanticRef> & { role: string; name: string }): SemanticRef {
  return {
    stableId: undefined,
    path: [],
    ordinal: 0,
    sig: '',
    ...partial,
  };
}

const GMAIL_PATH = [
  { role: 'Window', name: 'Inbox - Gmail' },
  { role: 'Document' },
  { role: 'Group', name: 'Compose' },
];

describe('resolveRef scoring ladder', () => {
  it('sig identity wins outright at 1.0', () => {
    const target = node({ role: 'Button', name: 'Send', sig: 'abc123', sessionId: 7 });
    const decoy = node({ role: 'Button', name: 'Send', sig: 'zzz999', sessionId: 8 });
    const res = resolveRef(ref({ role: 'Button', name: 'Send', sig: 'abc123' }), [decoy, target]);
    expect(res.method).toBe('sig');
    expect(res.confidence).toBe(1.0);
    expect(res.node?.sessionId).toBe(7);
  });

  it('stableId + role resolves at 1.0 even when the name changed', () => {
    const target = node({ role: 'Button', name: 'Send now', stableId: 'sendBtn', sessionId: 3 });
    const res = resolveRef(
      ref({ role: 'Button', name: 'Send', stableId: 'sendBtn', sig: 'old-sig' }),
      [node({ role: 'Button', name: 'Send' }), target],
    );
    expect(res.method).toBe('stableId');
    expect(res.node?.sessionId).toBe(3);
  });

  it('path+name survives id churn and window-title drift', () => {
    const stored = ref({
      role: 'Button', name: 'Send', sig: 'gone',
      path: GMAIL_PATH, ordinal: 0,
    });
    const live = node({
      role: 'Button', name: 'Send', sig: 'different-now',
      path: [
        { role: 'Window', name: 'Re: hello - Gmail' }, // title changed
        { role: 'Document' },
        { role: 'Group', name: 'Compose' },
      ],
      sessionId: 42,
    });
    const res = resolveRef(stored, [live, node({ role: 'Button', name: 'Discard' })]);
    expect(res.method).toBe('path+name');
    expect(res.node?.sessionId).toBe(42);
    expect(res.confidence).toBeGreaterThan(0.55);
  });

  it('role+name+ordinal disambiguates repeated siblings', () => {
    const rows = [0, 1, 2].map((i) =>
      node({ role: 'ListItem', name: 'Message', ordinal: i, sessionId: 10 + i }),
    );
    const res = resolveRef(ref({ role: 'ListItem', name: 'Message', ordinal: 2 }), rows);
    expect(res.node?.sessionId).toBe(12);
    expect(res.method).toBe('role+name+ordinal');
  });

  it('fuzzy match stays at or below 0.5 and respects the floor', () => {
    const candidates = [node({ role: 'MenuItem', name: 'Save As…' })];
    const res = resolveRef(ref({ role: 'MenuItem', name: 'Save' }), candidates, 0.2);
    expect(res.method).toBe('fuzzy');
    expect(res.confidence).toBeLessThanOrEqual(0.5);

    const floored = resolveRef(ref({ role: 'MenuItem', name: 'Save' }), candidates);
    expect(floored.method).toBe('none');
    expect(floored.node).toBeNull();
  });

  it('never resolves across roles', () => {
    const res = resolveRef(
      ref({ role: 'Button', name: 'Send' }),
      [node({ role: 'MenuItem', name: 'Send' })],
    );
    expect(res.node).toBeNull();
  });

  it('returns none on an empty surface', () => {
    const res = resolveRef(ref({ role: 'Button', name: 'Send' }), []);
    expect(res.method).toBe('none');
    expect(res.confidence).toBe(0);
  });
});

describe('pathSimilarity', () => {
  it('weights leaf-end segments over the root', () => {
    const stored = GMAIL_PATH;
    const leafDiffers = [
      { role: 'Window', name: 'Inbox - Gmail' },
      { role: 'Document' },
      { role: 'Pane', name: 'Compose' }, // leaf role changed
    ];
    const rootDiffers = [
      { role: 'Pane', name: 'Inbox - Gmail' }, // root role changed
      { role: 'Document' },
      { role: 'Group', name: 'Compose' },
    ];
    expect(pathSimilarity(stored, rootDiffers)).toBeGreaterThan(
      pathSimilarity(stored, leafDiffers),
    );
  });

  it('is 1 for identical paths and 0 against an empty path', () => {
    expect(pathSimilarity(GMAIL_PATH, GMAIL_PATH)).toBe(1);
    expect(pathSimilarity(GMAIL_PATH, [])).toBe(0);
  });
});

describe('fuzzyNameScore', () => {
  it('scores containment by length ratio', () => {
    expect(fuzzyNameScore('Save', 'Save As…')).toBeGreaterThan(0.4);
    expect(fuzzyNameScore('Save', 'Delete')).toBe(0);
  });
});

describe('UIA adapter', () => {
  const el: UiaSemanticElement = {
    id: 5,
    name: 'Send',
    automation_id: 'sendBtn',
    class_name: 'Button',
    control_type: 'Button',
    enabled: true,
    focusable: true,
    offscreen: false,
    rect: { x: 10, y: 20, w: 80, h: 24 },
    patterns: ['Invoke', 'Text'],
    depth: 3,
    path: GMAIL_PATH,
    ordinal: 0,
    sig: 'deadbeef00112233',
  };

  it('maps a Go semantic element to a SemanticNode', () => {
    const n = semanticNodeFromUia(el);
    expect(n.ref.stableId).toBe('sendBtn');
    expect(n.ref.sig).toBe('deadbeef00112233');
    expect(n.actions).toEqual(['click', 'get_text']);
    expect(n.bounds).toEqual({ x: 10, y: 20, width: 80, height: 24 });
    expect(n.sessionId).toBe(5);
  });

  it('round-trips through resolveRef: stored ref finds the adapted node', () => {
    const surface = surfaceFromUia({ window_title: 'Inbox - Gmail', pid: 1, elements: [el] });
    const res = resolveRef(surface.nodes[0]!.ref, surface.nodes);
    expect(res.confidence).toBe(1.0);
  });
});
