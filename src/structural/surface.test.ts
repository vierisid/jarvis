import { describe, expect, it } from 'bun:test';
import { salienceFilter, computeCoverage } from './surface.ts';
import { semanticNodeFromUia } from './types.ts';
import type { UiaSemanticElement } from './types.ts';

function uia(p: Partial<UiaSemanticElement> & { control_type: string; name: string }): UiaSemanticElement {
  return {
    id: 1, automation_id: '', class_name: '', enabled: true, focusable: true,
    offscreen: false, rect: { x: 0, y: 0, w: 100, h: 30 }, patterns: [], depth: 1,
    ...p,
  };
}

describe('salienceFilter', () => {
  it('keeps interactable elements and named text, drops unnamed containers', () => {
    const nodes = [
      semanticNodeFromUia(uia({ control_type: 'Button', name: 'Send', patterns: ['Invoke'] })),
      semanticNodeFromUia(uia({ control_type: 'Text', name: 'To:' })),           // named label
      semanticNodeFromUia(uia({ control_type: 'Pane', name: '' })),               // unnamed container
      semanticNodeFromUia(uia({ control_type: 'Group', name: '' })),              // unnamed container
      semanticNodeFromUia(uia({ control_type: 'Edit', name: '', patterns: ['Value'] })), // interactable, unnamed
    ];
    const kept = salienceFilter(nodes);
    const roles = kept.map((n) => n.role).sort();
    expect(roles).toEqual(['Button', 'Edit', 'Text']);
  });
});

describe('computeCoverage', () => {
  it('is high when named-interactable elements fill the visible area', () => {
    const nodes = [
      semanticNodeFromUia(uia({ control_type: 'Button', name: 'OK', patterns: ['Invoke'], rect: { x: 0, y: 0, w: 100, h: 100 } })),
    ];
    expect(computeCoverage(nodes)).toBeGreaterThan(0.9);
  });

  it('is low when the visible area is unnamed/actionless (canvas-like)', () => {
    const nodes = [
      semanticNodeFromUia(uia({ control_type: 'Pane', name: '', rect: { x: 0, y: 0, w: 900, h: 900 } })),
      semanticNodeFromUia(uia({ control_type: 'Button', name: 'OK', patterns: ['Invoke'], rect: { x: 0, y: 0, w: 30, h: 30 } })),
    ];
    expect(computeCoverage(nodes)).toBeLessThan(0.4);
  });

  it('falls back to a count proxy when no element has bounds (browser AX)', () => {
    const noBounds = [
      { ...semanticNodeFromUia(uia({ control_type: 'button', name: 'Send', patterns: ['Invoke'] })), bounds: null, actions: ['click'] },
      { ...semanticNodeFromUia(uia({ control_type: 'button', name: '', patterns: ['Invoke'] })), bounds: null, actions: ['click'] },
    ];
    // one of two interactables is named → 0.5
    expect(computeCoverage(noBounds)).toBeCloseTo(0.5, 1);
  });
});
