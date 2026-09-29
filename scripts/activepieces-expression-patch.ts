/** Exact replacements fail a vendor sync if the supported expression boundary drifts. */
export const expressionPatches = {
  'packages/server/engine/src/lib/core/code/no-op-code-sandbox.ts': [
    ["import { CodeSandbox } from '../../core/code/code-sandbox-common'", "import type { CodeSandbox } from '../../core/code/code-sandbox-common'"],
    ["import { spawn } from 'node:child_process'", "import { spawn } from 'node:child_process'\nimport { evaluateWorkflowExpression } from '../../../../../../../../runtime/safe-expression'"],
    // #512: the CODE-step child gets a sanitized env rather than the engine's.
    // Registered here so a vendor sync re-applies it instead of dropping it.
    ["import { evaluateWorkflowExpression } from '../../../../../../../../runtime/safe-expression'", "import { evaluateWorkflowExpression } from '../../../../../../../../runtime/safe-expression'\nimport { sanitizedEnv } from '../../../../../../../../../util/subprocess-env'"],
    [
      "            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],\n        })",
      "            stdio: ['pipe', 'pipe', 'pipe', 'ipc'],\n" +
      '            // Jarvis: this child runs a CODE step, i.e. workflow-authored code.\n' +
      "            // Inheriting would hand it the engine's own env: SANDBOX_ID (what\n" +
      "            // the daemon's worker RPC accepts an engine connection on), the WS\n" +
      "            // port, and the reaper's JARVIS_ENGINE_* markers. This is env\n" +
      '            // hygiene, not isolation: at the same uid the child can still read\n' +
      "            // /proc/<engine pid>/environ, and up the parent chain the daemon's\n" +
      '            // /proc/<pid>/environ, which holds every secret it started with.\n' +
      '            env: sanitizedEnv(),\n' +
      '        })',
    ],
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
    ['        return result ?? \'\'\n    }))',
      "        if (result === undefined) throw new Error('Workflow reference resolved to an absent value; supply a value or an explicit fallback')\n        return result\n    }))"],
    ["        console.warn('[evalInScope] Error evaluating variable', resultError)\n        return ''",
      '        // Jarvis: an unsupported expression must stop the step before any effect.\n        throw resultError'],
  ],
  'packages/server/engine/src/lib/variables/props-processor.ts': [
    ["import { getAuthPropertyForValue,",
      "import { resolvedInputIssues } from '../../../../../../../runtime/resolved-input-guard'\nimport { getAuthPropertyForValue,"],
    ['        return { processedInput, errors }',
      '        Object.assign(errors, resolvedInputIssues(processedInput, props, requireAuth, !!auth, propertySettings, resolvedInput))\n        return { processedInput, errors }'],
  ],
  'packages/server/engine/src/lib/handler/router-executor.ts': [
    ["import { LATEST_CONTEXT_VERSION } from '@activepieces/pieces-framework'",
      "import { LATEST_CONTEXT_VERSION } from '@activepieces/pieces-framework'\nimport { withPresenceFallbacks } from '../../../../../../../runtime/router-presence'"],
    [`        const { censoredInput, resolvedInput } = await constants.getPropsResolver(LATEST_CONTEXT_VERSION).resolve<RouterActionSettings>({
            unresolvedInput: {
                ...action.settings,
            },
            executionState,
        })`,
      `        const resolver = constants.getPropsResolver(LATEST_CONTEXT_VERSION)
        const settings = withPresenceFallbacks(action.settings) as RouterActionSettings
        // Resolve metadata first, leaving condition operands untouched until
        // their AND/OR group actually needs them. A presence guard must be
        // able to stop an absent comparison before strict input resolution.
        const { censoredInput, resolvedInput } = await resolver.resolve<RouterActionSettings>({
            unresolvedInput: {
                ...settings,
                branches: settings.branches.map(branch => branch.branchType === BranchExecutionType.CONDITION
                    ? { ...branch, conditions: [] } : branch),
            },
            executionState,
        })
        for (const [index, branch] of settings.branches.entries()) {
            if (branch.branchType !== BranchExecutionType.CONDITION) continue
            const resolvedGroups: BranchCondition[][] = []
            const censoredGroups: BranchCondition[][] = []
            resolvedInput.branches[index] = { ...resolvedInput.branches[index], branchType: BranchExecutionType.CONDITION, conditions: resolvedGroups }
            const censoredSettings = censoredInput as RouterActionSettings
            censoredSettings.branches[index] = { ...censoredSettings.branches[index], branchType: BranchExecutionType.CONDITION, conditions: censoredGroups }
            for (const group of branch.conditions) {
                const resolvedGroup: BranchCondition[] = []
                const censoredGroup: BranchCondition[] = []
                resolvedGroups.push(resolvedGroup)
                censoredGroups.push(censoredGroup)
                let matched = true
                for (const condition of group) {
                    const result = await resolver.resolve<BranchCondition>({ unresolvedInput: condition, executionState })
                    resolvedGroup.push(result.resolvedInput)
                    censoredGroup.push(result.censoredInput as BranchCondition)
                    matched = evaluateConditions([[result.resolvedInput]])
                    if (!matched) break
                }
                if (matched) break
            }
            // FIRST_MATCH must not resolve operands in later branches. Their
            // condition lists remain empty in the recorded input.
            if (resolvedInput.executionType === RouterExecutionType.EXECUTE_FIRST_MATCH && evaluateConditions(resolvedGroups)) break
        }
        // Each retained group is its evaluated prefix. The existing boolean
        // evaluator yields the same result; logs contain only evaluated data.`],
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
