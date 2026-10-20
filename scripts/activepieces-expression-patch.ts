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
    // #837 and #863: the CODE child runs with --no-install and the engine's
    // --config=<empty bunfig>. Registered so a vendor sync re-applies both.
    [
      "async function runInChildProcess(",
      "/**\n * Jarvis (#863): the Bun config the CODE child must run with, as argv. The\n * engine is spawned with `--config=<empty file>` (spawnEngine, spawn.ts), and\n * the child gets that same argument. Only that spelling, with a non-empty\n * value, replaces the cwd `bunfig.toml`: `--config <path>`, `-c` and\n * `--config=` all leave it read (measured). With none to forward -- this module\n * run outside a spawned engine, as unit tests do -- POSIX gets `/dev/null`,\n * which Bun reads as an empty config (measured, 1.3.8 and 1.4.2). Windows has\n * no such path, so it refuses rather than run the step with the cwd config.\n */\nexport function codeChildConfigArgs(execArgv: readonly string[] = process.execArgv, platform: string = process.platform): string[] {\n    const own = execArgv.filter(a => a.startsWith('--config='))\n    const last = own[own.length - 1]\n    if (last !== undefined && last.length > '--config='.length) return [last]\n    if (platform !== 'win32') return ['--config=/dev/null']\n    throw new Error('CODE step refused: the engine was not started with --config=<empty bunfig>, so the step would read a bunfig.toml from its working directory (#863).')\n}\n\nasync function runInChildProcess(",
    ],
    [
      "        const child = spawn(process.execPath, ['--eval', CODE_RUNNER_SCRIPT], {",
      "        // Jarvis (#837): `--no-install`, because a step file has no `node_modules`\n        // above it unless the daemon installed its declared dependencies there\n        // (code-materialize.ts), and with none Bun AUTO-INSTALLS any bare name the\n        // code requires: fetches the latest version from the npm registry and runs\n        // it. Measured with `is-number`, into an empty install cache. Bun-only:\n        // under Node there is no auto-install and the flag would be rejected.\n        //\n        // Jarvis (#863): and the engine's own `--config=<empty bunfig>`, so a\n        // `bunfig.toml` in the cwd this child inherits is never read: its\n        // `preload` would run before the step, as code nothing pins. And\n        // `--no-env-file`, so a `.env` there cannot add variables to the\n        // sanitized env below (a proxy for every request the step makes).\n        const args = process.versions.bun ? [...codeChildConfigArgs(), '--no-env-file', '--no-install', '--eval', CODE_RUNNER_SCRIPT] : ['--eval', CODE_RUNNER_SCRIPT]\n        const child = spawn(process.execPath, args, {",
    ],
  ],
  'packages/server/engine/src/lib/helper/trigger-helper.ts': [
    ["import { isValidCron } from 'cron-validator'", "import { validateCronExpression } from '../../../../../../../../lib/cron-scheduler'"],
    ['                if (!isValidCron(request.cronExpression)) {', '                try {\n                    validateCronExpression(request.cronExpression)\n                } catch {'],
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
    // #735: "starts with" has one meaning under both spellings, and an operator
    // the switch does not implement fails the step instead of staying true.
    // Registered here so a vendor sync re-applies it: readiness accepts
    // TEXT_STARTS_WITH only because the engine reads it as TEXT_START_WITH.
    ['            switch (castedCondition.operator) {',
      `            // === JARVIS PATCH: one meaning for "starts with", and no silent match ===
            // The enum's VALUE for starts-with is TEXT_START_WITH (what the dashboard
            // saves); its KEY name, TEXT_STARTS_WITH, is what composed workflows write.
            // Without a case for the key name, the condition fell through this switch
            // and stayed true, so "starts with" matched every input.
            const operator = (castedCondition.operator as string) === 'TEXT_STARTS_WITH'
                ? BranchOperator.TEXT_STARTS_WITH : castedCondition.operator
            // === END JARVIS PATCH ===
            switch (operator) {`],
    [`                case BranchOperator.DOES_NOT_EXIST:
                    andGroup = andGroup && (castedCondition.firstValue === undefined || castedCondition.firstValue === null || castedCondition.firstValue === '')
                    break
`,
      `                case BranchOperator.DOES_NOT_EXIST:
                    andGroup = andGroup && (castedCondition.firstValue === undefined || castedCondition.firstValue === null || castedCondition.firstValue === '')
                    break
                // === JARVIS PATCH: an operator this switch does not implement fails the step instead of matching ===
                default:
                    throw new EngineGenericError('UnsupportedOperatorError', \`Router condition operator \${String(operator)} is not supported\`)
                // === END JARVIS PATCH ===
`],
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
