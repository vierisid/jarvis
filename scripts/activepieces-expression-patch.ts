/** Exact replacements fail a vendor sync if the supported expression boundary drifts. */
export const expressionPatches = {
  'packages/server/engine/src/lib/core/code/no-op-code-sandbox.ts': [
    ["import { CodeSandbox } from '../../core/code/code-sandbox-common'", "import type { CodeSandbox } from '../../core/code/code-sandbox-common'"],
    ["import { spawn } from 'node:child_process'", "import { spawn } from 'node:child_process'\nimport { evaluateWorkflowExpression } from '../../../../../../../../runtime/safe-expression'"],
    [
      '    async runScript({ script, scriptContext, functions }) {\n' +
      '        const newContext = {\n' +
      '            ...scriptContext,\n' +
      '            ...functions,\n' +
      '        }\n' +
      '        const params = Object.keys(newContext)\n' +
      '        const args = Object.values(newContext)\n' +
      '        const body = `return (${script})`\n' +
      '        const fn = Function(...params, body)\n' +
      '        return fn(...args)',
      '    async runScript({ script, scriptContext }) {\n' +
      '        // Jarvis: expressions may read data, never execute arbitrary code or callbacks.\n' +
      '        return evaluateWorkflowExpression(script, scriptContext)',
    ],
  ],
  'packages/server/engine/src/lib/variables/props-resolver.ts': [
    ["        console.warn('[evalInScope] Error evaluating variable', resultError)\n        return ''",
      '        // Jarvis: an unsupported expression must stop the step before any effect.\n        throw resultError'],
  ],
} as const;

export function applyExpressionPatch(source: string, replacements: readonly (readonly [string, string])[]): string {
  let result = source.replace(/\r\n/g, '\n');
  for (const [before, after] of replacements) {
    if (result.split(before).length !== 2) throw new Error('Expression boundary patch must match exactly once; review upstream changes');
    result = result.replace(before, () => after);
  }
  return result;
}
