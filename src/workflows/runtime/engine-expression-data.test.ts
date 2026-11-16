import { describe, expect, test } from 'bun:test';
import { ownStep } from './engine-expression-data';

const PROTOTYPE_NAMES = ['toString', 'hasOwnProperty', 'valueOf', '__defineGetter__', 'isPrototypeOf'];

describe('step names that Object.prototype also uses', () => {
  test('ownStep finds only steps the run recorded', () => {
    const steps: Record<string, unknown> = { recorded: { status: 'SUCCEEDED' } };
    expect(ownStep(steps, 'recorded')).toEqual({ status: 'SUCCEEDED' });
    for (const name of PROTOTYPE_NAMES) expect(ownStep(steps, name)).toBeUndefined();
    Object.assign(steps, { toString: { status: 'SUCCEEDED' } });
    expect(ownStep(steps, 'toString')).toEqual({ status: 'SUCCEEDED' });
  });
});
